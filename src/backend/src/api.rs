macro_rules! ensure { ($condition:expr, $($arg:tt)*) => { if !$condition { return Err(anyhow::anyhow!($($arg)*).into()); } }; }
macro_rules! bail { ($($arg:tt)*) => { return Err(anyhow::anyhow!($($arg)*).into()) }; }
use crate::{
    App, codex_settings, coordination,
    model::*,
    runtime, schedules,
    security::{self, ApiError, ApiResult},
    store,
};
use anyhow::{Context, Result};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Multipart, Path, Query, State},
    http::{StatusCode, header},
    middleware,
    response::{
        IntoResponse, Response, Sse,
        sse::{Event as SseEvent, KeepAlive},
    },
    routing::{delete, get, post, put},
};
use futures::stream;
use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, convert::Infallible, path::PathBuf, time::Duration};
use subtle::ConstantTimeEq;

pub fn router(app: App, frontend: PathBuf) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route("/api/state", get(state))
        .route("/api/workstations", post(crate::workstations::save))
        .route(
            "/api/workstations/import",
            post(crate::workstations::import),
        )
        .route(
            "/api/workstations/{id}",
            delete(crate::workstations::remove),
        )
        .route(
            "/api/workstations/{id}/test",
            post(crate::workstations::test),
        )
        .route(
            "/api/workstations/{id}/host-keys",
            get(crate::workstations::host_keys),
        )
        .route(
            "/api/workstations/{id}/trust",
            post(crate::workstations::trust),
        )
        .route("/mcp", post(crate::agent_tools::handle))
        .route("/api/actions", post(crate::actions::save))
        .route("/api/actions/{id}/invoke", post(crate::actions::invoke))
        .route("/api/actions/{id}/cancel", post(crate::actions::cancel))
        .route(
            "/api/actions/{id}",
            axum::routing::delete(crate::actions::delete),
        )
        .route("/api/organization/layout", put(save_organization_layout))
        .route("/api/codex/settings", get(codex_catalog))
        .route("/api/harness/settings", get(harness_catalog))
        .route("/api/agents", post(save_agent))
        .route("/api/agents/{id}", put(update_agent).delete(delete_agent))
        .route("/api/agents/{id}/restore", post(restore_agent))
        .route("/api/agents/{id}/revisions", get(revisions))
        .route(
            "/api/agents/{id}/organization-context",
            get(agent_organization_context),
        )
        .route("/api/agents/{id}/probe", post(probe))
        .route("/api/agents/{id}/files", get(files).put(save_script))
        .route(
            "/api/agents/{id}/terminal",
            get(crate::terminal::list).post(crate::terminal::start),
        )
        .route(
            "/api/agents/{id}/terminal/{run_id}",
            get(crate::terminal::get),
        )
        .route(
            "/api/agents/{id}/terminal/{run_id}/stop",
            post(crate::terminal::stop),
        )
        .route("/api/agents/{id}/skills", get(crate::skills::list))
        .route("/api/workspaces/probe", post(workspace_probe))
        .route("/api/workspaces/directories", get(workspace_directories))
        .route("/api/preferences/panels", put(save_panel_sizes))
        .route("/api/preferences/groups", put(save_group_preferences))
        .route("/api/groups", post(save_group))
        .route("/api/groups/{id}/archive", post(archive_group))
        .route("/api/groups/{id}/restore", post(restore_group))
        .route("/api/groups/{id}", delete(delete_group))
        .route("/api/groups/{id}/schedules", post(schedules::create))
        .route(
            "/api/schedules/{id}",
            put(schedules::update).delete(schedules::delete),
        )
        .route("/api/schedules/{id}/enabled", put(schedules::set_enabled))
        .route("/api/groups/{id}/messages", get(messages))
        .route("/api/messages", post(send_message))
        .route("/api/runs/{id}", get(get_run))
        .route("/api/runs/{id}/cancel", post(cancel))
        .route("/api/runs/{id}/events", get(run_events))
        .route("/api/runs/{id}/files", get(crate::run_files::read))
        .route("/api/questions/{id}", get(crate::questions::get))
        .route("/api/questions/{id}/answer", post(crate::questions::answer))
        .route("/api/sessions", get(sessions))
        .route("/api/sessions/{id}/reset", post(reset_session))
        .route("/api/events", get(events))
        .route("/api/artifacts", post(upload))
        .route("/api/artifacts/{id}", get(download).delete(delete_artifact))
        .route("/api/artifacts/{id}/index", post(index_artifact))
        .route("/api/search", get(search))
        .route("/api/export", post(export))
        .route("/api/backups/{id}", get(download_backup))
        .route(
            "/api/{*path}",
            axum::routing::any(|| async { StatusCode::NOT_FOUND }),
        )
        .fallback_service(tower_http::services::ServeDir::new(&frontend).fallback(
            tower_http::services::ServeFile::new(frontend.join("index.html")),
        ))
        .layer(DefaultBodyLimit::max(26 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(app.clone(), security::guard))
        .with_state(app)
}
async fn health() -> Json<Value> {
    Json(json!({"status":"ok","product":"Agentic Enterprise","version":env!("CARGO_PKG_VERSION")}))
}
async fn codex_catalog(Query(query): Query<FileQuery>) -> ApiResult<codex_settings::CodexSettings> {
    if let Some(host) = query.ssh_host.filter(|s| !s.is_empty()) {
        return Ok(Json(
            tokio::task::spawn_blocking(move || crate::remote::settings(&host))
                .await
                .map_err(anyhow::Error::from)??,
        ));
    }
    Ok(Json(codex_settings::read()?))
}
#[derive(Deserialize)]
struct HarnessQuery {
    runtime_id: Option<String>,
    #[serde(default)]
    harness: Harness,
    ssh_host: Option<String>,
    agent_id: Option<String>,
}
async fn harness_catalog(
    State(app): State<App>,
    Query(query): Query<HarnessQuery>,
) -> ApiResult<codex_settings::CodexSettings> {
    Ok(Json(
        tokio::task::spawn_blocking(move || -> Result<_> {
            if let Some(id) = query.runtime_id.filter(|id| !id.is_empty()) {
                return crate::fleet::settings(&app, &id, query.harness);
            }
            let workspace = if let Some(id) = query.agent_id {
                let agent: Agent = app.store.get("agents", &id)?;
                if agent.project_id.is_none()
                    && agent.workdir.is_none()
                    && let Some(id) = &agent.runtime_id
                {
                    return crate::fleet::settings(&app, id, query.harness);
                }
                app.store
                    .read(|conn| crate::projects::workspace(conn, &agent))?
            } else {
                query
                    .ssh_host
                    .filter(|h| !h.is_empty())
                    .map(|ssh_host| Workspace {
                        runtime_id: None,
                        ssh_host: Some(ssh_host),
                        path: String::new(),
                        canonical_path: String::new(),
                        git_root: None,
                    })
            };
            crate::opencode::settings_for(&app, query.harness, workspace.as_ref())
        })
        .await
        .map_err(anyhow::Error::from)??,
    ))
}
async fn get_run(State(app): State<App>, Path(id): Path<String>) -> ApiResult<Run> {
    Ok(Json(app.store.get("runs", &id)?))
}
async fn agent_organization_context(
    State(app): State<App>,
    Path(id): Path<String>,
) -> ApiResult<coordination::OrganizationContext> {
    Ok(Json(coordination::organization_context(&app, &id)?))
}

