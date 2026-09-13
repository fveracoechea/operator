# Herdr Control and Recovery Capabilities

Date: 2026-09-12. Research for [Verify Herdr control and recovery capabilities][issue]
in [Map the first Operator orchestration workflow][map].
Status: complete. Citations were re-verified against the primary sources:
all linked pages and pinned files resolve, and the specific claims checked
against them were supported. One functional error in the recovered draft's
cleanup sequencing was found by review and corrected here (see Cleanup
Ownership). Read-only probes against the installed Herdr confirmed the
client/server version and the CLI record shapes.
Scope: one machine, Linux or macOS, mixed OpenCode and Claude Code crew.
This report informs decisions. It does not select a support contract or authorize setup.

## Evidence Boundary

- **D**: verified in first-party documentation, not tested in a running session.
- **S**: verified by reading pinned implementation source, not runtime testing.
- **T**: observed on the running installed server with read-only commands only
  (`herdr status`, `--help` surfaces, `agent list`, `worktree list`). No pane was
  inspected beyond list metadata, and no agent was prompted, started, or resumed.
  This describes this report's verification session only; the wider Operator
  effort dispatches crew agents that do run, and that dispatch is outside this
  report's evidence boundary.
- **I**: inference from those facts; a design implication, not a Herdr guarantee.
- **U**: unknown or untested behavior that needs separate evidence.
- Started with the [Herdr agent guide][guide], then its CLI, socket, agents,
  integration, automation, worktree, and recovery references.
- The live docs selected **0.9.0**. GitHub identified **v0.9.0**, published
  2026-09-07, as the latest stable release. Its resolved source commit is
  `b99002ac99b09e00b4ca692436cb15a6b0d676f1` [release].
- Source references below pin that release. Live documentation links were read
  on this report's date; they can change independently of the release.
- Reading note for future verification: only `https://herdr.dev/agent-guide.md`
  serves markdown; the `/docs/<page>.md` variants return the homepage shell with
  HTTP 200, so read the trailing-slash pages or their rendered HTML.
- No Herdr socket command mutated state, no user pane was controlled, no
  integration installer, global config change, agent start, or resume was run.
  Source and docs were reviewed read-only. macOS machine readiness and the
  installed OpenCode/Claude application versions remain U.

## Capability Matrix

