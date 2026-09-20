// Shared short-lived transport for the official Codex app-server read APIs.
use crate::{App, process_tree::OwnedProcessTree, runtime};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

pub(crate) fn request(
    app: &App,
    home: &Path,
    cwd: &Path,
    method: &str,
    params: Value,
) -> Result<Value> {
    let mut command = Command::new(&app.codex);
    command
        .args([
            "app-server",
            "--stdio",
            "-c",
            "cli_auth_credentials_store=\"file\"",
        ])
        .current_dir(cwd)
        .env_clear();
    runtime::system_environment(&mut command);
    command
        .env("CODEX_HOME", home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    let (mut child, owner) = OwnedProcessTree::spawn_with_creation_flags(&mut command, 0x08000000)?;
    #[cfg(not(windows))]
    let (mut child, owner) = OwnedProcessTree::spawn(&mut command)?;
    let result = (|| {
        let mut input = child.stdin.take().context("Codex input pipe unavailable")?;
        let output = child
            .stdout
            .take()
            .context("Codex output pipe unavailable")?;
        let (send, receive) = mpsc::channel();
        std::thread::spawn(move || {
            // Bound unexpected protocol output, including individual lines.
            for line in BufReader::new(output.take(2 * 1024 * 1024)).lines() {
                if send.send(line).is_err() {
                    break;
                }
            }
        });
        writeln!(
            input,
            "{}",
            json!({"id":0,"method":"initialize","params":{"clientInfo":{"name":"agentic_enterprise","title":"Agentic Enterprise","version":env!("CARGO_PKG_VERSION")}}})
        )?;
        input.flush()?;
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let line = receive
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .context(
                    "Codex request timed out or disconnected. Check the installed CLI and retry.",
                )??;
            let message: Value =
                serde_json::from_str(&line).context("Codex returned an invalid response")?;
            let Some(id) = message["id"].as_u64() else {
                continue;
            };
            if !message["error"].is_null() {
                // Avoid exposing authentication material in upstream error details.
                bail!(
                    "Codex request failed (code {}). Check the installed CLI and sign-in, then retry.",
                    message["error"]["code"].as_i64().unwrap_or(-1)
                );
            }
            if id == 0 {
                writeln!(input, "{}", json!({"method":"initialized","params":{}}))?;
                writeln!(input, "{}", json!({"id":1,"method":method,"params":params}))?;
                input.flush()?;
            } else if id == 1 {
                return Ok(message["result"].clone());
            }
        }
    })();
    owner.terminate()?;
    child.wait()?;
    result
}
