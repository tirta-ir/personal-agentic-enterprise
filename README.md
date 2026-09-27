# Agentic Enterprise

<p align="center"><img src="src/frontend/public/agentic-enterprise-logo.png" alt="Agentic Enterprise" width="180"></p>

A native desktop-hosted workspace for agent groups, project chats, delegated work, knowledge, and local or SSH workspaces. The Rust service serves the React app and runs Codex CLI or OpenCode.

## Run

Requirements: Windows, PowerShell 7, Rust, Node.js/npm, Git, and a signed-in Codex CLI. From the repository root:

```powershell
pwsh -NoProfile -File src/scripts/Build.ps1
pwsh -NoProfile -File src/scripts/Start.ps1
```

Open `http://127.0.0.1:8765` and sign in with the owner key created under `org/.state/owner.key`. Stop with `pwsh -NoProfile -File src/scripts/Stop.ps1`.

## Maintain

From `src`:

```powershell
cargo fmt --all --check
cargo test --workspace --locked
Set-Location frontend
npm run lint
npm run build
```

For app setup, configuration, and smoke-test guidance, see [platform docs](src/README.md) and [verification](src/VERIFICATION.md). Upstream components and licenses are listed in [UPSTREAM.md](src/UPSTREAM.md).

`org/` stores local organization data and runtime state; `workdir/` is for attached codebases. Both are excluded from Git.