| Area | Verified capability | Limit or Operator implication | Evidence |
| --- | --- | --- | --- |
| Worktree creation | `worktree create` creates a Git checkout plus grouped workspace, tab, and root pane; accepts branch, base, path, and no-focus. | I: suitable for one checkout per crew member, not a security sandbox. | D [cli]; S [worktree]; D [git] |
| Worktree ownership | Workspace records contain Git provenance; `worktree list` discovers checkouts; `open` can reuse an already-open workspace. | I: provenance is not an assignment lease or exclusive write permission. | D [socket] |
| Checkout cleanup | `workspace close` removes runtime state, not the checkout. `worktree remove --workspace ID` runs `git worktree remove`, never deletes the branch, and requires force for dirty-checkout refusal. | D: the documented remove surface targets a workspace ID. S: the remove handler itself closes the linked workspace after success, so the workspace must still exist when remove runs. | D [cli]; S [wt-remove], [wt-remove-finish] |
| Agent launch | `agent start NAME --kind opencode\|claude --pane ID -- ...` uses an existing available shell and waits for readiness. | D: it does not create topology; blocked startup returns `agent_not_ready`, not an absent process. | D [automation] |
| Identity | Targets are a unique live name or pane ID; agent records can expose native `agent_session`. | D: names belong to the current occupant and one server, not a durable task. | D [cli]; S [agent-schema] |
| OpenCode lifecycle | Active official plugin reports working, blocked, idle, and native session identity. | S: reports are best effort; blocked also covers `session.error`. No task success result is reported. | D [agents]; S [oc-plugin] |
| Claude lifecycle | Foreground process plus screen manifest determines state; official hook reports native session identity only. | D: unknown dialog shapes can fall back to idle, including when actually waiting for input. | D [agents]; S [claude-hook] |
| Prompt submission | `agent prompt` sends text and delayed Enter in order, with bracketed-paste handling and optional combined wait. | D: no-wait success acknowledges writes, not a turn; a working agent's older turn can satisfy the wait. | D [cli], [socket] |
| Questions and approvals | Wait for blocked, read the visible UI, and use deliberate `agent send-keys`. Prompt rejects already-blocked agents. | I: Herdr is terminal transport, not a structured question inbox, answer ledger, or authorization policy. | D [automation]; S [agent-schema], [oc-plugin] |
| Completion | Waits observe semantic state and pin the current occupant. | D: done is unseen idle; idle, done, blocked, and unknown do not prove the assigned work passed review or tests. I: the map requires a separate code-review crew pass per completed task; Herdr supplies no review signal. | D [cli], [socket] |
| Output | Visible, recent, unwrapped, and detection reads; read-only live terminal streams. | D: alternate-screen history reads can scroll an idle agent; output waits can match old text. | D [automation], [cli] |
| Reconnect | Snapshot plus live subscriptions can rebuild a runtime cache. | D: lifecycle subscriptions do not replay earlier events; reconnect needs a new snapshot. | D [socket] |
| Detach | Server-owned pane processes continue after client detach or SSH loss. | I: this permits unattended work while the server survives, not after host/server failure. | D [guide], [recovery] |
| Cold restart | Saved layout/cwd returns; eligible native sessions can resume after client attach. | D/S: new processes, not preserved tests or tool calls; missing cwd can fall back to HOME. | D [recovery]; S [restore] |
| Durable coordination | Snapshots save layout, provenance, selected identity fields, and native references. | I: no durable Operator assignments, pending-question records, approvals, or verified results are supplied by these fields. | S [snapshot]; D [socket] |
| Platforms and permissions | Linux/macOS releases, Unix sockets, foreground-process detection, same-host terminal control. | S/I: socket owner access is broad control, not a per-crew-member permission boundary. | D [install], [socket], [agents]; S [api-server], [platform-linux], [platform-macos] |
| Installed surface | T: client and server both 0.9.0 on Linux, protocol 22, endpoint compatible, no update restart flagged. CLI groups and worktree/agent flags match the docs. `agent list` records carry native `agent_session`, live `name`, state, `screen_detection_skipped`, and `interactive_ready`; `worktree list` records carry Git provenance and `open_workspace_id`, all matching the pinned schema. | T/I: this confirms one Linux machine at 0.9.0; it is not a support contract, and macOS, OpenCode/Claude application versions, and integration revisions on it remain U. | T (probes); S [agent-schema] |

## Worktree and Runtime Control

**D/S:** Herdr calls ordinary `git worktree add`, with `-b` for a new branch.
An existing branch is checked out without forcing it; Git normally rejects a
branch already checked out elsewhere. Git worktrees have separate HEAD/index
and files, but share objects, most refs, and repository config [worktree], [git].

**I:** This gives edit isolation, not isolation of credentials, global agent
settings, ports, Git refs, or filesystem access. Crew members under the same
account can still change shared resources. Assignment ownership needs an
Operator rule or record; Herdr workspace membership alone does not enforce it.

**D:** Capture returned workspace/tab/pane IDs, not predicted IDs. Use explicit
targets, cwd, base, and `--no-focus`. Some omitted targets use UI focus. Raw
worktree paths must be absolute; the CLI expands relative paths [cli], [socket].

**D/S:** `--trust-repository` adds request-scoped `git -c safe.directory=...`,
not global Git config. It is a deliberate ownership-check exception. The normal
Git trust refusal is not permission to retry with trust automatically [cli], [worktree].

**D:** Names match `[a-z][a-z0-9_-]{0,31}` and are unique among live agents.
They clear on exit, release, or replacement. A cross-workspace pane move changes
the public pane ID, keeps a launch-time alias for that terminal, and ends an
existing agent wait with `agent_not_running` [automation].

