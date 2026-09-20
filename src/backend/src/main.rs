mod actions;
mod agent_tools;
mod api;
mod chat_commands;
mod codex_rpc;
mod codex_settings;
mod codex_usage;
mod coordination;
mod group_scope;
mod knowledge;
mod model;
mod process_tree;
mod projects;
mod questions;
mod remote;
mod run_files;
mod runtime;
mod schedules;
mod security;
mod skills;
mod store;
mod terminal;
mod workspaces;
mod workstations;

use anyhow::{Context, Result};
use clap::Parser;
use fs2::FileExt;
use std::{
    collections::HashMap,
    net::{Ipv4Addr, SocketAddrV4},
    path::PathBuf,
    sync::{Arc, Mutex, atomic::AtomicBool},
};
use tokio::sync::Notify;

#[derive(Parser)]
#[command(
    name = "agentic-enterprise",
    version,
    about = "Native personal agent workspace"
)]
struct Args {
    #[arg(long, default_value = "../org")]
    org: PathBuf,
    #[arg(long, default_value = "8765")]
    port: u16,
    /// Specific local IPv4 address to listen on (wildcards are not allowed).
    #[arg(long, default_value = "127.0.0.1")]
    bind: Ipv4Addr,
    #[arg(long, default_value = "frontend/dist")]
    frontend: PathBuf,
    #[arg(long)]
    codex: Option<PathBuf>,
    #[arg(long)]
    export_types: bool,
}

#[derive(Clone)]
pub struct App {
    store: Arc<store::Store>,
    token: Arc<String>,
    address: SocketAddrV4,
    codex: PathBuf,
    codex_version: Arc<String>,
    wake: Arc<Notify>,
    cancellations: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    knowledge: Arc<knowledge::Knowledge>,
    tool_tokens: Arc<Mutex<HashMap<String, String>>>,
}

#[tokio::main]
async fn main() -> Result<()> {
    if workstations::askpass()? {
        return Ok(());
    }
    tracing_subscriber::fmt()
        .with_env_filter("agentic_enterprise=info")
        .init();
    let args = Args::parse();
    if args.export_types {
        use ts_rs::TS;
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../frontend/src/bindings");
        model::StateView::export_all_to(&directory)?;
        model::Message::export_all_to(&directory)?;
        model::Event::export_all_to(&directory)?;
        codex_settings::CodexSettings::export_all_to(&directory)?;
        workspaces::DirectoryView::export_all_to(&directory)?;
        terminal::TerminalRun::export_all_to(&directory)?;
        skills::SkillList::export_all_to(&directory)?;
        return Ok(());
    }
    anyhow::ensure!(
        !args.bind.is_unspecified() && !args.bind.is_multicast() && !args.bind.is_broadcast(),
        "Use a specific local IPv4 address, not a wildcard, multicast or broadcast address"
    );
    let address = SocketAddrV4::new(args.bind, args.port);
    std::fs::create_dir_all(&args.org)?;
    let org = args.org.canonicalize()?;
    std::fs::create_dir_all(org.join(".state"))?;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(org.join(".state/service.lock"))?;
    lock.try_lock_exclusive()
        .context("Another Agentic Enterprise instance owns this organization")?;
    let token_path = org.join(".state/owner.key");
    let token = if token_path.exists() {
        std::fs::read_to_string(&token_path)?
    } else {
        let value = format!("{}{}", model::id(), model::id());
        store::atomic_write(&token_path, value.as_bytes())?;
        value
    };
    let codex = args.codex.unwrap_or_else(|| PathBuf::from("codex"));
    let version = std::process::Command::new(&codex)
        .arg("--version")
        .output()
        .context("Codex CLI not found; pass --codex with its executable path")?;
    anyhow::ensure!(version.status.success(), "Codex version probe failed");
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .with_context(|| format!("Cannot listen on {address}"))?;
    let store = Arc::new(store::Store::open(org.clone())?);
    workstations::initialize(&store)?;
    for agent in store.list::<model::Agent>("agents")? {
        store.materialize(&agent)?;
    }
    let app = App {
        store,
        tool_tokens: Arc::new(Mutex::new(HashMap::new())),
        token: Arc::new(token.trim().to_owned()),
        address,
        codex,
        codex_version: Arc::new(String::from_utf8_lossy(&version.stdout).trim().to_owned()),
        wake: Arc::new(Notify::new()),
        cancellations: Arc::new(Mutex::new(HashMap::new())),
        knowledge: Arc::new(knowledge::Knowledge::new(org.join(".state"))),
    };
    runtime::start_queue(app.clone());
    remote::start_monitor(app.clone());
    tracing::info!(url=%format!("http://{address}"), org=%org.display(),"Agentic Enterprise ready");
    axum::serve(listener, api::router(app, args.frontend))
        .with_graceful_shutdown(async {
            if let Err(e) = tokio::signal::ctrl_c().await {
                tracing::error!("Signal listener: {e}");
            }
            if let Err(e) = process_tree::force_terminate_owned() {
                tracing::error!("Process cleanup: {e}");
            }
        })
        .await?;
    Ok(())
}
