# Decentralized workspaces

The controller stores organizations, room history, schedules and run evidence. Each
workspace has a separate organization database, sessions, files and agent hierarchy.
Workers connect outbound, own their native CLI login and workdir, and register with
one workspace. No inbound SSH server is needed for a registered worker.

## Install

Native installers build the checked-out source using the committed Cargo/npm lockfiles.
They are source installers, so the first build requires several GB of disk and RAM.
Linux x64/ARM64, Apple Silicon and Windows x64 include ONNX Runtime for knowledge
indexing. Intel macOS workers run natively; controller knowledge indexing needs a
manually supplied ONNX 1.24.4 library or Docker because upstream has no Intel Mac binary.
Use `AE_REF` to select a reviewed branch, commit or tag. The commands below install
this development branch. Switch both the raw URL and `AE_REF` to a release or `main`
after the changes are merged.

Windows (PowerShell, Git, Node 22+, Rust 1.94+, Visual Studio C++ Build Tools):

```powershell
$env:AE_REF='codex/decentralized-workspaces'; irm https://raw.githubusercontent.com/tirta-ir/personal-agentic-enterprise/codex/decentralized-workspaces/src/install.ps1 | iex
```

Linux (Debian/Ubuntu; sudo for native build dependencies):

```sh
curl -fsSL https://raw.githubusercontent.com/tirta-ir/personal-agentic-enterprise/codex/decentralized-workspaces/src/install.sh | AE_REF=codex/decentralized-workspaces bash
```

macOS (Homebrew and Xcode command line tools):

```sh
curl -fsSL https://raw.githubusercontent.com/tirta-ir/personal-agentic-enterprise/codex/decentralized-workspaces/src/install.sh | AE_REF=codex/decentralized-workspaces bash
```

Docker (Docker Compose, Git, OpenSSL):

```sh
curl -fsSL https://raw.githubusercontent.com/tirta-ir/personal-agentic-enterprise/codex/decentralized-workspaces/src/install-docker.sh | AE_REF=codex/decentralized-workspaces bash
```

The Docker installer provisions Synapse, a private bridge identity and the platform.
Default ports are loopback-only: platform `18766`, Matrix `18767`. Change ports through
`AE_PORT` / `AE_MATRIX_PORT` and set the exact browser origin in `AE_PUBLIC_URL`.
For access outside a trusted private network, terminate HTTPS at your reverse proxy;
do not expose an unencrypted public listener. Forward Host unchanged. `AE_INTERNAL_URL`
is the explicitly trusted Docker service address, not a forwarded-header wildcard.

The first owner signs in with `/data/org/.state/owner.key` (native: `org/.state/owner.key`).
Retrieve it locally with `docker compose exec platform cat /data/org/.state/owner.key`.
Keep this bootstrap key private. It retains the original organization's local/SSH access.
New workspaces only execute through their registered runtimes.

## People and Matrix

Configure an existing homeserver with `AE_MATRIX_HOMESERVER`, `AE_MATRIX_BOT_USERNAME`
and `AE_MATRIX_BOT_PASSWORD`, or use the bundled Synapse. To create a human account on
the bundled server, run the interactive command:

```sh
docker compose exec matrix register_new_matrix_user -c /data/homeserver.yaml http://localhost:8008
```

Humans sign in with Matrix credentials. The platform issues an expiring, server-side,
revocable session in an HttpOnly/SameSite cookie; it does not store human passwords.
Create/rename/delete/restore workspaces and invite Matrix IDs in **Manage workspaces**.
Each workspace has an owner and members. Owners administer it; members can read and
post in invited rooms. Revocation is checked on every HTTP request. Deletion retains
history, disables dispatch and rejects access until an owner restores it.

Groups invite people and agents. Selecting an agent includes its reporting ancestors;
the UI expands a selected manager's descendants and lets you remove individual branches.
Excluded branches cannot receive delegated work. Projects retain their own custom hierarchy.
Legacy level-based groups remain readable and are converted to explicit members when saved.

Ordinary messages do not run agents. Use the **@** picker or complete `@name` / `@id`
mentions; `@all` addresses enabled participants (maximum eight per message). Scheduled
work must explicitly mention an agent; old schedules without a target pause with an error.
The automatic chat-lead controls have been removed.

The `matrix-sdk` 0.18 client creates private rooms, reconciles human membership, imports
native Matrix text events, and publishes platform main-room messages and agent replies.
The bridge labels the originating human/agent in Matrix; it does not impersonate native
Matrix users. Matrix event IDs and transaction IDs prevent duplicate delivery. The platform
checks tenant and group authorization before a Matrix event can invoke an agent.
Side chats and file attachments currently remain in the platform; this is a text-room bridge.
Rooms are not end-to-end encrypted: the trusted homeserver and agent bridge can read their
content. Do not enable room encryption in another client; encrypted events are not supported.

