// Reuse OpenSSH's config, host verification and SSH_ASKPASS contract. Secrets use
// Windows DPAPI; neither SSH arguments nor the public profile contain them.
use crate::{App, model::*, remote, security::ApiResult, store};
use anyhow::{Context, Result, ensure};
use axum::{
    Json,
    extract::{Path, State},
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    process::Command,
    sync::{Mutex, OnceLock},
};
use ts_rs::TS;

#[derive(Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Workstation {
    pub id: String,
    pub name: String,
    pub hostname: String,
    pub host_ip: String,
    pub port: u16,
    pub username: String,
    pub auth: String,
    pub ssh_alias: String,
    pub ssh_key_path: String,
    #[serde(default)]
    pub secret_saved: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SaveInput {
    pub workstation: Workstation,
    pub secret: Option<String>,
    #[serde(default)]
    pub clear_secret: bool,
}

struct Registry {
    root: PathBuf,
    hosts: BTreeMap<String, Workstation>,
}
static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();

fn secret_path(root: &std::path::Path, id: &str) -> PathBuf {
    root.join("ssh-secrets").join(format!("{id}.dpapi"))
}

pub fn list(store: &store::Store) -> Result<Vec<Workstation>> {
    let mut hosts = store.list::<Workstation>("workstations")?;
    for host in &mut hosts {
        host.secret_saved = secret_path(&store.org.join(".state"), &host.id).is_file();
    }
    hosts.sort_by_cached_key(|h| h.name.to_lowercase());
    Ok(hosts)
}

pub fn initialize(store: &store::Store) -> Result<()> {
    let mut aliases = BTreeSet::new();
    for agent in store.list::<Agent>("agents")? {
        if let Some(host) = agent.workdir.and_then(|w| w.ssh_host) {
            aliases.insert(host);
        }
    }
    for group in store.list::<Group>("groups")? {
        if let Some(host) = group.project.and_then(|p| p.workdir.ssh_host) {
            aliases.insert(host);
        }
    }
    let existing: BTreeSet<_> = list(store)?.into_iter().map(|h| h.id).collect();
    for alias in aliases.difference(&existing) {
        // Import only referenced aliases; no saved workdir/session IDs are rewritten.
        let host = imported(alias)?;
        store.put("workstations", &host.id, &host)?;
    }
    ensure!(
        REGISTRY
            .set(Mutex::new(Registry {
                root: store.org.join(".state"),
                hosts: list(store)?
                    .into_iter()
                    .map(|h| (h.id.clone(), h))
                    .collect(),
            }))
            .is_ok(),
        "Workstations already initialized"
    );
    Ok(())
}

fn imported(alias: &str) -> Result<Workstation> {
    remote::validate_host(alias)?;
    let mut command = Command::new("ssh");
    command.args(["-G", alias]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let result = command.output().context("OpenSSH is unavailable")?;
    ensure!(result.status.success(), "Cannot read this SSH alias");
    let text = String::from_utf8(result.stdout)?;
    let values: BTreeMap<_, _> = text
        .lines()
        .filter_map(|line| line.split_once(' '))
        .collect();
    Ok(Workstation {
        id: alias.into(),
        name: alias.into(),
        hostname: values.get("hostname").unwrap_or(&alias).to_string(),
        host_ip: String::new(),
        port: values.get("port").unwrap_or(&"22").parse()?,
        username: values.get("user").unwrap_or(&"").to_string(),
        auth: "ssh_config".into(),
        ssh_alias: alias.into(),
        ssh_key_path: String::new(),
        secret_saved: false,
    })
}

fn validate(host: &Workstation) -> Result<()> {
    remote::validate_host(&host.id)?;
    ensure!(
        !host.name.trim().is_empty() && host.name.len() <= 100,
        "Name must contain 1–100 bytes"
    );
    remote::validate_host(&host.hostname).context("Use a hostname or IPv4 address")?;
    ensure!(
        host.host_ip.is_empty() || host.host_ip.parse::<std::net::IpAddr>().is_ok(),
        "Host IP is invalid"
    );
    ensure!(host.port > 0, "Port must be between 1 and 65535");
    ensure!(
        !host.username.is_empty()
            && host.username.len() <= 100
            && host
                .username
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "._-\\@".contains(c)),
        "Enter a valid SSH username"
    );
    ensure!(
        ["ssh_config", "key", "password"].contains(&host.auth.as_str()),
        "Choose SSH config, key, or password"
    );
    if host.auth == "ssh_config" {
        remote::validate_host(&host.ssh_alias)?;
    }
    if host.auth == "key" {
        let path = std::path::Path::new(&host.ssh_key_path);
        ensure!(
            path.is_absolute() && path.is_file() && !host.ssh_key_path.contains(['\n', '\r', '"']),
            "Choose an existing absolute SSH private-key file on this machine"
        );
    }
    Ok(())
}

