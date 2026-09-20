# Agentic Enterprise

A personal agent workspace with group and project chats, organization reporting lines, scoped delegation, an action board, knowledge, and local or remote workdirs. A native Rust backend serves a React/TypeScript frontend using shadcn UI and runs agents through Codex CLI.

## Layout

- `src/` — platform code, migrations, build scripts, tests, and upstream licenses.
- `PRD.md` — product requirements and accepted behavior.
- `org/` — local organization data, sessions, and runtime state; excluded from Git.
- `workdir/` — attached local codebases; excluded from Git.

## Native Windows setup

Install Rust, Node.js/npm, PowerShell 7, Git, and Codex CLI, then sign in to Codex. From this directory:

```powershell
pwsh -NoProfile -File src/scripts/Build.ps1
pwsh -NoProfile -File src/scripts/Start.ps1
```

Fresh deployments listen at `http://127.0.0.1:8765`. The sign-in key is generated in `org/.state/owner.key`. No Docker is required. Stop the service with:

```powershell
pwsh -NoProfile -File src/scripts/Stop.ps1
```

See [platform documentation](src/README.md) for installation, remote workstations, configuration, and feature usage; [verification](src/VERIFICATION.md) for execution evidence; and [upstream sources](src/UPSTREAM.md) for reused code and licenses.
