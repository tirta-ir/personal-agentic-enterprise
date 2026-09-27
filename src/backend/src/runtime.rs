// Codex argument and event mapping adapted from Paperclip v2026.916.0 (MIT).
// See UPSTREAM.md and vendor/PAPERCLIP-LICENSE. Process ownership is from CCCC.
use crate::{App, coordination, model::*, security, store};
use anyhow::{Context, Result, bail};
use rusqlite::params;
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

pub fn start_queue(app: App) {
    tokio::spawn(async move {
        loop {
            app.knowledge.release_idle_models();
            if let Err(error) = dispatch(&app) {
                tracing::error!("Run dispatcher: {error}");
            }
            tokio::select! { _=app.wake.notified()=>{}, _=tokio::time::sleep(Duration::from_millis(500))=>{} }
        }
    });
}

fn dispatch(app: &App) -> Result<()> {
    crate::agent_tools::tick(app)?;
    crate::schedules::tick(app)?;
    crate::actions::tick(app)?;
    coordination::summarize_ready(app)?;
    coordination::review_failures(app)?;
    let runs = app.store.list::<Run>("runs")?;
    let mut active: Vec<Run> = runs
        .iter()
        .filter(|r| ["starting", "running"].contains(&r.status.as_str()))
        .cloned()
        .collect();
    for mut run in runs.into_iter().filter(|r| r.status == "queued") {
        // No workstation cap; ownership locks still protect sessions and workdirs.
        if active.iter().any(|r| conflicts(r, &run)) {
            continue;
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        app.cancellations
            .lock()
            .map_err(|_| anyhow::anyhow!("Cancellation registry unavailable"))?
            .insert(run.id.clone(), cancelled.clone());
        let admitted = app.store.write(|tx| {
            if crate::terminal::busy(
                tx,
                &run.agent_id,
                &run.profile
                    .workdir
                    .as_ref()
                    .map(Workspace::identity)
                    .unwrap_or_default(),
            )? {
                return Ok(false);
            }
            let current: Run = store::get(tx, "runs", &run.id)?;
            if current.status != "queued" {
                return Ok(false);
            }
            let group: Group = store::get(tx, "groups", &run.group_id)?;
            if let Err(error) =
                crate::group_scope::access(tx, &group)?.ensure_allowed(&run.agent_id, run.kind)
            {
                run.status = "failed".into();
                run.error = Some(error.to_string());
                run.ended_at = Some(now());
                store::put(tx, "runs", &run.id, &run)?;
                store::event(tx, "run.changed", &json!({"run_id":run.id}))?;
                return Ok(false);
            }
            run.status = "starting".into();
            store::put(tx, "runs", &run.id, &run)?;
            Ok(true)
        })?;
        if !admitted {
            app.cancellations
                .lock()
                .map_err(|_| anyhow::anyhow!("Cancellation registry unavailable"))?
                .remove(&run.id);
            continue;
        }
        active.push(run.clone());
        let app = app.clone();
        tokio::task::spawn_blocking(move || {
            if let Err(error) = execute(&app, &mut run, &cancelled) {
                run.status = "failed".into();
                run.error = Some(error.to_string());
                run.ended_at = Some(now());
                if let Err(save_error) = app.store.put("runs", &run.id, &run) {
                    tracing::error!("Persist failed run: {save_error}");
                }
                if let Err(save_error) = app.store.event("run.changed", json!({"run_id":run.id})) {
                    tracing::error!("Persist failure event: {save_error}");
                }
            }
            if let Err(error) = crate::questions::finish(&app, &run) {
                tracing::error!("Close pending questions: {error}");
            }
            match app.cancellations.lock() {
                Ok(mut registry) => {
                    registry.remove(&run.id);
                }
                Err(e) => tracing::error!("Cancellation registry: {e}"),
            }
            app.wake.notify_one();
        });
    }
    Ok(())
}

fn same_queue(a: &Run, b: &Run) -> bool {
    a.side_chat_id == b.side_chat_id && (a.side_chat_id.is_none() || a.group_id == b.group_id)
}

pub(crate) fn conflicts(a: &Run, b: &Run) -> bool {
    a.session_id == b.session_id
        || (same_queue(a, b)
            && (a.agent_id == b.agent_id
                || a.profile
                    .workdir
                    .as_ref()
                    .zip(b.profile.workdir.as_ref())
                    .is_some_and(|(a, b)| {
                        if a.ssh_host.is_some() || b.ssh_host.is_some() {
                            a.identity() == b.identity()
                        } else {
                            a.canonical_path.eq_ignore_ascii_case(&b.canonical_path)
                        }
                    })))
}

pub fn cancel(app: &App, run_id: &str) -> Result<Run> {
    let run = app.store.write(|tx| {
        let mut run: Run = store::get(tx, "runs", run_id)?;
        if ["queued", "waiting"].contains(&run.status.as_str()) {
            run.status = "cancelled".into();
            run.ended_at = Some(now());
            store::put(tx, "runs", run_id, &run)?;
        }
        Ok(run)
    })?;
    if run.kind == RunKind::Coordinator {
        for child in app
            .store
            .list::<Run>("runs")?
            .into_iter()
            .filter(|r| r.parent_run_id.as_deref() == Some(run_id) && coordination::active(r))
        {
            if let Err(error) = cancel(app, &child.id) {
                // A child can finish between listing it and requesting cancellation.
                if coordination::active(&app.store.get::<Run>("runs", &child.id)?) {
                    return Err(error);
                }
            }
        }
    }
    if ["starting", "running"].contains(&run.status.as_str()) {
        let flags = app
            .cancellations
            .lock()
            .map_err(|_| anyhow::anyhow!("Cancellation registry unavailable"))?;
        flags
            .get(run_id)
            .context("Run ownership unavailable; reload status")?
            .store(true, Ordering::SeqCst);
    } else if run.status != "cancelled" {
        bail!("Run is already finished");
    }
    app.store
        .event("run.cancel_requested", json!({"run_id":run_id}))?;
    Ok(run)
}

pub(crate) fn runtime_home(app: &App, agent_id: &str) -> PathBuf {
    app.store
        .org
        .join(".state/runtime")
        .join(agent_id)
        .join("codex")
}

pub fn login_status(app: &App, agent_id: &str) -> Result<Value> {
    let mut agent: Agent = app.store.get("agents", agent_id)?;
    agent.workdir = app
        .store
        .read(|conn| crate::projects::workspace(conn, &agent))?;
    if agent.harness == Harness::Opencode {
        let settings = crate::opencode::settings(app, agent.workdir.as_ref())?;
        return Ok(
            json!({"ready":true,"message":format!("OpenCode ready · {} available models",settings.models.len()),"harness":"opencode"}),
        );
    }
    if let Some(workspace) = agent.workdir.filter(|w| w.ssh_host.is_some()) {
        let result = crate::remote::probe(&workspace);
        return Ok(
            json!({"ready":result.status=="online", "message":result.message,"version":result.version,"host":result.host}),
        );
    }
    anyhow::ensure!(!app.store.list::<Run>("runs")?.iter().any(|r|r.agent_id==agent_id&&["starting","running"].contains(&r.status.as_str())),"Wait for this agent's run before probing credentials");
    let home = runtime_home(app, agent_id);
    std::fs::create_dir_all(&home)?;
    let auth = seed_auth(&home)?;
    let output = Command::new(&app.codex)
        .args(["login", "status"])
        .env("CODEX_HOME", &home)
        .output()?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    auth.finish()?;
    Ok(
        json!({"ready":output.status.success(),"message":text.trim(),"version":app.codex_version.as_str(),"executable":app.codex,"runtime_home":home}),
    )
}

// Borrow only the selected Codex auth file. Compare before copyback so a newer
// desktop login is never overwritten by a stale scoped runtime credential.
pub(crate) struct AuthLease {
    source: Option<PathBuf>,
    original: Vec<u8>,
    target: PathBuf,
}
impl AuthLease {
    pub(crate) fn finish(self) -> Result<()> {
        if let Some(source) = self.source {
            let updated = std::fs::read(&self.target)?;
            if updated != self.original && std::fs::read(&source)? == self.original {
                store::atomic_write(&source, &updated)?;
            }
        }
        Ok(())
    }
}
pub(crate) fn seed_auth(home: &std::path::Path) -> Result<AuthLease> {
    let target = home.join("auth.json");
    let source = Some(crate::codex_settings::home()?.join("auth.json"))
        .filter(|p| p.exists() && *p != target);
    #[cfg(windows)]
    if let Some(parent) = source.as_ref().and_then(|p| p.parent()) {
        // Reuse the already-installed Windows sandbox identity, never reprovision
        // machine accounts per agent. These files remain inside protected org state.
        for relative in [
            ".sandbox/setup_marker.json",
            ".sandbox-secrets/sandbox_users.json",
        ] {
            let from = parent.join(relative);
            let to = home.join(relative);
            if from.exists() && !to.exists() {
                store::atomic_write(&to, &std::fs::read(from)?)?;
            }
        }
    }
    let original = if let Some(ref source) = source {
        let bytes = std::fs::read(source)?;
        store::atomic_write(&target, &bytes)?;
        bytes
    } else {
        Vec::new()
    };
    Ok(AuthLease {
        source,
        original,
        target,
    })
}

pub(crate) fn system_environment(command: &mut Command) {
    for key in [
        "PATH",
        "PATHEXT",
        "COMSPEC",
        "SystemRoot",
        "SYSTEMDRIVE",
        "WINDIR",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "HOME",
        "LANG",
        "TERM",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "NO_PROXY",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
}

fn execute(app: &App, run: &mut Run, cancelled: &AtomicBool) -> Result<()> {
    let mut active_time = Duration::ZERO;
    let mut answers = vec![];
    loop {
        if !execute_turn(app, run, cancelled, &mut active_time, &answers)? {
            return Ok(());
        }
        answers = crate::questions::wait_for_answers(app, run, cancelled)?;
        if answers.is_empty() {
            return Ok(());
        }
    }
}

fn execute_turn(
    app: &App,
    run: &mut Run,
    cancelled: &AtomicBool,
    active_time: &mut Duration,
    answers: &[crate::questions::QuestionRequest],
) -> Result<bool> {
    let workspace = run
        .profile
        .workdir
        .as_ref()
        .context("Attach a workdir before running this agent")?;
    let remote_host = workspace.ssh_host.clone();
    let opencode = run.profile.harness == Harness::Opencode;
    if remote_host.is_some() {
        let connection = crate::remote::probe_for(workspace, run.profile.harness);
        anyhow::ensure!(
            connection.status == "online",
            "{}: {}",
            connection.host,
            connection.message
        );
    } else {
        security::revalidate(workspace)?;
    }
    run.native_session_id = app.store.read(|c| {
        Ok(c.query_row(
            "SELECT native_id FROM sessions WHERE id=?",
            [&run.session_id],
            |r| r.get(0),
        )?)
    })?;
    let mut home = match &run.side_chat_id {
        Some(side) => app
            .store
            .org
            .join(".state/runtime")
            .join(&run.agent_id)
            .join("side-chats")
            .join(side)
            .join("codex"),
        None => runtime_home(app, &run.agent_id),
    };
    if opencode {
        home.set_file_name("opencode");
    }
    std::fs::create_dir_all(&home)?;
    let auth = if remote_host.is_none() && !opencode {
        Some(seed_auth(&home)?)
    } else {
        None
    };
    let env = if remote_host.is_none() {
        security::workdir_env(workspace)?
    } else {
        Default::default()
    };
    let tools_lease = crate::agent_tools::Lease::new(app, run)?;
    let mut secrets: Vec<String> = env.values().filter(|s| !s.is_empty()).cloned().collect();
    secrets.push(tools_lease.token().into());
    let message: Message = app.store.get("messages", &run.message_id)?;
    let organization_instructions = security::read_optional(&app.store.org.join("AGENTS.md"))?;
    let mut organization = coordination::organization_context(app, &run.agent_id)?;
    let group: Group = app.store.get("groups", &run.group_id)?;
    if let Some(project) = &group.project {
        organization.project = Some(project.clone());
        for member in &mut organization.members {
            if project.members.iter().any(|m| m.agent_id == member.id) {
                member.workdir = Some(project.workdir.identity());
                member.environment_keys = env.keys().cloned().collect();
                member.available = member.enabled;
                member.unavailable_reason = (!member.enabled).then(|| "Agent is paused".into());
            }
        }
    }
    let access = app.store.read(|conn| {
        crate::group_scope::access(conn, &store::get(conn, "groups", &run.group_id)?)
    })?;
    access.ensure_allowed(&run.agent_id, run.kind)?;
    organization.chat_lead_id = access.chat_lead_id.clone();
    let participates = access.participant_ids.contains(&run.agent_id);
    organization.group_access = Some(access);
    if run.kind == RunKind::Delegate {
        let parent: Run = app.store.get(
            "runs",
            run.parent_run_id
                .as_deref()
                .context("Delegated run has no assigner")?,
        )?;
        organization.assigned_by_id = parent.agent_id.clone();
        organization.return_results_to_id = parent.agent_id;
    }
    run.organization_context = Some(organization);
    let instruction = format!(
        "Agent: {}\nPosition: {}\nRole: {}\n\nOrganization instructions:\n{}\n\nAgent instructions:\n{}\n\nAgent AGENTS.md:\n{}",
        run.profile.name,
        run.profile.position,
        run.profile.role,
        organization_instructions,
        run.profile.instructions,
        run.profile.agents_md
    );
    store::atomic_write(&home.join("AGENTS.md"), instruction.as_bytes())?;
    let mut prompt = String::new();
    if let Some(reply) = &message.reply_to
        && participates
    {
        let quoted: Message = app.store.get("messages", reply)?;
        prompt.push_str(&format!(
            "Replying to {}:\n{}\n\n",
            quoted.sender, quoted.body
        ));
    }
    prompt.push_str(&coordination::context(app, run)?);
    prompt.push_str("\nPlatform tools are available through the enterprise MCP server. Use workspace_list and action_list to discover accessible work. Only explicit tasks cross chat boundaries; never copy unrelated histories or secrets. Cross-chat work returns asynchronously with a receipt and summary. Use chat_usage, chat_reset or chat_btw when requested; do not type slash commands as a substitute for calling tools. If project is present in your context, its members define your project manager/team and its workdir overrides defaults for every assignment in this chat. Global reporting remains in the organization snapshot. An action with no planned_start is backlog, never scheduled. Do not invoke it until asked.\n");
    prompt.push_str("\nCurrent task:\n");
    if run.kind == RunKind::Summary {
        prompt.push_str("This is a summary-only turn: report the existing worker results and answers. Do not repeat the original task or ask the owner again. The assigned worker owns clarification.\n");
    } else {
        prompt.push_str("If you need clarification, a decision or missing information from the owner, call enterprise.ask_user and wait for the answer. Use that tool instead of ending with an unanswered question, request_user_input (unavailable in exec), or reading terminal stdin. Suggested choices are optional; the owner can always write their own answer. Do not assume an answer or request credentials. A tool error or cancelled question is not approval. Continue the same task after the returned answer.\n");
    }
    prompt.push_str(run.task.as_deref().unwrap_or(&message.body));
    if !answers.is_empty() {
        prompt.push_str("\n\nThe owner has now answered your saved questions. The earlier CLI turn ended while waiting; do not wait on its expired tool/exec cell or ask these questions again. Continue the original task in this same session using these answers:\n");
        prompt.push_str(&serde_json::to_string(
            &answers
                .iter()
                .map(|q| json!({"questions":q.questions,"answers":q.answers}))
                .collect::<Vec<_>>(),
        )?);
    }
    let mut command = match &remote_host {
        Some(host) => crate::remote::command(host)?,
        None => Command::new(if opencode {
            crate::opencode::executable()?
        } else {
            app.codex.clone()
        }),
    };
    let settings = crate::opencode::settings_for(app, run.profile.harness, Some(workspace))?;
    let (selected_model, selected_reasoning) =
        settings.resolve(&run.profile.model, &run.profile.reasoning)?;
    let opencode_auth = if opencode && remote_host.is_none() {
        let lease = crate::opencode::seed_credentials(workspace, &home)?;
        secrets.extend(lease.secrets());
        Some(lease)
    } else { None };
    run.model_display_name = settings
        .models
        .iter()
        .find(|m| m.slug == selected_model)
        .map(|m| m.display_name.clone());
    let mut args = vec![
        "exec".into(),
        "--json".into(),
        "--color".into(),
        "never".into(),
        "--skip-git-repo-check".into(),
        "-c".into(),
        "cli_auth_credentials_store=\"file\"".into(),
        "-c".into(),
        format!("sandbox_mode=\"{}\"", run.profile.permission),
        "-c".into(),
        "approval_policy=\"never\"".into(),
        "-c".into(),
        format!("model_reasoning_effort=\"{}\"", selected_reasoning),
    ];
    args.extend([
        "-c".into(),
        format!("mcp_servers.enterprise.url=\"http://{}/mcp\"", app.address),
        "-c".into(),
        "mcp_servers.enterprise.bearer_token_env_var=\"AE_TOOL_TOKEN\"".into(),
        "-c".into(),
        "mcp_servers.enterprise.required=true".into(),
        "-c".into(),
        "mcp_servers.enterprise.tool_timeout_sec=86500".into(),
    ]);
    if remote_host.is_none() {
        args.push("--ignore-user-config".into());
    }
    // Windows otherwise downgrades workspace-write to read-only when no sandbox
    // implementation is selected in the isolated (ignored-config) runtime.
    #[cfg(windows)]
    if remote_host.is_none() {
        args.extend([
            "-c".into(),
            "windows.sandbox=\"elevated\"".into(),
            "-c".into(),
            "sandbox_workspace_write.exclude_tmpdir_env_var=true".into(),
            "-c".into(),
            "sandbox_workspace_write.exclude_slash_tmp=true".into(),
        ]);
    }
    if !selected_model.is_empty() {
        args.extend(["--model".into(), selected_model.clone()]);
    }
    if opencode {
        args = vec![
            "run".into(),
            "--standalone".into(),
            "--format".into(),
            "json".into(),
            "--auto".into(),
            "--model".into(),
            if selected_reasoning.is_empty() {
                selected_model.clone()
            } else {
                format!("{selected_model}#{selected_reasoning}")
            },
        ];
        if run.kind == RunKind::Coordinator {
            prompt.push_str("\nReturn ONLY a JSON object matching this schema. No Markdown fences or commentary outside the JSON:\n");
            prompt.push_str(include_str!("coordination-schema.json"));
        }
    }
    if run.kind == RunKind::Coordinator && remote_host.is_none() && !opencode {
        let schema = home.join("coordination-schema.json");
        store::atomic_write(&schema, include_bytes!("coordination-schema.json"))?;
        args.extend([
            "--output-schema".into(),
            schema.to_string_lossy().into_owned(),
        ]);
    }
    let mut remote_images = Vec::<Value>::new();
    for artifact_id in &message.artifacts {
        let artifact: Artifact = app.store.get("artifacts", artifact_id)?;
        let path = security::artifact_path(&app.store.org, &artifact.id)?;
        if artifact.media_type.starts_with("image/") {
            if remote_host.is_some() {
                use base64::Engine;
                remote_images.push(json!({"id":artifact.id,"data":base64::engine::general_purpose::STANDARD.encode(std::fs::read(path)?)}));
            } else {
                args.extend([
                    if opencode { "--file" } else { "--image" }.into(),
                    path.to_string_lossy().into_owned(),
                ]);
            }
        } else if artifact.media_type.starts_with("text/") {
            prompt.push_str(&format!(
                "\n\nAttached document {}:\n{}",
                artifact.name,
                std::fs::read_to_string(path)?
            ));
        } else {
            bail!(
                "Attachment {} cannot be sent to this harness; only text and images are supported",
                artifact.name
            );
        }
    }
    let remote_request = remote_host.as_ref().map(|_| json!({
        "op":"execute", "path":workspace.path, "workspace":workspace,
        "namespace":crate::remote::namespace(app),"session_id":run.session_id,"run_id":run.id,
        "instructions":instruction,"arguments":args,"prompt":prompt,"images":remote_images,
        "timeout_seconds":run.profile.timeout_seconds,"native_session_id":run.native_session_id,
        "tool_token":tools_lease.token(),
        "harness":run.profile.harness,"opencode_config":opencode.then(||crate::opencode::config(&home,&run.profile.permission,&selected_model,&app.address.to_string())),
        "schema":(run.kind==RunKind::Coordinator && !opencode).then(||include_str!("coordination-schema.json"))
    }));
    if let Some(native) = &run.native_session_id {
        args.extend([
            if opencode { "--session" } else { "resume" }.into(),
            native.clone(),
        ]);
    }
    if !opencode {
        args.push("-".into());
    }
    if remote_host.is_none() {
        command.args(&args).current_dir(&workspace.path).env_clear();
        system_environment(&mut command);
        command
            .envs(&env)
            .env("PWD", &workspace.path)
            .env("AE_TOOL_TOKEN", tools_lease.token())
            .env("CODEX_HOME", &home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if opencode {
            crate::opencode::environment(&mut command, Some(&home));
            command.env(
                "OPENCODE_CONFIG_CONTENT",
                crate::opencode::config(
                    &home,
                    &run.profile.permission,
                    &selected_model,
                    &app.address.to_string(),
                )
                .to_string(),
            );
        }
    }
    #[cfg(windows)]
    let (mut child, owner) =
        crate::process_tree::OwnedProcessTree::spawn_with_creation_flags(&mut command, 0x08000000)?;
    #[cfg(not(windows))]
    let (mut child, owner) = crate::process_tree::OwnedProcessTree::spawn(&mut command)?;
    run.pid = Some(child.id());
    run.status = "running".into();
    run.started_at.get_or_insert_with(now);
    run.executable = remote_host
        .as_ref()
        .map(|h| format!("ssh:{h}/{}", run.profile.harness.as_str()))
        .unwrap_or_else(|| command.get_program().to_string_lossy().into_owned());
    run.arguments = args;
    app.store.put("runs", &run.id, run)?;
    let directory = app.store.org.join(".state/sessions").join(&run.session_id);
    std::fs::create_dir_all(&directory)?;
    store::atomic_write(
        &directory.join(format!("{}.json", run.id)),
        serde_json::to_vec_pretty(run)?.as_slice(),
    )?;
    let (tx, rx) = mpsc::sync_channel::<(bool, String)>(128);
    let stdout = child.stdout.take().context("Missing stdout")?;
    let stderr = child.stderr.take().context("Missing stderr")?;
    let readers = [
        read_pipe(stdout, tx.clone(), false),
        read_pipe(stderr, tx, true),
    ];
    let mut remote_stdin = None;
    if let Some(mut stdin) = child.stdin.take() {
        if let Some(request) = remote_request {
            crate::remote::write_request(&mut stdin, request)?;
            remote_stdin = Some(stdin);
        } else {
            stdin.write_all(prompt.as_bytes())?;
        }
    }
    let mut answers_delivered = answers.is_empty();
    let mut last_tick = Instant::now();
    let mut was_waiting = false;
    let mut last_heartbeat = Instant::now();
    let mut remote_stop_at = None;
    let mut protocol = Protocol::default();
    let mut stopped = None;
    app.store.event("run.changed", json!({"run_id":run.id}))?;
    loop {
        for (is_error, line) in rx.try_iter().take(256) {
            if !protocol.capture(app, &run.id, &secrets, is_error, &line)? {
                stopped = Some("failed");
                run.error = Some("Run output exceeded 8 MiB; stopped to protect storage".into());
                break;
            }
        }
        if !answers_delivered && protocol.session.is_some() {
            for answer in answers {
                crate::questions::delivered(app, &run.id, &answer.request_id)?;
            }
            answers_delivered = true;
        }
        if let Some(metadata) = protocol.remote_started.take() {
            run.remote_pid = metadata["pid"].as_u64().and_then(|v| u32::try_from(v).ok());
            run.executable = metadata["executable"]
                .as_str()
                .unwrap_or(&run.executable)
                .into();
            run.arguments = serde_json::from_value(metadata["arguments"].clone())?;
            app.store.put("runs", &run.id, run)?;
        }
        if cancelled.load(Ordering::SeqCst) {
            stopped = Some("cancelled");
        }
        let waiting = app
            .store
            .read(|conn| crate::questions::pending(conn, &run.id))?;
        let tick = Instant::now();
        if !was_waiting {
            *active_time += tick.duration_since(last_tick);
        }
        last_tick = tick;
        if *active_time > Duration::from_secs(run.profile.timeout_seconds) {
            stopped = Some("timed_out");
        }
        if let Some(stdin) = remote_stdin.as_mut() {
            if stopped.is_some() && remote_stop_at.is_none() {
                let _ = stdin.write_all(b"cancel\n");
                remote_stop_at = Some(Instant::now());
            } else if waiting != was_waiting || last_heartbeat.elapsed() > Duration::from_secs(2) {
                if stdin
                    .write_all(if waiting {
                        b"waiting_for_input\n"
                    } else {
                        b"heartbeat\n"
                    })
                    .is_err()
                {
                    stopped = Some("interrupted");
                }
                last_heartbeat = Instant::now();
            }
        }
        was_waiting = waiting;
        if stopped.is_some()
            && (remote_host.is_none()
                || remote_stop_at.is_some_and(|time| time.elapsed() > Duration::from_secs(10)))
        {
            owner.request_stop()?;
            owner.terminate()?;
        }
        if let Some(status) = owner.try_wait(|| child.try_wait())? {
            run.exit_code = status.code();
            // Process exit can precede the pipe readers draining their final frames.
            while readers.iter().any(|r| !r.is_finished()) {
                for (is_error, line) in rx.try_iter() {
                    protocol.capture(app, &run.id, &secrets, is_error, &line)?;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            for reader in readers {
                reader
                    .join()
                    .map_err(|_| anyhow::anyhow!("Output reader panicked"))??;
            }
            for (is_error, line) in rx.try_iter() {
                protocol.capture(app, &run.id, &secrets, is_error, &line)?;
            }
            // OpenCode's CLI terminates with an exit status, not Codex's turn.completed frame.
            if opencode
                && status.success()
                && protocol.session.is_some()
                && !protocol.text.is_empty()
            {
                protocol.completed = true;
            }
            if protocol.bytes > 8 * 1024 * 1024 {
                stopped = Some("failed");
                run.error = Some("Run output exceeded 8 MiB".into());
            }
            if remote_host.is_some() && protocol.remote_finished.is_none() {
                run.status = "interrupted".into();
                run.error = Some("Remote connection ended without completion confirmation. Its heartbeat watchdog stops owned work within 15 seconds; inspect the remote workdir before retrying.".into());
            } else if let Some(state) = stopped {
                run.status = state.into();
            } else if status.success()
                && protocol.completed
                && protocol.error.is_none()
                && (!protocol.text.is_empty()
                    || !crate::questions::unresolved(app, &run.id)?.is_empty())
                && !protocol.malformed
            {
                run.status = "succeeded".into();
            } else {
                run.status = "failed".into();
                run.error = Some(protocol.error.clone().unwrap_or_else(|| {
                    format!(
                        "Harness ended without a valid completed reply (exit {:?}). {}",
                        status.code(),
                        protocol.diagnostic.trim()
                    )
                }));
            }
            if let Some(finished) = &protocol.remote_finished {
                run.exit_code = finished["exit_code"]
                    .as_i64()
                    .and_then(|v| i32::try_from(v).ok());
                if let Some(state) = finished["status"].as_str() {
                    run.status = state.into();
                }
            }
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    run.native_session_id = protocol.session.or(run.native_session_id.clone());
    if let Some(auth) = opencode_auth { auth.finish()?; }
    run.output = security::redacted(&protocol.text, &secrets);
    run.error = run
        .error
        .as_deref()
        .map(|text| security::redacted(text, &secrets));
    run.usage = protocol.usage;
    if opencode
        && run.native_session_id.is_some()
        && !["cancelled", "timed_out", "interrupted"].contains(&run.status.as_str())
    {
        match crate::opencode::usage(app, run, &home) {
            Ok(usage) => run.usage = Some(usage),
            Err(error) => {
                app.store.event(
                    "run.usage_unavailable",
                    json!({"run_id":run.id,"error":error.to_string()}),
                )?;
            }
        }
    }
    if run.status == "succeeded" && !crate::questions::unresolved(app, &run.id)?.is_empty() {
        anyhow::ensure!(
            run.native_session_id.is_some(),
            "Harness asked a question without a resumable session"
        );
        // Code-mode can end a native turn while a tool call is still waiting.
        // Keep its queue slot and resume this same session only after an answer.
        run.status = "running".into();
        run.pid = None;
        run.remote_pid = None;
        run.exit_code = None;
        app.store.write(|conn| {
            store::put(conn, "runs", &run.id, run)?;
            conn.execute(
                "UPDATE sessions SET native_id=? WHERE id=?",
                params![run.native_session_id, run.session_id],
            )?;
            store::event(conn, "run.awaiting_answer", &json!({"run_id":run.id}))?;
            Ok(())
        })?;
        if let Some(auth) = auth {
            auth.finish()?;
        }
        return Ok(true);
    }
    run.ended_at = Some(now());
    app.store.write(|tx| {
        coordination::complete(tx, run, &message, &secrets)?;
        store::put(tx, "runs", &run.id, run)?;
        if let Some(native) = &run.native_session_id {
            tx.execute(
                "UPDATE sessions SET native_id=? WHERE id=?",
                params![native, run.session_id],
            )?;
        }
        let current_access =
            crate::group_scope::access(tx, &store::get(tx, "groups", &run.group_id)?)?;
        if ["succeeded", "waiting"].contains(&run.status.as_str())
            && participates
            && current_access.participant_ids.contains(&run.agent_id)
        {
            let reply = Message {
                id: id(),
                group_id: run.group_id.clone(),
                side_chat_id: message.side_chat_id.clone(),
                sender: run.agent_id.clone(),
                body: run.output.clone(),
                recipients: vec![],
                reply_to: Some(run.message_id.clone()),
                artifacts: vec![],
                run_id: Some(run.id.clone()),
                created_at: now(),
                auto_routed: false,
                schedule_id: None,
                command: None,
                usage_report: None,
            };
            store::put(tx, "messages", &reply.id, &reply)?;
        }
        store::event(tx, "run.changed", &json!({"run_id":run.id}))?;
        Ok(())
    })?;
    store::atomic_write(
        &directory.join(format!("{}.json", run.id)),
        serde_json::to_vec_pretty(run)?.as_slice(),
    )?;
    if let Err(error) = auth.map(|auth| auth.finish()).transpose() {
        tracing::warn!("Codex credential synchronization failed: {error}");
        app.store
            .event("auth.sync_failed", json!({"agent_id":run.agent_id}))?;
    }
    Ok(false)
}

pub(crate) fn read_pipe(
    pipe: impl std::io::Read + Send + 'static,
    tx: mpsc::SyncSender<(bool, String)>,
    error: bool,
) -> std::thread::JoinHandle<Result<()>> {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(pipe);
        let mut buffer = Vec::new();
        loop {
            buffer.clear();
            let n = std::io::Read::by_ref(&mut reader)
                .take(1024 * 1024)
                .read_until(b'\n', &mut buffer)?;
            if n == 0 {
                break;
            }
            if n == 1024 * 1024 && buffer.last() != Some(&b'\n') {
                bail!("Provider frame exceeds 1 MiB");
            }
            if tx
                .send((error, String::from_utf8_lossy(&buffer).trim_end().into()))
                .is_err()
            {
                break;
            }
        }
        Ok(())
    })
}

#[derive(Default)]
struct Protocol {
    remote_started: Option<Value>,
    remote_finished: Option<Value>,
    bytes: usize,
    diagnostic: String,
    session: Option<String>,
    text: String,
    completed: bool,
    error: Option<String>,
    usage: Option<Value>,
    malformed: bool,
}
impl Protocol {
    fn capture(
        &mut self,
        app: &App,
        run_id: &str,
        secrets: &[String],
        is_error: bool,
        line: &str,
    ) -> Result<bool> {
        self.bytes = self.bytes.saturating_add(line.len());
        if self.bytes > 8 * 1024 * 1024 {
            return Ok(false);
        }
        if !is_error {
            match serde_json::from_str::<Value>(line) {
                Ok(value) => {
                    self.observe(&value);
                    if value["type"] == "item.completed"
                        && value["item"]["type"] == "mcp_tool_call"
                        && value["item"]["server"] == "enterprise"
                        && value["item"]["tool"] == "ask_user"
                        && value["item"]["status"] == "completed"
                        && !value["item"]["result"].is_null()
                    {
                        if let Some(request) = value["item"]["arguments"]["request_id"].as_str() {
                            crate::questions::delivered(app, run_id, request)?;
                        }
                    }
                    for request in opencode_question_deliveries(&value) {
                        crate::questions::delivered(app, run_id, request)?;
                    }
                }
                Err(_) => {
                    if !line.trim().is_empty() {
                        self.malformed = true;
                    }
                }
            }
        }
        let line = security::redacted(line, secrets);
        if is_error && self.diagnostic.len() < 16000 {
            self.diagnostic.push_str(&line);
            self.diagnostic.push('\n');
        }
        app.store.event(
            "run.output",
            json!({"run_id":run_id,"stderr":is_error,"line":line}),
        )?;
        Ok(true)
    }

    fn observe(&mut self, v: &Value) {
        if let Some(session) = v["sessionID"].as_str() {
            self.session = Some(session.into());
        }
        match v["type"].as_str() {
            Some("text") => {
                if let Some(text) = v["part"]["text"].as_str() {
                    self.text = text.into();
                }
            }
            Some("step_finish") => {
                self.usage = Some(v["part"].clone());
            }
            Some("ae.remote.started") => self.remote_started = Some(v.clone()),
            Some("ae.remote.finished") => self.remote_finished = Some(v.clone()),
            Some("thread.started") => self.session = v["thread_id"].as_str().map(str::to_owned),
            Some("item.completed") if v["item"]["type"] == "agent_message" => {
                if let Some(t) = v["item"]["text"].as_str() {
                    self.text = t.into();
                }
            }
            Some("turn.completed") => {
                self.completed = true;
                self.usage = Some(v["usage"].clone());
            }
            Some("turn.failed") => {
                self.error = Some(
                    v["error"]["message"]
                        .as_str()
                        .unwrap_or("Codex turn failed")
                        .into(),
                )
            }
            Some("error") => {
                self.error = Some(
                    v["message"]
                        .as_str()
                        .or_else(|| v["error"]["message"].as_str())
                        .or_else(|| v["error"]["data"]["message"].as_str())
                        .unwrap_or("Harness protocol error")
                        .into(),
                )
            }
            _ => {}
        }
    }
}

fn opencode_question_deliveries(value: &Value) -> Vec<&str> {
    if value["type"] != "tool_use" || value["part"]["state"]["status"] != "completed" {
        return vec![];
    }
    let state = &value["part"]["state"];
    if value["part"]["tool"] == "enterprise_ask_user" {
        return state["input"]["request_id"].as_str().into_iter().collect();
    }
    state["metadata"]["metadata"]["toolCalls"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|call| call["tool"] == "enterprise.ask_user" && call["status"] == "completed")
        .filter_map(|call| call["input"]["request_id"].as_str())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn opencode_events_preserve_session_reply_and_errors() {
        let mut p = Protocol::default();
        p.observe(
            &json!({"type":"text","sessionID":"ses_native","part":{"text":"OpenCode reply"}}),
        );
        assert_eq!(p.session.as_deref(), Some("ses_native"));
        assert_eq!(p.text, "OpenCode reply");
        assert!(!p.completed);
        let mut event = json!({"type":"tool_use","part":{"tool":"execute","state":{"status":"completed","metadata":{"metadata":{"toolCalls":[{"tool":"enterprise.ask_user","status":"completed","input":{"request_id":"native-question"}}]}}}}});
        assert_eq!(
            opencode_question_deliveries(&event),
            vec!["native-question"]
        );
        event["part"]["state"]["metadata"]["metadata"]["toolCalls"][0]["status"] = "error".into();
        assert!(opencode_question_deliveries(&event).is_empty());
        p.observe(&json!({"type":"error","error":{"message":"Free model unavailable"}}));
        assert_eq!(p.error.as_deref(), Some("Free model unavailable"));
    }
    #[test]
    fn completed_message_is_not_completed_turn() {
        let mut p = Protocol::default();
        p.observe(&json!({"type":"item.completed","item":{"type":"agent_message","text":"hello"}}));
        assert!(!p.completed);
        p.observe(&json!({"type":"turn.completed","usage":{"input_tokens":4}}));
        assert!(p.completed);
        assert_eq!(p.text, "hello");
        p.observe(&json!({"type":"turn.failed","error":{"message":"failed"}}));
        assert_eq!(p.error.as_deref(), Some("failed"));
    }
}
