// OpenCode v2 native CLI/API; event mapping follows Paperclip's MIT adapter.
// Private servers are owned by CCCC's existing process tree. See UPSTREAM.md.
use crate::{
    App,
    codex_settings::{CodexSettings, ModelOption, ReasoningOption},
    model::*,
    process_tree::OwnedProcessTree,
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

pub fn executable() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("AE_OPENCODE") {
        let path = PathBuf::from(path);
        ensure!(
            path.is_file(),
            "AE_OPENCODE must point to the native OpenCode executable"
        );
        return Ok(path);
    }
    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        for relative in if cfg!(windows) {
            vec![
                "opencode.exe",
                "node_modules/@opencode/cli/bin/opencode.exe",
            ]
        } else {
            vec!["opencode"]
        } {
            let path = dir.join(relative);
            if path.is_file() {
                return Ok(path);
            }
        }
    }
    anyhow::bail!(
        "OpenCode native executable not found. Install OpenCode v2 or set AE_OPENCODE to its executable path."
    )
}

pub fn environment(command: &mut Command, home: Option<&Path>) {
    // Provider configuration belongs to the workstation's CLI; session storage
    // remains scoped to the platform. Never redirect its global config directory.
    for key in ["XDG_CONFIG_HOME", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    for (key, dir) in [
        ("XDG_DATA_HOME", "data"),
        ("XDG_CACHE_HOME", "cache"),
        ("XDG_STATE_HOME", "state"),
    ] {
        if let Some(home) = home {
            command.env(key, home.join(dir));
        } else if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    if let Some(home) = home {
        command.env("OPENCODE_DB", home.join("data/opencode/opencode.db"));
    } else if let Some(value) = std::env::var_os("OPENCODE_DB") {
        command.env("OPENCODE_DB", value);
    }
    command.env(
        "OPENCODE_CONFIG_CONTENT",
        json!({"share":"disabled","autoupdate":false}).to_string(),
    );
}

// Use the native model/skill registry; it can be empty before plugins settle.
pub fn query(app: &App, workspace: Option<&Workspace>, route: &str) -> Result<Value> {
    if let Some(host) = workspace.and_then(|w| w.ssh_host.as_deref()) {
        return crate::remote::call(
            host,
            json!({"op":"opencode_query","route":route,"path":workspace.map(|w| &w.path),"namespace":crate::remote::namespace(app)}),
        );
    }
    query_local(workspace, route, None)
}

fn query_local(workspace: Option<&Workspace>, route: &str, home: Option<&Path>) -> Result<Value> {
    if let Some(home) = home {
        std::fs::create_dir_all(home)?;
    }
    let password = format!("{}{}", id(), id());
    let mut command = Command::new(executable()?);
    command
        .args(["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"])
        .current_dir(
            workspace
                .map(|w| Path::new(&w.path))
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(&std::env::current_dir()?),
        )
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::runtime::system_environment(&mut command);
    environment(&mut command, home);
    if let Some(workspace) = workspace.filter(|w| !w.path.is_empty()) {
        command
            .envs(crate::security::workdir_env(workspace)?)
            .env("PWD", &workspace.path);
    }
    command.env("OPENCODE_PASSWORD", &password);
    #[cfg(windows)]
    let (mut child, owner) = OwnedProcessTree::spawn_with_creation_flags(&mut command, 0x08000000)?;
    #[cfg(not(windows))]
    let (mut child, owner) = OwnedProcessTree::spawn(&mut command)?;
    let (tx, rx) = mpsc::channel();
    let stdout = child.stdout.take().context("Missing OpenCode stdout")?;
    std::thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout)
            .take(65536)
            .read_line(&mut line)
            .map(|_| line);
        let _ = tx.send(result);
    });
    let stderr = child.stderr.take().context("Missing OpenCode stderr")?;
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut stderr.take(65536), &mut std::io::sink());
    });
    let result = (|| {
        let line = rx
            .recv_timeout(Duration::from_secs(20))
            .context("OpenCode server did not become ready")??;
        let ready: Value =
            serde_json::from_str(&line).context("OpenCode v2 private server required")?;
        let address = ready["url"]
            .as_str()
            .context("OpenCode server did not report an address")?;
        let url = url::Url::parse(address)?;
        ensure!(
            url.scheme() == "http" && url.host_str() == Some("127.0.0.1"),
            "Unexpected OpenCode server address"
        );
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()?;
        let registry = ["/api/model", "/api/skill"].contains(&route);
        let fetch = |route: &str| -> Result<Value> {
            let mut request = client.get(format!("{address}{route}"));
            if let Some(workspace) = workspace {
                request = request.query(&[("location[directory]", &workspace.path)]);
            }
            Ok(request
                .basic_auth("opencode", Some(&password))
                .send()?
                .error_for_status()?
                .json()?)
        };
        if registry {
            // Native plugin inventory is published after activation finishes. A nonempty
            // skill registry alone can still contain only the early builtin skills.
            let start = Instant::now();
            loop {
                let value = fetch("/api/plugin")?;
                let plugins = value["data"]
                    .as_array()
                    .context("Invalid OpenCode plugin inventory")?;
                if !plugins.is_empty() {
                    ensure!(
                        plugins.iter().all(|p| p["state"]["status"] == "active"),
                        "An OpenCode plugin failed to activate; check the workstation's OpenCode setup"
                    );
                    break;
                }
                ensure!(
                    start.elapsed() < Duration::from_secs(20),
                    "OpenCode plugins did not become ready"
                );
                std::thread::sleep(Duration::from_millis(250));
            }
        }
        let mut value = fetch(route)?;
        if route == "/api/model" {
            value["default"] = fetch("/api/model/default")?["data"].clone();
        }
        Ok(value)
    })();
    drop(child.stdin.take());
    owner.terminate()?;
    child.wait()?;
    result
}

