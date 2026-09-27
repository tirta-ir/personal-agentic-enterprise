# Agentic Enterprise

<p align="center"><img src="src/frontend/public/agentic-enterprise-logo.png" alt="Agentic Enterprise" width="180"></p>

A native workspace for agent groups, project chats, delegated work, knowledge, and local or SSH workspaces. Optional decentralized workers add Matrix transport and isolated runtimes.

## Run locally

Requirements: Windows, PowerShell 7, Rust, Node.js/npm, Git, and a signed-in Codex CLI. From the repository root:

```powershell
pwsh -NoProfile -File src/scripts/Build.ps1
pwsh -NoProfile -File src/scripts/Start.ps1
```

Open `http://127.0.0.1:8765` and sign in with the key created under `org/.state/owner.key`. Stop with `pwsh -NoProfile -File src/scripts/Stop.ps1`.

## Maintain

From `src`:

```powershell
cargo fmt --all --check
cargo test --workspace --locked
Set-Location frontend
npm run lint
npm run build
```

See [platform documentation](src/README.md), [deployment and worker setup](src/DEPLOYMENT.md), [verification](src/VERIFICATION.md), and [upstream sources](src/UPSTREAM.md). `org/` and `workdir/` contain local state and attached codebases; both are excluded from Git.
