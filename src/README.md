# Agentic Enterprise

The decentralized workspace implementation adds authenticated tenants, registered outbound workers, explicit human/agent groups, and Matrix rooms. Start with [deployment and one-line installation](DEPLOYMENT.md) and the [real-service verification record](VERIFICATION-DECENTRALIZED-2026-09-21.md). The local/SSH instructions below describe the retained bootstrap-owner mode; new workspaces use registered runtimes.

## Workspace navigation

Open **User settings** from the account button at the bottom of the sidebar, then choose **Profile**, **Runtime**, or **Workspace**. **Action board** and **Organization** remain in the main sidebar. Workspace owners can invite Matrix users and assign **Member** or **Owner** roles. Owners manage the workspace, its agents, runtimes, and actions; members use shared rooms. You cannot change your own ownership. Profile shows your authenticated identity and current access. Existing `/settings/workstations` bookmarks still open Runtime.

On the action table, click a data-column heading to toggle ascending/descending order. Drag its right edge to resize; keyboard users can focus the separator and use Left/Right (Home resets). Unscheduled dates remain last. The pencil edits, the green play button invokes, and the red trash button confirms deletion. Stop active work before deleting. Deleted actions leave the board and cannot run again; stored run history and evidence remain available. Table sizing and sorting last until you leave the board.

## Projects, actions and collaboration

- Use **+ → Create project** beside Groups. Choose a name and a local or saved remote workdir. Creation leaves the team empty and opens **Structure** immediately. Add organization agents or create dedicated project agents and set reporting lines there; the create/edit project dialog no longer edits the team. Projects use a folder icon and `/projects/<name--id>/...` URLs. Chat, Knowledge, Runs and independent side conversations use the existing group machinery.
- **Structure → Add agent → Project** creates a dedicated agent. It also appears in Organization. Project reporting lines are separate from organization lines: a dedicated agent reports globally to its project manager only when that manager is an organization agent; otherwise it reports to the owner. Normal agents keep their global reporting lines.
- Every project run, including delegates and side chats, snapshots the project's workdir and host instead of the agent's default. Dedicated agents also inherit it in their profile terminal and Skills tab. A normal agent retains its own default outside the project. Models/credentials resolve on the actual execution host; leave model/effort blank to use that host's defaults.
- Open **Action board** in the sidebar for the organization-wide **Table / Calendar** views, or **Actions** inside a project/group for a filtered view. Select a PIC and choose **Save to backlog**, a future **planned start**, or **Run now**. Blank planned start never invokes work. Dates display in the browser's local timezone and persist as UTC. Calendar leaves unscheduled work in a separate backlog.
- Actions dispatch through the existing persisted queue. A transaction claims each scheduled occurrence once. Results link to Runs; failures/cancellation remain visible. Owner or the assigning agent can invoke/edit an action; agent visibility follows current group membership, with delegation-only agents limited to their own assigned items. Archiving/deleting a group or restoring a backup removes pending action schedules; review before scheduling again.

Every native agent run receives a temporary `enterprise` MCP connection to the same Rust service, using an ephemeral per-run credential (never the owner key). Available tools: `workspace_list`, `action_list`, `action_save`, `action_invoke`, `cross_chat_invoke`, `handoff_status`, `chat_usage`, `chat_reset`, and `chat_btw`. The HTTP endpoint rejects inactive credentials and rechecks membership on each operation. Remote workstations must be able to reach the platform's bound private address. The existing SSH watchdog still owns remote execution.

Cross-chat work requires the sender to participate in **both** chats and the recipient to participate in the destination. Only the explicit task crosses; the recipient resumes its own destination session. A stable request ID prevents duplicate invocation. The source receives a linked result and one summary when both runs finish. Membership is checked again before delivery. Requests are one hop, at most three per turn; receipt summaries cannot launch more work, preventing automatic reply loops.

`chat_btw` starts a separately queued side session using the main context at opening. `chat_reset` defers until existing work finishes: main resets that group and its side chats, side resets only itself. Other groups stay untouched. New sends receive a clear pending-reset message until it completes. `chat_usage` retains `/usage` behavior: the platform account's Codex quota plus recorded OpenCode usage for the current conversation. Remote account quotas and OpenCode reset times are not exposed.

Platform tool authorization controls platform data and invocation. It is not an operating-system security boundary for agents granted YOLO filesystem/network access.

The action board persists in `action_items`. Records from the retired Work feature stay untouched in `work_items`; they are not assigned or scheduled by this upgrade. The migration is safe to rerun and imports only fully shaped actions from the initial collaboration preview build.

A native personal agent workspace: persistent group chat, configurable Codex and OpenCode agents, and direct attachment to existing codebases. A background Rust executable serves the API and built React/TypeScript/shadcn browser UI. Fresh deployments use `http://127.0.0.1:8765`; this machine is configured for `wt0` at `http://10.69.0.102:8765`. No Docker, Node application server, or database service is required.

Codex uses `exec` / `exec resume`; OpenCode v2 uses native `run --standalone --format json --auto` and `--session`. Command Code remains deferred.

## OpenCode pilot

Choose **Organization → agent → Profile → Harness → OpenCode**. Existing agents default to Codex; switching harness preserves each harness's resumable sessions. Sessions are created only when work is invoked and are separate per group, side chat, agent, workdir and harness. A workstation must have the selected CLI installed. Local native executable discovery supports `AE_OPENCODE`; remote discovery uses the saved SSH workstation. A side-by-side v2 install at `~/.local/share/agentic-enterprise/tools/opencode` takes priority over PATH; install it with `npm install --prefix ~/.local/share/agentic-enterprise/tools/opencode @opencode/cli@2.0.11`. This leaves a system v1 install unchanged.

Model names, provider IDs, supported variants and the default selection come from that workstation’s native OpenCode catalog. All enabled models are selectable, with no price filter or provider allowlist. Configure providers in the CLI; opening Profile, returning focus to the app or pressing Refresh reloads the catalog. Saved unavailable models show an error and never silently fall back. Variant controls disappear when unsupported. Global/project OpenCode configuration and workdir `.env` are read by the native CLI. Its v2 credential records are borrowed into the scoped runtime database, with compare-before-copyback for refreshed OAuth tokens; native chat history is never copied. Sessions, cache and state remain isolated under the organization. Provider charges and rate limits follow the selected model.

