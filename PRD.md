# Agentic Enterprise — Product Requirements Document

Group invitation UX amendment (2026-09-22): use a searchable people/agents/teams picker with removable selection chips and an Invite button, followed by a list of existing access. Do not render membership as a checklist. Selecting a manager's team includes its descendants; selecting a sub-team includes its ancestors without sibling branches. Show automatically included managers and protected workspace owners. Apply draft invitations and removals through Save group, preserving the existing group API and authorization rules. Projects continue to manage agent membership in Structure.

Decentralized workspace amendment (2026-09-21): introduce workspace CRUD with a separate organization and authorization boundary per workspace; Matrix-authenticated humans; persistent outbound registered workers for Windows/Linux/macOS/Docker; runtime-local workdirs with Docker volume or bind-mount support; individual human/agent group invitations with included ancestors and selectively excluded team branches; explicit mentions only (ordinary chat must not invoke a chat lead). Use matrix-rust-sdk for bidirectional main-room text communication. This supersedes earlier single-owner, SSH-only and automatic chat-lead routing requirements. Preserve existing project-specific reporting structures, scoped tools and native session persistence. See `src/DEPLOYMENT.md` for the implemented contract and limitations.

OpenCode catalog amendment (2026-09-20): label the harness OpenCode. Expose all models enabled by that workstation’s native CLI, including later configured providers, with native defaults and variants. Refresh on profile opening, window focus and manual refresh. Reuse native configuration and credentials while preserving separate platform sessions; do not silently substitute a different saved model.

Multi-harness amendment (2026-09-20): pilot OpenCode locally, then on a configured macOS workstation. Harness is per agent; Codex and OpenCode delegate in both directions. Preserve independent resumable sessions when switching harness. Native names and variants drive the UI; unsupported controls are hidden. OpenCode defaults to YOLO with native tool-permission alternatives, explicitly not OS sandbox guarantees. Existing group/project scope, workdir overrides, actions, schedules, side chats, skills and owner questions use the same production paths. No fixed concurrency cap, automatic provider fallback or automatic task retry. Managers or eligible teammates review failures once; private delegate failures return to their parent. Report actual available usage and label missing quota/metrics honestly. Command Code remains deferred. This amendment supersedes earlier Codex-only deployment and two-slot limits below.


Project setup and saved workstations amendment (2026-09-20): creating a project collects its name, description and workdir only; team membership and reporting start empty. Navigate directly to Structure for inline organization-agent membership, dedicated project-agent creation and manager configuration. User settings owns saved SSH workstations (hostname, optional IP, port, username, password or local private-key path). Agent/project workdirs select Local or a saved Remote connection. Preserve existing SSH aliases, verify host keys, encrypt saved credentials for the native Windows account, and exclude credentials from exports. Changes during active work and deletion of referenced connections must fail clearly.

Agent clarification amendment (2026-09-20): new Codex runs receive an `ask_user` MCP tool that forwards one to three questions to the owner in the originating group/side chat, including questions from private delegates. Show optional suggested choices and editable free-text answers, saved history, Needs your answer activity and notices linking from other views. Deliver answers to the same waiting run/native session. If native code-mode ends its turn with a tool call pending, retain the queue slot and resume the same session after the answer. Exclude human waiting time from execution limits; keep cancellation and SSH heartbeat ownership active. Never auto-select an answer. Stop, expiry after 24 hours, and service restart make pending requests unavailable with an explicit reason. The adapter remains exec/resume plus MCP, with no added execution permissions or terminal keystroke proxy.

## Projects, action board and agent collaboration — 2026-09-20

- Each group/project owns separate per-agent native sessions, created only when triggered. Each side conversation owns an independent session and queue. Project workdir/host overrides apply to direct, delegated, scheduled and side-chat runs without rewriting a normal agent's defaults.
- Projects are peers of group chats with a distinct folder icon, `/projects/` routes, the same chat/knowledge/run behavior, an explicit member list and a separate reporting chart. Dedicated project agents also appear globally. A project-only manager maps to the organization owner in the global tree; a normal organization manager remains the global manager.
- One organization action board supports Table and Calendar views, project/group and PIC filtering, backlog, future planned starts, Run now, cancellation, evidence and failures. No planned start means no automatic invocation. Schedules claim atomically through the existing queue; archive/delete/backup restore require rescheduling.
- Agents receive real MCP tools for accessible workspace discovery, scoped board reading/editing/invocation, usage, deferred reset, side chat and cross-chat requests. Tokens are active-run scoped. Only an item's assigning agent or owner may edit/invoke it; delegation-only PICs can read their own assigned items and return results privately.
- Owner-confirmed access rule: cross-chat requests require the sender to participate in both chats. Recipient participates in the destination and uses that destination's session. Send only an explicit task; do not copy conversation histories. Persist request receipts, deduplicate retries, recheck access before returning results and return one source summary. One hop, maximum three requests per turn; summary turns cannot invoke more work.
- Agent reset waits for existing work to finish. Reset from main affects only that group and its side chats; side reset affects only that side. Agent `/usage` retains the platform account quota semantics. Operating-system YOLO access is separate from platform tool authorization.

## Remote workstation addition — 2026-09-20

- Agents can attach a Linux/macOS workdir through an existing SSH host alias. Codex executes natively there with that workstation's own login, catalog, workdir `.env`, and lazily created native sessions.
- Organization cards and profiles expose checked connection status separately from agent enablement. Remote agents retain the same reporting relationships, group scopes, delegation, queues and independent side sessions as local agents.
- Workdir browsing, Terminal, project Skills, Code and linked output previews route to the attached workstation. Remote workdir identity includes its alias, preventing cross-workstation native-session reuse.
- Credentials and environment values remain remote. Owner authentication, SSH host-key verification, file containment and secret-file restrictions apply. Native sessions live in a scoped remote runtime; organization chat and execution evidence remain under `./org`.
- Stop owns the remote Unix process group; missing heartbeats stop that group after about 15 seconds. Missing completion is interrupted and never replayed automatically. Deliberately detached daemons are outside this stop boundary.
- Linux and macOS workstations can be attached through saved SSH settings. Remote Windows support is outside this first release. `/usage` remains the platform account's usage, and saved organization scripts remain on the platform machine.


Workspace navigation amendment (2026-09-20): Position badges are followed by the model and reasoning actually recorded for that reply; Codex's local catalog supplies display names, with recorded identifiers as fallback. Later profile edits must not rewrite historical labels. A chat-scoped activity button shows spinning queued/working, green Done after successful work, and Needs attention for failures or interrupted/cancelled work, including delegates and independent side conversations. Group sorting moves into a three-dot menu beside +. The + button explicitly offers Create group and Create section as separate actions. Default Pinned and All groups sections and user-created sections can collapse; custom sections support rename/remove and moving groups through drag, keyboard or menus, with preferences persisted in SQLite. Deleted groups are hidden from platform navigation and old links; retained data and authenticated restore API remain. Archived groups move into a preview/restore modal beside Sign out; remove the owner-bar export button while retaining the backup API. Click the navigation edge to collapse it, drag to resize, and use Workspace to reopen. Below 768 px use a navigation drawer and full-width inspectors; support 320 px layouts and touch-accessible group controls. This amendment supersedes the earlier sidebar lifecycle descriptions below.