fn uses(workspace: Option<&Workspace>, id: &str) -> bool {
    workspace.and_then(|w| w.ssh_host.as_deref()) == Some(id)
}

fn ensure_idle(conn: &rusqlite::Connection, id: &str) -> Result<()> {
    ensure!(
        !store::list::<Run>(conn, "runs")?
            .iter()
            .any(|r| crate::coordination::active(r) && uses(r.profile.workdir.as_ref(), id)),
        "Wait for this workstation's active runs before changing its connection"
    );
    ensure!(
        !store::list::<crate::terminal::TerminalRun>(conn, "terminal_runs")?
            .iter()
            .any(|r| r.status == "running" && r.canonical_cwd.starts_with(&format!("ssh://{id}/"))),
        "Stop this workstation's terminal commands first"
    );
    Ok(())
}

pub async fn save(State(app): State<App>, Json(input): Json<SaveInput>) -> ApiResult<Workstation> {
    let mut host = input.workstation;
    if host.id.is_empty() {
        host.id = format!("ws-{}", id());
    }
    validate(&host)?;
    let root = app.store.org.join(".state");
    let path = secret_path(&root, &host.id);
    let encrypted = input
        .secret
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|secret| {
            ensure!(
                secret.len() <= 1000 && !secret.contains(['\n', '\r', '\0']),
                "Password/passphrase must be one line, at most 1000 bytes"
            );
            protect(secret.as_bytes(), false)
        })
        .transpose()?;
    if host.auth == "password" && encrypted.is_none() && (input.clear_secret || !path.is_file()) {
        return Err(anyhow::anyhow!("Enter a password for password authentication").into());
    }
    let registry = REGISTRY.get().context("Workstations unavailable")?;
    let mut registry = registry
        .lock()
        .map_err(|_| anyhow::anyhow!("Workstation lock poisoned"))?;
    let changed_destination = registry.hosts.get(&host.id).is_some_and(|old| {
        (
            &old.hostname,
            &old.host_ip,
            old.port,
            &old.username,
            &old.ssh_alias,
        ) != (
            &host.hostname,
            &host.host_ip,
            host.port,
            &host.username,
            &host.ssh_alias,
        )
    });
    app.store.write(|tx| {
        ensure_idle(tx, &host.id)?;
        if let Some(encrypted) = &encrypted {
            store::atomic_write(&path, encrypted)?;
        } else if input.clear_secret && path.exists() {
            std::fs::remove_file(&path)?;
        }
        host.secret_saved = path.is_file();
        store::put(tx, "workstations", &host.id, &host)?;
        // A changed destination must never resume a thread belonging to the old host.
        if changed_destination {
            let prefix = format!("ssh://{}/", host.id);
            tx.execute(
                "UPDATE sessions SET active=0 WHERE substr(workspace,1,length(?1))=?1",
                [&prefix],
            )?;
        }
        store::event(tx, "workstation.saved", &json!({"id":host.id}))?;
        Ok(())
    })?;
    registry.hosts.insert(host.id.clone(), host.clone());
    remote::invalidate(&host.id);
    Ok(Json(host))
}

#[derive(Deserialize)]
pub struct ImportInput {
    pub alias: String,
}
pub async fn import(
    State(app): State<App>,
    Json(input): Json<ImportInput>,
) -> ApiResult<Workstation> {
    let host = tokio::task::spawn_blocking(move || imported(&input.alias))
        .await
        .map_err(anyhow::Error::from)??;
    if list(&app.store)?.iter().any(|h| h.id == host.id) {
        return Err(anyhow::anyhow!("This SSH alias is already saved").into());
    }
    save(
        State(app),
        Json(SaveInput {
            workstation: host,
            secret: None,
            clear_secret: false,
        }),
    )
    .await
}

