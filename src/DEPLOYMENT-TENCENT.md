# Tencent deployment over NetBird

The platform is deployed on `tencent-personal` at **http://10.69.0.101:18766**.
Connect through NetBird (`wt0`). Docker publishes the app only on `10.69.0.101`;
Matrix is available to the platform internally and on host loopback `127.0.0.1:18767`.
No public HTTPS hostname or reverse-proxy route is configured for this deployment.

## Installation

- Application source: `codex/decentralized-workspaces`, including searchable invitations,
  worker catalog preservation, embedded replies and direct reply routing.
- Platform image: `agentic-enterprise:runtime-browser-20260922` (Linux x86_64), including
  runtime-first setup, runtime metadata editing, custom Codex catalogs, human-only `/btw` and worker folder browsing.
- Image: `sha256:4410a2ebd68fd29ce7cf430c6929150559ac9ef1bef3729a77f731e7ef0171a7`.
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
The initial deployment source archive SHA-256 was
`df165c4dadca258ef48618daf90b8ea6a2e5464fa398e04b67daf6185c639e3c`.
Its source and imported images were verified to have identical seven filesystem layers,
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

## Searchable group invitations

Group settings use a search field, removable selection chips, an Invite button, and
a current-access list. Invites are applied with Save group. Team invitations retain
ancestor inclusion and selective branch removal; projects still use Structure for
agent membership. No dependencies or authorization changes were introduced.

Verify against a real deployment (the private credentials JSON contains `url`,
`username`, and `password`; the script creates and removes an isolated workspace):

```sh
node src/scripts/verify-group-invites.mjs /path/to/credentials.json /path/to/proof
```

The live browser check covers search, chips, keyboard selection/Escape, team and
ancestor inclusion, sibling exclusion, branch removal, protected owners, persistence,
empty results, duplicate prevention, and a 390 px viewport. The previous deployment
configuration remains in `compose.before-invites.yaml` for rollback.

## Embedded chat replies

Replies embed the original author and message excerpt. A direct reply to an agent
invokes that agent, and its answer quotes the triggering user message. Explicit
mentions take precedence; human replies and ordinary room posts remain passive.
The existing authenticated message-list endpoint supports an optional `id` filter
for quoted messages outside the loaded page, retaining group and conversation scope.

Run the real browser/worker check with a workspace, registered runtime and existing
workdir. It creates a temporary agent/group and uses two read-only Codex turns:

```sh
node src/scripts/verify-replies.mjs /path/to/credentials.json /path/to/proof WORKSPACE_ID RUNTIME_ID WORKDIR
```

The check covers composer cancellation, both reply previews, invocation without a
mention, retry idempotency, reload, older history, side-chat isolation, anonymous
access rejection and a 390 px viewport. Successful runs soft-delete only their
verification agent/group; failures retain evidence for inspection.
The prior live image and `compose.before-replies.yaml` remain available for rollback.
On 2026-09-22 the live check passed with two successful Windows worker runs, no
browser errors and unchanged original agent/group records in both workspaces.
Evidence is retained in `org/verification-replies-20260922/browser/` (private).

Quoted previews are buttons that scroll to, focus and briefly highlight the
original bubble. Older pages load automatically; loaded history and scroll position
survive live refreshes. A side-chat opening quote can return to its original main
conversation. Reduced-motion preferences suppress the highlight animation.

`node src/scripts/verify-reply-jump.mjs /path/to/credentials.json /path/to/proof`
checks mouse, Enter/Space, multiple history pages, live updates, mobile and side-to-main
navigation in a disposable workspace, using real APIs without model calls or mocks.
The prior live configuration is saved as `compose.before-reply-jump.yaml`.
The live check passed on 2026-09-22, including reduced-motion behavior and zero
browser errors. Evidence: `org/verification-reply-jump-20260922/final/` (private).

Action-table headers and cells now align vertically in the middle, including Controls.
Live browser measurements on 2026-09-22 showed a maximum 0.5 px center difference
across headers and short/wrapped rows, versus up to 18 px before. Sorting, resizing
and 390 px layout passed; existing organization and action records were unchanged.
Evidence: `org/verification-action-alignment-20260922/` (private). Rollback configuration:
`compose.before-action-alignment.yaml`.

Organization/project cards display the assigned runtime beside the agent type, using
the effective project workdir where applicable. Saved card geometry is preserved.
`node src/scripts/verify-org-runtimes.mjs credentials.json output-dir workspace-id`
checks actual runtime names, tooltips, layout fit and unchanged saved records using
read-only APIs and the real browser. The 2026-09-22 check covered 17 agents, Windows
and Mac registrations, and the CRD–AKM project, with no browser errors.
Evidence: `org/verification-runtime-badges-20260922/browser/` (private). Rollback:
`compose.before-runtime-badges.yaml`.


