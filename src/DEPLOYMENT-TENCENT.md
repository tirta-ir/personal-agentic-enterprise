# Tencent deployment over NetBird

The platform is deployed on `tencent-personal` at **http://10.69.0.101:18766**.
Connect through NetBird (`wt0`). Docker publishes the app only on `10.69.0.101`;
Matrix is available to the platform internally and on host loopback `127.0.0.1:18767`.
No public HTTPS hostname or reverse-proxy route is configured for this deployment.

## Installation

- Application source: `e323338d1042ff1fdd37952ffe21c109625b840a`.
- Platform image: `agentic-enterprise:e323338-amd64` (Linux x86_64).
- Image on Tencent: `sha256:82dfb08e15a6dcca93a69373802abc0f0683f8b1a1e5e18edf708c6673593698`.
- Synapse: `ghcr.io/element-hq/synapse:v1.161.0`; server name `agentic.tencent`.
- Deployment directory: `/home/ubuntu/agentic-enterprise`.
- Managed service: `agentic-enterprise.service`, enabled at boot and ordered after Docker
  and NetBird. Its pre-start check waits for the expected address on `wt0`.
- Persistent Docker volumes: `agentic-enterprise_platform-data` and
  `agentic-enterprise_matrix-data`.

Tencent has 2 GB RAM. The image was built on mac-personal with a native ARM Rust
compiler targeting `x86_64-unknown-linux-gnu`, then transferred directly over SSH.
The dev build disables debug symbols. The build context, cross-build Dockerfile,
and log are retained at `/Users/punya-tirta/ae-tencent-build-e323338`.
The source archive SHA-256 is
`df165c4dadca258ef48618daf90b8ea6a2e5464fa398e04b67daf6185c639e3c`.
Source and imported images were verified to have identical seven filesystem layers,
architecture, entrypoint, command, environment, user, and working directory.

## Access and operation

Alice (`@alice:agentic.tencent`) owns `Personal` and the migrated `Tirta` workspace. Her generated
password is kept in the deployment's mode-0600 `.credentials.json` and a private
local handoff file; it is not committed. Bridge credentials are in mode-0600 `.env`.
The Mac deployment's data remains separate. Register execution machines through
**User settings → Runtime**; this controller has no mounted provider credentials.

```sh
ssh tencent-personal
sudo systemctl status agentic-enterprise
cd /home/ubuntu/agentic-enterprise
sudo docker compose ps
sudo docker compose logs --tail 100 platform
sudo systemctl restart agentic-enterprise
```

For bootstrap-owner recovery, read `/data/org/.state/owner.key` inside the platform
container and enter it in Administrator sign in. Keep that key private.

## Verification

- The actual browser signed in through bundled Matrix, created `Personal`, opened
  Profile/Runtime/Workspace and Action board, and retained its session after reload.
- Health returned HTTP 200 with `status: ok`; protected state returned 401 before
  sign-in and again after logout. Browser exceptions: zero.
- A full service restart preserved an existing authenticated session, the workspace,
  and its agent records. The systemd unit is active and enabled.
- Both containers reported healthy. The socket table showed only
  `10.69.0.101:18766` for the app and `127.0.0.1:18767` for Matrix.
- Windows reached the app through NetBird; Matrix's port was not reachable on wt0.

Detailed private proof files and screenshots are in local
`org/deployment-tencent-20260922/`. No mocks or paid model invocations were used.
The initial deployment checks above preceded runtime registration.

## Windows organization migration — 2026-09-22

The existing Windows organization was restored into **Tirta**, preserving **Personal**.
Verified against a consistent SQLite snapshot: all 42 agent records (17 active),
13 groups/projects (9 undeleted), 175 messages, 109 historical runs, 13 artifacts,
reporting relationships, model choices, instructions, and saved navigation/chart layouts.
Historical `owner` messages now belong to Alice. Deleted records remain recoverable.
The original Windows organization and Tencent's pre-migration volume backup are retained.

- Fifteen agents use `PUNYA-TIRTA (Windows)`, with their existing `F:\Engineering`
  paths. The hidden scheduled task **Agentic Enterprise Tencent Worker** starts at
  Windows sign-in and restarts on failure. This PC must remain awake and signed in;
  a noninteractive S4U task could not run Codex's Windows shell sandbox.
- Worker registration, outbox, and new native sessions remain in
  `org/.state/tencent-worker` on this PC, protected by user/SYSTEM ACLs. This location
  also avoids packaged-app LocalAppData redirection during scheduled startup. Its
  `bin` directory contains the deployed executable/DLLs independently of development
  builds. To stop it, run `org/.state/tencent-worker/Stop-Worker.ps1`; this stops both
  the task and its worker process. Start with
  `Start-ScheduledTask -TaskName 'Agentic Enterprise Tencent Worker'`.
- The two existing Mac agents and CRD–AKM project retain their Mac directories via
  a separate persistent Docker worker, Compose project `ae-tencent-worker` in
  `/Users/punya-tirta/ae-tencent-worker`. The Engineering directory is mounted at
  the same absolute path; native Codex credentials remain on that Mac.
- Existing native session handles were retired during migration. Chat/run history
  remains available; subsequent work uses fresh worker-owned native sessions.
- All eleven saved `gpt-5.6-luna` choices were preserved. Luna was initially absent
  from the changing native catalog, then reappeared. A real Luna shell run on Windows
  read the expected local verification file; an Astra run did the same on the Mac.
  Availability continued to vary. The Windows worker now keeps advertising available
  models when its configured default is absent; choosing an unavailable model still
  fails explicitly, without substituting another model.
- Both workers reconnected after controller restart. Authenticated browser checks
  displayed the migrated organization and runtimes, retained workspace selection
  after reload, and returned HTTP 401 after logout. Outside-root and worker-state
  workdir probes were rejected with HTTP 400. No mocks were used.

Private migration snapshots, runnable checks, and screenshots are retained in
`org/migration-tencent-20260922/`. The controller received organization data and
artifacts, not workdir files or provider credentials. Registered-worker terminal/file
browsing remains subject to the limitations in [DEPLOYMENT.md](DEPLOYMENT.md).