pub fn usage(app: &App, run: &Run, home: &Path) -> Result<Value> {
    let native = run
        .native_session_id
        .as_deref()
        .context("No OpenCode session")?;
    ensure!(
        native
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_'),
        "Invalid OpenCode session ID"
    );
    let route = format!("/api/session/{native}/message?limit=200&order=desc");
    let workspace = run.profile.workdir.as_ref().context("No workdir")?;
    let value = if let Some(host) = &workspace.ssh_host {
        crate::remote::call(
            host,
            json!({"op":"opencode_query","route":route,"path":workspace.path,
            "namespace":crate::remote::namespace(app),"runtime_session_id":run.session_id}),
        )?
    } else {
        query_local(Some(workspace), &route, Some(home))?
    };
    let since = chrono::DateTime::parse_from_rfc3339(
        run.started_at.as_deref().context("Missing run start")?,
    )?
    .timestamp_millis();
    let messages = value["data"]
        .as_array()
        .context("Invalid native session messages")?;
    let mut input = 0u64;
    let mut output = 0u64;
    let mut cost = Some(0.0);
    let mut count = 0;
    for message in messages.iter().filter(|m| {
        m["type"] == "assistant" && m["time"]["created"].as_i64().is_some_and(|t| t >= since)
    }) {
        if !message["tokens"].is_object() {
            continue;
        }
        input += message["tokens"]["input"].as_u64().unwrap_or(0);
        output += message["tokens"]["output"].as_u64().unwrap_or(0)
            + message["tokens"]["reasoning"].as_u64().unwrap_or(0);
        cost = cost
            .zip(message["cost"].as_f64())
            .map(|(total, amount)| total + amount);
        count += 1;
    }
    ensure!(
        count > 0,
        "OpenCode did not report token usage for this run"
    );
    Ok(
        json!({"input_tokens":input,"output_tokens":output,"cost_usd":cost,"source":"opencode_session","messages":count}),
    )
}

pub fn settings(app: &App, workspace: Option<&Workspace>) -> Result<CodexSettings> {
    parse_models(&query(app, workspace, "/api/model")?)
}