Runtime setup was verified through the deployed browser on 2026-09-22. New-agent
creation follows runtime, detected harness, workdir, then profile. The check created
and removed a temporary agent using the real Windows worker probe, rejected an
out-of-root folder, switched runtime through Profile, reattached a workdir without
losing its selected model, and checked project inheritance and mobile layout.
A temporary workspace verified name/description persistence, invalid metadata,
cross-workspace access, anonymous access and revoked-registration rejection.
Original agents, groups, workdirs, models and saved layouts were preserved.

Reproduce with `node src/scripts/verify-runtime-setup.mjs credentials.json output-dir
workspace-id windows-runtime-id other-runtime-id absolute-workdir` (one line).
The script uses real Matrix authentication and worker APIs, with no mocks or model
calls. Backend tests: 65 passed; frontend lint/typecheck/build passed. Evidence:
`org/verification-runtime-setup-20260922/browser/` (private). Rollback:
`compose.before-runtime-setup.yaml`. Machine-reported root, OS and harness catalogs
remain read-only; edit those on the worker itself.


Luna catalog and human-only side chats were deployed on 2026-09-22. TIRTA-PC uses
its native `model_catalog_json` override, populated with Luna metadata from the
installed Codex 0.155.0 bundled catalog. The platform reads that override and passes
it explicitly to isolated agent executions. All eleven existing Luna selections
remain unchanged; no replacement model was assigned. Refresh the custom catalog
when the installed model catalog changes.

`python src/scripts/verify-luna-human-btw.py credentials.json output-dir workspace-id
runtime-id absolute-workdir` verifies a real Luna execution, native catalog arguments,
absence of `chat_btw` from MCP discovery, rejection of cached direct calls and
cross-chat `/btw` injection, and successful authenticated human `/btw`. The MCP probe
uses only its temporary run's credential on the server; it never prints the token.
Temporary agents/groups are soft-deleted afterward, preserving original records.
Evidence: `org/verification-luna-human-btw-20260922/` (private). Backend tests: 66
passed; frontend lint/typecheck/build passed. Finance Operations returned HTTP 200
with no browser errors; historical side chats remain accessible. Previous failed
runs remain in history and were not automatically replayed.

Rollback configuration: `compose.before-luna-human-btw.yaml`. The prior Windows
worker executable and native Codex configuration are retained in the private
verification directory. Its updated worker executable SHA-256 is
`AC6DC18C3C8299F12560732D94B6543883F83B5727AF3AC3B32DB536CD208DB0`.
The initial verification's read-only profile could not call `ask_user` because
native Codex required approval while the profile uses `approval_policy=never`;
that separate limitation remains. The final authorization probe directly exercised
the real MCP endpoint during a native Luna run, without mocks or permission changes.


Registered-runtime folder browsing was deployed on 2026-09-22 to the controller,
Windows worker and Mac Docker worker. The shared picker sends directory requests
through the existing outbound worker queue. Only workspace owners can browse;
runtime ownership, online status, canonical root containment and protected state
folders are checked. Controller filesystem restrictions remain unchanged.
The Project Browse button and agent Workdir Browse folders button now support
registered runtimes. Selecting a different project runtime clears the old path.

Verification: `node src/scripts/verify-runtime-browser.mjs credentials.json output-dir
workspace-id windows-runtime-id mac-runtime-id`. Evidence is retained under
`org/verification-runtime-browser-20260922/` (private). Backend checks: 67 tests pass;
frontend lint/typecheck/build pass. The browser test creates and removes one empty
verification project without running agents or changing existing workdirs.

Rollback: Tencent `compose.before-runtime-browser.yaml`, Mac worker
`/Users/punya-tirta/ae-tencent-worker/compose.before-runtime-browser.yaml`, and the
Windows worker backup in the private verification directory. Mac worker image:
`ae-tencent-worker:runtime-browser-20260922`; Windows executable SHA-256:
`F1611DBBC8C9B91D422ACF97CC8E97D264734F3E3552D4D78190237D692330E5`.

The live browser check passed on both TIRTA-PC and TIRTA-MAC: folder selection,
project creation, reload persistence, runtime switching, bounded navigation,
unauthorized/out-of-root rejection and 390 px dialog bounds. Browser errors: zero.
Both original workspaces retained their agents, groups and saved layouts; the
verification project was removed. Final proof: `org/verification-runtime-browser-20260922/final/proof.json`.