## Cleanup Ownership

**Map requirement:** the Operator owns closing completed crew agents and
removing their Herdr-managed worktrees, subject to result preservation and the
agreed approval requirements. Worktree deletion, merge, and package publication
remain separate approval points, and the cleanup policy is still an open map
decision. Herdr supplies the mechanics below; it does not enforce the policy.

**D:** The documented surfaces: `worktree remove --workspace ID [--force]`
targets the workspace that owns the checkout, runs `git worktree remove`,
never deletes the branch, and requires `--force` when Git refuses a dirty
checkout. `workspace close` removes runtime state only [cli]. Branch deletion
and any push are separate Git actions the Operator must treat as distinct
steps. The source below confirms that remove needs a live workspace handle.

**S:** The pinned remove handler confirms and extends this. It resolves
`workspace_id` first and fails `workspace_not_found` when the workspace is
gone; it refuses non-linked worktree workspaces (`not_linked_worktree`),
in-progress operations (`worktree_operation_in_progress`), and, on Windows
only, an unforced dirty checkout up front. On Unix, it shuts down the
workspace's pane terminal runtimes before removal only when `--force` is set.
After a successful `git worktree remove`, the same handler closes the linked
workspace itself, refocuses the parent repo workspace if the removed one was
active, and emits `WorkspaceClosed` then `WorktreeRemoved`. On failure the
workspace stays open: dirty refusals return `dirty_worktree_requires_force`
and other Git errors `worktree_remove_failed`, with force-shutdown panes
restored. A forced removal can also clear a leftover prunable checkout by
deleting its directory after verifying it matches the repo [wt-remove],
[wt-remove-finish], [wt-close], [wt-prunable].

**D:** `workspace close --group` closes the primary workspace and its linked
worktree workspaces together; a plain close can fail with
`workspace_group_close_required`. It must never be used merely to bypass that
error, and closing workspaces one did not create requires explicit authority
[guide].

**I:** The corrected cleanup flow for the first workflow: preserve results
first (artifact files, commits, test evidence); the workspace is not a durable
store. Then remove the checkout with `worktree remove --workspace ID` under
its own approval. That one call both deletes the checkout and closes the
workspace; no separate `workspace close` precedes it, and closing the
workspace first would make remove fail. Recheck for uncommitted work before
requesting `--force`, because it discards dirty state and, on Unix, shuts down
the workspace's panes. `workspace close` alone is for handing back runtime
state when the checkout must survive. Pane history is off by default, so
transcript evidence does not survive either path [recovery].

**U:** Whether the Operator should keep the branch, when deletion is safe
relative to review, and who approves dirty-checkout force removal are cleanup
policy decisions the map still owes. The remove handler's failure and restore
paths are source-read, not runtime-tested.

## Lifecycle, Prompts, and Questions

**D:** Startup timeout defaults to 30,000 ms; explicit values must be greater
than 3,000 and at most 300,000. A successful start requires the expected agent
to own that terminal and be ready for input. After blocked startup, the assigned
name remains usable for reads and keys; do not start a duplicate [cli].

**D:** `agent prompt --wait` submitted from a non-working state must observe
working or blocked within five seconds, or returns `agent_prompt_stalled`.
The caller timeout can expire first and includes submission time. After activity,
the default settled states are idle, done, or blocked. A standalone wait can
return immediately. Omitted wait timeouts can wait indefinitely [cli].

**D/I:** Timeout, stalled, or lost response does not prove non-delivery. The
combined prompt/wait removes a separate-call race, not duplicate delivery or
turn ambiguity. The API prompt has target/text/wait, with no task ID or
idempotency key. Inspect and reconcile before any resend [automation], [agent-schema].

**D:** Done means idle but not marked seen by the server. Explicit focus marks
it seen; reads do not. TUI clients track seen state separately. Screen detection
uses the live bottom buffer, not the user's scrolled viewport. Manifests can
update independently of the binary; local overrides win [cli], [agents].