pub async fn remove(State(app): State<App>, Path(id): Path<String>) -> ApiResult<Value> {
    remote::validate_host(&id)?;
    let mut registry = REGISTRY
        .get()
        .context("Workstations unavailable")?
        .lock()
        .map_err(|_| anyhow::anyhow!("Workstation lock poisoned"))?;
    app.store.write(|tx| {
        ensure_idle(tx, &id)?;
        ensure!(
            !store::list::<Agent>(tx, "agents")?
                .iter()
                .any(|a| uses(a.workdir.as_ref(), &id))
                && !store::list::<Group>(tx, "groups")?
                    .iter()
                    .any(|g| uses(g.project.as_ref().map(|p| &p.workdir), &id)),
            "Detach this workstation from agents and projects before removing it"
        );
        tx.execute("DELETE FROM workstations WHERE id=?", [&id])?;
        store::event(tx, "workstation.deleted", &json!({"id":id}))?;
        Ok(())
    })?;
    registry.hosts.remove(&id);
    let path = secret_path(&registry.root, &id);
    if path.exists() {
        std::fs::remove_file(path).context("Cannot remove the saved SSH credential")?;
    }
    remote::invalidate(&id);
    Ok(Json(json!({"removed":true})))
}

pub async fn test(State(app): State<App>, Path(id): Path<String>) -> ApiResult<Value> {
    let _: Workstation = app.store.get("workstations", &id)?;
    Ok(Json(
        tokio::task::spawn_blocking(move || {
            let directories = remote::call(&id, json!({"op":"directories","path":""}))?;
            let workspace = remote::validate_workspace(
                &id,
                directories["path"]
                    .as_str()
                    .context("Missing home directory")?,
            )?;
            Ok::<_, anyhow::Error>(
                json!({"connection":remote::probe(&workspace),"home":workspace.path}),
            )
        })
        .await
        .map_err(anyhow::Error::from)??,
    ))
}

#[derive(Deserialize)]
pub struct TrustInput {
    fingerprints: Vec<String>,
}