pub(crate) fn validate_reporting_line(
    connection: &rusqlite::Connection,
    agent: &Agent,
) -> Result<()> {
    let mut seen = std::collections::HashSet::from([agent.id.clone()]);
    let mut parent = agent.reports_to.clone();
    while let Some(id) = parent {
        ensure!(
            seen.insert(id.clone()),
            "Reporting relationships cannot form a cycle"
        );
        let manager: Agent = store::get(connection, "agents", &id)
            .context("The selected manager no longer exists")?;
        ensure!(
            manager.deleted_at.is_none(),
            "The selected manager has been deleted"
        );
        parent = manager.reports_to;
    }
    Ok(())
}
#[derive(Deserialize)]
struct Login {
    token: String,
}
async fn login(State(app): State<App>, Json(input): Json<Login>) -> Result<Response, ApiError> {
    if !bool::from(input.token.as_bytes().ct_eq(app.token.as_bytes())) {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "Invalid owner key".into(),
        ));
    }
    Ok((
        [(
            header::SET_COOKIE,
            format!(
                "ae_session={}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400",
                app.token
            ),
        )],
        Json(json!({"ok":true})),
    )
        .into_response())
}
async fn logout() -> Response {
    (
        [(
            header::SET_COOKIE,
            "ae_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        )],
        Json(json!({"ok":true})),
    )
        .into_response()
}
async fn state(State(app): State<App>) -> ApiResult<StateView> {
    let cursor = app
        .store
        .read(|c| Ok(c.query_row("SELECT COALESCE(MAX(seq),0) FROM events", [], |r| r.get(0))?))?;
    let mut runs = app.store.list::<Run>("runs")?;
    runs.reverse();
    runs.truncate(100);
    let mut view = StateView {
        workstations: crate::workstations::list(&app.store)?,
        questions: crate::questions::recent(&app)?,
        actions: app
            .store
            .list::<ActionItem>("action_items")?
            .into_iter()
            .filter(|a| a.status != "deleted")
            .collect(),
        project_connections: app
            .store
            .list::<Group>("groups")?
            .into_iter()
            .filter_map(|g| {
                g.project
                    .and_then(|p| crate::remote::connection(&p.workdir))
                    .map(|c| (g.id, c))
            })
            .collect(),
        project_layouts: app.store.read(|conn| {
            let values = conn
                .prepare("SELECT key,value FROM metadata WHERE key LIKE 'project_layout:%'")?
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            values
                .into_iter()
                .map(|(key, value)| {
                    Ok((
                        key.trim_start_matches("project_layout:").to_owned(),
                        serde_json::from_str(&value)?,
                    ))
                })
                .collect::<Result<_>>()
        })?,
        connections: crate::remote::connections(&app)?,
        agents: app
            .store
            .list::<Agent>("agents")?
            .into_iter()
            .filter(|a| a.deleted_at.is_none())
            .collect(),
        deleted_agents: app
            .store
            .list::<Agent>("agents")?
            .into_iter()
            .filter(|a| a.deleted_at.is_some())
            .collect(),
        chat_lead_id: app
            .store
            .read(|conn| Ok(coordination::lead(conn)?.map(|a| a.id)))?,
        groups: app.store.list("groups")?,
        group_access: app.store.read(|conn| {
            store::list::<Group>(conn, "groups")?
                .into_iter()
                .map(|group| Ok((group.id.clone(), crate::group_scope::access(conn, &group)?)))
                .collect::<Result<_>>()
        })?,
        schedules: app.store.list("schedules")?,
        group_preferences: app.store.read(|conn| {
            Ok(conn
                .query_row(
                    "SELECT value FROM metadata WHERE key='group_preferences'",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .optional()?
                .map(|v| serde_json::from_str(&v))
                .transpose()?
                .unwrap_or_default())
        })?,
        runs,
        artifacts: app
            .store
            .list::<Artifact>("artifacts")?
            .into_iter()
            .filter(|a| a.status != "deleted")
            .collect(),
        cursor,
        org_path: app.store.org.to_string_lossy().into_owned(),
        codex_path: app.codex.to_string_lossy().into_owned(),
        codex_version: app.codex_version.to_string(),
        panel_sizes: app.store.read(|conn| {
            Ok(conn
                .query_row(
                    "SELECT value FROM metadata WHERE key='panel_sizes'",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .optional()?
                .map(|v| serde_json::from_str(&v))
                .transpose()?
                .unwrap_or_default())
        })?,
        organization_layout: app.store.read(|conn| {
            let value: Option<String> = conn
                .query_row(
                    "SELECT value FROM metadata WHERE key='organization_layout'",
                    [],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(value
                .map(|s| serde_json::from_str(&s))
                .transpose()?
                .unwrap_or_default())
        })?,
    };
    view.groups.retain(|g| crate::platform::can_read(&app, g));
    let groups: std::collections::HashSet<_> = view.groups.iter().map(|g| g.id.clone()).collect();
    view.group_access.retain(|id, _| groups.contains(id));
    view.project_connections.retain(|id, _| groups.contains(id));
    view.project_layouts.retain(|id, _| groups.contains(id));
    view.runs.retain(|r| groups.contains(&r.group_id));
    view.schedules.retain(|r| groups.contains(&r.group_id));
    view.actions.retain(|r| groups.contains(&r.group_id));
    view.questions.retain(|r| groups.contains(&r.group_id));
    view.artifacts.retain(|r| groups.contains(&r.group_id));
    view.group_preferences
        .pinned
        .retain(|id| groups.contains(id));
    view.group_preferences
        .order
        .retain(|id| groups.contains(id));
    for section in &mut view.group_preferences.sections {
        section.groups.retain(|id| groups.contains(id));
    }
    if app.identity.as_ref().is_some_and(|i| i.role != "owner") {
        view.workstations.clear();
        view.deleted_agents.clear();
        view.connections.clear();
        view.org_path.clear();
        view.codex_path.clear();
        view.agents
            .retain(|a| a.project_id.as_ref().is_none_or(|id| groups.contains(id)));
    }
    Ok(Json(view))
}
#[derive(Deserialize)]
struct LayoutQuery {
    group_id: Option<String>,
}
async fn save_organization_layout(
    State(app): State<App>,
    Query(query): Query<LayoutQuery>,
    Json(layout): Json<BTreeMap<String, ChartCard>>,
) -> ApiResult<BTreeMap<String, ChartCard>> {
    app.store.write(|conn| {
        let key = if let Some(id) = &query.group_id {
            let group: Group = store::get(conn, "groups", id)?;
            group.ensure_active()?;
            ensure!(group.project.is_some(), "Project required for project layout");
            format!("project_layout:{id}")
        } else { "organization_layout".into() };
        for (id, card) in &layout {
            if id != "owner" {
                let agent_id = id.strip_prefix("agent:").context("Invalid chart card ID")?;
                let _: Agent = store::get(conn, "agents", agent_id)?;
            }
            ensure!(card.x.is_finite() && card.y.is_finite()
                && card.x.abs() <= 100_000.0 && card.y.abs() <= 100_000.0,
                "Card position must be within the canvas limits");
            ensure!((248.0..=1200.0).contains(&card.width)
                && (176.0..=1000.0).contains(&card.height),
                "Card size must be 248–1200 px wide and 176–1000 px tall");
        }
        conn.execute(
            "INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [key, serde_json::to_string(&layout)?],
        )?;
        store::event(conn, "organization.layout_saved", &json!({"cards":layout.len()}))?;
        Ok(())
    })?;
    Ok(Json(layout))
}
fn validate_agent(app: &App, agent: &mut Agent) -> Result<()> {
    security::validate_id(&agent.id)?;
    agent.position = agent.position.trim().to_owned();
    ensure!(
        agent.position.chars().count() <= 120 && !agent.position.chars().any(char::is_control),
        "Position must be at most 120 characters without line breaks or control characters"
    );
    ensure!(
        !agent.name.trim().is_empty() && agent.name.len() <= 80,
        "Agent name must contain 1–80 characters"
    );
    ensure!(
        agent.instructions.len() + agent.agents_md.len() <= 128 * 1024,
        "Instructions exceed 128 KiB"
    );
    ensure!(
        ["read-only", "workspace-write", "danger-full-access"].contains(&agent.permission.as_str()),
        "Unsupported access mode"
    );
    let effective_workspace = app
        .store
        .read(|conn| crate::projects::workspace(conn, agent))?;
    if agent.project_id.is_some() {
        agent.runtime_id = effective_workspace
            .as_ref()
            .and_then(|workspace| workspace.runtime_id.clone());
    } else if let Some(workspace) = &agent.workdir {
        ensure!(
            agent
                .runtime_id
                .as_ref()
                .is_none_or(|id| workspace.runtime_id.as_ref() == Some(id)),
            "Workdir belongs to a different runtime; attach a folder on the selected runtime"
        );
        agent.runtime_id = workspace.runtime_id.clone();
    }
    if let Some(id) = &agent.runtime_id {
        security::validate_id(id)?;
        ensure!(
            crate::fleet::list(app)?
                .iter()
                .any(|runtime| runtime["id"] == *id && runtime["revoked"] == false),
            "Runtime not available in this workspace"
        );
    }
    if effective_workspace.is_some() {
        crate::opencode::settings_for(app, agent.harness, effective_workspace.as_ref())?
            .resolve(&agent.model, &agent.reasoning)?;
    }
    ensure!(
        (10..=14400).contains(&agent.timeout_seconds),
        "Timeout must be 10–14400 seconds"
    );
    if let Some(w) = &agent.workdir {
        ensure!(
            (app.workspace_id == "default"
                && app.identity.as_ref().is_none_or(|i| i.user == "owner"))
                || w.runtime_id.is_some(),
            "Register a runtime for this workspace; controller filesystem access requires the bootstrap owner"
        );
        let validated = if w.runtime_id.is_some() {
            crate::fleet::validate(app, w)?
        } else {
            match &w.ssh_host {
                Some(host) => crate::remote::validate_workspace(host, &w.path)?,
                None => security::validate_workspace(&w.path)?,
            }
        };
        ensure!(
            validated.runtime_id.is_some()
                || validated.ssh_host.is_some()
                || !std::path::Path::new(&validated.canonical_path)
                    .starts_with(app.store.org.join(".state")),
            "Runtime state cannot be attached as a codebase"
        );
        agent.workdir = Some(validated);
    }
    Ok(())
}
async fn save_agent(State(app): State<App>, Json(mut agent): Json<Agent>) -> ApiResult<Agent> {
    if agent.id.is_empty() {
        agent.id = id();
    }
    let validation_app = app.clone();
    agent = tokio::task::spawn_blocking(move || -> Result<Agent> {
        validate_agent(&validation_app, &mut agent)?;
        Ok(agent)
    })
    .await
    .map_err(anyhow::Error::from)??;
    ensure!(agent.deleted_at.is_none(), "New agents cannot be deleted");
    agent.revision = 1;
    app.store.write(|tx| {
        crate::projects::attach_agent(tx, &mut agent)?;
        validate_reporting_line(tx, &agent)?;
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM agents WHERE id=?)",
            [&agent.id],
            |r| r.get(0),
        )?;
        ensure!(!exists, "Agent already exists");
        store::put(tx, "agents", &agent.id, &agent)?;
        tx.execute(
            "INSERT INTO revisions VALUES(?,?,?)",
            params![
                agent.id,
                i64::try_from(agent.revision)?,
                serde_json::to_string(&agent)?
            ],
        )?;
        store::event(tx, "agent.created", &json!({"agent_id":agent.id}))?;
        Ok(())
    })?;
    app.store.materialize(&agent)?;
    Ok(Json(agent))
}
async fn update_agent(
    State(app): State<App>,
    Path(id): Path<String>,
    Json(mut agent): Json<Agent>,
) -> ApiResult<Agent> {
    ensure!(agent.id == id, "Agent ID mismatch");
    let validation_app = app.clone();
    agent = tokio::task::spawn_blocking(move || -> Result<Agent> {
        validate_agent(&validation_app, &mut agent)?;
        Ok(agent)
    })
    .await
    .map_err(anyhow::Error::from)??;
    app.store.write(|tx| {
        crate::projects::attach_agent(tx, &mut agent)?;
        validate_reporting_line(tx, &agent)?;
        let current: Agent = store::get(tx, "agents", &id)?;
        ensure!(
            current.project_id == agent.project_id,
            "Project ownership cannot be changed after creation"
        );
        ensure!(
            !crate::terminal::busy(tx, &id, "")?,
            "Stop this agent's terminal command before changing its profile"
        );
        ensure!(
            current.deleted_at.is_none() && agent.deleted_at.is_none(),
            "Restore this agent before editing it"
        );
        ensure!(
            current.revision == agent.revision,
            "Profile changed since it was opened; reload before saving"
        );
        if agent.workdir.is_none() || !agent.enabled {
            let runs = store::list::<Run>(tx, "runs")?;
            ensure!(
                !runs
                    .iter()
                    .any(|r| r.agent_id == id && coordination::active(r)),
                "Cancel pending runs before detaching or disabling this agent"
            );
        }
        agent.revision += 1;
        store::put(tx, "agents", &id, &agent)?;
        tx.execute(
            "INSERT INTO revisions VALUES(?,?,?)",
            params![
                id,
                i64::try_from(agent.revision)?,
                serde_json::to_string(&agent)?
            ],
        )?;
        store::event(
            tx,
            "agent.updated",
            &json!({"agent_id":id,"revision":agent.revision}),
        )?;
        Ok(())
    })?;
    app.store.materialize(&agent)?;
    Ok(Json(agent))
}

pub(crate) fn record_profile(conn: &rusqlite::Connection, agent: &mut Agent) -> Result<()> {
    agent.revision += 1;
    store::put(conn, "agents", &agent.id, agent)?;
    conn.execute(
        "INSERT INTO revisions VALUES(?,?,?)",
        params![
            agent.id,
            i64::try_from(agent.revision)?,
            serde_json::to_string(agent)?
        ],
    )?;
    Ok(())
}
async fn delete_agent(State(app): State<App>, Path(id): Path<String>) -> ApiResult<Value> {
    let changed = app.store.write(|conn| {
        let mut agent: Agent = store::get(conn, "agents", &id)?;
        ensure!(agent.deleted_at.is_none(), "Agent is already deleted");
        ensure!(
            !crate::terminal::busy(conn, &id, "")?,
            "Stop this agent's terminal command before deleting it"
        );
        ensure!(
            !store::list::<Run>(conn, "runs")?
                .iter()
                .any(|r| r.agent_id == id && coordination::active(r)),
            "Stop this agent's active work before deleting it"
        );
        let mut changed = Vec::new();
        for mut child in store::list::<Agent>(conn, "agents")?
            .into_iter()
            .filter(|a| a.deleted_at.is_none() && a.reports_to.as_deref() == Some(&id))
        {
            child.reports_to = agent.reports_to.clone();
            record_profile(conn, &mut child)?;
            changed.push(child);
        }
        for mut group in store::list::<Group>(conn, "groups")? {
            if let Some(project) = &mut group.project {
                if project.members.iter().any(|m| m.agent_id == id) {
                    ensure!(
                        !store::list::<Run>(conn, "runs")?
                            .iter()
                            .any(|r| r.group_id == group.id && coordination::active(r)),
                        "Wait for active project work before removing a team member"
                    );
                    project.members.retain(|m| m.agent_id != id);
                    for member in &mut project.members {
                        if member.manager_id.as_deref() == Some(&id) {
                            member.manager_id = None;
                        }
                    }
                    if group.chat_lead_id.as_deref() == Some(&id) {
                        group.chat_lead_id = None;
                    }
                    store::put(conn, "groups", &group.id, &group)?;
                    crate::projects::sync_reporting(conn, &group)?;
                }
            }
        }
        agent.deleted_at = Some(now());
        agent.enabled = false;
        record_profile(conn, &mut agent)?;
        changed.push(agent);
        conn.execute("UPDATE sessions SET active=0 WHERE agent_id=?", [&id])?;
        conn.execute(
            "DELETE FROM metadata WHERE key='chat_lead_id' AND value=?",
            [&id],
        )?;
        // Retain profiles, scripts, environment and historical runs for reversible deletion.
        store::event(conn, "agent.deleted", &json!({"agent_id":id}))?;
        Ok(changed)
    })?;
    for agent in changed {
        app.store.materialize(&agent)?;
    }
    Ok(Json(json!({"deleted":true})))
}
async fn restore_agent(State(app): State<App>, Path(id): Path<String>) -> ApiResult<Agent> {
    let agent = app.store.write(|conn| {
        let mut agent: Agent = store::get(conn, "agents", &id)?;
        ensure!(agent.deleted_at.is_some(), "Agent is not deleted");
        agent.deleted_at = None;
        agent.enabled = false;
        if let Some(parent) = &agent.reports_to {
            let parent: Agent = store::get(conn, "agents", parent)?;
            if parent.deleted_at.is_some() {
                agent.reports_to = None;
            }
        }
        crate::projects::attach_agent(conn, &mut agent)?;
        validate_reporting_line(conn, &agent)?;
        record_profile(conn, &mut agent)?;
        store::event(conn, "agent.restored", &json!({"agent_id":id}))?;
        Ok(agent)
    })?;
    app.store.materialize(&agent)?;
    Ok(Json(agent))
}
async fn revisions(State(app): State<App>, Path(id): Path<String>) -> ApiResult<Vec<Agent>> {
    Ok(Json(app.store.read(|c| {
        let mut q =
            c.prepare("SELECT data FROM revisions WHERE agent_id=? ORDER BY revision DESC")?;
        q.query_map([id], |r| r.get::<_, String>(0))?
            .map(|r| Ok(serde_json::from_str(&r?)?))
            .collect()
    })?))
}
async fn probe(State(app): State<App>, Path(id): Path<String>) -> ApiResult<Value> {
    let _: Agent = app.store.get("agents", &id)?;
    let result = tokio::task::spawn_blocking(move || runtime::login_status(&app, &id))
        .await
        .map_err(anyhow::Error::from)??;
    Ok(Json(result))
}
#[derive(Deserialize)]
struct WorkspaceInput {
    path: String,
    #[serde(default)]
    ssh_host: Option<String>,
    #[serde(default)]
    runtime_id: Option<String>,
}
async fn workspace_probe(
    State(app): State<App>,
    Json(input): Json<WorkspaceInput>,
) -> ApiResult<Value> {
    if input.runtime_id.is_some() {
        let workspace = tokio::task::spawn_blocking(move || {
            crate::fleet::validate(
                &app,
                &Workspace {
                    runtime_id: input.runtime_id,
                    ssh_host: None,
                    path: input.path,
                    canonical_path: String::new(),
                    git_root: None,
                },
            )
        })
        .await
        .map_err(anyhow::Error::from)??;
        return Ok(Json(
            json!({"workspace":workspace,"git_status":"Workdir verified by the registered runtime"}),
        ));
    }
    ensure!(
        (app.workspace_id == "default" && app.identity.as_ref().is_none_or(|i| i.user == "owner")),
        "Select a registered runtime"
    );
    if let Some(host) = input.ssh_host.filter(|s| !s.is_empty()) {
        return Ok(Json(tokio::task::spawn_blocking(move || -> Result<Value> {
            let workspace = crate::remote::validate_workspace(&host, &input.path)?;
            let connection = crate::remote::probe(&workspace);
            Ok(json!({"workspace":workspace,"connection":connection,"git_status":format!("{} · {} · {}", host, connection.status, connection.message)}))
        }).await.map_err(anyhow::Error::from)??));
    }
    let result=tokio::task::spawn_blocking(move||->Result<Value>{let workspace=security::validate_workspace(&input.path)?;let output=std::process::Command::new("git").args(["-C",&input.path,"status","--short","--branch"]).output()?;Ok(json!({"workspace":workspace,"git_status":if output.status.success(){String::from_utf8_lossy(&output.stdout).into_owned()}else{"Not a Git repository".into()}}))}).await.map_err(anyhow::Error::from)??;
    Ok(Json(result))
}
async fn workspace_directories(
    State(app): State<App>,
    Query(query): Query<FileQuery>,
) -> ApiResult<crate::workspaces::DirectoryView> {
    if let Some(host) = query.ssh_host.filter(|s| !s.is_empty()) {
        return Ok(Json(
            tokio::task::spawn_blocking(move || -> Result<crate::workspaces::DirectoryView> {
                Ok(serde_json::from_value(crate::remote::call(
                    &host,
                    json!({"op":"directories","path":query.path}),
                )?)?)
            })
            .await
            .map_err(anyhow::Error::from)??,
        ));
    }
    Ok(Json(
        tokio::task::spawn_blocking(move || crate::workspaces::browse(&app, &query.path))
            .await
            .map_err(anyhow::Error::from)??,
    ))
}
async fn save_panel_sizes(
    State(app): State<App>,
    Json(sizes): Json<BTreeMap<String, f64>>,
) -> ApiResult<Value> {
    for (name, size) in &sizes {
        let (min, max) = match name.as_str() {
            "sidebar" => (180.0, 420.0),
            "inspector" => (300.0, 900.0),
            _ => bail!("Unknown navigation panel"),
        };
        ensure!(
            size.is_finite() && *size >= min && *size <= max,
            "Navigation width is outside its supported range"
        );
    }
    app.store.write(|conn| {
        let mut saved: BTreeMap<String, f64> = conn.query_row("SELECT value FROM metadata WHERE key='panel_sizes'", [], |r| r.get::<_,String>(0)).optional()?.map(|v| serde_json::from_str(&v)).transpose()?.unwrap_or_default();
        saved.extend(sizes);
        conn.execute("INSERT INTO metadata(key,value) VALUES('panel_sizes',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [serde_json::to_string(&saved)?])?;
        store::event(conn,"preferences.panels_saved",&json!({}))?;
        Ok(())
    })?;
    Ok(Json(json!({"saved":true})))
}
#[derive(Deserialize)]
struct FileQuery {
    #[serde(default)]
    ssh_host: Option<String>,
    #[serde(default)]
    path: String,
    #[serde(default)]
    scope: String,
}
fn file_base(app: &App, agent: &Agent, scope: &str) -> Result<PathBuf> {
    if scope == "scripts" {
        let base = app.store.org.join(&agent.id).join("scripts");
        std::fs::create_dir_all(&base)?;
        Ok(base)
    } else {
        let workspace = agent.workdir.as_ref().context("Attach a workdir first")?;
        security::revalidate(workspace)?;
        Ok(PathBuf::from(&workspace.path))
    }
}
pub(crate) fn contained(base: &std::path::Path, relative: &str) -> Result<PathBuf> {
    let path = std::path::Path::new(relative);
    ensure!(
        !path.is_absolute()
            && !path.components().any(|c| matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::Prefix(_)
            )),
        "Path escapes workspace"
    );
    visible_file_path(path)?;
    let result = base.join(path).canonicalize()?;
    let base = base.canonicalize()?;
    ensure!(
        result.starts_with(&base),
        "Symlink or junction escapes workspace"
    );
    visible_file_path(result.strip_prefix(&base)?)?;
    Ok(result)
}
pub(crate) fn visible_file_path(path: &std::path::Path) -> Result<()> {
    ensure!(
        !path.components().any(|c| {
            let name = c.as_os_str().to_string_lossy().to_lowercase();
            name.starts_with(".env")
                || name == ".git"
                || name == ".state"
                || (matches!(c, std::path::Component::Normal(_)) && name.contains(':'))
        }),
        "Sensitive/internal files are not exposed by this viewer"
    );
    Ok(())
}
async fn files(
    State(app): State<App>,
    Path(id): Path<String>,
    Query(query): Query<FileQuery>,
) -> ApiResult<Value> {
    let mut agent: Agent = app.store.get("agents", &id)?;
    agent.workdir = app
        .store
        .read(|conn| crate::projects::workspace(conn, &agent))?;
    if query.scope != "scripts" {
        if let Some(workspace) = agent
            .workdir
            .as_ref()
            .filter(|w| w.ssh_host.is_some())
            .cloned()
        {
            return Ok(Json(
                tokio::task::spawn_blocking(move || -> Result<Value> {
                    let mut request = crate::remote::request(&workspace, "files");
                    request["reference"] = query.path.into();
                    crate::remote::call(
                        workspace
                            .ssh_host
                            .as_deref()
                            .context("Missing workstation")?,
                        request,
                    )
                })
                .await
                .map_err(anyhow::Error::from)??,
            ));
        }
    }
    let base = file_base(&app, &agent, &query.scope)?;
    let path = contained(&base, &query.path)?;
    if path.is_dir() {
        let mut entries = Vec::new();
        for entry in std::fs::read_dir(path)
            .map_err(anyhow::Error::from)?
            .take(300)
        {
            let entry = entry.map_err(anyhow::Error::from)?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if [".git", ".state", "node_modules", "target"].contains(&name.to_lowercase().as_str())
                || name.to_lowercase().starts_with(".env")
            {
                continue;
            }
            entries.push(json!({"name":name,"directory":entry.file_type().map_err(anyhow::Error::from)?.is_dir()}));
        }
        Ok(Json(json!({"entries":entries,"base":base})))
    } else {
        let bytes = std::fs::read(path).map_err(anyhow::Error::from)?;
        ensure!(
            bytes.len() <= 256 * 1024,
            "File exceeds 256 KiB preview limit"
        );
        let text = String::from_utf8(bytes).context("Binary file preview is not supported")?;
        Ok(Json(json!({"text":text,"base":base})))
    }
}
#[derive(Deserialize)]
struct ScriptInput {
    name: String,
    content: String,
}
async fn save_script(
    State(app): State<App>,
    Path(id): Path<String>,
    Json(input): Json<ScriptInput>,
) -> ApiResult<Value> {
    let agent: Agent = app.store.get("agents", &id)?;
    ensure!(
        !input.name.is_empty()
            && input.name.len() < 80
            && input
                .name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
            && !input.name.starts_with('.'),
        "Use a simple script filename"
    );
    ensure!(input.content.len() <= 256 * 1024, "Script exceeds 256 KiB");
    let base = file_base(&app, &agent, "scripts")?;
    let path = base.join(&input.name);
    if path.exists() {
        contained(&base, &input.name)?;
    }
    store::atomic_write(&path, input.content.as_bytes())?;
    app.store
        .event("script.saved", json!({"agent_id":id,"name":input.name}))?;
    Ok(Json(json!({"saved":true})))
}
async fn save_group_preferences(
    State(app): State<App>,
    Json(preferences): Json<GroupPreferences>,
) -> ApiResult<GroupPreferences> {
    app.store.write(|tx| {
        ensure!(preferences.sections.len() <= 100, "At most 100 sections are allowed");
        let mut section_ids = std::collections::HashSet::from(["pinned", "all"]);
        let mut section_names = std::collections::HashSet::from(["pinned".to_owned(), "all groups".to_owned()]);
        let mut assigned = std::collections::HashSet::new();
        for section in &preferences.sections {
            security::validate_id(&section.id)?;
            ensure!(section_ids.insert(section.id.as_str()), "Duplicate or reserved section ID");
            ensure!(!section.name.trim().is_empty() && section.name.len() <= 80, "Section name must contain 1–80 characters");
            ensure!(section_names.insert(section.name.trim().to_lowercase()), "Section names must be unique");
            ensure!(section.groups.len() <= 10000, "Too many groups in section");
            for id in &section.groups {
                ensure!(assigned.insert(id), "A group can belong to only one section");
                let _: Group = store::get(tx, "groups", id)?;
            }
        }
        let mut collapsed = std::collections::HashSet::new();
        ensure!(preferences.collapsed.len() <= 102, "Too many collapsed sections");
        for id in &preferences.collapsed {
            ensure!(section_ids.contains(id.as_str()) && collapsed.insert(id), "Unknown or duplicate collapsed section");
        }
        for ids in [&preferences.pinned, &preferences.order] {
            let mut seen = std::collections::HashSet::new();
            ensure!(ids.len() <= 10000, "Too many groups");
            for id in ids {
                ensure!(seen.insert(id), "Duplicate group in order");
                let _: Group = store::get(tx, "groups", id)?;
            }
        }
        tx.execute("INSERT INTO metadata(key,value) VALUES('group_preferences',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [serde_json::to_string(&preferences)?])?;
        store::event(tx, "groups.ordered", &json!({}))?;
        Ok(())
    })?;
    Ok(Json(preferences))
}
async fn save_group(State(app): State<App>, Json(mut group): Json<Group>) -> ApiResult<Group> {
    if let Some(project) = &group.project {
        ensure!(
            (app.workspace_id == "default"
                && app.identity.as_ref().is_none_or(|i| i.user == "owner"))
                || project.workdir.runtime_id.is_some(),
            "Projects require a registered runtime"
        );
    }
    if group.id.is_empty() {
        group.id = id();
    }
    security::validate_id(&group.id)?;
    ensure!(
        !group.name.trim().is_empty() && group.name.len() <= 80,
        "Group name must contain 1–80 characters"
    );
    let validation_app = app.clone();
    group = tokio::task::spawn_blocking(move || -> Result<Group> {
        crate::projects::validate_workdir(&mut group, &validation_app)?;
        Ok(group)
    })
    .await
    .map_err(anyhow::Error::from)??;
    app.store.write(|tx| {
        crate::group_scope::validate(tx, &mut group)?;
        let old: Option<String> = tx
            .query_row("SELECT data FROM groups WHERE id=?", [&group.id], |r| {
                r.get(0)
            })
            .optional()?;
        if let Some(old) = old {
            let old = serde_json::from_str::<Group>(&old)?;
            old.ensure_active()?;
            ensure!(old.project.is_some() == group.project.is_some(), "Create a separate project or group to change its type");
            if old.member_ids != group.member_ids || old.human_ids != group.human_ids || old.scope_levels != group.scope_levels || old.chat_lead_id != group.chat_lead_id || serde_json::to_value(&old.project)? != serde_json::to_value(&group.project)? {
                ensure!(!store::list::<Run>(tx, "runs")?.iter().any(|run| run.group_id == group.id && coordination::active(run)),
                    "Stop or wait for this group's active runs before changing its membership or structure");
                // Do not carry a formerly public chat session into a delegation-only role.
                tx.execute("UPDATE sessions SET active=0 WHERE group_id=?", [&group.id])?;
            }
        }
        // Status changes use the lifecycle routes, never stale profile form values.
        group.archived_at = None;
        group.deleted_at = None;
        store::put(tx, "groups", &group.id, &group)?;
        crate::projects::sync_reporting(tx, &group)?;
        store::event(tx, "group.saved", &json!({"group_id":group.id}))?;
        Ok(())
    })?;
    if let Some(project) = &group.project {
        for member in &project.members {
            let agent: Agent = app.store.get("agents", &member.agent_id)?;
            if agent.project_id.as_deref() == Some(&group.id) {
                app.store.materialize(&agent)?;
            }
        }
    }
    Ok(Json(group))
}
#[derive(Clone, Copy)]
enum GroupAction {
    Archive,
    Delete,
    Restore,
}

// Reuse the agent soft-delete pattern: retain records and serialize with dispatch.
fn change_group(tx: &rusqlite::Connection, id: &str, action: GroupAction) -> Result<Group> {
    let mut group: Group = store::get(tx, "groups", id)?;
    match action {
        GroupAction::Restore if group.archived_at.is_none() && group.deleted_at.is_none() => {
            return Ok(group);
        }
        GroupAction::Archive if group.archived_at.is_some() && group.deleted_at.is_none() => {
            return Ok(group);
        }
        GroupAction::Delete if group.deleted_at.is_some() => return Ok(group),
        _ => {}
    }
    if !matches!(action, GroupAction::Restore) {
        ensure!(
            !store::list::<Run>(tx, "runs")?
                .iter()
                .any(|r| r.group_id == id && coordination::active(r)),
            "Stop or wait for active runs in this group before archiving or deleting it"
        );
        ensure!(
            !store::list::<Artifact>(tx, "artifacts")?
                .iter()
                .any(|a| a.group_id == id && a.status == "indexing"),
            "Wait for this group's knowledge indexing to finish before archiving or deleting it"
        );
    }
    let event = match action {
        GroupAction::Archive => {
            ensure!(
                group.deleted_at.is_none(),
                "Restore this deleted group before archiving it"
            );
            group.archived_at = Some(now());
            "group.archived"
        }
        GroupAction::Delete => {
            group.deleted_at = Some(now());
            "group.deleted"
        }
        GroupAction::Restore => {
            group.archived_at = None;
            group.deleted_at = None;
            "group.restored"
        }
    };
    for mut item in store::list::<ActionItem>(tx, "action_items")?
        .into_iter()
        .filter(|a| a.group_id == id && a.status == "scheduled")
    {
        item.status = "backlog".into();
        item.planned_start = None;
        item.updated_at = now();
        item.revision += 1;
        item.error =
            Some("Group lifecycle changed. Review this action before scheduling again.".into());
        store::put(tx, "action_items", &item.id, &item)?;
    }
    // Restore deliberately does not re-enable schedules or replay old work.
    for mut schedule in store::list::<Schedule>(tx, "schedules")?
        .into_iter()
        .filter(|s| s.group_id == id && s.enabled)
    {
        schedule.enabled = false;
        store::put(tx, "schedules", &schedule.id, &schedule)?;
    }
    store::put(tx, "groups", id, &group)?;
    store::event(tx, event, &json!({"group_id":id}))?;
    Ok(group)
}
async fn archive_group(State(app): State<App>, Path(id): Path<String>) -> ApiResult<Group> {
    Ok(Json(
        app.store
            .write(|tx| change_group(tx, &id, GroupAction::Archive))?,
    ))
}
async fn delete_group(State(app): State<App>, Path(id): Path<String>) -> ApiResult<Group> {
    Ok(Json(
        app.store
            .write(|tx| change_group(tx, &id, GroupAction::Delete))?,
    ))
}
async fn restore_group(State(app): State<App>, Path(id): Path<String>) -> ApiResult<Group> {
    Ok(Json(
        app.store
            .write(|tx| change_group(tx, &id, GroupAction::Restore))?,
    ))
}

#[derive(Deserialize)]
struct Page {
    id: Option<String>,
    side_chat_id: Option<String>,
    #[serde(default)]
    main: bool,
    before: Option<String>,
    #[serde(default = "page_size")]
    limit: usize,
}
fn page_size() -> usize {
    50
}
pub(crate) fn validate_side_chat(
    conn: &rusqlite::Connection,
    group_id: &str,
    side: Option<&str>,
) -> Result<()> {
    if let Some(id) = side {
        security::validate_id(id)?;
        let root: Message = store::get(conn, "messages", id).context("Side chat not found")?;
        ensure!(
            root.group_id == group_id
                && root.side_chat_id.as_deref() == Some(id)
                && root.command.as_deref() == Some("btw"),
            "Side chat must belong to this group"
        );
    }
    Ok(())
}
async fn messages(
    State(app): State<App>,
    Path(id): Path<String>,
    Query(page): Query<Page>,
) -> ApiResult<Vec<Message>> {
    let _: Group = app.store.get("groups", &id)?;
    let result = app.store.read(|conn| {
        validate_side_chat(conn, &id, page.side_chat_id.as_deref())?;
        let mut query = conn.prepare("SELECT data FROM messages WHERE json_extract(data,'$.group_id')=?1 AND rowid<COALESCE((SELECT rowid FROM messages WHERE id=?2),9223372036854775807) AND (?3 IS NULL OR json_extract(data,'$.side_chat_id')=?3 OR (json_extract(data,'$.side_chat_id') IS NULL AND json_extract(data,'$.command')='reset' AND json_extract(data,'$.sender')='system')) AND (?4=0 OR json_extract(data,'$.side_chat_id') IS NULL OR json_extract(data,'$.side_chat_id')=id) AND (?6 IS NULL OR id=?6) ORDER BY rowid DESC LIMIT ?5")?;
        let mut values = query.query_map(params![id,page.before,page.side_chat_id,page.main,page.limit.clamp(1,200) as i64,page.id], |row| row.get::<_,String>(0))?
            .map(|value| Ok(serde_json::from_str(&value?)?)).collect::<Result<Vec<Message>>>()?;
        values.reverse();
        Ok(values)
    })?;
    Ok(Json(result))
}
#[derive(Deserialize)]
pub(crate) struct SendInput {
    pub id: String,
    pub group_id: String,
    #[serde(default)]
    pub side_chat_id: Option<String>,
    pub body: String,
    #[serde(default)]
    pub recipients: Vec<String>,
    pub reply_to: Option<String>,
    #[serde(default)]
    pub artifacts: Vec<String>,
}
async fn send_message(State(app): State<App>, Json(input): Json<SendInput>) -> ApiResult<Message> {
    if crate::chat_commands::parse(&input.body)?.is_some_and(|command| command != "btw") {
        return Ok(Json(crate::chat_commands::send(&app, input).await?));
    }
    let message = app.store.write(|tx| {
        if let Some(identity) = &app.identity {
            let old: Option<String> = tx
                .query_row(
                    "SELECT json_extract(data,'$.sender') FROM messages WHERE id=?",
                    [&input.id],
                    |r| r.get(0),
                )
                .optional()?;
            ensure!(
                old.as_ref().is_none_or(|sender| sender == &identity.user),
                "Message ID belongs to another sender"
            );
        }
        let mut message = submit_message(tx, input, None)?;
        if let Some(identity) = &app.identity {
            message.sender = identity.user.clone();
            store::put(tx, "messages", &message.id, &message)?;
        }
        Ok(message)
    })?;
    app.wake.notify_one();
    Ok(Json(message))
}

pub(crate) fn validate_message_input(input: &mut SendInput) -> Result<()> {
    security::validate_id(&input.id)?;
    if let Some(side) = &input.side_chat_id {
        security::validate_id(side)?;
    }
    ensure!(
        !input.body.trim().is_empty() && input.body.len() <= 64000,
        "Message must contain 1–64000 bytes"
    );
    input.recipients.sort();
    input.recipients.dedup();
    ensure!(
        input.recipients.len() <= 8,
        "Maximum eight recipients per message"
    );
    Ok(())
}
pub(crate) fn existing_message(
    tx: &rusqlite::Connection,
    input: &SendInput,
    schedule_id: Option<&str>,
) -> Result<Option<Message>> {
    if let Some(data) = tx
        .query_row("SELECT data FROM messages WHERE id=?", [&input.id], |r| {
            r.get::<_, String>(0)
        })
        .optional()?
    {
        let old: Message = serde_json::from_str(&data)?;
        ensure!(
            old.group_id == input.group_id
                && old.side_chat_id == input.side_chat_id
                && old.body == input.body
                && old.schedule_id.as_deref() == schedule_id
                && ((old.auto_routed && input.recipients.is_empty())
                    || (!old.auto_routed && old.recipients == input.recipients))
                && old.artifacts == input.artifacts
                && old.reply_to == input.reply_to,
            "Idempotency key already used for different content"
        );
        return Ok(Some(old));
    }
    Ok(None)
}

pub(crate) fn submit_message(
    tx: &rusqlite::Connection,
    mut input: SendInput,
    schedule_id: Option<String>,
) -> Result<Message> {
    if input.recipients.is_empty() {
        let group: Group = store::get(tx, "groups", &input.group_id)?;
        input.recipients = crate::group_scope::mentions(tx, &group, &input.body)?;
    }
    ensure!(
        schedule_id.is_none() || !input.recipients.is_empty(),
        "Scheduled work must mention an invited agent explicitly"
    );
    validate_message_input(&mut input)?;
    let starts_side =
        schedule_id.is_none() && crate::chat_commands::parse(&input.body)? == Some("btw");
    if starts_side {
        ensure!(
            input.side_chat_id.is_none(),
            "Return to the main chat to start another side chat"
        );
        input.side_chat_id = Some(input.id.clone());
    } else {
        validate_side_chat(tx, &input.group_id, input.side_chat_id.as_deref())?;
    }
    let empty_side = starts_side && input.body.trim() == "/btw";
    ensure!(
        !empty_side
            || (input.recipients.is_empty()
                && input.artifacts.is_empty()
                && input.reply_to.is_none()),
        "Add a question after /btw to include recipients, attachments or a reply"
    );
    if let Some(reply) = &input.reply_to {
        let quoted: Message = store::get(tx, "messages", reply)?;
        ensure!(
            quoted.group_id == input.group_id,
            "Reply must belong to this group"
        );
        ensure!(
            quoted.side_chat_id == input.side_chat_id
                || (starts_side && quoted.side_chat_id.is_none()),
            "Reply must belong to this conversation"
        );
        if input.recipients.is_empty()
            && tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM agents WHERE id=?)",
                [&quoted.sender],
                |row| row.get::<_, bool>(0),
            )?
        {
            input.recipients.push(quoted.sender);
        }
    }
    if let Some(old) = existing_message(tx, &input, schedule_id.as_deref())? {
        return Ok(old);
    }
    crate::agent_tools::ensure_no_reset(tx, &input.group_id, input.side_chat_id.as_deref())?;
    let group: Group = store::get(tx, "groups", &input.group_id)?;
    group.ensure_active()?;
    for artifact in &input.artifacts {
        let a: Artifact = store::get(tx, "artifacts", artifact)?;
        ensure!(
            a.group_id == group.id && a.status != "deleted",
            "Attachment not available to this group"
        );
    }
    // A room message only invokes explicitly addressed agents.
    let auto_routed = false;
    let recipients = input.recipients.clone();
    let message = Message {
        id: input.id.clone(),
        group_id: group.id.clone(),
        side_chat_id: input.side_chat_id.clone(),
        sender: "owner".into(),
        body: input.body.clone(),
        recipients,
        reply_to: input.reply_to.clone(),
        artifacts: input.artifacts.clone(),
        run_id: None,
        created_at: now(),
        auto_routed,
        schedule_id,
        command: starts_side.then(|| "btw".into()),
        usage_report: None,
    };
    for recipient in &message.recipients {
        let agent: Agent = store::get(tx, "agents", recipient)?;
        coordination::enqueue(
            tx,
            &message,
            agent,
            if auto_routed {
                RunKind::Coordinator
            } else {
                RunKind::Direct
            },
            None,
            None,
        )?;
    }
    store::put(tx, "messages", &message.id, &message)?;
    store::event(
        tx,
        "message.created",
        &json!({"group_id":group.id,"message_id":message.id}),
    )?;
    Ok(message)
}
async fn cancel(State(app): State<App>, Path(id): Path<String>) -> ApiResult<Run> {
    Ok(Json(runtime::cancel(&app, &id)?))
}
async fn run_events(State(app): State<App>, Path(id): Path<String>) -> ApiResult<Vec<Event>> {
    let _: Run = app.store.get("runs", &id)?;
    Ok(Json(app.store.read(|c|{let mut q=c.prepare("SELECT seq,kind,payload,created_at FROM events WHERE json_extract(payload,'$.run_id')=? ORDER BY seq LIMIT 10000")?;q.query_map([id],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?)))?.map(|r|{let(seq,kind,payload,created_at)=r?;Ok(Event{seq,kind,payload:serde_json::from_str(&payload)?,created_at})}).collect()})?))
}
async fn sessions(State(app): State<App>) -> ApiResult<Vec<Value>> {
    Ok(Json(app.store.read(|c|{let mut q=c.prepare("SELECT id,group_id,agent_id,workspace,native_id,active,side_chat_id,harness FROM sessions ORDER BY rowid DESC")?;Ok(q.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"group_id":r.get::<_,String>(1)?,"agent_id":r.get::<_,String>(2)?,"workspace":r.get::<_,String>(3)?,"native_id":r.get::<_,Option<String>>(4)?,"active":r.get::<_,bool>(5)?,"side_chat_id":r.get::<_,Option<String>>(6)?,"harness":r.get::<_,String>(7)?})))?.collect::<rusqlite::Result<Vec<_>>>()?)})?))
}
async fn reset_session(State(app): State<App>, Path(id): Path<String>) -> ApiResult<Value> {
    app.store.write(|tx| {
        ensure!(
            !store::list::<Run>(tx, "runs")?
                .iter()
                .any(|r| r.session_id == id && coordination::active(r)),
            "Cancel pending runs before resetting"
        );
        ensure!(
            tx.execute("UPDATE sessions SET active=0 WHERE id=?", [&id])? == 1,
            "Session not found"
        );
        store::event(tx, "session.reset", &json!({"session_id":id}))?;
        Ok(())
    })?;
    Ok(Json(json!({"reset":true})))
}
#[derive(Deserialize)]
struct EventQuery {
    #[serde(default)]
    after: i64,
}
async fn events(
    State(app): State<App>,
    Query(query): Query<EventQuery>,
    headers: axum::http::HeaderMap,
) -> Sse<impl futures::Stream<Item = Result<SseEvent, Infallible>>> {
    let after = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(query.after)
        .max(query.after);
    let events = stream::unfold(
        (app, after, Vec::<Event>::new()),
        |(app, mut cursor, mut pending)| async move {
            loop {
                if !pending.is_empty() {
                    let event = pending.remove(0);
                    cursor = event.seq;
                    let data = serde_json::to_string(&event).expect("event serialization");
                    return Some((
                        Ok(SseEvent::default().id(cursor.to_string()).data(data)),
                        (app, cursor, pending),
                    ));
                }
                match app.store.events(cursor, 100) {
                    Ok(values) => pending = values,
                    Err(e) => {
                        tracing::error!("Event replay: {e}");
                        return None;
                    }
                }
                if pending.is_empty() {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
            }
        },
    );
    Sse::new(events).keep_alive(KeepAlive::new().interval(Duration::from_secs(10)))
}
async fn upload(State(app): State<App>, mut multipart: Multipart) -> ApiResult<Artifact> {
    let mut group_id = String::new();
    let mut file = None;
    while let Some(field) = multipart.next_field().await.map_err(anyhow::Error::from)? {
        match field.name() {
            Some("group_id") => group_id = field.text().await.map_err(anyhow::Error::from)?,
            Some("file") => {
                let name = field.file_name().unwrap_or("attachment").to_string();
                let mime = field
                    .content_type()
                    .unwrap_or("application/octet-stream")
                    .to_string();
                let data = field.bytes().await.map_err(anyhow::Error::from)?;
                ensure!(data.len() <= 25 * 1024 * 1024, "Attachment exceeds 25 MiB");
                file = Some((name, mime, data));
            }
            _ => bail!("Unexpected upload field"),
        }
    }
    let _: Group = app.store.get("groups", &group_id)?;
    let (name, mime, data) = file.context("No file uploaded")?;
    let media_type = if name.ends_with(".md")
        || name.ends_with(".txt")
        || name.ends_with(".rs")
        || name.ends_with(".ts")
        || name.ends_with(".json")
    {
        "text/plain".to_owned()
    } else {
        mime
    };
    let artifact = Artifact {
        id: id(),
        group_id,
        name,
        media_type,
        size: data.len() as u64,
        sha256: format!("{:x}", Sha256::digest(&data)),
        status: "stored".into(),
        error: None,
        created_at: now(),
    };
    app.store.write(|tx| {
        store::get::<Group>(tx, "groups", &artifact.group_id)?.ensure_active()?;
        store::atomic_write(
            &security::artifact_path(&app.store.org, &artifact.id)?,
            &data,
        )?;
        store::put(tx, "artifacts", &artifact.id, &artifact)?;
        store::event(tx, "artifact.uploaded", &json!({"id":artifact.id}))?;
        Ok(())
    })?;
    Ok(Json(artifact))
}
async fn download(State(app): State<App>, Path(id): Path<String>) -> Result<Response, ApiError> {
    let artifact: Artifact = app.store.get("artifacts", &id)?;
    ensure!(artifact.status != "deleted", "Artifact deleted");
    let bytes = tokio::fs::read(security::artifact_path(&app.store.org, &id)?)
        .await
        .map_err(anyhow::Error::from)?;
    let inline =
        artifact.media_type.starts_with("image/") && artifact.media_type != "image/svg+xml";
    Ok((
        [
            (
                header::CONTENT_TYPE,
                if inline {
                    artifact.media_type
                } else {
                    "application/octet-stream".into()
                },
            ),
            (
                header::CONTENT_DISPOSITION,
                if inline {
                    "inline".into()
                } else {
                    "attachment".into()
                },
            ),
        ],
        bytes,
    )
        .into_response())
}
async fn index_artifact(State(app): State<App>, Path(id): Path<String>) -> ApiResult<Artifact> {
    let mut artifact = app.store.write(|tx| {
        let mut artifact: Artifact = store::get(tx, "artifacts", &id)?;
        store::get::<Group>(tx, "groups", &artifact.group_id)?.ensure_active()?;
        ensure!(
            ["stored", "failed", "indexed"].contains(&artifact.status.as_str()),
            "Artifact cannot be indexed in this state"
        );
        ensure!(
            artifact.media_type.starts_with("text/") || artifact.media_type.starts_with("image/"),
            "Semantic indexing supports text and images"
        );
        artifact.status = "indexing".into();
        artifact.error = None;
        store::put(tx, "artifacts", &id, &artifact)?;
        Ok(artifact)
    })?;
    let pending = artifact.clone();
    tokio::spawn(async move {
        let path = match security::artifact_path(&app.store.org, &id) {
            Ok(p) => p,
            Err(e) => {
                tracing::error!("Artifact path: {e}");
                return;
            }
        };
        let result = app
            .knowledge
            .clone()
            .index(
                id.clone(),
                artifact.group_id.clone(),
                path,
                artifact.media_type.starts_with("image/"),
            )
            .await;
        if let Ok(current) = app.store.get::<Artifact>("artifacts", &id) {
            if current.status == "deleted" {
                if let Err(e) = app.knowledge.delete(&id).await {
                    tracing::error!("Delete stale index: {e}");
                }
                return;
            }
        }
        match result {
            Ok(()) => artifact.status = "indexed".into(),
            Err(e) => {
                artifact.status = "failed".into();
                artifact.error = Some(format!("{e:#}"));
            }
        }
        if let Err(e) = app.store.put("artifacts", &id, &artifact) {
            tracing::error!("Index status: {e}");
        }
        if let Err(e) = app.store.event("artifact.indexed", json!({"id":id})) {
            tracing::error!("Index event: {e}");
        }
    });
    Ok(Json(pending))
}
async fn delete_artifact(State(app): State<App>, Path(id): Path<String>) -> ApiResult<Value> {
    app.store.write(|tx| {
        let mut artifact: Artifact = store::get(tx, "artifacts", &id)?;
        store::get::<Group>(tx, "groups", &artifact.group_id)?.ensure_active()?;
        artifact.status = "deleted".into();
        store::put(tx, "artifacts", &id, &artifact)
    })?;
    if let Err(e) = app.knowledge.delete(&id).await {
        tracing::warn!("Deferred index cleanup for {id}: {e}");
    }
    let path = security::artifact_path(&app.store.org, &id)?;
    if path.exists() {
        std::fs::remove_file(path).map_err(anyhow::Error::from)?;
    }
    app.store.event("artifact.deleted", json!({"id":id}))?;
    Ok(Json(json!({"deleted":true})))
}
#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    group_id: String,
    #[serde(default)]
    semantic: bool,
    #[serde(default = "document_search")]
    media: String,
}
fn document_search() -> String {
    "documents".into()
}
async fn search(State(app): State<App>, Query(query): Query<SearchQuery>) -> ApiResult<Value> {
    let _: Group = app.store.get("groups", &query.group_id)?;
    ensure!(
        !query.q.trim().is_empty() && query.q.len() <= 1000,
        "Search query must contain 1–1000 characters"
    );
    if query.semantic {
        ensure!(
            ["documents", "images"].contains(&query.media.as_str()),
            "Choose documents or images for semantic search"
        );
        let hits = app
            .knowledge
            .clone()
            .search(query.q, query.group_id.clone(), query.media == "images")
            .await?;
        let valid = app.store.list::<Artifact>("artifacts")?;
        let results = hits
            .into_iter()
            .filter(|h| {
                valid.iter().any(|a| {
                    a.id == h["id"] && a.group_id == query.group_id && a.status == "indexed"
                })
            })
            .map(|mut hit| {
                if let Some(a) = valid.iter().find(|a| a.id == hit["id"]) {
                    hit["name"] = json!(a.name);
                }
                hit
            })
            .collect::<Vec<_>>();
        Ok(Json(json!({"artifacts":results})))
    } else {
        let matches=app.store.read(|c|{let mut q=c.prepare("SELECT data FROM messages WHERE json_extract(data,'$.group_id')=? AND instr(lower(json_extract(data,'$.body')),lower(?))>0 ORDER BY rowid DESC LIMIT 50")?;q.query_map(params![query.group_id,query.q],|r|r.get::<_,String>(0))?.map(|r|Ok(serde_json::from_str::<Message>(&r?)?)).collect::<Result<Vec<_>>>()})?;
        Ok(Json(json!({"messages":matches})))
    }
}
async fn export(State(app): State<App>) -> ApiResult<Value> {
    let value = tokio::task::spawn_blocking(move || export_org(&app))
        .await
        .map_err(anyhow::Error::from)??;
    Ok(Json(value))
}
fn export_org(app: &App) -> Result<Value> {
    use std::io::{Read, Write};
    let backup_id = id();
    let directory = app.store.org.join(".state/backups");
    std::fs::create_dir_all(&directory)?;
    let temp = tempfile::NamedTempFile::new_in(&directory)?;
    app.store.read(|conn| {
        conn.backup("main", temp.path(), None)?;
        Ok(())
    })?;
    let snapshot = rusqlite::Connection::open(temp.path())?;
    let artifacts = store::list::<Artifact>(&snapshot, "artifacts")?;
    let agents = store::list::<Agent>(&snapshot, "agents")?;
    let file = std::fs::File::create(directory.join(format!("{backup_id}.zip")))?;
    let mut archive = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();
    let mut manifest = Vec::new();
    let mut add = |name: &str, bytes: &[u8]| -> Result<()> {
        archive.start_file(name, options)?;
        archive.write_all(bytes)?;
        manifest.push(json!({"path":name,"sha256":format!("{:x}",Sha256::digest(bytes))}));
        Ok(())
    };
    let mut bytes = Vec::new();
    temp.reopen()?.read_to_end(&mut bytes)?;
    add(".state/app.sqlite3", &bytes)?;
    for a in agents {
        add(
            &format!("{}/profile.json", a.id),
            &serde_json::to_vec_pretty(&a)?,
        )?;
        add(
            &format!("{}/instructions.md", a.id),
            a.instructions.as_bytes(),
        )?;
        add(&format!("{}/AGENTS.md", a.id), a.agents_md.as_bytes())?;
        let scripts = app.store.org.join(&a.id).join("scripts");
        if scripts.exists() {
            for entry in std::fs::read_dir(scripts)? {
                let e = entry?;
                if e.file_type()?.is_file() {
                    add(
                        &format!("{}/scripts/{}", a.id, e.file_name().to_string_lossy()),
                        &std::fs::read(e.path())?,
                    )?;
                }
            }
        }
    }
    for a in artifacts.into_iter().filter(|a| a.status != "deleted") {
        let bytes = std::fs::read(security::artifact_path(&app.store.org, &a.id)?)?;
        ensure!(
            format!("{:x}", Sha256::digest(&bytes)) == a.sha256,
            "Artifact changed during backup"
        );
        add(&format!(".state/artifacts/{}", a.id), &bytes)?;
    }
    let instructions = security::read_optional(&app.store.org.join("AGENTS.md"))?;
    add("AGENTS.md", instructions.as_bytes())?;
    drop(add);
    archive.start_file("manifest.json", options)?;
    archive.write_all(&serde_json::to_vec_pretty(&json!({"version":1,"created_at":now(),"files":manifest,"credentials_included":false,"native_sessions_included":false}))?)?;
    archive.finish()?;
    app.store
        .event("organization.exported", json!({"backup_id":backup_id}))?;
    Ok(
        json!({"id":backup_id,"url":format!("/api/backups/{backup_id}"),"credentials_included":false,"native_sessions_included":false}),
    )
}
async fn download_backup(
    State(app): State<App>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    security::validate_id(&id)?;
    let bytes = tokio::fs::read(
        app.store
            .org
            .join(".state/backups")
            .join(format!("{id}.zip")),
    )
    .await
    .map_err(anyhow::Error::from)?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/zip"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=agentic-enterprise.zip",
            ),
        ],
        bytes,
    )
        .into_response())
}