**S:** OpenCode maps `permission.asked`, `question.asked`, and `session.error`
to blocked; replies/rejections map to working. Known child-session questions can
report blocked against the root session. The reporter sends state/session IDs,
not question text, choices, permission scope, or answer acknowledgements.
Requests are serialized and sequenced, but a 500 ms timeout, socket error, or
any response ends a report without response validation or durable delivery [oc-plugin].

**I/U:** A blocked event alone cannot distinguish a user decision from an error,
nor prove the dialog still awaits the same answer. Operator needs a defined
question/answer correlation and authorization flow. Native agent APIs or a
crew-written question artifact are possible follow-ups, not verified Herdr features.
Mixed-agent free text, multi-select, cancellation, nested questions, and simultaneous
human input need E2E tests before unattended answer routing can be claimed.

**Map requirement:** every completed task triggers a separate code-review crew
pass using the code-review skill. This report only records the capability
implication: Herdr lifecycle states report turn completion, not review
verdicts, so review evidence must come from that separate review pass, not
from `idle`, `done`, or output reads. How review results route back and gate
completion is a policy decision this report does not resolve.

## Output and Event Transport

**D:** CLI wrappers use the same local socket control surface. Most commands
return JSON; reads print text directly. Raw reads return `.result.read.text`.
Unix transport is newline-delimited JSON with response IDs; raw clients are useful
for subscriptions. Exported schema describes the installed binary, not proof of
the running server's version. Unsupported methods must be handled [cli], [socket];
`.result.read.text` is documented on the automation page [automation].

**D:** Recent reads default to the last 80 rendered rows. For idle recognized
alternate-screen agents, a larger text read may scroll through transcript pages
and return to bottom. Visible/detection reads remain passive. Explicit agent
history reads can fail `agent_not_idle` while blocked or working. Output waits
poll immediately and can match pre-existing text; regex matches one line at a time [automation].

**I:** Terminal text is useful evidence, but not a complete durable result.
An artifact path plus commit/test evidence avoids dependence on transcript length.
Live observers are read-only; a writable direct attach has one controller, with
explicit takeover. Neither is a durable question queue [cli], [remote].

**D:** To avoid a bootstrap gap: subscribe on one connection, wait for its
acknowledgement, buffer events, request `session.snapshot` on another connection,
install the snapshot, then apply buffered events in order. Repeat after reconnect.
Subscriptions begin at acceptance and do not replay prior lifecycle events [socket].

## Recovery and Durability

**D:** Detach is the strongest path: original processes continue. A full server
restart restores session shape, not running shells, tests, or arbitrary commands.
Native restore is enabled by default, but requires a valid official session
reference and a client attach that supplies terminal size/theme context [recovery].

**D/S:** Eligible commands are `claude --resume ID` and `opencode --session ID`.
Unsupported, duplicate, invalid, or stale references can fall back to shells.
The restore source falls back to HOME, then `/`, when saved cwd is missing.
Revalidate the checkout before allowing resumed work [recovery], [restore], [resume].

**S/I:** Native resume builds a new canonical argv from the session reference;
it does not append original `agent start` arguments. Snapshot pane data has no
extra launch environment; cold restore constructs it empty. Do not assume custom
config paths, model flags, wrappers, or permission settings are reproduced.
Agent-native persistence may retain some settings, but that is U [snapshot], [restore], [resume].

**S:** Active managed-agent names/kinds can be saved and restored with eligible
native sessions; identity is not simply lost on every restart. The snapshot is
still not an assignment ledger. Ordinary saves use a five-second debounce and a
background job, with explicit shutdown/checkpoint paths. Writes use temporary
JSON plus rename, without file/directory fsync in that helper. This is not a
power-loss-safe transaction or a maximum five-second loss guarantee [snapshot],
[restore], [save-schedule], [save-delay], [save-io].