// Borrow only native credentials, never the CLI's chat history. Mirrors the
// existing Codex auth lease, with compare-before-copyback for OAuth refreshes.
pub struct CredentialLease {
    source: PathBuf,
    target: PathBuf,
    rows: Vec<Vec<rusqlite::types::Value>>,
}
impl CredentialLease {
    pub fn secrets(&self) -> Vec<String> {
        self.rows
            .iter()
            .filter_map(|row| match &row[3] {
                rusqlite::types::Value::Text(text) => Some(text.as_str()),
                _ => None,
            })
            .filter_map(|raw| serde_json::from_str::<Value>(raw).ok())
            .flat_map(|value| {
                ["key", "access", "refresh"]
                    .into_iter()
                    .filter_map(|key| value[key].as_str().map(String::from))
                    .collect::<Vec<_>>()
            })
            .collect()
    }
    pub fn finish(self) -> Result<()> {
        let target = rusqlite::Connection::open_with_flags(
            &self.target,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        let source = rusqlite::Connection::open_with_flags(
            &self.source,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE,
        )?;
        source.busy_timeout(Duration::from_secs(5))?;
        for row in self.rows {
            use rusqlite::OptionalExtension;
            let updated: Option<(String, i64)> = target
                .query_row(
                    "SELECT value,time_updated FROM credential WHERE id=?",
                    [&row[0]],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            if let Some((value, time)) =
                updated.filter(|(value, _)| row[3] != rusqlite::types::Value::Text(value.clone()))
            {
                source.execute(
                    "UPDATE credential SET value=?,time_updated=? WHERE id=? AND value=?",
                    rusqlite::params![value, time, row[0], row[3]],
                )?;
            }
        }
        Ok(())
    }
}
pub fn seed_credentials(workspace: &Workspace, home: &Path) -> Result<CredentialLease> {
    let user = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .context("Cannot locate OpenCode user directory")?;
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(user).join(".local/share"))
        .join("opencode");
    let source = data.join(std::env::var_os("OPENCODE_DB").unwrap_or_else(|| "opencode.db".into()));
    let target = home.join("data/opencode/opencode.db");
    if !target.exists() {
        // Let the installed CLI own its database schema and migrations.
        query_local(Some(workspace), "/api/model", Some(home))?;
    }
    let native =
        rusqlite::Connection::open_with_flags(&source, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .context("Cannot read native OpenCode credentials; open the workstation's CLI first")?;
    let rows = native.prepare("SELECT id,integration_id,label,value,connector_id,method_id,active,time_created,time_updated FROM credential")?
        .query_map([], |row| (0..9).map(|i| row.get(i)).collect::<rusqlite::Result<Vec<rusqlite::types::Value>>>())?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut scoped = rusqlite::Connection::open(&target)?;
    scoped.busy_timeout(Duration::from_secs(5))?;
    let transaction = scoped.transaction()?;
    transaction.execute("DELETE FROM credential", [])?;
    for row in &rows {
        transaction.execute("INSERT INTO credential (id,integration_id,label,value,connector_id,method_id,active,time_created,time_updated) VALUES (?,?,?,?,?,?,?,?,?)", rusqlite::params_from_iter(row))?;
    }
    transaction.commit()?;
    Ok(CredentialLease {
        source,
        target,
        rows,
    })
}

pub fn parse_models(value: &Value) -> Result<CodexSettings> {
    let mut models = vec![];
    for model in value["data"]
        .as_array()
        .context("Invalid OpenCode model catalog")?
    {
        if model["enabled"] != true {
            continue;
        }
        let provider = model["providerID"]
            .as_str()
            .context("Model provider missing")?;
        let id = model["id"].as_str().context("Model identifier missing")?;
        models.push(ModelOption {
            slug: format!("{provider}/{id}"),
            display_name: model["name"].as_str().unwrap_or(id).into(),
            visibility: "list".into(),
            default_reasoning_level: String::new(),
            supported_reasoning_levels: model["variants"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v["id"].as_str())
                .map(|id| ReasoningOption {
                    effort: id.into(),
                    description: "Native OpenCode model variant".into(),
                })
                .collect(),
        });
    }
    ensure!(
        !models.is_empty(),
        "OpenCode has no available models. Configure a provider in the workstation's OpenCode CLI, then refresh models."
    );
    let default = &value["default"];
    let preferred = format!(
        "{}/{}",
        default["providerID"].as_str().unwrap_or(""),
        default["id"].as_str().unwrap_or("")
    );
    Ok(CodexSettings {
        model: models
            .iter()
            .find(|m| m.slug == preferred)
            .unwrap_or(&models[0])
            .slug
            .clone(),
        reasoning: String::new(),
        models,
        fetched_at: Some(now()),
    })
}

pub fn settings_for(
    app: &App,
    harness: Harness,
    workspace: Option<&Workspace>,
) -> Result<CodexSettings> {
    if let Some(id) = workspace.and_then(|w| w.runtime_id.as_deref()) {
        return crate::fleet::settings(app, id, harness);
    }
    ensure!(
        app.workspace_id == "default" && app.identity.as_ref().is_none_or(|i| i.user == "owner"),
        "Choose a registered runtime for its model catalog"
    );
    match harness {
        Harness::Opencode => settings(app, workspace),
        Harness::Codex => match workspace.and_then(|w| w.ssh_host.as_deref()) {
            Some(host) => crate::remote::settings(host),
            None => crate::codex_settings::read(),
        },
    }
}

pub fn config(home: &Path, permission: &str, model: &str, address: &str) -> Value {
    let rules = match permission {
        "read-only" => {
            json!({"*":"allow","edit":"deny","bash":"deny","external_directory":"deny","question":"deny","task":"deny"})
        }
        "workspace-write" => {
            json!({"*":"allow","bash":"deny","external_directory":"deny","question":"deny","task":"deny"})
        }
        _ => json!({"*":"allow","question":"deny","task":"deny"}),
    };
    json!({"share":"disabled","autoupdate":false,"model":model,"small_model":model,
        "instructions":[home.join("AGENTS.md").to_string_lossy()], "permission":rules,
        "mcp":{"enterprise":{"type":"remote","url":format!("http://{address}/mcp"),"oauth":false,
        "headers":{"Authorization":"Bearer {env:AE_TOOL_TOKEN}"},"timeout":86500000}}})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_catalog_includes_added_providers_prices_and_variants() {
        let model = json!({"id":"free","providerID":"native","name":"Native Free","enabled":true,"capabilities":{"tools":true},"cost":[{"input":0,"output":0,"cache":{"read":0,"write":0}}],"variants":[{"id":"deep"}]});
        let mut paid = model.clone();
        paid["providerID"] = "new-provider".into();
        paid["id"] = "paid".into();
        paid["cost"][0]["input"] = 1.into();
        let mut text_only = model.clone();
        text_only["capabilities"]["tools"] = false.into();
        let mut unknown = model.clone();
        unknown["id"] = "unknown-price".into();
        unknown["cost"][0]["cache"] = Value::Null;
        text_only["id"] = "text-only".into();
        let mut disabled = model.clone();
        disabled["enabled"] = false.into();
        let settings = parse_models(&json!({"data":[model,paid,text_only,unknown,disabled],"default":{"providerID":"new-provider","id":"paid"}})).unwrap();
        assert_eq!(settings.models.len(), 4);
        assert_eq!(
            settings.resolve("", "").unwrap(),
            ("new-provider/paid".into(), "".into())
        );
        assert_eq!(settings.resolve("", "deep").unwrap().1, "deep");
        assert!(settings.resolve("", "xhigh").is_err());
        assert!(settings.resolve("missing/model", "").is_err());
        assert!(parse_models(&json!({"data":[]})).is_err());
        assert!(parse_models(&json!({"data":"invalid"})).is_err());
    }

    #[test]
    fn credential_refresh_preserves_a_newer_native_login() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("native.db");
        let target = dir.path().join("scoped.db");
        for path in [&source, &target] {
            rusqlite::Connection::open(path)
                .unwrap()
                .execute_batch(
                    "CREATE TABLE credential(id TEXT PRIMARY KEY,value TEXT,time_updated INTEGER);
                 INSERT INTO credential VALUES('one','original',1),('two','original',1);",
                )
                .unwrap();
        }
        let native = rusqlite::Connection::open(&source).unwrap();
        native
            .execute(
                "UPDATE credential SET value='newer-login' WHERE id='two'",
                [],
            )
            .unwrap();
        let scoped = rusqlite::Connection::open(&target).unwrap();
        scoped
            .execute("UPDATE credential SET value='refreshed',time_updated=2", [])
            .unwrap();
        CredentialLease {
            source,
            target,
            rows: ["one", "two"]
                .into_iter()
                .map(|id| {
                    vec![
                        id.to_owned().into(),
                        rusqlite::types::Value::Null,
                        rusqlite::types::Value::Null,
                        "original".to_owned().into(),
                    ]
                })
                .collect(),
        }
        .finish()
        .unwrap();
        let values: Vec<String> = native
            .prepare("SELECT value FROM credential ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(values, ["refreshed", "newer-login"]);
    }
}
