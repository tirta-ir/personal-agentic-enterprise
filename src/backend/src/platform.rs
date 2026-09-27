//! Identity and tenant boundary. Each workspace retains the existing organization store.
use crate::{
    App,
    model::{self, Group, Run},
    security::ApiError,
    store::Store,
};
use anyhow::{Context, Result};
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::any,
};
use matrix_sdk::Client;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use subtle::ConstantTimeEq;
use tower::ServiceExt;
macro_rules! ensure { ($condition:expr, $($arg:tt)*) => { if !$condition { return Err(anyhow::anyhow!($($arg)*).into()); } }; }

#[derive(Clone, Debug)]
pub struct Identity {
    pub user: String,
    pub role: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Tenant {
    pub id: String,
    pub name: String,
    pub deleted: bool,
}
pub struct Platform {
    db: Mutex<Connection>,
    pub(crate) apps: Mutex<HashMap<String, App>>,
    pub(crate) base: App,
    frontend: PathBuf,
    pub(crate) homeserver: Option<String>,
}
fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn credential(req: &Request) -> Option<&str> {
    req.headers()
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .or_else(|| cookie(req, "ae_session"))
}
fn cookie<'a>(req: &'a Request, name: &str) -> Option<&'a str> {
    req.headers()
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .map(str::trim)
        .find_map(|s| {
            s.split_once('=')
                .filter(|(k, _)| *k == name)
                .map(|(_, v)| v)
        })
}
impl Platform {
    pub fn open(base: App, frontend: PathBuf) -> Result<Arc<Self>> {
        let origin = url::Url::parse(&base.public_url)?;
        ensure!(
            ["http", "https"].contains(&origin.scheme())
                && origin.host_str().is_some()
                && origin.path() == "/"
                && origin.query().is_none()
                && origin.username().is_empty(),
            "Public URL must be an HTTP(S) origin without path or credentials"
        );
        let db = Connection::open(base.store.org.join(".state/platform.sqlite3"))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS tenants(id TEXT PRIMARY KEY,name TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS members(tenant TEXT REFERENCES tenants(id),user TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('owner','member')),PRIMARY KEY(tenant,user));
            CREATE TABLE IF NOT EXISTS logins(token_hash TEXT PRIMARY KEY,user TEXT NOT NULL,expires INTEGER NOT NULL);
            INSERT OR IGNORE INTO tenants(id,name) VALUES('default','My workspace');
            INSERT OR IGNORE INTO members VALUES('default','owner','owner');")?;
        let tenants = {
            let mut q = db.prepare("SELECT id,name,deleted FROM tenants")?;
            q.query_map([], |r| {
                Ok(Tenant {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    deleted: r.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
        };
        let platform = Arc::new(Self {
            db: Mutex::new(db),
            apps: Mutex::new(HashMap::new()),
            base,
            frontend,
            homeserver: std::env::var("AE_MATRIX_HOMESERVER").ok(),
        });
        for tenant in tenants {
            let app = platform.load(&tenant)?;
            platform
                .apps
                .lock()
                .map_err(|_| anyhow::anyhow!("Workspace registry unavailable"))?
                .insert(tenant.id, app);
        }
        Ok(platform)
    }
    fn load(&self, tenant: &Tenant) -> Result<App> {
        let mut app = self.base.clone();
        app.workspace_id = tenant.id.clone();
        app.enabled = Arc::new(AtomicBool::new(!tenant.deleted));
        if tenant.id != "default" {
            app.store = Arc::new(Store::open(
                self.base.store.org.join("workspaces").join(&tenant.id),
            )?);
            app.knowledge = Arc::new(crate::knowledge::Knowledge::new(
                app.store.org.join(".state"),
            ));
            app.wake = Arc::new(tokio::sync::Notify::new());
            app.cancellations = Default::default();
            app.tool_tokens = Default::default();
        }
        crate::runtime::start_queue(app.clone());
        crate::fleet::initialize(&app)?;
        if tenant.id == "default" {
            crate::remote::start_monitor(app.clone());
        }
        Ok(app)
    }
    pub(crate) fn db<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let db = self
            .db
            .lock()
            .map_err(|_| anyhow::anyhow!("Identity store unavailable"))?;
        f(&db)
    }
    fn user(&self, req: &Request) -> Result<Option<String>> {
        let Some(token) = credential(req) else {
            return Ok(None);
        };
        if bool::from(token.as_bytes().ct_eq(self.base.token.as_bytes())) {
            return Ok(Some("owner".into()));
        }
        self.db(|db| {
            Ok(db
                .query_row(
                    "SELECT user FROM logins WHERE token_hash=? AND expires>unixepoch()",
                    [hash(token)],
                    |r| r.get(0),
                )
                .optional()?)
        })
    }
    fn tenant(&self, id: &str, user: &str) -> Result<(App, String)> {
        let role = self.db(|db| Ok(db.query_row("SELECT m.role FROM members m JOIN tenants t ON t.id=m.tenant WHERE m.tenant=? AND m.user=? AND t.deleted=0",[id,user],|r|r.get::<_,String>(0)).optional()?))?.context("Workspace access denied")?;
        let app = self
            .apps
            .lock()
            .map_err(|_| anyhow::anyhow!("Workspace registry unavailable"))?
            .get(id)
            .cloned()
            .context("Workspace unavailable")?;
        Ok((app, role))
    }
    pub fn members(&self, tenant: &str) -> Result<Vec<Value>> {
        self.db(|db| {
            let mut q = db.prepare("SELECT user,role FROM members WHERE tenant=? ORDER BY user")?;
            Ok(q.query_map([tenant], |r| {
                Ok(json!({"user":r.get::<_,String>(0)?,"role":r.get::<_,String>(1)?}))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }
    async fn handle(self: &Arc<Self>, mut req: Request) -> Result<Response, ApiError> {
        let path = req.uri().path().to_owned();
        let method = req.method().clone();
        let expected = self.base.public_url.trim_end_matches('/');
        let url = url::Url::parse(expected).map_err(anyhow::Error::from)?;
        let expected_host = match url.port() {
            Some(port) => format!("{}:{port}", url.host_str().unwrap_or_default()),
            None => url.host_str().unwrap_or_default().to_owned(),
        };
        let host = req
            .headers()
            .get(header::HOST)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let internal_host = std::env::var("AE_INTERNAL_URL")
            .ok()
            .and_then(|s| url::Url::parse(&s).ok())
            .map(|u| u[url::Position::BeforeHost..url::Position::AfterPort].to_owned());
        if host != expected_host
            && Some(host) != internal_host.as_deref()
            && host != self.base.address.to_string()
            && !(self.base.address.ip().is_loopback()
                && host == format!("localhost:{}", self.base.address.port()))
        {
            return Err(ApiError(StatusCode::FORBIDDEN, "Invalid host".into()));
        }
        if let Some(origin) = req.headers().get(header::ORIGIN) {
            if origin.to_str().ok() != Some(expected)
                && origin.to_str().ok() != Some(format!("http://{host}").as_str())
            {
                return Err(ApiError(
                    StatusCode::FORBIDDEN,
                    "Cross-origin request rejected".into(),
                ));
            }
        }
        if path == "/api/auth" {
            return Ok(axum::Json(json!({"matrix":self.homeserver.is_some()})).into_response());
        }
        if let Some(op) = path.strip_prefix("/api/runtime/") {
            if method != Method::POST {
                return Ok(StatusCode::METHOD_NOT_ALLOWED.into_response());
            }
            let token = credential(&req).unwrap_or("").to_owned();
            let input: Value = serde_json::from_slice(
                &to_bytes(req.into_body(), 10 * 1024 * 1024)
                    .await
                    .map_err(anyhow::Error::from)?,
            )
            .map_err(anyhow::Error::from)?;
            let apps: Vec<_> = self
                .apps
                .lock()
                .map_err(|_| anyhow::anyhow!("Workspace registry unavailable"))?
                .iter()
                .map(|(id, app)| (id.clone(), app.clone()))
                .collect();
            let response =
                crate::fleet::worker_request(&apps, op, &token, &input)?.ok_or_else(|| {
                    ApiError(
                        StatusCode::UNAUTHORIZED,
                        "Runtime token is invalid, expired or revoked".into(),
                    )
                })?;
            return Ok(axum::Json(response).into_response());
        }
        if path == "/api/login" && method == Method::POST {
            let input: Value = serde_json::from_slice(
                &to_bytes(req.into_body(), 16384)
                    .await
                    .map_err(anyhow::Error::from)?,
            )
            .map_err(anyhow::Error::from)?;
            let user = if let Some(token) = input["token"].as_str() {
                if !bool::from(token.as_bytes().ct_eq(self.base.token.as_bytes())) {
                    return Err(ApiError(
                        StatusCode::UNAUTHORIZED,
                        "Invalid owner key".into(),
                    ));
                }
                "owner".to_owned()
            } else {
                let homeserver = self
                    .homeserver
                    .as_ref()
                    .context("Matrix sign-in is not configured")?;
                let username = input["username"].as_str().context("Username required")?;
                let password = input["password"].as_str().context("Password required")?;
                let client = Client::builder()
                    .homeserver_url(homeserver)
                    .request_config(
                        matrix_sdk::config::RequestConfig::new()
                            .disable_retry()
                            .timeout(std::time::Duration::from_secs(15)),
                    )
                    .build()
                    .await
                    .map_err(anyhow::Error::from)?;
                client
                    .matrix_auth()
                    .login_username(username, password)
                    .initial_device_display_name("Agentic Enterprise")
                    .await
                    .map_err(|error| {
                        if matches!(
                            error.client_api_error_kind(),
                            Some(matrix_sdk::ruma::api::error::ErrorKind::LimitExceeded(_))
                        ) {
                            ApiError(
                                StatusCode::TOO_MANY_REQUESTS,
                                "Sign-in rate limited; retry later".into(),
                            )
                        } else {
                            ApiError(StatusCode::UNAUTHORIZED, "Matrix sign-in failed".into())
                        }
                    })?;
                let user = client
                    .user_id()
                    .context("Matrix returned no user identity")?
                    .to_string();
                client
                    .matrix_auth()
                    .logout()
                    .await
                    .map_err(anyhow::Error::from)?;
                user
            };
            let token = format!("{}{}", model::id(), model::id());
            self.db(|db| {
                db.execute("DELETE FROM logins WHERE expires<=unixepoch()", [])?;
                db.execute(
                    "INSERT INTO logins VALUES(?,?,unixepoch()+86400)",
                    params![hash(&token), user],
                )?;
                Ok(())
            })?;
            return Ok((
                [(
                    header::SET_COOKIE,
                    format!(
                        "ae_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400{}",
                        if expected.starts_with("https:") {
                            "; Secure"
                        } else {
                            ""
                        }
                    ),
                )],
                axum::Json(json!({"ok":true,"user":user})),
            )
                .into_response());
        }
        if path == "/api/health" || (!path.starts_with("/api/") && path != "/mcp") {
            return Ok(crate::api::router(self.base.clone(), self.frontend.clone())
                .oneshot(req)
                .await
                .expect("infallible router"));
        }
        if path == "/mcp" {
            let token = credential(&req).unwrap_or("");
            let app = self
                .apps
                .lock()
                .map_err(|_| anyhow::anyhow!("Workspace registry unavailable"))?
                .values()
                .find(|app| {
                    app.tool_tokens
                        .lock()
                        .is_ok_and(|tokens| tokens.contains_key(token))
                })
                .cloned();
            let app = app.ok_or_else(|| {
                ApiError(StatusCode::UNAUTHORIZED, "Unknown run capability".into())
            })?;
            return Ok(crate::api::router(app, self.frontend.clone())
                .oneshot(req)
                .await
                .expect("infallible router"));
        }
        let user = self
            .user(&req)?
            .ok_or_else(|| ApiError(StatusCode::UNAUTHORIZED, "Sign-in required".into()))?;
        if path == "/api/logout" {
            if let Some(token) = credential(&req) {
                self.db(|db| {
                    db.execute("DELETE FROM logins WHERE token_hash=?", [hash(token)])?;
                    Ok(())
                })?;
            }
            return Ok((
                [(
                    header::SET_COOKIE,
                    "ae_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
                )],
                axum::Json(json!({"ok":true})),
            )
                .into_response());
        }
        if path == "/api/me" {
            return Ok(
                axum::Json(json!({"user":user,"matrix":self.homeserver.is_some()})).into_response(),
            );
        }
        if path == "/api/tenants" {
            if method == Method::GET {
                let values = self.db(|db| {let mut q=db.prepare("SELECT t.id,t.name,t.deleted,m.role FROM tenants t JOIN members m ON t.id=m.tenant WHERE m.user=? ORDER BY t.name")?;
                    Ok(q.query_map([&user],|r|Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"deleted":r.get::<_,bool>(2)?,"role":r.get::<_,String>(3)?})))?.collect::<rusqlite::Result<Vec<_>>>()?)})?;
                return Ok(axum::Json(values).into_response());
            }
            if method == Method::POST {
                let input: Value = serde_json::from_slice(
                    &to_bytes(req.into_body(), 16384)
                        .await
                        .map_err(anyhow::Error::from)?,
                )
                .map_err(anyhow::Error::from)?;
                let name = input["name"].as_str().unwrap_or("").trim();
                ensure!(
                    !name.is_empty() && name.len() <= 80,
                    "Workspace name must contain 1–80 bytes"
                );
                let tenant = Tenant {
                    id: model::id(),
                    name: name.into(),
                    deleted: false,
                };
                let app = self.load(&tenant)?;
                self.db(|db| {
                    let tx = db.unchecked_transaction()?;
                    tx.execute(
                        "INSERT INTO tenants(id,name) VALUES(?,?)",
                        [&tenant.id, &tenant.name],
                    )?;
                    tx.execute(
                        "INSERT INTO members VALUES(?,?,'owner')",
                        [&tenant.id, &user],
                    )?;
                    tx.commit()?;
                    Ok(())
                })?;
                self.apps
                    .lock()
                    .map_err(|_| anyhow::anyhow!("Workspace registry unavailable"))?
                    .insert(tenant.id.clone(), app);
                return Ok(axum::Json(tenant).into_response());
            }
            return Ok(StatusCode::METHOD_NOT_ALLOWED.into_response());
        }
        if let Some(rest) = path.strip_prefix("/api/tenants/") {
            let (id, sub) = rest.split_once('/').unwrap_or((rest, ""));
            let role = self.db(|db| {
                Ok(db
                    .query_row(
                        "SELECT role FROM members WHERE tenant=? AND user=?",
                        [id, &user],
                        |r| r.get::<_, String>(0),
                    )
                    .optional()?)
            })?;
            if role.as_deref() != Some("owner") {
                return Err(ApiError(
                    StatusCode::FORBIDDEN,
                    "Workspace owner required".into(),
                ));
            }
            if sub == "members" && method == Method::GET {
                return Ok(axum::Json(self.members(id)?).into_response());
            }
            let input: Value = serde_json::from_slice(
                &to_bytes(req.into_body(), 16384)
                    .await
                    .map_err(anyhow::Error::from)?,
            )
            .map_err(anyhow::Error::from)?;
            if sub == "members" && [Method::POST, Method::PUT, Method::DELETE].contains(&method) {
                let invite = input["user"].as_str().context("Matrix user ID required")?;
                matrix_sdk::ruma::UserId::parse(invite).map_err(anyhow::Error::from)?;
                ensure!(invite != user, "Cannot change your own ownership");
                let assigned_role = input["role"]
                    .as_str()
                    .or_else(|| {
                        (method != Method::PUT && input.get("role").is_none()).then_some("member")
                    })
                    .context("Role must be owner or member")?;
                ensure!(
                    ["owner", "member"].contains(&assigned_role),
                    "Choose owner or member"
                );
                self.db(|db| {
                    let current: String = db.query_row(
                        "SELECT role FROM members WHERE tenant=? AND user=?",
                        [id, &user],
                        |r| r.get(0),
                    )?;
                    ensure!(current == "owner", "Workspace owner required");
                    if method == Method::DELETE {
                        db.execute(
                            "DELETE FROM members WHERE tenant=? AND user=? AND role='member'",
                            [id, invite],
                        )?;
                    } else if method == Method::PUT {
                        ensure!(
                            db.execute(
                                "UPDATE members SET role=? WHERE tenant=? AND user=?",
                                [assigned_role, id, invite]
                            )? == 1,
                            "Workspace member not found"
                        );
                    } else {
                        db.execute(
                            "INSERT OR IGNORE INTO members VALUES(?,?,?)",
                            [id, invite, assigned_role],
                        )?;
                    }
                    Ok(())
                })?;
                return Ok(axum::Json(self.members(id)?).into_response());
            }
            if sub.is_empty() && [Method::PUT, Method::DELETE].contains(&method) {
                let app = self
                    .apps
                    .lock()
                    .map_err(|_| anyhow::anyhow!("Workspace registry unavailable"))?
                    .get(id)
                    .cloned()
                    .context("Workspace unavailable")?;
                let deleted =
                    method == Method::DELETE || input["deleted"].as_bool().unwrap_or(false);
                if deleted {
                    ensure!(
                        !app.store
                            .list::<Run>("runs")?
                            .iter()
                            .any(crate::coordination::active),
                        "Stop active runs before deleting this workspace"
                    );
                }
                self.db(|db| {
                    if let Some(name) = input["name"].as_str() {
                        ensure!(
                            !name.trim().is_empty() && name.len() <= 80,
                            "Invalid workspace name"
                        );
                        db.execute("UPDATE tenants SET name=? WHERE id=?", [name.trim(), id])?;
                    }
                    db.execute(
                        "UPDATE tenants SET deleted=? WHERE id=?",
                        params![deleted, id],
                    )?;
                    Ok(())
                })?;
                app.enabled.store(!deleted, Ordering::Relaxed);
                return Ok(axum::Json(json!({"id":id,"deleted":deleted})).into_response());
            }
            return Ok(StatusCode::METHOD_NOT_ALLOWED.into_response());
        }
        let tenant = req
            .headers()
            .get("x-ae-workspace")
            .and_then(|v| v.to_str().ok())
            .or_else(|| cookie(&req, "ae_workspace"))
            .unwrap_or("default")
            .to_owned();
        let (mut app, role) = self
            .tenant(&tenant, &user)
            .map_err(|_| ApiError(StatusCode::FORBIDDEN, "Workspace access denied".into()))?;
        if path == "/api/people" && method == Method::GET {
            return Ok(axum::Json(self.members(&tenant)?).into_response());
        }
        app.identity = Some(Identity {
            user: user.clone(),
            role: role.clone(),
        });
        if (user != "owner" || tenant != "default")
            && (path.starts_with("/api/workstations")
                || path == "/api/workspaces/directories"
                || path.ends_with("/terminal")
                || path.contains("/terminal/")
                || path.ends_with("/files")
                || path == "/api/codex/settings")
        {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                "Controller filesystem access requires the bootstrap owner".into(),
            ));
        }
        if path == "/api/runtimes" || path.starts_with("/api/runtimes/") {
            if role != "owner" {
                return Err(ApiError(
                    StatusCode::FORBIDDEN,
                    "Workspace owner required".into(),
                ));
            }
            if path == "/api/runtimes" && method == Method::GET {
                return Ok(axum::Json(crate::fleet::list(&app)?).into_response());
            }
            if path == "/api/runtimes" && method == Method::POST {
                let input: Value = serde_json::from_slice(
                    &to_bytes(req.into_body(), 16384)
                        .await
                        .map_err(anyhow::Error::from)?,
                )
                .map_err(anyhow::Error::from)?;
                return Ok(axum::Json(crate::fleet::register(
                    &app,
                    input["name"].as_str().unwrap_or(""),
                )?)
                .into_response());
            }
            if let Some(id) = path.strip_prefix("/api/runtimes/") {
                if let Some(id) = id.strip_suffix("/directories")
                    && method == Method::POST
                {
                    let input: Value = serde_json::from_slice(
                        &to_bytes(req.into_body(), 16384)
                            .await
                            .map_err(anyhow::Error::from)?,
                    )
                    .map_err(anyhow::Error::from)?;
                    let folder = input["path"]
                        .as_str()
                        .context("Folder path required")?
                        .to_owned();
                    let id = id.to_owned();
                    let result = tokio::task::spawn_blocking(move || {
                        crate::fleet::directories(&app, &id, &folder)
                    })
                    .await
                    .map_err(anyhow::Error::from)??;
                    return Ok(axum::Json(result).into_response());
                }
                if method == Method::PUT {
                    let input: crate::fleet::RuntimeMetadata = serde_json::from_slice(
                        &to_bytes(req.into_body(), 16384)
                            .await
                            .map_err(anyhow::Error::from)?,
                    )
                    .map_err(anyhow::Error::from)?;
                    app.store.write(|db| crate::fleet::update(db, id, input))?;
                    return Ok(axum::Json(json!({"updated":true})).into_response());
                }
                if method == Method::DELETE {
                    crate::fleet::revoke(&app, id)?;
                    return Ok(axum::Json(json!({"revoked":true})).into_response());
                }
            }
            return Ok(StatusCode::METHOD_NOT_ALLOWED.into_response());
        }
        if path == "/api/groups" && method == Method::POST {
            let bytes = to_bytes(std::mem::replace(req.body_mut(), Body::empty()), 128 * 1024)
                .await
                .map_err(anyhow::Error::from)?;
            let group: Group = serde_json::from_slice(&bytes).map_err(anyhow::Error::from)?;
            let members = self.members(&tenant)?;
            if let Some(ids) = &group.human_ids {
                ensure!(
                    ids.iter()
                        .all(|id| members.iter().any(|p| p["user"].as_str() == Some(id))),
                    "Invite workspace members to the group first"
                );
            }
            *req.body_mut() = Body::from(bytes);
        }
        if role != "owner" {
            authorize_member(&app, &path, &method, &mut req).await?;
        }
        req.extensions_mut().insert(Identity { user, role });
        Ok(crate::api::router(app, self.frontend.clone())
            .oneshot(req)
            .await
            .expect("infallible router"))
    }
}

pub fn can_read(app: &App, group: &Group) -> bool {
    app.identity.as_ref().is_none_or(|i| {
        i.role == "owner"
            || group
                .human_ids
                .as_ref()
                .is_none_or(|ids| ids.contains(&i.user))
    })
}
async fn authorize_member(
    app: &App,
    path: &str,
    method: &Method,
    req: &mut Request,
) -> Result<(), ApiError> {
    let forbidden = || {
        ApiError(
            StatusCode::FORBIDDEN,
            "Room membership or workspace owner permission required".into(),
        )
    };
    if path == "/api/state" && method == Method::GET {
        return Ok(());
    }
    // Members receive a filtered snapshot; global event payloads and administrative APIs are owner-only.
    let group_id = if path == "/api/messages" && method == Method::POST {
        let bytes = to_bytes(std::mem::replace(req.body_mut(), Body::empty()), 128 * 1024)
            .await
            .map_err(anyhow::Error::from)?;
        let value: Value = serde_json::from_slice(&bytes).map_err(anyhow::Error::from)?;
        ensure!(
            !value["body"]
                .as_str()
                .unwrap_or("")
                .trim_start()
                .starts_with('/'),
            "Workspace owner permission required for commands"
        );
        let group = value["group_id"]
            .as_str()
            .context("Group required")?
            .to_owned();
        *req.body_mut() = Body::from(bytes);
        group
    } else if path.starts_with("/api/questions/")
        && (method == Method::GET || (method == Method::POST && path.ends_with("/answer")))
    {
        let id = path
            .trim_start_matches("/api/questions/")
            .trim_end_matches("/answer");
        app.store
            .get::<crate::questions::QuestionRequest>("questions", id)
            .map_err(|_| forbidden())?
            .group_id
    } else if method == Method::GET
        && path.starts_with("/api/groups/")
        && path.ends_with("/messages")
    {
        path.trim_start_matches("/api/groups/")
            .trim_end_matches("/messages")
            .to_owned()
    } else {
        return Err(forbidden());
    };
    let group: Group = app
        .store
        .get("groups", &group_id)
        .map_err(|_| forbidden())?;
    if !can_read(app, &group) {
        return Err(forbidden());
    }
    Ok(())
}
pub fn router(platform: Arc<Platform>) -> Router {
    Router::new()
        .fallback(any(
            |State(p): State<Arc<Platform>>, req: Request| async move {
                let mut response = match p.handle(req).await {
                    Ok(r) => r,
                    Err(e) => e.into_response(),
                };
                response
                    .headers_mut()
                    .insert(header::CACHE_CONTROL, "no-store".parse().expect("static"));
                response.headers_mut().insert(
                    header::X_CONTENT_TYPE_OPTIONS,
                    "nosniff".parse().expect("static"),
                );
                response
            },
        ))
        .with_state(platform)
}
