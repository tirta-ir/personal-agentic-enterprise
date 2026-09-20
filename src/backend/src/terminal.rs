// Manual CLI commands reuse the CCCC-owned native process path used by agent runs.
use crate::{
    App, coordination,
    model::{Agent, Run, now},
    process_tree::OwnedProcessTree,
    runtime, security, store,
};
use anyhow::{Context, Result, ensure};
use axum::{
    Json,
    extract::{Path, State},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    io::Read,
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
use ts_rs::TS;

const OUTPUT_LIMIT: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TerminalRun {
    pub id: String,
    pub agent_id: String,
    pub command: String,
    pub cwd: String,
    pub canonical_cwd: String,
    pub shell: String,
    pub status: String,
    pub output: String,
    pub created_at: String,
    pub ended_at: Option<String>,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
}

pub fn busy(conn: &rusqlite::Connection, agent_id: &str, canonical_cwd: &str) -> Result<bool> {
    let mut query = conn
        .prepare("SELECT data FROM terminal_runs WHERE json_extract(data,'$.status')='running'")?;
    for value in query.query_map([], |row| row.get::<_, String>(0))? {
        let run: TerminalRun = serde_json::from_str(&value?)?;
        if run.agent_id == agent_id
            || (!canonical_cwd.is_empty() && canonical_cwd.eq_ignore_ascii_case(&run.canonical_cwd))
        {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn agent(app: &App, id: &str) -> Result<Agent> {
    let mut agent: Agent = app.store.get("agents", id)?;
    agent.workdir = app
        .store
        .read(|conn| crate::projects::workspace(conn, &agent))?;
    ensure!(agent.deleted_at.is_none(), "Restore this agent first");
    let workspace = agent
        .workdir
        .as_ref()
        .context("Attach a workdir in Workdir first")?;
    if workspace.ssh_host.is_none() {
        security::revalidate(workspace)?;
    }
    Ok(agent)
}

pub async fn list(
    State(app): State<App>,
    Path(id): Path<String>,
) -> security::ApiResult<Vec<TerminalRun>> {
    let _: Agent = app.store.get("agents", &id)?;
    Ok(Json(app.store.read(|conn| {
        // Fetch summaries only; output is loaded separately for the selected command.
        let mut query = conn.prepare("SELECT json_set(data,'$.output','') FROM terminal_runs WHERE json_extract(data,'$.agent_id')=? ORDER BY rowid DESC LIMIT 50")?;
        query.query_map([id], |row| row.get::<_, String>(0))?
            .map(|value| Ok(serde_json::from_str(&value?)?)).collect()
    })?))
}

fn owned(app: &App, id: &str, run_id: &str) -> Result<TerminalRun> {
    let run: TerminalRun = app.store.get("terminal_runs", run_id)?;
    ensure!(run.agent_id == id, "Command does not belong to this agent");
    Ok(run)
}

pub async fn get(
    State(app): State<App>,
    Path((id, run_id)): Path<(String, String)>,
) -> security::ApiResult<TerminalRun> {
    Ok(Json(owned(&app, &id, &run_id)?))
}

pub async fn stop(
    State(app): State<App>,
    Path((id, run_id)): Path<(String, String)>,
) -> security::ApiResult<TerminalRun> {
    let run = owned(&app, &id, &run_id)?;
    if run.status == "running" {
        app.cancellations
            .lock()
            .map_err(|_| anyhow::anyhow!("Cancellation registry unavailable"))?
            .get(&format!("terminal:{run_id}"))
            .context("Command is ending; refresh its output")?
            .store(true, Ordering::SeqCst);
    }
    Ok(Json(run))
}

#[derive(Deserialize)]
pub struct StartInput {
    id: String,
    command: String,
}

pub async fn start(
    State(app): State<App>,
    Path(id): Path<String>,
    Json(input): Json<StartInput>,
) -> security::ApiResult<TerminalRun> {
    security::validate_id(&input.id)?;
    if input.command.trim().is_empty()
        || input.command.len() > 16 * 1024
        || input.command.contains('\0')
    {
        return Err(
            anyhow::anyhow!("Command must contain 1–16384 bytes without null characters").into(),
        );
    }
    let profile = agent(&app, &id)?;
    let workspace = profile.workdir.as_ref().context("Attach a workdir first")?;
    let env = if workspace.ssh_host.is_none() {
        security::workdir_env(workspace)?
    } else {
        Default::default()
    };
    let mut secrets: Vec<String> = env.values().filter(|s| !s.is_empty()).cloned().collect();
    secrets.push(app.token.to_string());
    let visible_command = if let Some(host) = &workspace.ssh_host {
        let host = host.clone();
        let mut request = crate::remote::request(workspace, "redact");
        request["command"] = input.command.clone().into();
        tokio::task::spawn_blocking(move || crate::remote::call(&host, request))
            .await
            .map_err(anyhow::Error::from)??["command"]
            .as_str()
            .context("Missing command")?
            .to_owned()
    } else {
        input.command.clone()
    };
    let mut run = TerminalRun {
        id: input.id,
        agent_id: id,
        command: security::redacted(&visible_command, &secrets),
        cwd: workspace.path.clone(),
        canonical_cwd: workspace.identity(),
        shell: if workspace.ssh_host.is_some() {
            "Remote sh"
        } else if cfg!(windows) {
            "PowerShell"
        } else {
            "sh"
        }
        .into(),
        status: "running".into(),
        output: String::new(),
        created_at: now(),
        ended_at: None,
        exit_code: None,
        error: None,
    };
    let cancelled = Arc::new(AtomicBool::new(false));
    // Register before admission so Stop is valid as soon as the row becomes visible.
    let mut registry = app
        .cancellations
        .lock()
        .map_err(|_| anyhow::anyhow!("Cancellation registry unavailable"))?;
    let admitted = app.store.write(|tx| {
        if tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM terminal_runs WHERE id=?)",
            [&run.id],
            |row| row.get::<_, bool>(0),
        )? {
            let existing: TerminalRun = store::get(tx, "terminal_runs", &run.id)?;
            ensure!(
                existing.agent_id == run.agent_id && existing.command == run.command,
                "Command ID already used"
            );
            run = existing;
            return Ok(false);
        }
        let current: Agent = store::get(tx, "agents", &run.agent_id)?;
        ensure!(
            current.revision == profile.revision && current.deleted_at.is_none(),
            "Profile changed; refresh before running"
        );
        ensure!(
            !busy(tx, &run.agent_id, &run.canonical_cwd)?,
            "A terminal command is already running in this workdir"
        );
        ensure!(
            !store::list::<Run>(tx, "runs")?
                .iter()
                .any(|r| coordination::active(r)
                    && (r.agent_id == run.agent_id
                        || r.profile.workdir.as_ref().is_some_and(|w| w
                            .identity()
                            .eq_ignore_ascii_case(&run.canonical_cwd)))),
            "Wait for agent work in this workdir to finish, or cancel it in Runs"
        );
        let active: i64 = tx.query_row(
            "SELECT COUNT(*) FROM terminal_runs WHERE json_extract(data,'$.status')='running'",
            [],
            |row| row.get(0),
        )?;
        ensure!(
            active < 2,
            "Two terminal commands are already running; stop or finish one first"
        );
        store::put(tx, "terminal_runs", &run.id, &run)?;
        store::event(
            tx,
            "terminal.started",
            &json!({"agent_id":run.agent_id,"run_id":run.id}),
        )?;
        Ok(true)
    })?;
    if !admitted {
        return Ok(Json(run));
    }
    registry.insert(format!("terminal:{}", run.id), cancelled.clone());
    drop(registry);
    let response = run.clone();
    tokio::task::spawn_blocking(move || {
        if let Err(error) = execute(
            &app,
            &profile,
            &mut run,
            &input.command,
            &env,
            &secrets,
            &cancelled,
        ) {
            run.status = "failed".into();
            run.error = Some(security::redacted(&error.to_string(), &secrets));
        }
        run.ended_at = Some(now());
        if let Err(error) = app.store.put("terminal_runs", &run.id, &run) {
            tracing::error!("Save terminal result: {error}");
        }
        match app.cancellations.lock() {
            Ok(mut registry) => {
                registry.remove(&format!("terminal:{}", run.id));
            }
            Err(error) => tracing::error!("Cancellation registry: {error}"),
        }
        if let Err(error) = app.store.event(
            "terminal.finished",
            json!({"agent_id":run.agent_id,"run_id":run.id}),
        ) {
            tracing::error!("Save terminal event: {error}");
        }
        app.wake.notify_one();
    });
    Ok(Json(response))
}

// Withhold unfinished secret prefixes while output is still arriving across reads.
fn visible_output(bytes: &[u8], secrets: &[String], finished: bool) -> String {
    let bytes = match std::str::from_utf8(bytes) {
        Err(error) if !finished && error.error_len().is_none() => &bytes[..error.valid_up_to()],
        _ => bytes,
    };
    let text = String::from_utf8_lossy(bytes);
    let plain = anstream::adapter::strip_str(&text).to_string();
    let mut visible = security::redacted(&plain, secrets);
    if !finished {
        let mut end = visible.len();
        for secret in secrets.iter().filter(|s| !s.is_empty()) {
            let quoted = serde_json::to_string(secret).expect("string serialization");
            for pattern in [secret.as_str(), &quoted[1..quoted.len() - 1]] {
                for (length, _) in pattern.char_indices().skip(1) {
                    if visible.ends_with(&pattern[..length]) {
                        end = end.min(visible.len() - length);
                    }
                }
            }
        }
        visible.truncate(end);
    }
    visible
}

fn execute(
    app: &App,
    profile: &Agent,
    run: &mut TerminalRun,
    script: &str,
    env: &std::collections::BTreeMap<String, String>,
    secrets: &[String],
    cancelled: &AtomicBool,
) -> Result<()> {
    if cancelled.load(Ordering::SeqCst) {
        run.status = "cancelled".into();
        return Ok(());
    }
    if profile
        .workdir
        .as_ref()
        .is_some_and(|w| w.ssh_host.is_some())
    {
        return crate::remote::terminal(app, profile, run, script, cancelled);
    }
    security::revalidate(profile.workdir.as_ref().context("Workdir missing")?)?;
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("pwsh.exe");
        command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", &format!("[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; $PSStyle.OutputRendering = 'PlainText'; {script}")]);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    };
    command.current_dir(&run.cwd).env_clear();
    runtime::system_environment(&mut command);
    let home = runtime::runtime_home(app, &run.agent_id);
    std::fs::create_dir_all(&home)?;
    command
        .envs(env)
        .env("CODEX_HOME", home)
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    let (mut child, owner) = OwnedProcessTree::spawn_with_creation_flags(&mut command, 0x08000000)
        .context("Could not start PowerShell; check that pwsh.exe is on PATH")?;
    #[cfg(not(windows))]
    let (mut child, owner) = OwnedProcessTree::spawn(&mut command)?;
    let (send, receive) = mpsc::sync_channel::<std::io::Result<Vec<u8>>>(64);
    fn reader(
        mut pipe: impl Read + Send + 'static,
        send: mpsc::SyncSender<std::io::Result<Vec<u8>>>,
    ) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            let mut buf = [0; 8192];
            loop {
                match pipe.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if send.send(Ok(buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = send.send(Err(e));
                        break;
                    }
                }
            }
        })
    }
    let readers = [
        reader(child.stdout.take().context("Missing stdout")?, send.clone()),
        reader(child.stderr.take().context("Missing stderr")?, send),
    ];
    let mut bytes = Vec::new();
    let started = Instant::now();
    let mut saved = Instant::now();
    let mut exited = None;
    loop {
        let mut received = false;
        for value in receive.try_iter().take(128) {
            received = true;
            let chunk = value.context("Could not read command output")?;
            let available = OUTPUT_LIMIT.saturating_sub(bytes.len());
            bytes.extend_from_slice(&chunk[..available.min(chunk.len())]);
            if chunk.len() > available {
                run.error = Some("Command stopped because output exceeded 2 MiB".into());
                run.status = "failed".into();
            }
        }
        if cancelled.load(Ordering::SeqCst) {
            run.status = "cancelled".into();
        }
        if started.elapsed() > Duration::from_secs(profile.timeout_seconds) {
            run.status = "timed_out".into();
            run.error = Some(format!(
                "Command exceeded the agent's {} second timeout",
                profile.timeout_seconds
            ));
        }
        if run.status != "running" {
            owner.terminate()?;
        }
        if exited.is_none() {
            exited = owner.try_wait(|| child.try_wait())?;
            if exited.is_some() {
                owner.terminate()?;
            }
        }
        if saved.elapsed() >= Duration::from_millis(300) {
            run.output = visible_output(&bytes, secrets, false);
            app.store.put("terminal_runs", &run.id, run)?;
            saved = Instant::now();
        }
        if exited.is_some() && readers.iter().all(|r| r.is_finished()) && !received {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    for reader in readers {
        reader
            .join()
            .map_err(|_| anyhow::anyhow!("Command output reader panicked"))?;
    }
    let status = exited.context("Command exited without status")?;
    run.exit_code = status.code();
    if run.status == "running" {
        run.status = if status.success() {
            "completed"
        } else {
            "failed"
        }
        .into();
    }
    run.output = visible_output(&bytes, secrets, true);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn output_redaction_survives_split_reads() {
        let secrets = vec!["private-value".into(), "line1\nline2".into()];
        assert_eq!(visible_output(b"value=private-", &secrets, false), "value=");
        assert_eq!(
            visible_output(b"value=private-value", &secrets, false),
            "value=[REDACTED]"
        );
        assert_eq!(
            visible_output(b"line1\nline2", &secrets, true),
            "[REDACTED]"
        );
        assert_eq!(visible_output(b"ordinary", &secrets, true), "ordinary");
        assert_eq!(
            visible_output(b"\x1b[31mprivate-value\x1b[0m", &secrets, true),
            "[REDACTED]"
        );
        assert_eq!(
            visible_output(
                "prefix-\u{00e9}".as_bytes().split_last().unwrap().1,
                &["prefix-\u{00e9}-secret".into()],
                false
            ),
            ""
        );
    }
}