fn scan(host: &Workstation) -> Result<(String, Vec<String>)> {
    validate(host)?;
    let address = if host.host_ip.is_empty() {
        &host.hostname
    } else {
        &host.host_ip
    };
    let mut command = Command::new("ssh-keyscan");
    command.args([
        "-T",
        "5",
        "-p",
        &host.port.to_string(),
        "-t",
        "ed25519,ecdsa,rsa",
        address,
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let result = command.output().context("OpenSSH host-key scan failed")?;
    ensure!(
        result.status.success() && result.stdout.len() < 65536,
        "Host did not return SSH keys; check its address and port"
    );
    let text = String::from_utf8(result.stdout)?;
    let mut keys = String::new();
    let mut fingerprints = Vec::new();
    for line in text
        .lines()
        .filter(|l| !l.starts_with('#') && !l.is_empty())
    {
        let fields: Vec<_> = line.split_whitespace().collect();
        ensure!(fields.len() == 3, "Invalid SSH host key");
        let key = base64::engine::general_purpose::STANDARD.decode(fields[2])?;
        fingerprints.push(format!(
            "{} SHA256:{}",
            fields[1],
            base64::engine::general_purpose::STANDARD_NO_PAD.encode(Sha256::digest(key))
        ));
        keys.push_str(line);
        keys.push('\n');
    }
    fingerprints.sort();
    ensure!(!fingerprints.is_empty(), "Host did not return SSH keys");
    Ok((keys, fingerprints))
}

pub async fn host_keys(State(app): State<App>, Path(id): Path<String>) -> ApiResult<Value> {
    let host = app.store.get::<Workstation>("workstations", &id)?;
    let (_, fingerprints) = tokio::task::spawn_blocking(move || scan(&host))
        .await
        .map_err(anyhow::Error::from)??;
    Ok(Json(json!({"fingerprints": fingerprints})))
}

pub async fn trust(
    State(app): State<App>,
    Path(id): Path<String>,
    Json(input): Json<TrustInput>,
) -> ApiResult<Value> {
    let host = app.store.get::<Workstation>("workstations", &id)?;
    let (keys, fingerprints) = tokio::task::spawn_blocking(move || scan(&host))
        .await
        .map_err(anyhow::Error::from)??;
    if input.fingerprints != fingerprints {
        return Err(anyhow::anyhow!(
            "Host keys changed after review. Check their fingerprints again."
        )
        .into());
    }
    app.store.write(|tx| {
        ensure_idle(tx, &id)?;
        let file = app.store.org.join(".state/ssh_known_hosts");
        let mut known = crate::security::read_optional(&file)?;
        for key in keys.lines() {
            if !known.lines().any(|line| line == key) {
                known.push_str(key);
                known.push('\n');
            }
        }
        store::atomic_write(&file, known.as_bytes())?;
        store::event(
            tx,
            "workstation.trusted",
            &json!({"id":id,"fingerprints":fingerprints}),
        )?;
        Ok(())
    })?;
    Ok(Json(json!({"trusted":true})))
}

pub fn configure(command: &mut Command, id: &str) -> Result<String> {
    let Some(registry) = REGISTRY.get() else {
        return Ok(id.into());
    };
    let registry = registry
        .lock()
        .map_err(|_| anyhow::anyhow!("Workstation lock poisoned"))?;
    let Some(host) = registry.hosts.get(id) else {
        ensure!(
            !id.starts_with("ws-"),
            "Saved workstation is unavailable; choose another workstation"
        );
        return Ok(id.into()); // Existing aliases and historical profiles remain compatible.
    };
    validate(host)?;
    let target = if host.auth == "ssh_config" {
        host.ssh_alias.clone()
    } else {
        host.hostname.clone()
    };
    let address = if host.host_ip.is_empty() {
        &host.hostname
    } else {
        &host.host_ip
    };
    command.args([
        "-o",
        &format!("HostName={address}"),
        "-p",
        &host.port.to_string(),
        "-l",
        &host.username,
    ]);
    if host.auth != "ssh_config" {
        command.args(["-F", "none"]);
        let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .context("Missing home directory")?;
        let user_keys = PathBuf::from(home).join(".ssh/known_hosts");
        let app_keys = registry.root.join("ssh_known_hosts");
        command.args([
            "-o",
            &format!(
                "UserKnownHostsFile=\"{}\" \"{}\"",
                app_keys.to_string_lossy().replace('\\', "/"),
                user_keys.to_string_lossy().replace('\\', "/")
            ),
        ]);
    }
    if host.auth == "key" {
        command.args([
            "-i",
            &host.ssh_key_path,
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "PreferredAuthentications=publickey",
        ]);
    }
    if host.auth == "password" {
        command.args([
            "-o",
            "PreferredAuthentications=password",
            "-o",
            "PubkeyAuthentication=no",
        ]);
    }
    let path = secret_path(&registry.root, id);
    if host.auth != "ssh_config" && path.is_file() {
        command.args(["-o", "BatchMode=no", "-o", "NumberOfPasswordPrompts=1"]);
        command
            .env("SSH_ASKPASS", std::env::current_exe()?)
            .env("SSH_ASKPASS_REQUIRE", "force")
            .env("AE_SSH_ASKPASS_FILE", path)
            .env("DISPLAY", "ae:0");
    } else {
        command.args(["-o", "BatchMode=yes"]);
    }
    Ok(target)
}

// Only OpenSSH's password/passphrase request is answered; never host-trust prompts.
pub fn askpass() -> Result<bool> {
    let Some(path) = std::env::var_os("AE_SSH_ASKPASS_FILE") else {
        return Ok(false);
    };
    let prompt = std::env::args().nth(1).unwrap_or_default().to_lowercase();
    ensure!(
        std::env::args_os().len() == 2
            && (prompt.contains("password") || prompt.contains("passphrase"))
            && std::env::var("SSH_ASKPASS_PROMPT").as_deref() != Ok("confirm"),
        "Unsupported SSH prompt"
    );
    let secret = protect(&std::fs::read(path)?, true)?;
    use std::io::Write;
    std::io::stdout().write_all(&secret)?;
    std::io::stdout().write_all(b"\n")?;
    Ok(true)
}

#[cfg(windows)]
fn protect(bytes: &[u8], decrypt: bool) -> Result<Vec<u8>> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len().try_into()?,
        pbData: bytes.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // DPAPI owns the output allocation, released with LocalFree after copying.
    unsafe {
        let ok = if decrypt {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        ensure!(
            ok != 0,
            "Windows could not protect/unlock the SSH credential for this account"
        );
        let result = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData.cast());
        Ok(result)
    }
}

#[cfg(not(windows))]
fn protect(_: &[u8], _: bool) -> Result<Vec<u8>> {
    anyhow::bail!(
        "Saved passwords/passphrases require the Windows deployment; use an SSH key or agent on this host"
    )
}

#[cfg(test)]
mod tests {
    #[test]
    #[cfg(windows)]
    fn credentials_are_encrypted_for_the_current_windows_user() -> anyhow::Result<()> {
        let value = b"test-only-password-731";
        let encrypted = super::protect(value, false)?;
        assert!(!encrypted.windows(value.len()).any(|w| w == value));
        assert_eq!(super::protect(&encrypted, true)?, value);
        assert!(super::protect(b"damaged", true).is_err());
        Ok(())
    }
}