Preview knowledge amendment (2026-09-20): add **Add to knowledge** to the rendered Markdown panel for main and side chats. Save the previewed source bytes into the current group's artifact library and invoke its existing semantic index. Show adding/indexing progress, **Added to knowledge** only after persisted indexing success, and actionable failure/retry states. Reuse an existing same-name text file with identical bytes within the group on repeated adds; do not overwrite changed versions. Preserve group isolation and archived/deleted write guards. The action saves the loaded Markdown document, not copies of its linked files, and leaves the conversation unchanged.

Chat file links amendment (2026-09-20, revised): agent messages in main and side chats resolve Windows paths, local file URLs and workdir-relative links through an authenticated run-scoped file endpoint. Use the workdir saved with the run so historical messages survive later profile edits. Raster images embed, scale within the bubble and open at full size by mouse or keyboard. Markdown links and Markdown attachments open rendered in a resizable right preview panel, keeping the chat and unsent draft visible; do not open a new tab. Render headings, tables, code and images, resolving relative report links from the document's folder. Provide download, close, Escape and focus restoration. Missing files and documents over the 1 MiB rendering limit show a clear error; larger documents remain downloadable within the native viewer's 25 MiB cap. Other text files open as plain text, other file types download. Preserve web URL sanitization and existing auth/CSP; reject traversal, symlink/junction escapes, network file paths, sensitive/internal paths and alternate data streams. Display an explicit unavailable state for missing images. Linked files remain live filesystem references, not archived copies.

Identity and chat bubble amendment (2026-09-20): create an original Agentic Enterprise logo with the image generator, store the asset under `src`, and use it throughout the platform's brand placements. Owner messages use right-aligned blue bubbles with white text; agent messages use left-aligned, predominantly white bubbles fading from pale blue. Preserve Markdown readability, message actions, attachments, statuses and identical styling in main and side conversations.

Chat composer amendment (2026-09-20): start the message input at a single line, expand automatically for new and wrapped lines, cap at 220 px or 30% of viewport height, then scroll. Shrink as text is removed or sent. Put the routing hint immediately left of Send. Remove the manual recipient picker; retain optional `@Agent A, @Agent B` and `@all` routing with existing scope validation. The avatar bubbles left of Manage group open a small accessible dialog listing the current group's chat participants, positions, chat lead and paused status. Main and side chats share this composer.

Group sessions and side chats amendment (2026-09-20, revised): each group and each side chat has a separate, lazily created session for each agent receiving work, including delegates. Native CLI processes exist only during execution. `/btw` opens an empty side view without launching agents; `/btw <question>` also sends a question. Side chats inherit a bounded snapshot of recent main-chat context at opening, then retain independent history, native runtime folders and queues. Subsequent side/main turns must not be automatically mixed. Main and side must run in parallel even for the same agent/workdir; within each queue, shared-agent/session/workdir runs remain serialized. No fixed concurrency cap; retain session, agent and workdir ownership rules within each queue. Shared files/resources and account limits remain shared. Side replies appear in their own view with a link from main. As confirmed by the owner, `/reset` inside a side resets only that side; `/reset` in main resets the group's main and all side sessions. Other groups remain unchanged.

Access-mode amendment (2026-09-20): agent Workdir settings offer Read only, Workspace write, and YOLO. YOLO explicitly uses Codex danger-full-access with approval_policy=never for new and resumed executions, including delegation. New agents continue to default to Read only. At the owner's request, current non-deleted agents using Workspace write are changed once to YOLO through the authenticated profile API; Read only and deleted profiles remain unchanged.

Workdir environment amendment (2026-09-20): remove the Environment/secret editor and its read/write/reveal API. Every native agent execution and terminal command loads the attached workdir's `.env` afresh using dotenv parsing, with value redaction retained. Do not search parents or use organization/agent `.env` fallbacks. Missing `.env` is optional; invalid/unreadable files fail clearly. Existing workdir files are never rewritten by the runtime.

- Version: 0.1
- Status: Product foundation; native Codex implementation tracked in `src/README.md` and `src/VERIFICATION.md`.
- Research date: 2026-09-19
- Product owner: Owner

Visual design amendment (2026-09-20): use a shared semantic palette, Poppins UI typography and JetBrains Mono code typography throughout navigation, chat, forms, agent configuration, knowledge, runs, scheduling and organization cards. Self-host fonts in the native deployment. Preserve saved agent colors and existing product behavior; newly created agents use the product's blue accent. Record adapted files and font licenses in `src/UPSTREAM.md`.

Group participation amendment (2026-09-20): chat message badges show Position instead of AGENT. Create/Edit group offers Entire organization (backward-compatible default) or selected organization levels: Level 1 directly reports to the owner, Level 2 to Level 1, and so on. Selected levels may participate in chat. Lower levels may receive delegated work but cannot be directly addressed or post to the group; results return to the assigning agent for its public summary and remain inspectable by the owner in Runs. Delegation-only workers receive assigned tasks without automatic previous group chat or quoted replies. Routing, explicit recipients/mentions, `@all`, scheduled messages, queue admission and reply publication must enforce the current scope. A group may select an included enabled chat lead; Automatic prefers the organization's lead when included, otherwise a highest-included-level agent. Scope changes wait for active group work, retire existing native sessions and preserve visible history/files. Existing historical messages are retained. Scope follows later reporting changes, and queued work is revalidated before execution.

Group lifecycle amendment (2026-09-19): Manage group provides Archive, recoverable Delete and Restore with inline confirmation before hiding. Archived and Deleted groups have separate sidebar lists; stable group URLs retain readable conversations, runs, sessions and downloadable knowledge. Hidden groups reject new messages (including slash commands), schedule changes and knowledge mutations at the authenticated API. Archiving/deletion atomically pauses scheduled tasks and rejects active runs or knowledge indexing. Restore returns the same group ID, history and sessions to active navigation, retaining pin/order preferences and leaving schedules paused for explicit review/resume. General and the last active group follow the same rules; creation and recovery remain available when no active groups remain. Group status persists in existing SQLite JSON records and backup archives; prior records default to active. No permanent purge is included.

Organization identity and awareness amendment (2026-09-19): each agent has a separate Display name, Position (job title), and Role (responsibilities). Position is editable during creation and in Profile and appears on organization cards. Every execution, including direct requests, the chat lead, delegated work, final summaries and resumed Codex sessions, receives a fresh organization snapshot: all non-deleted profiles, positions, roles, formal manager, management chain, direct and indirect reports, peers, chat lead and available workdir/permission/environment-key information. Paused or unattached agents remain visible as unavailable. The actual task assigner and result recipient are distinct from the formal manager. Exact agent IDs accompany delegated results to disambiguate identical names. No environment values are shared. Profile exposes Organization knowledge; Runs preserves the exact supplied snapshot for inspection. Saved changes apply on the next execution, including resumed sessions. Existing profiles remain compatible with an empty Position. Existing bounded chat-lead dispatch (up to three workers and one summary) remains in place.

Agent CLI and skills amendment (2026-09-19): agent configuration includes bookmarkable Terminal and Skills tabs. Terminal runs owner-entered PowerShell commands in the saved workdir with the attached workdir's `.env`, streams redacted plain output, records history/exit/failure state, stops owned child processes, respects configured timeouts, and marks interrupted commands without replay. Manual commands use the owner's Windows permissions; they are distinct from sandboxed autonomous agent runs. Workdir concurrency is serialized with agent execution. The initial console handles unattended CLI commands/installers; persistent interactive PTY sessions remain deferred. Skills uses installed Codex discovery to list repository skills with names, descriptions, paths, enabled state and visible discovery errors. The owner can filter, refresh and inspect their Markdown, and use Terminal to install into `.agents/skills`. All platform-managed command history remains under `org`; installing project skills writes to the explicitly attached codebase.

