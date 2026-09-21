# Harness and remote execution comparison — 21 September 2026

**Decision:** Keep Agentic Enterprise's Rust control plane, SQLite authority, native harnesses and existing SSH transport. Use Paperclip as the main reference for execution contracts and recovery evidence, CCCC for collaboration semantics, and Multica for an optional persistent remote worker. Do not merge three orchestration systems or replace the platform wholesale.

“Superior” below means better suited to a stated requirement, based on inspected implementation. It is not a measured speed, reliability, cost or model-quality ranking. No comparative inference benchmark was run.

**Scope and evidence**

The local baseline is the working tree, including existing uncommitted OpenCode and remote-workstation changes, at Git HEAD `0edba3426c2aac8120565644901f7e997a553f59`. `PRD.md` is the requirements document; no `SPEC.md` was found in the initial file inventory. The analysis read the root and platform READMEs, upstream attribution, verification history, actual frontend entrypoints, backend routing, queue, session, process ownership, credentials, MCP and SSH code.

Fresh shallow upstream checkouts were inspected at these exact revisions:

| Project | Revision | Role in this comparison |
| --- | --- | --- |
| [Paperclip](https://github.com/paperclipai/paperclip/tree/29d6b350969157c99d9328d525adc20bdb31d2e3) | `29d6b350969157c99d9328d525adc20bdb31d2e3` | Organization orchestration, adapter contracts, execution environments and recovery |
| [CCCC](https://github.com/ChesterRa/cccc/tree/3b2fc6456ed437bb8cf513686ba5f88dcf829b69) | `3b2fc6456ed437bb8cf513686ba5f88dcf829b69` | Persistent collaboration, managed native sessions, messaging and inter-instance connections |
| [Multica](https://github.com/multica-ai/multica/tree/f41fae6b08fb734afcbd13205c0b3203dd0bc9c6) | `f41fae6b08fb734afcbd13205c0b3203dd0bc9c6` | Distributed runtime registration, task claims, reconnect recovery and provider backends |

These are inspected branch heads, not a claim that every feature has passed a stable-release acceptance test. Upstream applications were not deployed or benchmarked. Source presence, prior local execution records and fresh live probes are identified separately.

**The ranking by requirement**

| Requirement | Strongest reference / fit | Reason and limitation |
| --- | --- | --- |
| Company-wide policy, budgets and task accountability | Paperclip | Explicit task ownership, budget policies, adapter results and execution leases. More infrastructure and policy complexity than our personal workspace needs today. |
| Live heterogeneous agent collaboration | CCCC | Separates delivery, reading and reply obligations; supports managed protocol sessions plus native terminals and durable group history. It is not simply a remote job executor. |
| Connecting multiple worker machines that may lose contact | Multica | Registered daemons, atomic claims, reconnect reconciliation and persistent completion reports. A network interruption need not destroy all execution evidence. |
| Managed sandbox execution and control-plane recovery | Paperclip | Capability-aware targets, native runner transports, controller leases and termination receipts. Paperclip also supports remote execution; it must not be characterized as local-only. |
| Our present Windows controller with attached Linux/macOS workdirs | Agentic Enterprise | Direct in-place SSH, native remote credentials, no continuously installed worker, existing project/group scope. Best fit for the current contract, not the broadest feature set. |
| Rich structured interaction with a running Codex session | CCCC; Multica for unattended app-server execution | Protocol-level lifecycle and interruption exceed a one-shot exec wrapper. Permission handling differs significantly between products. |
| Small operational footprint | Agentic Enterprise for the current requirements | One native application service and local SQLite. Simplicity comes with a single-controller availability limit. |

**What our platform actually does**

The real flow is:

```text
React chat / action / schedule
  -> authenticated Rust API
  -> group and project scope validation
  -> persisted message + run + native-session identity
  -> one dispatcher and ownership checks
  -> Codex exec/resume OR OpenCode standalone run/session
  -> local owned process tree OR SSH Python bridge + remote process group
  -> normalized output, session handle, usage, completion and SQLite events
  -> chat evidence, delegated results and at most one failure review

Agent -> ephemeral run-scoped enterprise MCP -> same Rust control plane
```

The frontend posts messages in `frontend/src/App.tsx:357` and fetches native harness settings at `App.tsx:1640`. `backend/src/api.rs:32` onwards supplies the production routes. `coordination.rs:213` snapshots the effective agent/project workdir, validates eligibility and enqueues work. The unique session index in `migrations/003-harness-sessions.sql` keys active sessions by group, agent, workspace, side chat and harness. Switching providers does not inherently mean reusing another provider's native conversation.

`runtime.rs:31` admits queued runs, rechecks group access and starts owned processes. Main work shares agent/workdir ownership rules; independent side chats deliberately relax those conflicts while retaining distinct sessions. This is an explicit PRD choice. It can allow simultaneous edits to the same files; it is not a missing lock that should be silently “fixed” by serializing every side chat.

`process_tree.rs:34` onwards owns process lifetime separately from provider protocol lifetime. Windows uses Job ownership with suspended launch; Unix uses process-group ownership. `remote_bridge.py:156` executes the native remote CLI; the bridge sends start/finish frames and kills its owned group on cancellation, timeout or missing controller heartbeats. Runtime control messages are normally sent about every two seconds; the remote loss threshold is 15 seconds. That threshold is source-inspected here, not newly fault-injected.

The platform already has several strong foundations worth preserving:

- Durable SQLite records and transactional schedule/action admission.
- Workdir identity and project overrides, instead of silently using the coordinator's directory.
- Separate native session handles for harnesses and side chats.
- Run-scoped MCP credentials, membership checks and idempotent tool receipts.
- Human questions persisted in the originating chat, with waiting excluded from execution time.
- Process ownership, output limits, secret redaction and remote completion checks.
- No automatic replay after uncertain side effects; restart marks even queued runs interrupted under the current policy.

Remote credentials stay on the workstation for native provider login. Saved SSH passwords/passphrases use Windows DPAPI, while native OpenSSH supplies transport and host-key verification. Local runtime homes borrow credentials; remote scoped homes borrow that host's credentials with compare-before-copyback guards. This is scoped state management, not isolation from another fully privileged process running as the same OS user.

**Paperclip: strongest execution-policy reference**

Paperclip's separation is valuable: the control plane owns work and policy, the adapter owns provider invocation, and an execution target owns where the process runs. Its current target types cover local, SSH and managed sandbox execution; capability snapshots describe what a target can actually do. Current native runner connectivity includes local loopback, direct outbound WSS and provider-authenticated ingress. These are materially broader than the older exec adapter adapted into our application. [Target contract](https://github.com/paperclipai/paperclip/blob/29d6b350969157c99d9328d525adc20bdb31d2e3/packages/adapter-utils/src/execution-target.ts), [runner connectivity](https://github.com/paperclipai/paperclip/blob/29d6b350969157c99d9328d525adc20bdb31d2e3/packages/adapter-utils/src/runner-connectivity.ts).

Its adapter result carries more than output text: session identity, usage basis, billing classification, structured errors, and positive evidence about whether execution can safely recover. In particular, bootstrap recovery distinguishes “provider work never started” from interrupted work with settled outcomes. This is more useful than adding a generic retry count to our runner. We should introduce only the fields our two harnesses can actually substantiate. [Adapter types](https://github.com/paperclipai/paperclip/blob/29d6b350969157c99d9328d525adc20bdb31d2e3/packages/adapter-utils/src/types.ts).

Paperclip also distinguishes controller ownership from process identity. Its legacy controller path uses a boot UUID, a renewable database lease, and revocation that permits cleanup rather than automatically authorizing a replacement agent. Remote termination receipts bind confirmation to the exact run, environment lease and provider lease. The useful principle is: **an expired lease or a dead connection is not proof that remote effects stopped**. [Controller ownership](https://github.com/paperclipai/paperclip/blob/29d6b350969157c99d9328d525adc20bdb31d2e3/server/src/services/legacy-controller-lease.ts), [termination evidence](https://github.com/paperclipai/paperclip/blob/29d6b350969157c99d9328d525adc20bdb31d2e3/server/src/services/remote-execution-termination.ts).

Its budget service supports scopes including company, agent and project, and threshold states including warnings and hard stops. Our `/usage` is observability, not equivalent budget enforcement. Add that policy only when we need controlled paid autonomous work; do not assume a subscription's token counts translate directly to dollars. [Budget implementation](https://github.com/paperclipai/paperclip/blob/29d6b350969157c99d9328d525adc20bdb31d2e3/server/src/services/budgets.ts).

One remote-workspace pattern should not be copied indiscriminately: Paperclip documents staging a local Git workspace remotely and restoring remote work into the local authoritative workspace. Our attached workstation directory is itself authoritative and may contain engineering datasets, uncommitted work and non-Git assets. Making every SSH execution a sync/restore operation would change the product and create avoidable transfer and conflict risks. [Workspace persistence contract](https://github.com/paperclipai/paperclip/blob/29d6b350969157c99d9328d525adc20bdb31d2e3/docs/adapters/creating-an-adapter.md).

**CCCC: strongest collaboration reference**

CCCC models agents as persistent actors in groups. Web, CLI and MCP address daemon-owned coordination state; a ledger preserves collaboration history. Its supported runtime guide distinguishes native terminal interaction from structured background protocols. For Codex, the implementation manages app-server sessions and validates resumed thread identity; runtime controls include starting, steering and interrupting turns. These capabilities are a better reference if we want users to intervene in a running session, rather than only submit another queued task. [Runtime guide](https://github.com/ChesterRa/cccc/blob/3b2fc6456ed437bb8cf513686ba5f88dcf829b69/docs/guide/runtimes.md), [Codex session launch](https://github.com/ChesterRa/cccc/blob/3b2fc6456ed437bb8cf513686ba5f88dcf829b69/crates/cccc-daemon/src/ops/codex_voice_analyst/launch_codex.rs), [turn control](https://github.com/ChesterRa/cccc/blob/3b2fc6456ed437bb8cf513686ba5f88dcf829b69/crates/cccc-daemon/src/ops/codex_voice_analyst/control.rs).

The most transferable idea is the separation of facts: local acceptance, delivery to another group, delivery into a runtime, consumption/read and a returned reply are different events. A process accepting stdin is not evidence an agent understood a task. Our handoff receipt is a good base, but the current compact `Handoff` record does not express CCCC's complete delivery/read/reply model. Enrich existing SQLite events and handoffs only where we have trustworthy evidence; never manufacture a “read” marker from successful transport. [Inbox operations](https://github.com/ChesterRa/cccc/blob/3b2fc6456ed437bb8cf513686ba5f88dcf829b69/crates/cccc-daemon/src/ops/messaging_inbox.rs).

CCCC Connect is a different remote architecture from our SSH runner. It links independently owned instances and groups, using qualified instance/group identities, authorization grants and a persistent delivery outbox. Bounded message retries survive restart; receipt is distinct from completion, and cancelling a reply obligation does not stop the receiving actor. That is useful if separate installations must collaborate. It is excessive if one owner simply wants Codex to work on a Mac directory. [Connect contract](https://github.com/ChesterRa/cccc/blob/3b2fc6456ed437bb8cf513686ba5f88dcf829b69/docs/guide/connect.md), [durable outbox](https://github.com/ChesterRa/cccc/blob/3b2fc6456ed437bb8cf513686ba5f88dcf829b69/crates/cccc-core/src/connect_delivery.rs).

We already reused CCCC's strongest low-level contribution: process-tree ownership. Adding its entire daemon and ledger would create competing authorities beside our queue, sessions and event log. Adopt the contracts and targeted implementation improvements, not a second collaboration backend.

**Multica: strongest persistent worker reference for our next remote step**

Multica separates its central application from a daemon installed on each execution machine. A daemon discovers provider CLIs, registers runtimes and capabilities, claims tasks, executes through provider backends and reports results. Its protocol includes WebSocket notifications/RPC, with HTTP paths and polling retained for compatibility and recovery. Wakeup notifications are hints; they do not themselves establish ownership of work. [Daemon implementation](https://github.com/multica-ai/multica/blob/f41fae6b08fb734afcbd13205c0b3203dd0bc9c6/server/internal/daemon/daemon.go), [wire protocol](https://github.com/multica-ai/multica/blob/f41fae6b08fb734afcbd13205c0b3203dd0bc9c6/server/pkg/protocol/messages.go).

Task claims use database locking and generation checks. The inspected SQL includes `FOR UPDATE SKIP LOCKED`, preparation leases and compare-and-set guards on the dispatch generation. An old handler cannot simply roll back a newer claim. The important distinction is claiming work, preparing it and acknowledging that execution started; those should not collapse into one “running” status. [Task SQL](https://github.com/multica-ai/multica/blob/f41fae6b08fb734afcbd13205c0b3203dd0bc9c6/server/pkg/db/queries/agent.sql), [server claim handlers](https://github.com/multica-ai/multica/blob/f41fae6b08fb734afcbd13205c0b3203dd0bc9c6/server/internal/handler/daemon.go).

Its durable terminal-report outbox is the most valuable feature to study first. Completion/failure callbacks are saved locally without authentication tokens, retried with current credentials and acknowledged individually. Transient failures remain pending; repeated permanent rejections are quarantined rather than silently deleted. Reconnection also wakes cancellation and membership reconciliation. This addresses the case where work completed but its final response never reached the controller. Replaying a completion report is fundamentally different from rerunning the agent task. [Result outbox](https://github.com/multica-ai/multica/blob/f41fae6b08fb734afcbd13205c0b3203dd0bc9c6/server/internal/daemon/terminal_report_queue.go), [reconciliation](https://github.com/multica-ai/multica/blob/f41fae6b08fb734afcbd13205c0b3203dd0bc9c6/server/internal/daemon/reconcile.go).

Multica's provider backends expose an execution interface and streamed results. Its Codex backend uses app-server rather than only exec JSONL. However, richer protocol support does not automatically mean a stronger permission model: the inspected daemon handler auto-accepts command/file approvals and grants recognized requested permission fields. We should preserve our explicit permission choices and owner-question behavior, not import that unattended approval policy. [Backend interface](https://github.com/multica-ai/multica/blob/f41fae6b08fb734afcbd13205c0b3203dd0bc9c6/server/pkg/agent/agent.go), [Codex backend and approval handling](https://github.com/multica-ai/multica/blob/f41fae6b08fb734afcbd13205c0b3203dd0bc9c6/server/pkg/agent/codex.go).

Provider counts are not evidence of feature parity. Multica's OpenCode v2 compatibility code explicitly describes MCP and resident-process differences at the versions it inspected; our pilot records target v2.0.11 with standalone ownership. We must verify the installed version's MCP, permissions, question, resume and cancellation paths individually. Neither implementation's assumptions can substitute for the other's runtime tests. [OpenCode v2 compatibility boundary](https://github.com/multica-ai/multica/blob/f41fae6b08fb734afcbd13205c0b3203dd0bc9c6/server/pkg/agent/opencode_v2.go), local `VERIFICATION.md`.

Multica also supports explicit in-place versus worktree execution for local-directory resources and refuses unknown modes instead of silently editing the original directory. That is a useful model for optional coding-task isolation. Its configurable worker concurrency limit is a capacity-management choice; copying its default cap would conflict with our current no-fixed-cap requirement. [Directory handling](https://github.com/multica-ai/multica/blob/f41fae6b08fb734afcbd13205c0b3203dd0bc9c6/server/internal/daemon/local_directory.go), [worker configuration](https://github.com/multica-ai/multica/blob/f41fae6b08fb734afcbd13205c0b3203dd0bc9c6/server/internal/daemon/config.go).

**Remote connection: what changes with each topology**

| Concern | Our current SSH | Paperclip targets / runner | CCCC Connect | Multica daemon |
| --- | --- | --- | --- | --- |
| Primary remote unit | Attached workstation workdir | Execution environment/lease | Independent instance and group | Registered execution runtime |
| Connection requirement | Controller reaches SSH; agent also reaches central MCP over the private network | SSH, outbound WSS or provider ingress, according to target capabilities | Reachable peer routes and connection grants | Daemon reaches central APIs/control connection |
| State authority | Central SQLite; native history on execution host | Central orchestration plus target/runner execution state | Each instance owns its local groups/history | Central task state plus worker execution and report state |
| Lost connection | Watchdog stops owned work; missing finish is interrupted | Path-dependent recovery, ownership leases and stop evidence | Persisted message delivery retries; does not imply remote actor cancellation | Reconciliation and durable result delivery; transient control loss is not an immediate universal process kill |
| Extra deployment | OpenSSH, Python and native CLI on the host | Target/provider/runner dependent | Another full CCCC instance | Installed and maintained worker daemon |
| Best use for us | Trusted private hosts and interactive engineering workdirs | Future managed sandboxes and strict recovery policy | Future independently administered teams | Future unattended or intermittently connected worker fleet |

Do not equate an SSH tunnel with reconnectable execution. Do not equate reconnectable execution with exactly-once external side effects. A worker may perform a filesystem/API action just before losing contact. Claim generations prevent stale state updates; they cannot undo an already-issued external operation. Safe recovery still needs settled outcome evidence, operation idempotency or explicit inspection.

**Concrete gaps in our current implementation**

| Priority | Finding | Evidence and user consequence | Smallest useful incorporation |
| --- | --- | --- | --- |
| 1 | Readiness combines too few facts | `remote.rs:161` and `remote_bridge.py` probe workdir/CLI/login; they do not prove callback connectivity or every required harness feature. A green workstation can still fail MCP collaboration. | Separate host reachability, workdir validity, CLI/version, native auth, selected-model availability and MCP reachability. Keep unknown distinct from ready. |
| 1 | Completion evidence is tied to the live SSH stream | `runtime.rs:749` onwards marks a missing remote finish interrupted; bridge finish is emitted without a durable per-run result outbox. | Persist a protected terminal receipt remotely before transmission; retrieve it by exact run/attempt identity after reconnect. Never replay the task just to recover the receipt. |
| 1 | Compatibility is mainly version/catalog-specific code | Provider flags, events, credential schema and MCP behavior are distributed across Rust and Python. The Mac model/CLI mismatch is already documented in `VERIFICATION.md`. | A small capability/diagnostic record and a shared acceptance matrix, not a provider marketplace. |
| 2 | Independent side sessions share files | `runtime.rs:120` conflict rules and the PRD intentionally permit side/main parallelism. | Offer explicit Git worktree isolation for coding tasks; retain in-place engineering workflows and preserve the chosen mode on resume. |
| 2 | Process completion and stop confirmation are not separate durable facts | Loss of the remote finish leaves the controller unable to confirm cleanup; the watchdog is a safety mechanism, not a receipt. | Record stop requested, stop confirmed, completed and outcome unknown separately; keep terminal UI labels consistent with actual evidence. |
| 2 | Harness and transport branches are intertwined | `runtime.rs:320` onwards mixes harness flags, runtime home, local/remote setup and completion normalization. | Extract only shared run specification and normalized result/capability types when implementing the next slice. Keep provider-specific logic explicit. |
| 2 | Presence monitoring scales per workdir/harness and checks sequentially | `remote.rs:251` iterates unique workspace/harness probes, then sleeps 30 seconds; each RPC may wait up to 35 seconds. This is not a fixed 30-second freshness guarantee. | Deduplicate host-level facts, retain workdir-level checks, expose observation time; bound parallel probes if measurements show delays. |
| 3 | Dispatcher reads historical runs repeatedly | `runtime.rs:36` loads all run records every dispatch; a status index already exists in `001.sql`. | Query queued/active records using the existing index if history growth makes dispatch expensive. No database migration needed for that first optimization. |
| 3 | Usage is not budget enforcement | Usage records/account limits are displayed, but admission is not a scoped monetary-budget policy. | Optional project/agent policies using measured billing data, only when requested for paid autonomous work. |

These are architecture findings, not claims that every gap has caused a production failure. The API availability failure below is directly observed; its root cause was not diagnosed in this comparison.

**Recommended incorporation sequence**

1. **Readiness and capability evidence.** Work in `remote.rs`, `remote_bridge.py`, the current harness diagnostics and existing workstation status UI. Do not store model catalogs permanently as capabilities: models and authentication change. Include checked timestamps and structured failure causes. Verify a reachable host with an unavailable MCP callback, missing CLI, unsupported version, invalid model and invalid workdir, plus a healthy local/Mac run. Fresh checks should not require paid inference; full acceptance can use explicitly selected test models.

2. **Recover terminal evidence without changing execution policy.** Extend the current SSH helper to write an atomic bounded receipt under its protected organization namespace. Bind it to controller identity, run ID and attempt ID; record native session, result classification, exit code, stop evidence and output digest/reference. On contact restoration, reconcile only that attempt. Receipt retrieval and duplicate acknowledgements must not execute another task. Keep the present 15-second loss policy initially. Verify dropped final frames, controller restart, duplicate receipt, cancellation/completion race, corrupt receipt and an unreachable host. If no trustworthy receipt exists, retain an explicit unknown/interrupted outcome.

3. **Optional coding-workspace isolation.** Reuse native Git worktrees, with an explicit user choice and validation that the source is a Git repository. Define whether a task starts from committed HEAD or includes current dirty changes; never silently discard them. Keep each resumed task on its original worktree. Prove side/main tasks can edit the same relative filename independently and that existing in-place projects behave unchanged. Worktrees isolate tracked files, not ports, databases, credentials or hardware.

4. **Structured Codex interaction, only for a concrete UX need.** Prototype app-server behind the existing harness contract when live steering, native approval requests or richer lifecycle evidence is needed. CCCC supplies useful session/control patterns. Keep the existing exec route available during acceptance. The current PRD explicitly chooses exec/resume, so changing that contract needs an explicit product decision. Test original session identity, question persistence, cancellation, process cleanup, local/remote parity and access modes. Do not auto-accept new protocol requests.

5. **Optional persistent worker when deployment requires it.** Use Multica's architecture as a reference for one small worker mode in our own application, rather than importing its full backend. Initially support one Linux host and one harness through the existing queue. Require outbound authenticated transport, explicit machine enrollment/revocation, capability negotiation, durable attempt ownership, local result outbox, reconnect reconciliation and bounded storage. Keep the central SQLite queue authoritative; the worker's journal is execution evidence, not another task scheduler. Network-loss grace and continued offline execution are explicit policy changes to the current watchdog contract. A stopped process cannot be “reattached”; distinguish resumed native conversation from recovery of a still-running process.

6. **Governance or federation only when needed.** Use Paperclip-style budget/approval policy for controlled paid autonomy. Use CCCC-style qualified instance/group addressing only if multiple independently owned platforms must collaborate. Preserve our stricter shared-membership and one-hop rules unless the owner changes them.

Suggested first implementation is step 1, followed by step 2. The greatest immediate value is making readiness and remote outcomes trustworthy, not adding more provider names.

**Acceptance criteria for any transport/harness change**

| Scenario | Required observation |
| --- | --- |
| First run, then follow-up | Same intended native session, host and workdir; second run actually uses prior context |
| Harness switch and return | Separate provider sessions; original provider resumes its own session |
| Project and side chat | Correct project override and independent context; no accidental file-isolation promise |
| Missing/invalid provider capability | Clear preflight failure; no weaker mode or different model selected silently |
| Connection loss before execution starts | No duplicate start; claim state and proof distinguish admission from execution |
| Loss after effects or final output | Recover receipt or report uncertainty; no blind rerun |
| Cancellation and late completion race | Final state reflects authoritative attempt and stop evidence; stale updates cannot win |
| Owner question | Correct chat, same run/session, no fabricated answer; cancellation stays active |
| Token revocation / membership removal | Platform operations reject stale authority, including after reconnect |
| Remote output or file access | Bounded output, redaction and containment retained |
| Worker/controller restart | Reconcile persisted evidence before offering continuation; no duplicate side effects claimed |

**Reuse and licensing**

Paperclip's inspected root license is MIT. CCCC's inspected root license is Apache-2.0; our retained `vendor/CCCC-LICENSE` is also Apache-2.0. Some prose in `UPSTREAM.md` incorrectly describes CCCC-related adaptations as MIT. Reconcile those attributions against the exact imported files/revisions before importing additional code; this report does not change license files. [Paperclip license](https://github.com/paperclipai/paperclip/blob/29d6b350969157c99d9328d525adc20bdb31d2e3/LICENSE), [CCCC license](https://github.com/ChesterRa/cccc/blob/3b2fc6456ed437bb8cf513686ba5f88dcf829b69/LICENSE).

Multica's inspected license incorporates Apache-2.0 with additional conditions. Its text allows internal organizational use, restricts third-party hosting and commercial embedding without a commercial license, preserves branding for derived UIs, and requires attribution for backend/daemon/CLI use. It should not be treated as plain Apache-2.0 when deciding whether to copy code. Prefer independently implementing the generic worker/outbox pattern; confirm applicable terms before vendoring or distributing Multica-derived implementation. [Exact license](https://github.com/multica-ai/multica/blob/f41fae6b08fb734afcbd13205c0b3203dd0bc9c6/LICENSE).

**Fresh verification and limits**

- The saved central URL `http://10.69.0.102:8765` refused local health/state connections. A process-name lookup returned no `agentic-enterprise` process. No production restart was performed. The null-state/count output from the failed initial API request is invalid and was discarded; counts below come from successful read-only database queries.
- The actual current `remote_bridge.py` was sent through native SSH using its production bootstrap and `op=probe`, against a saved active Mac workdir. Result: `mac-personal`, `ready=true`, `codex-cli 0.155.1`, `Darwin`, executable `/Users/punya-tirta/.local/bin/codex`. This exercised bridge/workdir/CLI/login checks, not an inference run or the UI.
- Native SSH inventory on `tencent-personal` returned Python `3.12.3` and `codex-cli 0.153.4`, exit 0. This establishes transport and executable availability only, not authentication, selected-model compatibility or a complete platform run on that host.
- A Mac-to-controller `/api/health` request timed out after five seconds. Combined with the ready Mac bridge probe, this demonstrates why host readiness and callback readiness need separate indicators. It does not identify whether service state, routing or filtering caused the timeout.
- Production SQLite was opened with URI `mode=ro` and `PRAGMA query_only=ON`. It contained 42 agent records (including retained history), 13 groups, 109 runs, 29 sessions, two workstations and 9,255 events. Run states: 73 succeeded, eight cancelled, seven failed, 18 delegated and three interrupted; no queued/starting/running records in that snapshot. These counts are historical observations, not benchmark samples or a reliability rate.
- A separate read-only query of the OpenCode pilot database found 15 successful local OpenCode runs and five successful Mac OpenCode runs. Prior verification also documents restricted-mode provider rejection and untested live OAuth refresh. Persisted successful status is historical evidence, not a fresh replay of those tasks.
- No model inference, upstream deployment, cancellation fault injection, new dependency, application-code change or production-data mutation was performed for this analysis. No mocks were used. Only this report was added to the repository.

Commands included fresh `git clone --depth 1 --filter=blob:none`, `git log -1`, scoped `rg`/source reads, `Invoke-RestMethod` health/state requests, native `ssh` CLI/bridge probes and Python stdlib read-only SQLite queries. Upstream copies are research checkouts outside the repository under `%LOCALAPPDATA%/Temp/ae-compare-20260921`.

The recommended hybrid is therefore specific: **our existing application and SSH path, Paperclip's execution and recovery contracts, CCCC's truthful collaboration state, and an optional Multica-inspired persistent worker when intermittent connectivity becomes a product requirement.**