## Register a runtime

1. Sign in to the native Codex or OpenCode CLI on the worker machine. Refresh its model
   catalog using the native CLI. Provider credentials are never uploaded to the controller.
2. In **User settings → Persistent runtimes**, register a runtime. Copy the one-use token
   (expires after 15 minutes).
3. Set `AE_ENROLLMENT_TOKEN` and `AE_CONTROLLER_URL` on the worker. Run:

```sh
agentic-enterprise --worker --worker-state /private/worker-state --worker-root /absolute/workdir
```

Both Windows and Unix support the same flags (use an absolute Windows workdir on Windows).
After first enrollment the persistent registration is reused; the enrollment token is not
needed again. `--enroll-only` registers without starting the polling loop. Running the native
installer with `AE_CONTROLLER_URL` set also installs a Windows scheduled task, Linux user
systemd service, or macOS LaunchAgent. Linux users can enable lingering for pre-login startup.

Choose the registered runtime and absolute workdir in the agent/project settings. Validation
runs on that worker and checks canonical path identity and containment in its declared root.
The controller does not need a local CLI or provider credentials. Runtime revocation prevents
further claims and cancels its outstanding jobs.

For Docker, set the enrollment token in `.env` and run `docker compose --profile worker up -d --build worker`.
That command adds a worker beside the bundled controller. On a separate runtime machine,
export `AE_CONTROLLER_URL` and `AE_ENROLLMENT_TOKEN` before the Docker one-line installer.
It uses `compose.worker.yaml` and starts only the worker. `AE_WORKDIR` optionally selects
an absolute host directory; otherwise a named workdir volume is used. `AE_CODEX_HOME`
optionally selects a dedicated signed-in Codex directory. Without it, credentials live in
a named volume; complete native sign-in with the command printed by the installer.
The worker sends outbound requests to the exact existing platform URL; expose that
controller through the documented private-network/HTTPS configuration first.

The worker image includes Codex; custom images can add other native harness executables.
Its scoped seccomp profile retains Docker filtering while allowing unprivileged namespace
and mount operations needed by Codex bubblewrap. It does not grant host capabilities,
privileged mode, or override the agent's read-only/workspace-write permission. This follows
the [documented nested sandbox requirement](https://learn.chatgpt.com/docs/agent-approvals-security).
Persist `/data` for registration, sessions and the result outbox. Native CLI credentials must
be available inside the worker user's home (`/home/agent/.codex` for Codex). Use a dedicated
credential directory for this runtime; do not mount your entire home directory.

Workdir storage defaults to a named Docker volume. To use a host directory instead, add:

```yaml
# compose.override.yaml
services:
  worker:
    volumes:
      - /absolute/host/project:/workdir
      - /absolute/dedicated/codex-home:/home/agent/.codex
```

Use the container path `/workdir` when attaching it in the platform. The non-root worker
UID is `10001`; grant it access to the selected paths. Each worker registration belongs to
one workspace; use separate worker state directories/containers for different workspaces.

## Failure and recovery contract

Claims and ordered output frames are durable. Workers retain an acknowledged result outbox
and native session state across restarts; retries resend results, never execute commands twice.
The controller uses its existing harness parser, queue conflicts, timeout/cancellation, question
handling and scoped MCP capabilities. The worker validates paths and owns the CLI process tree.
Loss of controller contact for 60 seconds stops owned work; a controller restart interrupts runs.
Inspect the saved workdir before explicitly retrying an interrupted task. A worker restart can
resume the saved native conversation on a subsequent, explicit message.

Install workers as managed services or containers: their process group/container is the crash
boundary. A hard kill of an unmanaged Unix foreground worker cannot guarantee descendant cleanup.
No transparent live migration or automatic command replay is provided.

The first version uses one controller process and SQLite per workspace. It is not a clustered
controller. Native terminal/file-browser operations remain available on the original local/SSH
workspace; registered workers currently expose harness execution and workdir validation.

## Verification

```sh
cd src
cargo test --locked --bin agentic-enterprise --no-fail-fast
cd frontend
npm run lint
npm run build
```

Run `scripts/verify-decentralized.py --help` for the real HTTP/Matrix/worker smoke test.
It requires a running controller, two real Matrix test identities and an enrolled runtime.
No provider or Matrix mocks are used.