**D:** Pane history is experimental and off by default because output can hold
secrets. It writes `session-history.json` beside `session.json`; native resume
takes priority over history replay. Display tokens do not survive cold restart.
Subscriptions, waits, and in-flight requests are not durable [recovery], [socket].

**D/I:** Experimental opt-in live handoff can retain processes, but interrupts
requests, waits, and streams. It is not crash recovery. The self-update handoff
path does not apply to Homebrew/mise/Nix installations. These facts do not establish
a need for an always-running Operator supervisor; the unattended recovery
boundary still needs a human decision [recovery].

## Platform, Setup, and Permission Limits

- **D/S:** Linux x86_64/aarch64 and macOS Intel/Apple silicon binaries exist.
  Linux detection reads `/proc` and terminal process groups; macOS uses native
  process APIs and terminal process groups. Restricted process visibility remains
  an environment-dependent limit, not a tested support claim [install], [platform-linux], [platform-macos].
- **D:** Host-visible wrappers can use `HERDR_AGENT=claude` or another known kind.
  A hint set only inside a container/VM is invisible to the host. Linux's opt-in
  `HERDR_PROCESS_DETECTION=child-groups` requires server restart and can mistake
  a newer background job for the foreground job [agents].
- **S/I:** API and client sockets are mode `0600`. The API dispatch accepts requests
  from socket clients without a per-agent capability token in that path. Same-user
  code with socket access can read/send input or request server stop. Named sessions
  separate runtime namespaces but share global config, not a security boundary
  [api-server], [client-socket], [remote].
- **D/S:** Claude installation changes `settings.json` and writes a hook under
  `~/.claude` or `CLAUDE_CONFIG_DIR` [integrations]. The Unix hook needs `python3`; if absent it
  silently exits. It reports only root `SessionStart` identity and catches socket
  failures. Screen state still works without successful session reporting [claude-hook].
- **S, docs gap:** The OpenCode installer writes `plugins/herdr-agent-state.js`,
  root `herdr-tui-session.js`, and updates `tui.jsonc` under `~/.config/opencode`.
  Its path helper does not use `OPENCODE_CONFIG_DIR` or `XDG_CONFIG_HOME`.
  The docs list only the lifecycle plugin. TUI selection reporting uses OpenCode's
  route/state/lifecycle plugin API, with bounded retries [oc-install], [oc-config], [integration-env], [oc-tui].
- **D/S:** Documented restore minima are Claude integration 6 and OpenCode 5;
  v0.9.0 actually bundles Claude 9 and OpenCode/TUI 11. These are integration
  revisions, not Claude/OpenCode application versions. Exact compatible application
  versions and the oldest sufficient Herdr release were not established
  [integrations], [claude-hook], [oc-plugin], [oc-tui].

## Unknowns and Possible Follow-up Tickets

These are suggested ticket scopes, not new issues or selected decisions.

1. **Verify project-local integration setup on Linux and macOS.** Test the actual
   three-file OpenCode install surface, existing JSON/JSONC precedence, relocated
   config, Claude's Python dependency, and native identity reporting. Record exact versions.
2. **Specify correlated questions and authorized answers.** Choose a transport for
   question IDs, choices, free text, permission scope, user-versus-Operator answers,
   cancellation, and acknowledgements. Test both agents without blanket approval.
3. **Specify restart reconciliation and the unattended boundary.** Cover fresh
   Operator sessions, detach, cold server restart before/after attach, missing cwd,
   native session loss, original argv/env changes, and no automatic duplicate work.
4. **Specify assignment completion and retry evidence.** Define durable assignments,
   attempt IDs, result/test/review evidence, and reconciliation after timeout or
   disconnect. Prove that idle, stale output, and an earlier turn cannot complete a task.
5. **Verify checkout adoption and failure recovery.** In disposable repos, test branch
   collisions, concurrent create/open, interrupted creation, deleted paths, dirty and
   locked worktrees, and existing-workspace ownership. Decide whether submodules are
   supported; Git documents incomplete multiple-checkout support [git].
