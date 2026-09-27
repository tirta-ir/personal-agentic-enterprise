use crate::{App, model::Workspace};
use anyhow::{Context, Result, bail};
use axum::{
    Json,
    extract::{Request, State},
    http::{StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde_json::json;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use subtle::ConstantTimeEq;

pub struct ApiError(pub StatusCode, pub String);
impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        Self(StatusCode::BAD_REQUEST, e.to_string())
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
pub type ApiResult<T> = std::result::Result<Json<T>, ApiError>;

pub async fn guard(State(app): State<App>, req: Request, next: Next) -> Response {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let valid_host = host == app.address.to_string()
        || std::env::var("AE_INTERNAL_URL")
            .ok()
            .and_then(|s| url::Url::parse(&s).ok())
            .is_some_and(|u| u[url::Position::BeforeHost..url::Position::AfterPort] == *host)
        || url::Url::parse(&app.public_url)
            .ok()
            .is_some_and(|u| u[url::Position::BeforeHost..url::Position::AfterPort] == *host)
        || (app.address.ip().is_loopback() && host == format!("localhost:{}", app.address.port()));
    if !valid_host {
        return (StatusCode::FORBIDDEN, "Invalid host").into_response();
    }
    if let Some(origin) = req.headers().get(header::ORIGIN) {
        if origin.to_str().ok() != Some(format!("http://{host}").as_str())
            && origin.to_str().ok() != Some(app.public_url.trim_end_matches('/'))
        {
            return (StatusCode::FORBIDDEN, "Cross-origin request rejected").into_response();
        }
    }
    let path = req.uri().path();
    if path.starts_with("/api/")
        && !["/api/login", "/api/health"].contains(&path)
        && req
            .extensions()
            .get::<crate::platform::Identity>()
            .is_none()
    {
        let bearer = req
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "));
        let cookie = req
            .headers()
            .get(header::COOKIE)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| {
                s.split(';')
                    .map(str::trim)
                    .find_map(|c| c.strip_prefix("ae_session="))
            });
        if !bearer
            .or(cookie)
            .is_some_and(|v| bool::from(v.as_bytes().ct_eq(app.token.as_bytes())))
        {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error":"Owner sign-in required"})),
            )
                .into_response();
        }
    }
    let mut response = next.run(req).await;
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        "nosniff".parse().expect("static header"),
    );
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        "no-referrer".parse().expect("static header"),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        "no-store".parse().expect("static header"),
    );
    response.headers_mut().insert(header::CONTENT_SECURITY_POLICY,"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'".parse().expect("static header"));
    response
}

pub fn validate_workspace(path: &str) -> Result<Workspace> {
    let path = Path::new(path);
    if !path.is_absolute() {
        bail!("Workdir must be an absolute path on this machine");
    }
    if !path.is_dir() {
        bail!("Workdir does not exist or is not a directory");
    }
    let canonical = path.canonicalize().context("Cannot access workdir")?;
    if canonical.parent().is_none() {
        bail!("Attach a codebase directory, not a filesystem root");
    }
    std::fs::read_dir(&canonical).context("Workdir is not readable")?;
    let output = std::process::Command::new("git")
        .args([
            "-C",
            path.to_str().context("Invalid Unicode path")?,
            "rev-parse",
            "--show-toplevel",
        ])
        .output()?;
    let git_root = output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string());
    Ok(Workspace {
        runtime_id: None,
        ssh_host: None,
        path: path.to_string_lossy().into_owned(),
        canonical_path: canonical.to_string_lossy().into_owned(),
        git_root,
    })
}
pub fn revalidate(workspace: &Workspace) -> Result<()> {
    if workspace.runtime_id.is_some() {
        bail!("Use the registered runtime for this workdir");
    }
    if workspace.ssh_host.is_some() {
        bail!("This operation requires the remote workstation connection");
    }
    let current = validate_workspace(&workspace.path)?;
    if current.canonical_path != workspace.canonical_path || current.git_root != workspace.git_root
    {
        bail!("Attached directory identity changed; reattach it explicitly");
    }
    Ok(())
}
pub fn validate_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        bail!("Invalid identifier");
    }
    Ok(())
}
pub fn read_optional(path: &Path) -> Result<String> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.into()),
    }
}
pub fn workdir_env(workspace: &Workspace) -> Result<BTreeMap<String, String>> {
    let content = read_optional(&Path::new(&workspace.path).join(".env"))
        .context("Cannot read workdir .env; check file access and UTF-8 encoding")?;
    parse_env(content.trim_start_matches('\u{feff}'))
        .context("Invalid workdir .env; check syntax and reserved variable names")
}
pub fn parse_env(content: &str) -> Result<BTreeMap<String, String>> {
    let mut values = BTreeMap::new();
    for pair in dotenvy::from_read_iter(content.as_bytes()) {
        let (k, v) = pair
            .map_err(|_| anyhow::anyhow!("Invalid environment syntax; check key/value quoting"))?;
        if !k
            .bytes()
            .enumerate()
            .all(|(i, b)| b == b'_' || b.is_ascii_alphabetic() || (i > 0 && b.is_ascii_digit()))
        {
            bail!("Invalid environment variable name");
        }
        if [
            "PATH",
            "PWD",
            "PATHEXT",
            "COMSPEC",
            "HOME",
            "USERPROFILE",
            "CODEX_HOME",
            "CODEX_THREAD_ID",
            "XDG_DATA_HOME",
            "XDG_CONFIG_HOME",
            "XDG_CACHE_HOME",
            "XDG_STATE_HOME",
            "OPENCODE_CONFIG",
            "OPENCODE_CONFIG_CONTENT",
            "OPENCODE_CONFIG_DIR",
            "OPENCODE_DB",
            "OPENCODE_PASSWORD",
            "OPENCODE_SERVER_PASSWORD",
            "AE_ORG",
            "AE_TOKEN",
            "AE_TOOL_TOKEN",
            "RUST_LOG",
        ]
        .iter()
        .any(|r| k.eq_ignore_ascii_case(r))
        {
            bail!("{k} is reserved by the platform");
        }
        values.insert(k, v);
    }
    Ok(values)
}
pub fn redacted(text: &str, secrets: &[String]) -> String {
    let mut result = text.to_owned();
    let mut patterns = Vec::new();
    for secret in secrets.iter().filter(|s| !s.is_empty()) {
        patterns.push(secret.clone());
        let quoted = serde_json::to_string(secret).expect("string serialization");
        patterns.push(quoted[1..quoted.len() - 1].to_owned());
    }
    patterns.sort_by_key(|s| std::cmp::Reverse(s.len()));
    patterns.dedup();
    for pattern in patterns {
        result = result.replace(&pattern, "[REDACTED]");
    }
    result
}
pub fn artifact_path(org: &Path, id: &str) -> Result<PathBuf> {
    validate_id(id)?;
    Ok(org.join(".state/artifacts").join(id))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reject_reserved_environment_and_traversal() {
        assert!(parse_env("CODEX_HOME=somewhere").is_err());
        assert!(validate_id("../other").is_err());
        assert_eq!(
            parse_env("SAMPLE='a b'").expect("valid env")["SAMPLE"],
            "a b"
        );
        assert_eq!(
            redacted("token=secret", &["secret".into()]),
            "token=[REDACTED]"
        );
        let secret = "prefix\\value\"quoted".to_owned();
        assert_eq!(
            redacted(
                &serde_json::to_string(&secret).expect("json"),
                &["prefix".into(), secret]
            ),
            "\"[REDACTED]\""
        );
        assert!(parse_env("BROKEN=\"unterminated").is_err());
    }
}