Chat command amendment (2026-09-19): typing `/` in group chat opens an accessible command picker. `/reset` retires all agent session handles for this group, including direct reports and delegated agents, and starts a new automatic conversation-context boundary. Visible history and organization configuration remain intact; other groups are unaffected. Reject reset while work is queued, running or awaiting delegated results. `/usage` reads current Codex account limits without creating an agent run, displays remaining percentages/reset times and marks missing data unavailable. Commands share authenticated chat submission, durable records/events, idempotency and clear failure handling. They are not sent to agents as prompts or included in their automatic context.

Group organization and scheduling amendment (2026-09-19): group navigation supports persisted A–Z/Z–A sorting, pins and pointer/keyboard custom reordering. Pinned groups stay above other groups; dragging across the boundary changes pin state and selects Custom order. Each group has a Scheduled tasks view with its own slug URL. The owner creates a custom message with a future local time and optional fixed repeat interval, and can pause, resume, edit or delete it. Dispatch uses the same chat lead, agent environment, workdir, native sessions and delegation queue as normal messages. SQLite atomically records the message and advances the schedule. Missed occurrences coalesce once; active prior work delays the next send; enqueue failures pause visibly; interrupted execution is never replayed automatically. Schedules require the native service and awake machine; restored backups start with schedules paused. Task deletion preserves existing messages/runs.

UI scope amendment (2026-09-19): remove Work/Team work from the product; replace the sidebar agent roster with an Organization manager and editable reporting relationships. Knowledge uses a compact file explorer with file previews. Agent model and reasoning choices come from installed Codex settings and its available-model catalog. Older work-item requirements below are superseded by this amendment; historical records remain preserved.

Chat and organization amendment (2026-09-19): ordinary group messages automatically reach the owner's selected direct report (Chat lead, initially CEO). It handles or delegates based on actual agent roles, workdirs, permissions and environment names, with at most three workers and one final summary per message. Workers use their own credentials and sessions, without recursive dispatch or secret forwarding. Explicit recipients remain optional. Agent deletion is recoverable, preserves conversation history and external codebases, blocks during active work and reparents direct reports. Organization cards drag and resize without visible corner markers and open profile settings when clicked.

Navigation amendment (2026-09-19): Workdir has a popup folder explorer so the owner can attach a codebase without entering its path. Agent settings expose one Instructions editor, including existing agent AGENTS.md content; the separate AGENTS.md settings tab is removed. The main navigation and agent settings widths resize by divider drag or keyboard, persist under `org`, and respect window constraints. Groups, main views and agent settings have readable, bookmarkable URLs; direct loads, refresh, Back/Forward, duplicate names and renames must resolve correctly. Attached repositories' own AGENTS.md files remain unchanged.

Implementation scope amendment (2026-09-19): the owner explicitly deferred OpenCode and Command Code and requested a native deployment on this Windows machine without Docker. The current acceptance gate is the complete Codex flow on Windows. References below to all three CLIs or Linux remain roadmap requirements, not claims about the current build. `src/VERIFICATION.md` records actual current-machine evidence and limitations.

## 1. Product vision

Agentic Enterprise is a personalized, self-hosted agent harness. The owner works with named AI agents in persistent group conversations, gives each agent a role and instructions, assigns work, and inspects what actually ran. Agents can use different coding CLIs while sharing one understandable interface and organization context.

The product combines organization and execution concepts from Paperclip with the group-chat interaction of CCCC. It must feel like managing a small team: people, conversations, responsibilities, work, and evidence.

The main outcome is: **configure an agent, address it in a group, watch a real CLI run, inspect the result, and continue the same conversation after restarting the platform.**

## 2. Fixed requirements

| Area | Requirement |
| --- | --- |
| Name | Agentic Enterprise. |
| Backend | Rust owns the application API, orchestration, persistence, process supervision, and policy enforcement. |
| Frontend | TypeScript, React, and shadcn/ui components. |
| Runtimes | Codex CLI through `exec`. Owner clarification during implementation: ignore OpenCode and Command Code for now; retain them as future adapters. |
| Interface | Persistent group chat with a default chat lead, scoped delegation, optional explicit recipients, visible run status, and inspectable outputs. |
| Personalization | Editable agent profiles, Markdown instructions, `AGENTS.md`, scoped environment configuration, and code/script visibility. |
| Attach workdir | Attach an existing codebase directory to a custom agent and execute its CLI directly in that directory, with explicit access permissions and visible working-directory context. |
| Source placement | All platform implementation, tests, migrations, scripts, build configuration, and dependency manifests live under `./src`. Root-level product/governance documentation is allowed. |
| Organization data | All platform-managed organization data, sessions, agent configuration, artifacts, logs, and runtime state live under `./org`. |
| Database | Open-source, local and lightweight to operate; support multimodal data and retrieval. See the explicit storage decision in section 8. |
| Development method | Search existing GitHub implementations first; reuse, selectively import, or adapt maintained code. Do not start equivalent subsystems from scratch. |

At the initial review, the workspace contained root `AGENTS.md`, an empty `src/`, and `org/ceo/AGENTS.md`, with no root README, SPEC, dependency manifests, or Git repository. The implementation now lives in `src/`. Preserve existing organization files; do not overwrite or silently relocate the CEO instructions.

## 3. Users, scope, and assumptions

The first user is the owner operating a trusted personal installation. The design supports several agent profiles, groups, and projects within one organization. Organization scoping is required from the beginning; a multi-organization user interface is deferred.

Initial supported deployment targets are Windows x64 and Linux x64, using a browser with a local Rust service. macOS support follows successful platform verification. No cloud service, Kubernetes, Redis, or external database server is required for local use. External agent CLIs and their accounts remain prerequisites.

“Multimodal” means storing and retrieving text and image content with metadata and embeddings, plus attaching files of other supported media types. It does not imply that every agent model understands every attachment. “Multi-model database” means relational/document/graph capabilities and is a separate concept; this PRD does not assume a graph database is required.

The named CommandCode integration is interpreted as **Command Code at commandcode.ai**, based on its documented coding CLI. This identity is explicit so a different intended product can be substituted before its adapter is implemented.

### First complete release

- One organization with configurable agents, roles, project workspaces, groups, and simple work items.
- Group messaging, replies, explicit agent targeting, durable history, and live run events.
- All three CLI adapters, continuation, cancellation, recovery, and clear unsupported-capability errors.
- Profile, Markdown, `AGENTS.md`, environment, script, session, and artifact inspection.
- Local persistence, backup/restore, text search, and text/image retrieval using real indexed content.
- Owner access control, scoped secrets, audit records, and safe workspace handling.

### Deferred until a demonstrated need

Recurring autonomous work, organization charts with complex delegation, billing, precise cross-provider budget enforcement, multi-user RBAC/SSO, remote execution fleets, plugin marketplaces, voice, chat-service bridges, and a full browser terminal are outside the first release. The name “Enterprise” does not make these prerequisites.

## 4. Reference architecture and reuse decisions

### Paperclip: organization and execution structure