6. **Set the support and permission contract.** This Linux machine's Herdr
   client/server version is recorded (0.9.0, protocol 22). Still open: macOS
   versions, the installed OpenCode/Claude application versions, integration
   revisions, and detection manifests on both OS families. Decide what same-user
   socket authority, global setup approval, and degraded screen detection permit.

## Verification Status

A citation-verification pass re-read every linked documentation page and every
pinned source file at commit `b99002ac99b09e00b4ca692436cb15a6b0d676f1`,
checking the specific claims each citation carries. All resolved, and the
checked claims were supported; this validates those claim-citation pairs, not
every sentence of this report independently. Four corrections were made in
this revision: Unix sockets are documented on the socket page, not the install
page; the Claude hook's `python3` dependency is in the hook source, not the
integration page; `.result.read.text` is on the automation page; and the
cleanup sequencing was functionally wrong. The pinned `worktree.remove`
handler shows the remove call closes the linked workspace itself after
success, so the draft's "close the workspace, then remove" order would fail
with `workspace_not_found`; Cleanup Ownership now carries the corrected,
source-verified ordering. The release check confirmed v0.9.0 is the latest
stable release, published 2026-09-07, at that commit, with bundled integration
revisions Claude 9 and OpenCode/TUI 11 matching the sources.

Read-only probes against the running installed server (`herdr status`, help
surfaces, `agent list`, `worktree list`) confirmed the 0.9.0 client/server pair
on Linux and that live agent and worktree records match the pinned schema.
No runtime capability of this report's own is E2E-verified: the verification
session started no agent, prompted nothing, read no pane output, and ran no
install, global change, recovery experiment, or destructive probe. The
Operator dispatch that produced this crew and started its agents is a separate
activity outside this evidence boundary. The source's tests were inspected
where relevant, not executed. This report is the only intended project change
on this branch.

## Sources

[issue]: https://github.com/fveracoechea/operator/issues/3
[map]: https://github.com/fveracoechea/operator/issues/1
[guide]: https://herdr.dev/agent-guide.md
[release]: https://github.com/herdrdev/herdr/releases/tag/v0.9.0
[cli]: https://herdr.dev/docs/cli-reference/
[socket]: https://herdr.dev/docs/socket-api/
[automation]: https://herdr.dev/docs/agent-automation/
[agents]: https://herdr.dev/docs/agents/
[integrations]: https://herdr.dev/docs/integrations/
[recovery]: https://herdr.dev/docs/session-state/
[install]: https://herdr.dev/docs/install/
[remote]: https://herdr.dev/docs/persistence-remote/
[git]: https://git-scm.com/docs/git-worktree/2.54.0
[worktree]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/worktree.rs#L154-L276
[wt-remove]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/app/api/worktrees/deferred.rs#L215-L364
[wt-remove-finish]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/app/api/worktrees/deferred.rs#L480-L599
[wt-close]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/app/worktrees.rs#L4-L37
[wt-prunable]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/worktree.rs#L343-L364
[agent-schema]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/api/schema/agents.rs
[oc-plugin]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/integration/assets/opencode/herdr-agent-state.js
[oc-tui]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/integration/assets/opencode/herdr-tui-session.js
[oc-install]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/integration/targets.rs#L453-L476
[oc-config]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/integration/opencode_config.rs#L9-L102
[integration-env]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/integration/env.rs#L58-L128
[claude-hook]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/integration/assets/claude/herdr-agent-state.sh
[snapshot]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/persist/snapshot.rs#L14-L118
[restore]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/persist/restore.rs#L475-L564
[resume]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/agent_resume.rs#L136-L235
[save-schedule]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/app/session.rs
[save-delay]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/app/mod.rs#L43
[save-io]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/persist/io.rs#L48-L94
[api-server]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/api/server.rs#L27-L199
[client-socket]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/server/socket_paths.rs#L11-L74
[platform-linux]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/platform/linux.rs#L338-L399
[platform-macos]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/platform/macos.rs#L357-L436