OpenCode defaults to YOLO. Its **Read only** and **Workspace write** modes are native tool permissions, not OS sandboxes: both deny shell commands and access outside the workdir; Read only also denies edits. YOLO allows shell and file tools. The free endpoint currently rejects some restricted runs before tools execute, so successful read-only execution is not guaranteed; permissions are never relaxed automatically. See the [upstream free-tier report](https://github.com/anomalyco/opencode/issues/49723). Project workdirs override agent defaults. Runtime environment comes from the workdir `.env`, instructions and organization context use the existing profile/run path, and Skills lists native repository skills. No separate secret editor is introduced.

Codex and OpenCode can delegate to each other using the existing organization and group scope rules. Both use the platform MCP tools for cross-chat requests, actions, usage, resets, side chats and owner questions. OpenCode questions use `enterprise.ask_user`; native terminal question/task tools are disabled in this noninteractive integration. Model output and tool errors remain visible in execution evidence.

A failed, timed-out or interrupted run gets one read-only review by an eligible manager or teammate. Private delegate failures already return to their parent manager; reviews do not spawn reviews. No task is automatically retried or moved to another harness. If no eligible reviewer exists, the owner receives a notice. `/usage` distinguishes recorded native token/cost measurements from unavailable quota information.

OpenCode standalone/private server processes belong to the existing local process tree or SSH watchdog; they are not a separately deployed daemon. Native session data stays under `org/.state/runtime` locally, or the organization namespace under `~/.local/share/agentic-enterprise` remotely. These protected directories must be included in stopped-service backups if native-session recovery is required.

## Answering agent questions

New runs receive `enterprise.ask_user` through the existing native MCP connection. When an agent needs clarification, it asks in a **Needs your answer** card in the originating group or side chat. Choose a suggestion or write your own answer, then **Send answer**. Other chats show a notice linking to the unanswered question. Private delegates can ask the owner through a system card without gaining permission to post normal group replies.

Reporting-only summaries reuse worker results and answers; they cannot ask the same question again. Answer cards remain accessible even if newer messages move the question out of the recent chat history.

Your answer continues the same platform run and native session; it does not create another task. Normally it returns directly to the waiting tool call. If Codex ends its native turn while waiting, the platform retains the question and queue slot, then resumes that same native session with the saved answer. Questions and answers persist in `org` and survive browser reloads. Waiting does not consume the agent's execution-time limit, including over SSH; process cancellation and the remote heartbeat watchdog remain active. Main queues stay serialized while independent side chats can continue.

**Stop run** cancels the question and task. Unanswered questions expire after 24 hours and stop their run without guessing an answer. A service restart interrupts pending questions and runs; send a new message to continue, with no automatic replay.

Codex `exec` is non-interactive: this integration uses its supported MCP tool calls for clarification, rather than the TUI/app-server input protocol. Each new run is instructed to use `ask_user` instead of terminal stdin or ending with a question. Permission settings are unchanged; these cards do not grant additional command or filesystem permissions. Plain questions in older completed replies can still be answered with Reply or an `@agent` message.

## Remote workstation agents

Open **User settings** by clicking your name above the account bar, or `/settings/workstations`. Save a display name, hostname, optional IP override, SSH port, username and either an existing SSH config alias, a private-key path, or a password. **Import existing SSH alias** reuses advanced OpenSSH settings, including jump hosts and host-key identity. Previously attached aliases are imported automatically without changing agent profiles or session IDs.

Passwords and optional private-key passphrases are encrypted with Windows DPAPI for the account running the native service. Blank fields keep saved credentials; the UI never returns their values. Ciphertext lives under `org/.state/ssh-secrets/` and is excluded from exports, as are private-key files. Restoring on another machine requires entering credentials again. Non-Windows platform hosts support keys/config; saved passwords/passphrases require this Windows deployment. Remote workstations can still be Linux or macOS.

For a new key/password connection, **Review host keys**, compare fingerprints with the workstation, then **Trust these host keys**. The service rescans and rejects keys that changed since review; accepted keys are stored only in this organization's state. **Test connection** verifies SSH, Python, the remote home directory and native Codex login. Wrong credentials, untrusted keys and unavailable hosts show errors. Changing a connection's destination retires its old sessions; changing its display name retains them. Changes are blocked during active work, and removal is blocked while agents/projects reference the workstation.

In **Organization → agent → Workdir**, choose **Local · This machine** or a saved workstation under **Remote · Saved SSH settings**, then browse and attach the folder. The same dropdown is used when creating/editing a project. The workstation needs Linux/macOS, Python 3.11+, Git, and a signed-in Codex CLI with a file-based native login and model catalog. Local workdirs continue to work as before.

Organization cards and settings show **Online**, **Offline**, **Needs attention**, or **Checking**, with the workstation name and checked time. Checks run approximately every 30 seconds; checks older than 90 seconds are stale. Online verifies SSH, the saved workdir, Codex login and workdir environment; a model request can still fail independently. Pausing an agent still controls whether it can receive work. Model/effort dropdowns come from that workstation's Codex catalog, and runs retain the resolved display name and arguments.

The Rust backend retains the existing queue, scoped delegation and per-group/per-side sessions. A small Python bridge invokes native Codex over SSH only when assigned work; it is sent on demand, opens no listening port, and needs no package installation. Native credentials and `.env` values stay on the workstation. Remote Codex homes live under `~/.local/share/agentic-enterprise/<organization-namespace>/sessions/`; chat and run records remain in local `org`. Session/workdir identity includes the SSH alias. Use one stable alias per workstation.

Terminal runs `/bin/sh` commands remotely with Stop, history and environment redaction. Skills uses remote Codex discovery and previews project instructions. Code browsing and linked report/image previews read the saved remote workdir over SSH. `/usage` still checks the platform machine's signed-in account. Agent scripts saved in Code remain organization files on the platform machine.

Stop terminates the owned remote process group. A stalled/lost controller stops owned work after about 15 seconds without a heartbeat. Lost completion confirmation is **interrupted**, never automatically retried; inspect existing side effects before retrying. Detached daemons deliberately created outside the process group are outside this stop contract.

This installation includes `tencent-personal` (Linux) and `mac-personal` (macOS) examples, attached to dedicated `~/.local/share/agentic-enterprise/workspaces/connection-demo` folders. Use Workdir to select an existing project. The Mac alias now uses its verified NetBird address `10.69.0.134`, retaining the existing host-key identity.

Verification against an isolated organization on port 8766: from `src/frontend`, run `node tests/remote-workstations.mjs` and `node tests/remote-availability.mjs`. From `src`, run `python backend/tests/remote_watchdog.py tencent-personal` and the same command with `mac-personal`; add `--cancel-immediately` to check cancellation during startup. Tests use the real SSH hosts and native Codex accounts.

## Chat metadata, activity and mobile navigation

The Action board and Organization shortcuts stay at the bottom of the navigation above the account bar, with 16 px of space above and below the shortcut stack and 8 px between buttons. Groups and projects scroll independently on desktop and in the mobile drawer.

Agent replies show the **Position**, followed by **model / reasoning effort**. Model names come from the same local Codex catalog used in Profile. Model and effort values come from the run's recorded CLI arguments (falling back only to its saved explicit profile values), so changing an agent's settings never relabels an old reply. Replies outside the recent-run window load their saved run through authenticated GET `/api/runs/{id}`. If a catalog entry is unavailable, its recorded model identifier is shown; missing historical settings are labeled rather than guessed.

The chat header has a clickable activity indicator: a spinner for queued/working runs, a green **Done** only for successfully finished work, and **Needs attention** for a failure, timeout, cancellation or interruption. It opens the relevant execution evidence. Activity includes delegated work and is scoped to the current main or side conversation. With no runs in the recent state window it says **No recent activity**.

Click the main navigation's edge to hide or show it; dragging the edge still resizes it. The Workspace button brings hidden navigation back. Below 768 px, navigation opens as a modal drawer and closes after choosing a group or Organization. Agent settings and file/run previews use the full width. Tabs and wide file tables scroll within their own regions, and forms remain usable at 320 px. Desktop panel widths remain saved; opening a phone layout does not overwrite them.

## Files linked in chat

Agent replies can embed screenshots and link to reports in their attached workdir. Markdown links and Markdown attachments open as rendered documents in the **right preview panel**, keeping the chat and unsent draft visible. Drag the divider to resize it; Close or Escape returns focus to the original link. The header provides a download action. Headings, tables, code and images render in the document; relative images and nested Markdown links resolve from the linked report's folder. Main and side chats share this behavior. Click an image to open it at full size; web links and other file types retain their existing behavior.

Windows paths, `file:` URLs and workdir-relative paths resolve through the authenticated native API, using the workdir saved with the run even if the agent's profile changes. Existing messages need no regeneration. The native viewer reads live files up to 25 MiB each; rendered Markdown previews are capped at 1 MiB, with a visible error and download action for larger documents. Other text files open as plain text; other types download. Missing reports display the API error in the panel; missing images display an unavailable message. Paths outside the saved workdir, traversal/junction escapes, network file paths, `.env*`, `.git`, `.state` and alternate data streams are rejected. Existing URL sanitization and image CSP remain. Uploaded Markdown attachments have no source workdir for relative filesystem links. Files moved or deleted from disk are unavailable; linked files are not archived copies.

**Add to knowledge** in the preview saves the exact Markdown bytes currently displayed as a file in the current group's Knowledge tab, then runs the existing semantic index. It changes to **Added to knowledge** only when indexing succeeds. Progress and errors stay visible; **Retry indexing** reuses the saved file after a failure. An existing text file with the same name and bytes in that group is reused on later clicks. Archived/deleted groups cannot add knowledge. The saved copy survives changes to the workdir file; linked images and other referenced files are not copied. This action uses loaded previews (up to 1 MiB). The existing upload API can still create copies if separate tabs add the same file simultaneously.

## Gauss design system

Agentic Enterprise has a custom generated blue ribbon logo, used in the navigation, sign-in screen and browser icon. Your chat messages appear on the right in blue bubbles with white text; agents reply on the left in mostly white bubbles with a pale blue gradient. Main and side chats share the same styling. Names, positions, timestamps, Reply, delivery status and execution evidence remain available outside the bubbles; attachments stay with their message.

The interface uses the owner's [Gauss design system](https://github.com/Gaussian-id/designsystemgauss-boilerplate): royal/electric blue accents, pale blue surfaces, Poppins for UI text and JetBrains Mono for code. `frontend/src/gauss-tokens.css` holds the upstream semantic palette and Tailwind mappings; navigation, chat, forms, knowledge, runs, schedules and the organization chart share these tokens. Fonts ship locally with the production bundle. Existing agent avatar colors remain personalized; newly created agents start with Gauss royal blue. Upstream revision and font licenses are recorded in `UPSTREAM.md`.

## Group chat permissions and position badges

Agent messages show the agent's **Position** beside the display name. Edit Position in **Organization → agent → Profile**; an unset position does not show a generic AGENT badge.

In **Create a group** or **Manage group → Chat permissions**, choose **Entire organization** (the default) or **Selected organization levels**. Level 1 reports directly to the owner; Level 2 reports to Level 1, and so on. Select one or more exact levels. The preview lists current chat participants and counts lower-level agents who can receive delegated work. Membership follows the saved reporting tree, including later agents and reporting changes.

Only selected levels appear in the group avatars and participant dialog; `@all` targets eligible chat participants. Direct requests or mentions to another level are rejected by the API. Lower levels may receive assigned work, but their output returns privately to the assigning agent, who summarizes it to the group. Their raw output remains visible to the owner in Runs. Delegation-only workers do not receive automatic earlier group messages or quoted replies. Higher levels outside the selected scope cannot be called as delegates.

**Group chat lead** can select an enabled participant. Automatic uses the organization's selected lead when included; for a scoped group whose organization lead is outside scope, it chooses an enabled agent at the highest included level (stable ID breaks ties). Explicit selections never silently switch to someone else. The selected lead still needs an attached workdir. Scheduled messages use the same group scope and lead.

Scope/lead edits are blocked while group work is queued, running or waiting for delegates. Changes retire the group's existing native sessions, preserving visible history and files. Already-posted historical messages remain intact. Scope is checked again before a queued run starts and before publishing a reply, so a reporting change cannot make an excluded agent start or post. These are application routing/chat permissions; each agent's workdir and execution permissions still govern its actual tools. Existing groups load with Entire organization access and keep their current behavior until edited.

## Archive, delete and restore groups

Open a group → **Manage group** → **Archive group** or **Delete group**, then confirm. Archive moves it into the **Archived groups** dialog, opened with the archive icon beside Sign out in the owner bar. Preview a conversation or restore it directly from that dialog. Delete hides the group throughout platform navigation; its old URL shows Page not found. Both preserve messages, files, runs and sessions, and block writes. Deleted data is retained and the authenticated restore API remains available; deleted groups are not listed in the product UI.

Scheduled tasks pause when a group is hidden. After restoring, review them in **Scheduled tasks** and resume explicitly; nothing is replayed automatically. Stop or wait for active group runs and knowledge indexing before archiving/deleting. Pin/order preferences and existing bookmarks remain usable. General can also be archived or deleted; creating or restoring a group stays available when all groups are hidden.

Authenticated lifecycle routes are POST `/api/groups/{id}/archive`, DELETE `/api/groups/{id}`, and POST `/api/groups/{id}/restore`. Status changes and schedule pausing use one SQLite transaction, shared with message/schedule dispatch. Hidden groups reject profile, chat/command, schedule and knowledge writes while retaining read/download access. Old saved groups default to active; exports include retained statuses and records.

## Agent positions and organization knowledge

Open **Organization → an agent → Profile**. **Display name** identifies the person, **Position** is their job title, and **Role** describes their responsibilities. Position also appears when creating an agent and on organization cards. Existing agents keep their saved names and responsibilities; fill in their new Position field and save.

The expandable **Organization knowledge** shows the agent's manager, full management chain, direct reports, team including indirect reports, and peers. Refresh relationships to inspect the current saved structure. Every Codex execution receives the full organization roster and these relationships, including direct requests, the chat lead, delegates, summaries and resumed sessions. Each member includes position, responsibilities, workdir, permission, environment **key names only**, and availability. Paused/unattached agents are visible but unavailable for delegation; deleted agents are excluded. Agent IDs distinguish duplicate display names.

Chart connections update immediately when the first direct report is added, reporting relationships change, or an agent is restored. Selecting **Organization owner** connects that agent to the owner card.

The snapshot separately identifies the formal manager, actual task assigner and result recipient, so work requested by the CEO can return to the CEO even when the engineer reports to a different manager. The chat lead considers these relationships and actual access when delegating. Returned worker evidence includes the agent ID and position. Saved organization changes are captured at the next execution, including session resume; an in-progress execution retains its original snapshot. **Runs → a run → Organization context supplied to this run** exposes that snapshot, also retained in the native run manifest under `org`.

Authenticated GET `/api/agents/{id}/organization-context` uses the same snapshot builder as execution. This extends the existing queue and scoped Codex runtime; the current limit remains three workers and one summary per owner message, with no recursive worker dispatch.

## Agent terminal and skills

Open **Organization → an agent → Terminal**. Enter a PowerShell command and click **Run command** (Ctrl+Enter). Each command starts in the saved workdir with the attached workdir's `.env` and scoped `CODEX_HOME`. This is an owner-operated CLI: it runs with your Windows account's access, independently of the agent's Codex sandbox setting. Commands do not retain shell variables or `cd` changes between submissions; combine related steps in one command or script. Output streams into the panel; Stop terminates the owned process tree. Recent command history and results survive reload/restart in organization SQLite. Interrupted commands are marked, never replayed.

**Skills** lists project skills reported by the installed Codex CLI for this workdir, including inherited repository skills. Filter by name/description, click to read `SKILL.md`, and Refresh after installation or changes. Discovery errors are shown. Personal/global/bundled skills are not part of this project list. Previews are limited to discovered `SKILL.md` files inside this codebase; external symlink targets must be inspected through Terminal.

For example, run the [Vercel Skills CLI](https://github.com/vercel-labs/skills) in Terminal to install a project skill, then open Skills:

```powershell
npx --yes skills@1.7.0 add vercel-labs/agent-skills --skill web-design-guidelines --agent codex --yes
```

The console supports unattended commands and installers, not interactive TUI programs. It uses the agent's configured timeout, limits each output to 2 MiB and command text to 16 KiB, and shows the latest 50 commands. Workdir `.env` values and the platform owner token are redacted from command history/output; arbitrary new secrets typed into commands are not automatically identifiable. Manual commands serialize with agent work in the same attached workdir, with at most two manual commands across the organization. Profile changes/deletion are blocked while its terminal command runs. Installers may require network access. Windows PowerShell 7 is the verified shell.

Authenticated APIs: GET/POST `/api/agents/{id}/terminal`, GET `/api/agents/{id}/terminal/{run_id}`, POST `/api/agents/{id}/terminal/{run_id}/stop`, GET `/api/agents/{id}/skills` (optional `path` for a discovered instruction preview). Profile routes end with `/terminal` and `/skills` and support direct refresh/back/forward.

## Run on this machine

Prerequisites: Windows x64, PowerShell 7.4+, Rust 1.94.1 with MSVC Build Tools, Node 24/npm, Git, Microsoft Edge for verification, and Codex CLI signed in. Dependency versions are locked. First build downloads the pinned Protocol Buffers compiler and ONNX Runtime DLL; first semantic index downloads the public CLIP model weights.

From this directory:

```powershell
pwsh -NoProfile -File scripts/Build.ps1
pwsh -NoProfile -File scripts/Install.ps1
pwsh -NoProfile -File scripts/Open.ps1
```

Install restricts access to the adjacent `org` directory, creates a desktop launcher and a Windows sign-in startup entry, and starts the service hidden. Open uses the saved deployment address and signs in using a URL fragment which the app immediately clears; the owner key is never printed. The authenticated cookie is HttpOnly and SameSite=Strict, with exact bound-host/origin validation on requests. The private HTTP deployment relies on the encrypted `wt0` tunnel; it is not a public HTTPS deployment.

```powershell
pwsh -NoProfile -File scripts/Stop.ps1
pwsh -NoProfile -File scripts/Start.ps1
```

Stop verifies the recorded process identity before terminating it. Windows Job Objects terminate owned Codex children. An interrupted run is preserved and marked interrupted on the next startup; it is never silently retried. Startup is per Windows sign-in, not an administrator-installed service. The native build uses Cargo's unoptimized development profile to keep rebuilds practical; the frontend is a production Vite bundle.

Closing the browser does not stop the platform. Use the **Agentic Enterprise** desktop shortcut or `scripts/Open.ps1` to start and open it with automatic owner sign-in. On another authorized private-network device, open the deployment URL and sign in with the owner key from `org/.state/owner.key`; keep this key private. Runtime process/address metadata is in `org/.state/service.json`, and logs are in `org/.state/logs`.

To change the binding, stop the service and select an interface:

```powershell
pwsh -NoProfile -File scripts/Stop.ps1
pwsh -NoProfile -File scripts/Start.ps1 -InterfaceAlias wt0
```

Start resolves the interface's current preferred IPv4 address and persists its alias and port in `org/.state/deployment.json`. Subsequent Start, Open and sign-in startup use that setting. The service listens only on that address; the old loopback URL stops working. The interface must be connected and have one preferred IPv4 address. A missing/ambiguous interface fails visibly without changing the saved configuration. Changing an already-running binding requires Stop first. Use `-InterfaceAlias ''` after stopping to return to loopback; `-Org` selects another organization and `-Port` selects its port. The native executable also accepts `--bind <IPv4>`, with loopback as its default and wildcard addresses rejected.

This machine has an inbound Windows Firewall rule named `AgenticEnterprise-wt0-8765`, restricted to the native executable, TCP port 8765 and interface `wt0`. To reproduce that rule on another installation, run in administrator PowerShell from `src`:

```powershell
New-NetFirewallRule -Name 'AgenticEnterprise-wt0-8765' -DisplayName 'Agentic Enterprise on wt0' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8765 -InterfaceAlias wt0 -Program (Join-Path $PWD 'target/debug/agentic-enterprise.exe') -Profile Any
```

## Use the app

In a group's chat, type `/` to open the command picker. Arrow keys select, Tab or Enter completes a command, Escape closes the picker, and Enter sends a complete command. `/reset` and `/usage` do not accept extra text, attachments or quoted replies. `/btw` can include a question, direct recipients, attachments or a quoted reply.

- **`/btw`** opens an empty side chat without starting Codex. `/btw <question>` opens one and sends the question. Each side chat has its own per-agent Codex sessions, runtime folders and queue and can run alongside main chat, including for the same agent/workdir. It starts with recent main-chat context available when the side chat was opened, then builds its own conversation; subsequent main/side turns are not mixed. Main chat shows an Open side chat link; side replies stay in the bookmarkable `?side=<id>` view. Use Back to main chat to return. Start additional side chats from the main view.
- **`/reset`** in a side chat starts fresh context for every agent in that side only; main and sibling sides continue unchanged, even while running. In main chat, it resets every agent session in the group, including delegates and all side chats. Active native handles are retired lazily and new sessions start on the next assignment. Visible history, profiles/instructions, workdirs, files and scheduled tasks remain. Other groups are unchanged. Stop or wait for active work within the reset scope first. The reset/context boundary is atomic, persists across restart and is idempotent.
- **`/usage`** reads live limits for the signed-in Codex account and displays remaining percentages, reset times, available buckets and a checked timestamp. Usage is shared across the account. Missing windows are labeled **Not reported**. Send it again to refresh. This uses the installed Codex account API without an agent turn or quota-reset action; unavailable authentication/network produces a clear error.

Only chat submission interprets slash commands. A scheduled task's custom message remains an agent prompt. Reset/usage messages and empty side-chat markers are excluded from automatic agent context; main prompts never automatically include side messages. A side receives the existing bounded history window (up to 20 messages, 3000 characters each) from main before its opening plus its own subsequent messages; this is a context snapshot, not a full native-session fork. Reset excludes older context, including a side's initial snapshot. Background refresh preserves command error banners until dismissed or resolved.

There is no configured simultaneous-run cap. Main and side queues remain independent. Runs using the same agent/session or workdir within one queue remain serialized. Main and side execution intentionally share attached files and external resources, so concurrent edits to the same files can conflict. Manual terminal commands still lock their agent/workdir. Model/account limits and machine resources are shared across all runs. Delegates and summaries follow the originating side's queue/session scope and existing group permissions.

1. Open **Organization** in the sidebar to manage agents in a connected chart. Cards show each agent's position, role, availability, attached codebase and direct reports. Drag a card to move it and drag its corners or edges to resize it. Positions and sizes save automatically in the organization's SQLite metadata; save failures show **Retry**. **Auto arrange** restores a spaced hierarchy while keeping card sizes. Drag empty canvas to pan; use zoom and fit controls to navigate. Click an agent card or its **Edit** button to open settings; the Edit button also supports Enter. **Add agent** creates a profile. **Reports to** persists its manager, with cycle prevention, and updates the chart links. Moving cards changes their position, not who they report to. In **Workdir**, click **Browse folders**, navigate this machine's drives/folders in the popup, and choose **Select folder**. Choose Read only, Workspace write or YOLO and attach it. The text field remains available for pasting a path. Attaching validates the selected folder and does not copy the codebase. Paths with spaces and existing dirty changes are supported.
2. Configure the display name, position, role, model, reasoning, timeout and Markdown **Instructions**. The separate AGENTS.md settings tab is removed: existing agent AGENTS.md content appears in the Instructions editor and is consolidated into that field on the next save. Historical revisions retain the original profile. Model and reasoning dropdowns read the installed Codex `config.toml` and `models_cache.json`; **Refresh** rereads these files. Reasoning options follow the selected model. Empty values inherit the current Codex setting (or the model's default effort when selecting a different model) at execution time. An unavailable catalog or unsupported choice produces an error. Profile revisions are inspectable and restorable. The attached repository's own `AGENTS.md` stays in place and is read by Codex.
3. Put variables in `<workdir>/.env`. Every agent execution (including delegates and resumed sessions) and terminal command loads that exact file afresh. Missing files mean no custom variables; unreadable/invalid files fail visibly. A small OS environment allowlist is applied first, then workdir variables. Runtime identity variables such as `PATH`, `HOME`, `CODEX_HOME`, `AE_ORG` and `AE_TOKEN` remain reserved. UTF-8 BOMs, quoted/multiline values and dotenv syntax are supported by the existing dotenvy parser. Values are redacted from normalized outputs. No Environment tab or secret read/write/reveal API exists.
4. Send an ordinary message: the group's **Chat lead** receives it, handles it directly or delegates according to group scope, positions, roles, reporting relationships, workdirs, permissions and available environment names, then summarizes the workers' results. By default groups use the entire organization and its selected lead; group settings can restrict chat to selected levels and choose a different lead. The lead needs an attached workdir. No tags are required. Mention `@Agent A, @Agent B` to address agents directly within the chat scope; the recipient picker is removed. The composer starts at one line, grows with typed or wrapped lines up to 220 px (30% of the viewport on shorter screens), then scrolls. The routing hint sits beside Send. Click the avatar bubbles beside **Manage group** to see the group's chat participants, positions, lead and paused status. Delegation uses each worker's own profile, environment and native session; secret values are never copied between agents. A message can start at most three workers and one lead summary, with no recursive delegation. Different groups retain separate history and native conversations.
5. Open **Execution evidence** to inspect the real process, working directory, arguments, profile revision, raw normalized events, exit result, and native session identifier. Stop cancels the owned process tree. Changing a workdir starts a separate native context; **Sessions** can explicitly reset it.
6. **Code** previews files in the workdir, excludes internal/secret paths, and rejects escaping symlinks. Agent-owned scripts can be edited there. Saving a script does not execute it; reference its path in instructions when it should be used.
7. **Knowledge** is a file explorer with a sortable list, category navigation, filename filtering and a selected-file preview. Upload several files, preview text/images, download originals, choose **Make searchable**, or delete a selected upload. Search uses real CLIP text/image embeddings in LanceDB. Categories organize the view; they are not physical folders. Text previews are limited to 256 KiB. Unsupported previews offer download, and search preparation failures show an error with retry available. The owner removed Work/Team work; its UI and API are gone, while historical database records remain intact for backup compatibility.

The CEO instructions already present in `org/ceo/AGENTS.md` are imported at first startup. After initialization, the database is the authority for profiles; edit instructions through the UI. `org/AGENTS.md`, when present, supplies organization-wide instructions. The attached workdir `.env` is the only custom environment source; organization/agent `.env` files are no longer read. Agents sharing a workdir share its variables. Existing legacy files are retained as backups, not used as a fallback. The platform never edits workdir `.env` files.

To delete an agent, open **Organization → agent card → Profile → Delete agent**, then confirm. Stop its active work first. Deletion removes it from the chart and dispatch, preserves its history and configuration, and moves its direct reports to its manager. **Organization → Deleted agents → Restore** recovers it paused; enable it when ready. Attached codebases are never deleted. Cards remain resizable from corners and edges without visible corner markers.

Drag the divider beside the main navigation or agent settings to resize it; focusing a divider and pressing Left/Right also works. Widths save in organization SQLite metadata and survive reload/restart. The main sidebar supports 180–420 px and the settings panel 300–900 px, constrained by available window space. The same settings-panel divider resizes execution evidence.

Click **+ (Add group or section)** in the GROUPS header, then choose **Create group** or **Create section**. Section creation opens a distinct dialog with **Section name** and **Save section**. The **three-dot Group options menu beside +** keeps **A–Z**, **Z–A**, **Custom order**, and a second **Create section** shortcut. **Pinned** and **All groups** are the default collapsible sections. Custom sections can be renamed or removed through their own menu; removing a section preserves its groups. Move groups using their three-dot menu (also available on touch devices), drag to another row or section heading, or focus the grip and press Arrow Up/Down. A row reorder switches to Custom order. Pinning temporarily moves a group to Pinned; unpinning returns it to its assigned section. Ordering, pins, section membership and collapse state persist in organization SQLite and across restarts.

Open a group's **Scheduled tasks** tab and choose **New task**. Give it a name, a custom message, and a local date/time; optionally repeat every hour, 24 hours, 7 days, or a custom interval of 1–525600 minutes. Times display in your browser's timezone; repeats use elapsed time, so daylight-saving changes can shift the displayed hour. Schedule URLs end in `/scheduled-tasks`. Tasks can be paused, resumed, edited or deleted. Editing preserves the paused state; a completed one-time task needs a new future time and Resume to send again. Deleting a task retains its chat messages and execution history.

The existing native queue dispatches scheduled messages to the current chat lead, with the same workdir, permissions, sessions and delegation validation as ordinary messages. Message creation and schedule advancement commit together in SQLite. The machine must be awake and the native service running. After downtime, at most one overdue occurrence is dispatched per task; repeats advance to the next future boundary. A task waits while its previous run or delegated work remains active. Enqueue failures pause the task with a visible error; run failures remain in execution evidence. Already-dispatched messages are never automatically replayed after restart. Restoring a backup pauses all imported schedules for review. Pause/delete stops future sends, not already-queued runs; cancel those through Runs.

Navigation has bookmarkable URLs: `/groups/general/chat`, `/groups/general/knowledge`, `/groups/general/runs` and `/organization/agents/ceo/workdir`, for example. Other group/agent names use readable slugs with their stable ID appended so duplicate names and renames remain safe. Browser Back/Forward and direct refresh restore the selected view; old name slugs resolve by ID and update to the current name. Unknown groups, agents and views show **Page not found**.

Codex uses the machine's selected model when the profile model is empty. Each agent has its own `CODEX_HOME` below organization state. The platform borrows the signed-in user's `auth.json`, and synchronizes refreshed credentials only if the original file has not changed. Global user configuration and unrelated credentials are not copied. In **Organization → agent → Workdir → Access mode**, choose **Read only**, **Workspace write**, or **YOLO — full access, no approvals**, then save using **Change workdir**. YOLO maps to Codex `sandbox_mode="danger-full-access"` and `approval_policy="never"`, the same effective permissions as `--yolo`. It runs commands with the Windows account’s access, without the Codex sandbox or approval prompts. The other two modes retain their native sandbox. Each execution uses its queued profile snapshot, including delegates, summaries and resumed sessions. New agents still default to Read only. Actual sandbox behavior depends on the installed Codex CLI and Windows support.

## Storage and backup

All implementation is in `src`; all organization data is in adjacent `org`:

```text
org/
  AGENTS.md                       optional shared instructions
  <agent-id>/                     profile.json, instructions.md, AGENTS.md, scripts/
  .state/
    app.sqlite3                   SQLite WAL: profiles, groups, schedules, messages, sessions, runs, events
    owner.key                     local authentication key
    deployment.json               saved interface alias and port for Start/Open
    service.json                  running process identity and resolved URL
    runtime/<agent-id>/codex/      scoped native sessions and Codex authentication
    sessions/                     immutable-input/final run manifests
    artifacts/                    original uploads
    lancedb/                      local CLIP vector tables
    models/                       downloaded model cache
    logs/                         native service output
    backups/                      exported archives
    verification/                 local execution evidence
```

SQLite is authoritative; LanceDB is the open-source embedded multimodal retrieval store. There are no synthetic embeddings. The shared CLIP ViT-B/32 space supports text-to-text and text-to-image retrieval. Documents are chunked at 48 words; this is simple local retrieval, not an OCR or PDF extraction system. Other file types can be stored, but only text/images are sent to Codex or indexed. Queries and results are scoped to the selected group.

The owner-bar download button is removed; authenticated POST `/api/export` remains available for backups. Exports include a consistent SQLite backup, profiles, scripts, organization instructions and original files with SHA-256 hashes. They exclude credentials, model/index caches, external codebases and provider-native session transcripts. Conversation history and run evidence remain in SQLite. Restore always targets a new directory:

```powershell
pwsh -NoProfile -File scripts/Restore.ps1 -Archive 'path\agentic-enterprise.zip' -Destination 'F:\RestoredOrg'
pwsh -NoProfile -File scripts/Start.ps1 -Org 'F:\RestoredOrg' -Port 8766
```

First restored startup resets unavailable native session handles and marks knowledge for reindexing. Reconnect agent environment values. Existing external workdir references remain, so verify them before issuing work. For full disaster recovery of native sessions and credentials, stop the service and copy the entire protected `org` directory to a secure backup location along with the external codebases.

## Verification

```powershell
cargo fmt --all --check
cargo test --workspace --locked
cd frontend
npm run build
npm run lint
node tests/native-smoke.mjs basic
node tests/native-smoke.mjs codex
node tests/native-smoke.mjs knowledge
node tests/native-smoke.mjs recovery
node tests/native-smoke.mjs ui
node tests/native-smoke.mjs privacy
node tests/native-smoke.mjs design
node tests/native-smoke.mjs organization
```

Smoke tests use the running real service and installed Edge, with no mocks. The `codex`, `knowledge`, `recovery`, `privacy`, and `design` phases use the signed-in Codex account and consume normal account usage; code changes stay in a generated temporary verification repository. Model downloads can be provisioned with `pwsh -NoProfile -File scripts/Models.ps1`, which checks pinned model hashes. The tests retain proof in `org/.state/verification`. Run the phases in order. `AE_TEST_ORG` and `AE_TEST_URL` can point to a separate native instance. Results from this machine are recorded in [VERIFICATION.md](VERIFICATION.md).

There are at most two concurrent runs, with one run per agent or workdir at a time. Event replay and delegation requests are durable; dispatch is in process. This is a trusted personal installation, without enterprise SSO or remote multi-user access. The chat lead can delegate to any available organization agent; reporting relationships determine who can be selected as your lead. Invalid decisions fail visibly and atomically. Stop on a waiting lead cancels its active workers. Interrupted workers are not replayed; their failures can be summarized after restart.

For organization-wide group access, run `node tests/native-smoke.mjs groups` against a fresh native instance on a separate port, with `AE_TEST_ORG` and `AE_TEST_URL` pointing to it. This phase creates groups and a later agent, checks live availability, old membership-field compatibility and validation failures, then runs a real read-only Codex request and verifies separate group history. It consumes normal account usage and refuses to run against the primary instance. Stop the test instance afterward with `scripts/Stop.ps1 -Org <test-org>`.

`node tests/native-smoke.mjs organization-editing` also requires a separate native test organization. It exercises actual card dragging/resizing, layout persistence, size limits, invalid layout rejection, offline-save retry, profile editing, narrow-screen settings and Auto arrange. It restores the prior layout and edited role afterward and does not launch Codex.

`node tests/native-smoke.mjs organization-reporting` requires `AE_TEST_ORG` and `AE_TEST_URL` pointing to a disposable native organization on a separate port. It replaces that test organization's active agents, then checks live owner/manager connectors from an empty chart through first-report creation, reparenting, deletion/restoration, drag/resize, narrow layout and reload. It validates actual SVG endpoints and saved organization knowledge without launching Codex. Stop the test service afterward.

`node tests/native-smoke.mjs coordination` requires a fresh separate native organization and consumes normal Codex usage. It verifies an untagged direct reply, automatic delegation to a worker with the required workspace and environment, a real file edit, resumed lead summary, idempotency, deletion/restoration, preserved history, reparenting and invisible resize handles. Set `AE_TEST_ORG` and `AE_TEST_URL` as above and stop the separate service afterward.

`node tests/native-smoke.mjs navigation` uses a separate organization outside internal `.state` directories (for example `org/verification-navigation`) on port 8766. It browses and attaches a real directory without typing its path, checks cancellation, consolidated instructions, URL refresh/Back/Forward, duplicate names, rename-stable bookmarks, persisted pointer/keyboard resizing, invalid paths/layouts, authentication and narrow-screen layout. A real Codex run reads the selected directory and acknowledges both instruction sources. It consumes normal account usage; stop the test service afterward.

Native Windows execution selects Codex's elevated sandbox implementation and reuses the machine's existing sandbox identity metadata in each protected scoped runtime home. This is required by the installed CLI's split-root enforcement; the unelevated implementation rejects this layout. This setting configures the sandbox implementation for Read only and Workspace write; YOLO explicitly disables sandbox enforcement. Install/sign in with native Codex and complete its Windows sandbox setup first on a new machine. Model sessions are released after one minute without embedding activity to reduce idle memory.

Semantic search offers Documents or Images so each query ranks one content type. CLIP similarity scores across the two types are not calibrated as a single relevance ranking; see the [modality-gap research](https://arxiv.org/abs/2203.02053). Native provider transcripts can contain tool output before platform redaction: the protected runtime directory is excluded from exports. Redaction covers literal and JSON-escaped configured values in platform run output; it is not a guarantee against arbitrary secret transformations by a CLI.

Stop the native service before rebuilding or replacing its executable/DLLs. Linux and macOS have not been verified; deployment scripts target Windows.

## Source provenance

See [UPSTREAM.md](UPSTREAM.md) for pinned GitHub source slices and integration decisions. Apache-2.0 CCCC process ownership, MIT Paperclip Codex exec behavior, official shadcn components, and released Axum/SQLite/LanceDB/FastEmbed libraries provide the foundation. Third-party licenses are retained in `vendor`.

Verify group ordering and scheduling with `AE_TEST_ORG` and `AE_TEST_URL` targeting a fresh separate native organization, then run `node tests/native-smoke.mjs groups-schedules` from `frontend`. This exercises real Edge drag/keyboard controls, real Codex messages, schedule CRUD, failure rollback, authentication, group isolation, native restart and persistence. It consumes normal Codex usage. Stop the test instance after verification.

For slash commands, use the same separate-instance setup and run `node tests/native-smoke.mjs chat-commands`. It verifies live account usage without an agent run, actual Codex sessions before/after reset for two agents, old-context exclusion in native transcripts, group isolation, active-run rejection, idempotency, restart persistence, picker keyboard/pointer controls and 775 px layout. Reset verification consumes normal account usage.

For position and organization awareness, run `node tests/native-smoke.mjs org-context` with `AE_TEST_ORG` and `AE_TEST_URL` pointing to a fresh separate native organization on port 8766. It exercises Position creation/editing, nested relationships, duplicate names, paused/unattached/deleted agents, validation/authentication, real direct/delegated/summary Codex runs, changed hierarchy in the same native session, snapshot persistence and native restart. It consumes normal Codex usage. Stop the test service afterward.

For group lifecycle verification, use `AE_TEST_ORG` and `AE_TEST_URL` for a fresh separate native instance, then run `node tests/native-smoke.mjs group-lifecycle` in `frontend`. The real Edge/API/Codex test checks confirmation/cancel, active-run rejection, archived/deleted history, guarded writes, a due paused schedule, unrelated-group isolation, restoration, saved pins, native restart, narrow layout and recovery with every group hidden. It consumes one normal Codex execution. Stop the test instance afterward.

For private-interface deployment verification, start a disposable organization with `scripts/Start.ps1 -Org <test-org> -Port 8766 -InterfaceAlias wt0`, set `AE_TEST_ORG` to that directory and `AE_TEST_URL` to its resolved HTTP address, then run `node tests/native-smoke.mjs private-network` from `frontend`. It exercises real browser sign-in, invalid credentials/host/origin rejection, chat `/reset`, native terminal output over a non-loopback HTTP origin, launcher validation, and persistence through Stop/Start using the saved interface/port. No Codex execution or mocks are used. Stop the test service afterward.

For scoped chat, run `node tests/native-smoke.mjs group-scope` from `frontend` with `AE_TEST_ORG` and `AE_TEST_URL` targeting a fresh disposable native organization. The real browser/API/Codex flow checks level selection, position badges, validation/authentication, direct/mention restrictions, private delegated file evidence, excluded earlier chat history, lead summary, scheduled routing, stale queued permissions, native session retirement and restart persistence. This uses normal Codex account usage. Stop the test service afterward.

`node tests/native-smoke.mjs workdir-env` requires a fresh disposable organization with `AE_TEST_ORG` and `AE_TEST_URL`. It verifies removed settings/APIs, optional and invalid dotenv files, legacy-file exclusion, terminal isolation/redaction, and real Codex execution/resume after editing `.env`. It consumes normal Codex usage. Project `.env` files are not included in organization backups; retain them with your codebase backup.

`node tests/native-smoke.mjs agent-permissions` requires a fresh disposable org with `AE_TEST_ORG` and `AE_TEST_URL`. It checks all three access choices and persistence, rejects invalid modes/stale edits/anonymous changes, and runs real Codex workspace-write, YOLO resume, delegation and summary. YOLO writes only owner-authorized verification files inside the disposable organization, including outside the attached test workdir. It consumes normal Codex usage.

Sessions are keyed by group, side-chat ID (empty for main), agent and attached workdir. Merely creating/opening a group, adding an agent, or opening an empty side chat never starts Codex. An assignment creates the session record lazily; its native Codex ID is obtained only when the queued work executes. Each `codex exec` process exits afterward; its session ID remains for the next trigger. Agent → Sessions identifies main/side and running/queued/idle status. Main keeps the existing runtime home; sides use `.state/runtime/<agent>/side-chats/<side>/codex`. Schema migration 2 preserves existing records and retires only old native sessions that previously mixed side turns into main; future work creates isolated sessions without deleting history.

`node tests/native-smoke.mjs group-sessions` requires a fresh disposable organization with `AE_TEST_ORG` and `AE_TEST_URL`. It verifies lazy/distinct group and side sessions, inherited main context without side leakage, simultaneous native processes, independent queues, delegation, side-only and group-wide reset, authenticated side routing, restart persistence and no idle Codex processes. Parallel verification uses controlled marker files in the disposable workdir and the real signed-in Codex account.

`node tests/native-smoke.mjs chat-composer` uses the same fresh disposable-instance setup. It checks automatic height growth/shrink/capping, multi-agent mentions through real Codex replies, the shared side composer, keyboard-accessible participant dialog, scoped membership and narrow layouts.

Verify this flow against a fresh disposable organization using `node tests/native-smoke.mjs workspace-navigation` with `AE_TEST_ORG` and `AE_TEST_URL`. It exercises real section CRUD/sorting/dragging, archive restoration, hidden deleted links, restart persistence, 320/390/768 px layouts and touch menus. One real read-only Codex run verifies recorded model badges and spinner-to-green completion; an invalid test-workdir dotenv verifies the failure state without a second provider call.