Paperclip separates its server, UI, CLI, shared packages, and runtime adapters. Its organization model and execution records are useful references for agents, projects, work ownership, and session continuity. It currently uses a Node.js backend, so its backend cannot be imported unchanged to satisfy the Rust requirement. Reuse suitable frontend code and adapt narrowly selected contracts and algorithms into the Rust application. [Paperclip source and workspace manifest](https://github.com/paperclipai/paperclip), [workspace package boundaries](https://github.com/paperclipai/paperclip/blob/3ff3b34e15255395e38ad03d0331e55b6c056061/pnpm-workspace.yaml).

Its Codex adapter explicitly constructs `exec --json` arguments and handles explicit resume IDs. Inspect the surrounding execution/parser code and tests before adapting it; do not blindly inherit its sandbox or network defaults. [Codex argument builder](https://github.com/paperclipai/paperclip/blob/3ff3b34e15255395e38ad03d0331e55b6c056061/packages/adapters/codex-local/src/server/codex-args.ts).

### CCCC: group chat and Rust reuse

CCCC is now a Rust product, with separate contracts, core, runtime, daemon, web, and CLI crates plus a React/TypeScript frontend. Its migration documentation states that the Python backend was retired in 0.4.36. This makes its Rust implementation the first place to inspect for compatible process, profile, and web behavior. Its current Codex path uses app-server, so it is not a drop-in replacement for the required Codex exec adapter. [Rust migration](https://github.com/ChesterRa/cccc/blob/37a0b1aab9344fc88cea9a964017566eaf2d0519/docs/rust-migration.md), [Cargo workspace](https://github.com/ChesterRa/cccc/blob/37a0b1aab9344fc88cea9a964017566eaf2d0519/Cargo.toml).

Inspect these concrete candidates before implementing their equivalents:

| Concern | Upstream candidate | Intended reuse |
| --- | --- | --- |
| Process ownership and termination | CCCC `crates/cccc-runtime/src/process_tree.rs`, `executable.rs`, `session.rs` | Select compatible Rust process-management behavior and tests; omit terminal-only dependencies when unnecessary. |
| Profiles | CCCC `crates/cccc-core/src/profiles.rs`, `crates/cccc-web/src/routes/actor_profiles.rs` | Adapt profile validation and API patterns to the required organization layout. |
| Chat presentation | CCCC `web/src/components/MessageBubble.tsx`, `VirtualMessageList.tsx`, `ActorAvatar.tsx` | Reuse suitable presentation behavior and compose the surrounding UI with shadcn/ui. |
| Web boundaries | CCCC `crates/cccc-web/src/lib.rs` and request-origin/auth modules | Reuse applicable Axum routing and origin protection patterns. |
| Codex exec lifecycle | Paperclip `packages/adapters/codex-local/src/server/` | Adapt relevant launch, parse, and resume contracts to Rust. |
| OpenCode invocation | Paperclip `packages/adapters/opencode-local/` and official OpenCode CLI | Inspect compatibility before selection; use native structured output. |
| Command Code invocation | Official CLI plus `tariqwest/commandcode-acp` | Use the community adapter only as a secondary example, not an assumed production dependency. |
| UI primitives | `shadcn-ui/ui` | Import the official components actually used by the product. |

CCCC also distinguishes delivery, reading, and replies. Agentic Enterprise adopts that distinction rather than treating an accepted process input as proof that an agent read or completed work. [CCCC messaging description](https://github.com/ChesterRa/cccc#messaging--coordination).

### Source selection policy

1. Search the existing workspace, the two reference repositories, and relevant official GitHub repositories before writing a subsystem.
2. Compare license, supported platforms, recent releases, maintenance, relevant tests, dependency cost, and fit to this PRD. Stars and newest commit alone do not establish stability.
3. Prefer a released, compatible version. A newer commit is acceptable for a required fix only with its associated regression proof. Never depend on floating `main`, `master`, or `latest` in a release.
4. Use the dependency directly when it already solves the problem. Otherwise import the smallest coherent source slice with the dependencies and tests it needs.
5. Use `git cherry-pick -x` for a compatible, self-contained commit in a checkout containing that history. Across unrelated architectures, use an attributed file import or port; do not describe that as a literal cherry-pick.
6. Record upstream repository, release/tag, full commit, original paths, license/NOTICE obligations, destination paths, local modifications, and verification in `src/UPSTREAM.md`; preserve required attribution in `src/THIRD_PARTY_NOTICES.md` and source files.
7. Write only the integration and adaptation necessary to connect selected implementations. If no suitable implementation exists, record the search and gap before proposing a bespoke subsystem; do not silently abandon the reuse requirement.
8. Run the selected code through the real application path. Upstream tests and release badges are supporting evidence, not proof of this integration.

### Maintenance snapshot

These were GitHub's latest published releases returned during research. They are selection candidates, not versions already installed, audited, or proven compatible together.

| Repository | Release observed | Published | License metadata |
| --- | --- | --- | --- |
| [paperclipai/paperclip](https://github.com/paperclipai/paperclip/releases/tag/v2026.916.0) | v2026.916.0 | 2026-09-16 | MIT |
| [ChesterRa/cccc](https://github.com/ChesterRa/cccc/releases/tag/v0.4.40) | v0.4.40 | 2026-09-18 | Apache-2.0 |
| [lancedb/lancedb](https://github.com/lancedb/lancedb/releases/tag/v0.39.0) | v0.39.0 | 2026-09-17 | Apache-2.0 |
| [anomalyco/opencode](https://github.com/anomalyco/opencode/releases/tag/v1.18.31) | v1.18.31 | 2026-09-14 | MIT |
| [shadcn-ui/ui](https://github.com/shadcn-ui/ui/releases/tag/shadcn%404.21.0) | shadcn@4.21.0 | 2026-09-04 | MIT |
| [tokio-rs/axum](https://github.com/tokio-rs/axum/releases/tag/axum-v0.8.9) | axum-v0.8.9 | 2026-04-14 | MIT |
| [tariqwest/commandcode-acp](https://github.com/tariqwest/commandcode-acp/releases/tag/v0.1.0) | v0.1.0 | 2026-08-09 | MIT |

All seven repositories were unarchived when checked. Paperclip and CCCC source inspection used commits `3ff3b34e15255395e38ad03d0331e55b6c056061` and `37a0b1aab9344fc88cea9a964017566eaf2d0519` respectively. These are reviewed branch snapshots, not claims that the release tags point to those commits. Recheck selected files at the exact release commit before importing.

## 5. Primary user journeys

### A. Configure a personalized agent

1. Open Agents and create a named profile, for example CEO, Researcher, or Engineer.
2. Choose Codex CLI, OpenCode, or Command Code and select a validated executable and available model.
3. Set the role, use **Attach workdir** to select an existing codebase, and configure execution limits and workspace permissions.
4. Edit Markdown instructions and inspect the effective `AGENTS.md` sources.
5. Configure environment variables and inspect any configured launcher script.
6. Run a connection check. Show installed version, executable path, authentication readiness, and supported capabilities without triggering paid work just to save a profile.
7. Save a versioned profile. A separately requested test message exercises the actual agent.

### B. Collaborate in a group

1. Create a group with a name and description. Choose Entire organization or selected organization levels for chat participation; lower levels can receive private delegated work. Membership follows the reporting tree, including agents created later; there is no individual-agent membership checklist.
2. Send an ordinary message to the selected chat lead. It decides whether to handle it or delegate using the organization capability catalog. Explicit recipients and `@agent` mentions are optional overrides.
3. Persist the message and per-recipient run request before acknowledging acceptance.
4. Show queued/starting/running state and real output as the selected CLI produces it.
5. Display the agent reply in the group with expandable tool activity, execution evidence, and attachments.
6. Reply to that message to continue the agent's session within that group and workspace.
7. Refresh or restart the platform and recover the same history and honest run state.

### C. Inspect and control work

Open an agent or run to see the exact profile revision, instruction sources, executable, redacted arguments, working directory, timestamps, provider session ID, exit outcome, emitted tool calls, scripts, and resulting files. Stop a run and verify that its owned child processes terminate. Retrying creates a new attempt linked to the previous one.

### D. Find previous knowledge

Attach a text document or image to a group, see its indexing state, and search it later. Results link to the original file/message with source context. Sending retrieved material to an agent is explicit, bounded, and capability-aware; saving an attachment does not itself submit it to an external provider.

### E. Attach an existing codebase

1. Open a custom agent's Workdir settings and choose **Attach workdir**. Enter an absolute directory path on the machine running the Rust backend, or use an authenticated backend directory picker restricted to owner-approved roots. A browser file upload is not a workdir attachment.
2. Validate the directory and display its resolved path, access mode, and Git root/branch/dirty state when applicable. Support non-Git directories when the selected CLI permits them; never initialize Git automatically.
3. Save the attachment as the agent's default workspace. Attaching registers a reference without copying, moving, modifying, indexing, or running the codebase.
4. Address the agent in chat. The composer shows its selected workdir; the CLI runs with that exact directory as its process `cwd` and can inspect or modify the existing codebase according to the granted permissions.
5. Inspect the run's actual `cwd`, repository instructions, commands, and resulting diff. Organization/session records remain under `org`; authorized code edits remain in the attached codebase.

## 6. Functional requirements

| ID | Requirement | Acceptance condition |
| --- | --- | --- |
| FR-01 | Organization and agent directory | Create, edit, disable, and list named agents with role, avatar, runtime, model, and workspace; existing CEO instructions remain intact. |
| FR-02 | Scoped organization addressing | Groups default to the entire organization or select exact reporting levels for chat. Lower levels can receive delegated work and return private results for the lead's summary. Stable agent IDs, current scope, enabled state and a valid workdir are enforced before execution. `@all` stays inside the chat scope and per-message run limit. Group history and native sessions remain separate. |
| FR-03 | Durable messaging | Markdown messages, replies, timestamps, attachments, and per-recipient state survive a restart. A duplicate client request does not create duplicate messages or runs. |
| FR-04 | Honest delivery state | Accepted, queued, dispatched, replied, and failed states have distinct evidence. A read receipt appears only when the runtime explicitly supports acknowledgement; otherwise it is unavailable. |
| FR-05 | Profile editor | Edit identity, Markdown instructions, `AGENTS.md`, environment, model, executable/arguments, workspace, permissions, timeout, and concurrency. Validation errors identify the field. |
| FR-06 | Effective configuration | Show source paths, precedence, revision, and redacted effective launch configuration. Saved edits affect the next run, not a running process. |
| FR-07 | Runtime support | Real prompts and follow-up prompts work through each of the three specified CLIs; missing executable, authentication, or unsupported flags produce actionable errors. |
| FR-08 | Session continuity | Map each organization/group/agent/workspace/runtime context to its own provider session. Explicit reset starts a new session; never use an unscoped “last session.” |
| FR-09 | Run supervision | Queue, launch, observe, time out, cancel, and recover runs with process ownership and final outcomes. Prevent concurrent use of the same provider session. |
| FR-10 | Code and script visibility | View launcher/script content and emitted tool commands, including path, content hash or revision, and available outputs. Missing runtime telemetry is marked unavailable. |
| FR-11 | Work items | Create a titled work item from a message, assign one owner, and track queued/in-progress/blocked/in-review/done. Agent output can request review; the owner marks work done. |
| FR-12 | Attachments and retrieval | Upload, inspect, download, index, search, and delete allowed files; text and images have tested retrieval. Unsupported model input is rejected before launch. |
| FR-13 | Search and history | Paginated message/run search by group, agent, date, state, and text. Semantic results include a source link and indexing/model metadata. |
| FR-14 | Export and recovery | Export an organization and restore its history, profiles, and artifacts to a clean installation. Exclude credentials from ordinary exports. |
| FR-15 | Access and audit | Protect management actions and artifact access; record actor, action, target, time, and outcome without storing secret values in audit logs. |
| FR-16 | Attach workdir to a custom agent | Attach, inspect, switch, and detach an existing backend-host directory through the app. All three CLI adapters honor the selected process `cwd`; bindings survive restart, and invalid paths block launch without fallback. |

### Attached workdir behavior

- Persist a workspace ID, display name, canonical absolute path, and granted access mode; reference the workspace ID from the agent profile. An agent has one selected default workdir; multiple agents may reference the same workspace subject to writer locking.
- Expose **Attach workdir**, **Change workdir**, and **Detach** in the agent inspector's Workdir view. Show the path and access mode beside the chat recipient and in every run's details so the owner can see which codebase each agent will use.
- Offer read-only, workspace-write and explicitly selected YOLO (danger-full-access) modes. Enforce the selected mode through the runtime's supported controls; if enforcement is unavailable, block launch with a capability error. Workspace-write authorizes requested code changes, not automatic cleanup, commits, or destructive reset operations.
- Snapshot the workspace binding with each queued run and revalidate the path, permissions, and repository identity where available immediately before launch. A missing/moved directory or changed symlink/junction target fails clearly; never fall back to the platform directory, agent home, or another repository.
- Changing the default affects new requests only. Existing queued/running requests retain their captured binding. A different workspace requires a separate provider session mapping; never resume an old codebase's session against the new path. Detach is blocked while queued or active runs reference the binding; the owner can cancel them first. Detaching never deletes the directory or its history.
- Respect the attached codebase's applicable `AGENTS.md` files and preserve its `.env` and local changes. Attachment alone does not import project secrets, execute setup scripts, install dependencies, or index the repository. Resolve instruction injection without silently replacing the attached `cwd` with a generated workspace.
- Direct work in the existing directory is the default. An optional isolated Git worktree must be explicitly selected and show its distinct actual `cwd`. Reuse existing workspace handling from the reference projects rather than building a separate execution path for attached workdirs.
- Backups include attachment metadata, not the external codebase. After restore on another host, unresolved attachments remain unavailable until the owner explicitly rebinds them.

### Profile and file behavior

- `profile.json` contains structured, non-secret configuration. `instructions.md` holds role/personality/task guidance; `AGENTS.md` holds the agent's operating instructions.
- The editor supports Markdown source, sanitized preview, save, revision history, diff, and restore. Concurrent changes produce a conflict instead of overwriting newer content.
- Show organization instructions, agent instructions, and repository instructions separately. Build a deterministic run manifest of their contents/hashes and order. Runtime-specific instruction loading must be tested; a common filename does not guarantee common precedence across CLIs.
- Explicit owner task directions operate within platform permissions. Markdown is prompt context, not a security boundary. Do not rewrite an external project's `AGENTS.md` to inject a profile.
- Automatically load `<attached workdir>/.env` for each agent execution and terminal command, including delegates and resumed sessions. Missing files add no variables; unreadable/invalid files fail clearly. Re-read for each execution; agents sharing a workdir share its environment.
- No platform secret editor, reveal/write API, or organization/agent `.env` overrides. Read dotenv as data, never source it as shell code. Precedence is the allowlisted OS environment followed by workdir values; runtime identity/data-directory variables remain reserved. Keep values out of normalized logs, browser responses, search and exports. Organization context receives key names only.
- Use documented CLI instruction/config injection where available. If a runtime needs files, materialize an owned run workspace with tracked generated instructions; do not mutate the user's original project files silently.
- Let the owner view and edit an agent-owned launcher script. A script outside the organization directory is read-only in this interface; import a copy before editing. Editing instructions or scripts never executes them.
- “Code used” includes configured scripts and tool commands actually exposed by the CLI. The interface must not claim access to hidden provider implementation or unreported tool internals.

### Group-chat layout

Use a left sidebar for organization, groups, and agents; a central conversation timeline and composer; and a right inspector for the selected profile, run, files, and configuration. The inspector has Profile, Workdir, Instructions, Code & Scripts, and Sessions views.

Use official shadcn/ui primitives for navigation, forms, dialogs, tabs, menus, and status surfaces. Preserve keyboard navigation, focus restoration, accessible labels, readable contrast, and a reduced-motion option. Collapse tool details by default. Do not fabricate typing, completion, read, or progress indicators.

## 7. Runtime adapter contract

Rust owns one shared launch/supervision path with three concrete adapters. Reuse upstream implementations for parsing, process ownership, and runtime-specific edge cases where compatible. Do not build a general plugin framework for these three adapters.

Each adapter reports executable identity/version, authentication status when safely discoverable, supported input modalities, structured output, explicit resume support, instruction injection, runtime-state relocation, and approval behavior. “Unknown” is a valid probe result and must not appear as “ready.”

| Runtime | Documented entrypoint | Continuation and integration notes |
| --- | --- | --- |
| Codex CLI | `codex exec --json` | Consume JSONL and capture the thread ID; continue with explicit `exec resume <SESSION_ID>`. Supply prompts through stdin where supported. Do not substitute app-server or a direct model API. |
| OpenCode | `opencode run --format json` | Capture the native session ID; continue using `--session <ID>`. Use one-shot CLI execution initially; a persistent `serve` transport is only needed if measured startup cost warrants it. |
| Command Code | `command-code -p "<prompt>" --output-format json` | Capture native session identity and use documented explicit session selection. Windows supports `cmdc`; never resolve Windows `cmd.exe` as the agent. |

These are upstream-documented command shapes, not smoke-test results for this workspace. Verify flags against each pinned installed version. Official references: [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [OpenCode CLI](https://opencode.ai/docs/cli/), [Command Code CLI](https://commandcode.ai/docs/reference/cli).

### Execution rules

1. Validate the organization agent, profile, workspace, executable, credentials, and capabilities before spawning.
2. Persist the requested run and its configuration revision. Claim queued work transactionally and enforce one active run per provider session; no fixed total concurrency cap is imposed; retain ownership locks.
3. Start a real child process with an argument array, explicit working directory, and scoped environment. Resolve Windows executable/shim behavior explicitly. Do not interpolate chat text into a shell command.
4. Read stdout and stderr without blocking either pipe. Normalize emitted events and redact secrets before persistence or browser streaming; retain bounded, redacted provider payloads for diagnosis.
5. Store ordered events before publishing them to the UI. Replay by event cursor after reconnect; stream connections never own the run lifecycle.
6. Record exit status and protocol outcome. A zero exit alone does not prove a valid reply or completed user task. Nonzero exit, malformed output, authentication failure, timeout, and cancellation remain distinguishable.
7. Cancellation targets only the owned process tree, with a graceful stop followed by bounded forced termination. On Windows, use verified process-tree/Job Object behavior from an established implementation.
8. After a service crash, reconcile owned processes and persisted runs. If ownership or completion cannot be proved, mark the run interrupted and require an explicit continuation/retry. Do not automatically repeat possibly completed side effects.

Run states: `queued → starting → running → succeeded | failed | cancelled | timed_out | interrupted`. A pre-launch policy gate may use `awaiting_approval → queued | cancelled`. Provider tool approval is a separate capability: if the headless CLI cannot pause and resume for approval, fail clearly and offer a newly authorized run; never pretend an in-app button approved a hidden provider request.

Agent replies are visible to the group. Only the selected chat lead can return a structured delegation decision, validated against current enabled agents and their attached workdirs. Persist at most three distinct worker requests, each using its own profile, environment and scoped session. When all workers terminate, resume the lead once to summarize actual results and failures. Reject self-delegation, duplicate targets and invalid assignments atomically. No worker can recursively dispatch. Persist the routing decision and parent run IDs, make retries idempotent, and allow cancellation of the waiting lead and its active workers.

## 8. Database and multimodal storage decision

**Recommended foundation: SQLite for authoritative application state plus embedded LanceDB OSS for multimodal retrieval, with original files under `./org`.** This is a deliberate two-store decision, not a claim that LanceDB alone should manage the application's transactional state.

| Candidate | Fit | Decision |
| --- | --- | --- |
| SQLite + LanceDB OSS | Embedded transactional application state plus Rust-accessible text/image/vector retrieval; no database service to administer. | Selected foundation, subject to the real Rust/Windows/Linux integration gate below. |
| SQLite alone | Small deployment and transactional history; files/BLOBs and text search cover basic attachments. | Useful for the first vertical slice, but insufficient by itself for the full semantic multimodal requirement. |
| SurrealDB | Relevant multi-model database candidate, but its current BSL licensing does not meet this PRD's strict open-source selection requirement. | Not selected. Reconsider only if the owner changes that requirement. |

[SQLite](https://www.sqlite.org/about.html) is an embedded, serverless SQL database with transactional storage and public-domain source. [LanceDB OSS](https://github.com/lancedb/lancedb) provides local multimodal/vector retrieval and a Rust API under Apache-2.0. SurrealDB's own [license explanation](https://github.com/surrealdb/license/blob/main/README.md) identifies BSL as not OSI-certified. Check the actual selected release licenses before distribution.

“Lightweight” here means local operation without separate database services. LanceDB's binary size, build requirements, and memory use still need measurement; no resource claim is assumed from the word “embedded.”

### Data ownership

- SQLite is authoritative for organizations, agents, profile revisions, attached workspaces, groups, messages, deliveries, work items, sessions, runs, run events, artifact metadata, indexing jobs, and audit records. Groups do not restrict agent membership.
- Agent profile files are inspectable materializations of committed profile revisions. Import existing files explicitly; save revisions transactionally and regenerate interrupted file materializations on startup. External edits require a visible import/conflict decision.
- Original artifacts live in organization storage. SQLite records their stable IDs, hashes, media types, size, scope, and relative paths. Never use a user-supplied filename as an unrestricted storage path.
- LanceDB holds derived chunks, embeddings, and retrieval metadata keyed by artifact/message ID and organization/group scope. Store embedding model, dimensions, source revision, and indexing status.
- Commit an indexing job alongside source metadata in SQLite; a Rust worker updates the derived index idempotently. Search validates returned IDs and permissions against authoritative metadata. Deletion tombstones immediately exclude results while index cleanup proceeds.
- Index failure does not erase the original content or break chat. The UI reports pending/failed indexing and allows retry. Derived indexes can be rebuilt from the authoritative data and original files.
- Use SQLite foreign keys, transactions, ordered migrations, a busy timeout, and a verified WAL/backup configuration. Keep its files on supported local storage, not a shared network filesystem.

### Multimodal boundary

Text and image attachments must have real end-to-end indexing/retrieval proof before the first complete release. Use a maintained embedding implementation with a documented model/license; validate text-to-image retrieval in a shared embedding space rather than assuming arbitrary vectors are compatible. Do not build an encoder from scratch.

Audio/video may initially be stored and downloaded with metadata; semantic retrieval and agent consumption are enabled only after a compatible extractor/model path is implemented and tested. Show those limitations in the UI. External embedding or model submission requires the configured provider and an explicit user action or enabled organization policy.

## 9. Repository and organization layout

The following is the intended layout, not directories created by this PRD. Keep a single application workspace initially; preserve imported crate boundaries only when they serve actual reused code.

```text
./
├── AGENTS.md                         # project development rules
├── PRD.md                            # this product foundation
├── src/                              # all platform code and build inputs
│   ├── README.md                     # setup, build, run, verification
│   ├── .gitignore
│   ├── .env.example                  # reproducible non-secret example only
│   ├── Cargo.toml / Cargo.lock
│   ├── rust-toolchain.toml
│   ├── backend/                      # Rust application / selected crates
│   ├── frontend/                     # React, TypeScript, shadcn/ui + manifests
│   ├── migrations/
│   ├── tests/                        # real API/browser/runtime checks
│   ├── scripts/                      # platform build/run/verification scripts
│   ├── UPSTREAM.md
│   └── THIRD_PARTY_NOTICES.md
└── org/                              # private mutable organization data
    ├── organization.json             # non-secret organization metadata
    ├── AGENTS.md                     # organization-level instructions
    ├── ceo/                          # preserve existing agent directory
    │   ├── profile.json
    │   ├── instructions.md
    │   ├── AGENTS.md
    │   └── scripts/                  # agent-owned user content, not app code
    ├── <agent-slug>/                  # other agents, same profile layout
    └── .state/                       # reserved platform-managed data
        ├── app.sqlite3
        ├── lancedb/
        ├── runtime/<agent-id>/        # provider session/config/cache homes
        ├── sessions/<session-id>/     # transcript exports and run manifests
        ├── artifacts/
        ├── workspaces/                # managed worktrees where needed
        ├── logs/
        └── backups/
```

Reserve `.state` and organization metadata names so agent slugs cannot collide with them. Database IDs remain stable when display names change.

Resolve the default organization root relative to an explicit application workspace root, not whichever shell directory happened to launch the binary. Display the resolved absolute path in settings. An explicit data-directory option may relocate the whole organization, preserving the same internal layout.

All platform-managed provider sessions must remain inside `org/.state/runtime`. Verify documented home/config/data overrides per CLI; do not assume one generic environment variable relocates all three. If a CLI cannot isolate required session state, that adapter fails the storage acceptance gate until a supported scoped-home method is proven. Do not silently write sessions to the owner's global CLI home.

Authentication may use an explicitly selected existing CLI login or OS credential store; report that external dependency in backup/restore. Do not copy global credential stores wholesale into organization files. Persistent application/session data remains under `org` even when authentication is externally managed.

Platform source, migrations, and launcher implementation belong in `src`; user-authored agent scripts belong in `org`. External project repositories stay in their existing locations and are referenced by validated workspace paths. Ignore private organization data, `.env`, builds, caches, logs, and dependency directories in any enclosing Git repository. Check in only non-secret examples under `src`.

## 10. Application architecture and API boundary

Use a Rust application with Axum/Tokio, adapting suitable CCCC components. It serves the built React frontend and same-origin API, supervises CLI children, and owns local stores. The frontend never spawns processes or reads private files directly. Package reuse must not pull the retired Python backend or a Node.js application server into production; external agent CLIs may have their own runtime dependencies.

```text
Browser: React + TypeScript + shadcn/ui
                  │ HTTP commands / resumable SSE events
Rust API: auth → validation → organization scope → services
                  ├── profiles / chat / work / search / audit
                  ├── persistent run queue → process supervisor
                  │                         ├── Codex exec
                  │                         ├── OpenCode run
                  │                         └── Command Code print
                  └── SQLite + organization files + LanceDB index
```

Initial API resources are `/api/agents`, `/api/workspaces`, `/api/groups`, `/api/messages`, `/api/work-items`, `/api/sessions`, `/api/runs`, `/api/artifacts`, `/api/search`, and `/api/events`. Profile revisions, agent-workspace bindings, run cancellation, and environment updates are scoped subresources. Workspace attachment and binding updates use the same authenticated API and validation path as execution. Every request resolves the organization and owner authority on the server. Generate frontend contract types from the selected Rust/OpenAPI tooling rather than maintaining mismatched hand-written duplicates.

Message submission uses a client idempotency key and atomically writes the message, recipient deliveries, and queued runs. REST fetches provide paginated history; server-sent events carry persisted changes with monotonic cursors. A cursor outside retention triggers explicit history resynchronization. WebSocket terminal transport is deferred unless an actual terminal feature is added.

Minimum entity relationships: Agent profiles reference a Workspace; Group has Members and Messages; Message has recipient Deliveries and optional reply/work-item links; Delivery may create a Run; Run belongs to an Agent profile revision and Session and snapshots its Workspace binding; Session owns an explicit provider session mapping scoped to that Workspace; Artifacts link to messages/runs; IndexJobs link to versioned sources. Uniqueness constraints enforce client idempotency and session/run ownership.

## 11. Security, reliability, and usability requirements

- Bind to loopback by default. Use owner authentication/session protection and strict origin/host checks even locally; untrusted websites must not be able to trigger local agent execution. Remote exposure requires authenticated access and HTTPS through an explicitly configured endpoint.
- Enforce authorization on API mutations, streams, search, file reads, exports, and downloads. Never rely on hidden UI controls.
- Canonicalize allowed paths and reject traversal, symlink/junction escapes, reserved paths, and unauthorized workspaces. Profile configuration editing is limited to its own organization files; agent execution may edit an attached codebase only within its explicitly granted workspace permissions.
- `.env` is sensitive plaintext when used. Restrict directory/file access to the owner/service account and exclude contents from platform previews and normal exports. Never imply that masking encrypts data on disk.
- Never inherit the service's complete secret environment into every agent. Load only the attached workdir .env and redact before storing logs or streaming output; reject unsafe extra arguments that override reserved policy controls.
- Keep native CLI sandbox protections enabled for Read only and Workspace write; YOLO is an explicit owner choice to disable the sandbox and approvals. Show the effective access policy; never silently change permissions to make a test pass. This personal host process is not a hardened boundary for mutually hostile agents.
- Treat imported Markdown, transcripts, retrieved documents, and tool output as untrusted content. Sanitize rendered markup and do not allow content to change platform permissions.
- Enforce configured prompt, attachment, upload, queue, run duration, and stored-output limits. Start with a 25 MiB attachment limit and 30-minute run timeout, both configurable. Truncation is visible and never represented as a complete transcript.
- Shared writable workspaces have one writer at a time. Use Git worktrees for explicitly selected concurrent coding work. Never discard local changes or create commits/merges as an incidental chat operation.
- Export only after obtaining a consistent database snapshot and associated immutable file manifest. Restore verifies hashes/schema compatibility and requires credentials to be reconnected. A normal file copy of a live WAL database is not a backup procedure.
- Store timestamps in UTC and display the owner's configured timezone. Display cost only when reported or explicitly estimated; missing usage is unknown, not zero.

### Initial measurable targets

On a documented reference machine, with external agent/model processes and embedding generation excluded from platform overhead measurements:

| Measure | Target and proof |
| --- | --- |
| Idle backend footprint | At most 300 MiB RSS with no indexing job active; publish measured binary size and memory. Failure requires an explicit storage/build decision. |
| Local readiness | API and first screen ready within 5 seconds after launch on the reference machine. |
| Message acceptance | p95 under 500 ms for durable acknowledgement with two active agents. |
| Event visibility | p95 under 1 second from backend receipt of a provider event to browser display. This is not a model response-time target. |
| History | A group with 10,000 messages opens its first 50 messages within 1 second; paginate rather than load all history. |
| Cancellation | Owned process tree confirmed stopped within 10 seconds, or a visible stop-failed state with evidence. |
| Durability | All acknowledged messages remain after tested restart/crash recovery; no automatic repeat of ambiguous side effects. |

These are acceptance targets, not measured results from this documentation task.

## 12. Delivery sequence and proof gates

Each milestone is a working vertical slice. Keep its implementation under `src` and its runtime evidence/data under `org`. No mock-only milestone counts as completed product behavior.

| Milestone | Delivered behavior | Required real proof |
| --- | --- | --- |
| M0 — Select reusable foundation | Resolve compatible upstream release commits, file/dependency scope, licenses, and the smallest Rust/web base. | Build/run the selected base on Windows and Linux; record exact versions and source provenance. Validate LanceDB Rust persistence/reopen on both before committing to its integration. |
| M1 — First agent conversation | Owner access, one editable profile, attached existing workdir, group chat, SQLite persistence, Codex exec, live output, stop, continuation. | Attach a real existing codebase through the browser, send a prompt to Codex CLI, verify its actual `cwd` and requested code change, inspect process/JSONL evidence, refresh, restart, continue the exact session, and cancel another run. |
| M2 — Complete runtime and profile support | OpenCode and Command Code; instructions, AGENTS.md, environment, scripts, versioned configuration, and scoped runtime homes. | Run each CLI, follow up in the same session, edit a harmless instruction/env marker and observe its next-run effect; confirm all session writes stay under `org`. |
| M3 — Team coordination and recovery | Multiple agents in a group, explicit targeting, work items, idempotency, writer locks, run reconciliation. | Two real agents respond to selected recipients; duplicate submit creates one request; stop/restart does not duplicate ambiguous work; blocked and failed states are visible. |
| M4 — Knowledge and release readiness | Text/image indexing and retrieval, source inspection, export/restore, performance and security acceptance. | Ingest real text/image files, retrieve expected sources, remove one and prove it disappears from search; restore to a clean data directory and run the recovered application. |

The original roadmap includes M1–M4 with all three real CLIs. Under the owner's scope amendment, the current deployment is complete when the Windows Codex flow, local storage/retrieval and native operational checks pass. Other runtime and platform gates remain deferred and must not be advertised as verified.

### Acceptance scenarios

- **Happy path:** The owner configures each runtime and receives a real reply in a group, with a persisted run and explicit native session ID.
- **Continuation:** Follow-up context survives platform restart. A second agent/group cannot accidentally resume the first agent's session.
- **Attached codebase:** For each CLI, attach a pre-existing codebase outside `src` and `org`, request a small authorized edit, and verify the real child-process `cwd`, resulting file/diff, preserved pre-existing changes, and session records under `org`. Attaching and detaching alone leave the codebase unchanged.
- **Workdir boundaries:** Verify persistence after restart, paths containing spaces, read-only write rejection, unavailable paths without fallback, symlink/junction retarget rejection, and non-Git capability errors without implicit initialization. Switching codebases starts a separate session; detaching with pending work is rejected; restored missing bindings require explicit rebinding.
- **Configuration:** A saved Markdown change affects the next run. The previous run retains its original manifest. Conflicting edits do not lose data.
- **Secret boundary:** A unique dummy secret reaches only its authorized child process and is absent from browser responses, logs, exports, and retrieval indexes.
- **Failure:** Missing binary, invalid model, expired authentication, malformed event output, nonzero exit, and timeout show distinguishable errors without fabricated replies.
- **Cancellation:** Stopping an agent ends its owned descendants and leaves unrelated processes running; prove this on Windows and Linux.
- **Durability/idempotency:** Repeated submission and interrupted event streams do not duplicate messages/runs; persisted events replay in order.
- **File safety:** Traversal, symlink/junction escapes, oversized uploads, and unauthorized downloads fail through the real API.
- **Permission:** Unauthenticated and disallowed-origin requests cannot read private data or execute agents. A requested provider approval unsupported by the CLI fails clearly.
- **Retrieval:** Known text/image examples return expected source IDs; deleted or inaccessible content cannot reappear through a stale index.
- **Backup:** Restore into a clean organization root reproduces message counts and artifact hashes, reports missing credentials, and supports a new real run.

Use the existing verification scripts of imported code and add only behavior checks needed for the integration. Rust checks include build, formatting, Clippy, and relevant tests; frontend checks include its actual lint, typecheck, test, and production build scripts. Record concrete commands after the source layout exists; this PRD does not invent currently runnable commands.

For each delivered milestone, include the repository's required SUMMARY / PROOF / NEXT report with the user path, commands, key output, changed files, real dependencies, any justified external-boundary mocks, and remaining risks. Live CLI acceptance needs configured credentials; missing credentials are a reported verification blocker, never replaced by a fake successful agent.

## 13. Decisions and risks carried into implementation

| Topic | Foundation decision / remaining gate |
| --- | --- |
| Reuse versus Rust | CCCC Rust components are first-choice candidates; Paperclip provides organization and Codex exec references. Imported dependency boundaries must be inspected before selection. |
| Persistence conversion | CCCC's existing state format is not assumed to be SQLite. Reused components must share the new authoritative storage boundary; do not run two competing chat/session stores. No legacy CCCC import feature is required. |
| CLI drift | Pin and record tested versions. Detect protocol incompatibility and fail explicitly; disable background auto-update where the CLI supports that option. |
| Provider-state location | Prove each adapter's supported home/config/data relocation, including resume. This is a release gate, not an optional convenience. |
| Command Code | Official CLI is the integration authority; the small community ACP repository is a reference with lower adoption confidence. Verify installed CLI behavior and authentication independently. |
| Multimodal storage | SQLite + LanceDB is selected on documented capabilities. Build size, memory, Rust integration, and platform support remain unbenchmarked. |
| Embeddings | Select a maintained text/image model and implementation during M0/M4 preparation; record license, download size, hardware needs, and real retrieval accuracy before enabling it. |
| Portability | Organization export preserves platform data; it does not promise that native sessions or credentials are portable across incompatible CLI versions or operating systems. |
| Agent authority | Profiles personalize behavior; they do not create isolation from other host resources. Stronger untrusted-agent isolation requires an explicit later deployment design. |
| Scope | This deliverable establishes requirements and research provenance only. Application functionality, runtime compatibility, resource targets, and end-to-end success remain to be implemented and proven. |
