# Writes outside an Operative worktree

Date: 2026-09-30.
Research for [Verify detection of writes outside an Operative worktree, #73][issue].
It feeds the decision ticket [Choose the recorded checks on a result, #72][decision].
Status: result for review, not an accepted decision.
Scope: one machine, macOS or Linux, a crew on Claude Code or OpenCode, Herdr worktrees.

## Evidence labels

Each claim has one label.

- **Verified (D)**: stated in first-party documentation of the cited version.
  Not tested in a running session.
- **Verified (S)**: read in pinned source code or in a pinned repository file.
  Not tested in a running session.
- **Verified (T)**: observed on this machine with read-only commands (`--help`, `find`, `ls`, `git status`).
- **Unverified (I)**: an inference from verified facts.
  It is a design implication, not a vendor guarantee.
- **Unverified (U)**: not known, or not tested.
  It needs its own evidence.

No setting on this machine was changed.
No agent was started, and no sandbox was entered.

## Result

Operator can detect the write that the flow found, at low cost, with a before-and-after scan of two known folders. Unverified (I).
The scan works the same on both hosts and on both operating systems, because it reads the file system and not the agent. Unverified (I).
The scan cannot tell which writer made a change, so it reports a change for review and does not prove fault. Unverified (I).

Operator can prevent most writes outside the worktree on Claude Code, through launch arguments it already passes. Unverified (I).
The Claude Code sandbox confines Bash commands at the OS level on macOS and Linux. Verified (D) [cc-sandbox].
The sandbox does not cover the Write and Edit tools, so a PreToolUse hook or permission rules must cover them. Verified (D) [cc-sandbox-scope].

Operator can only reduce such writes on OpenCode.
OpenCode has no sandbox, and its permission system is not a security boundary. Verified (D) [oc-security].
A `deny` rule for `external_directory` blocks file tools outside the worktree, but it sees only a short list of Bash commands. Verified (S) [oc-external], [oc-shell-files], [oc-shell-collect].

Herdr 0.9.1 does not confine a pane and does not report file changes. Verified (D) [h-socket-events], Verified (S) [h-cargo].

## Versions inspected

| Source | Version or revision | Limit |
| --- | --- | --- |
| Claude Code CLI | 2.1.281, installed. Verified (T). | Only `claude --help` was read. |
| Claude Code docs | Live pages at `code.claude.com/docs/en/*.md`, read on 2026-09-30. | Live docs can move ahead of the installed CLI. |
| OpenCode CLI | 1.18.31, installed. Verified (T). | Only `opencode --help` was read. |
| OpenCode source and docs | Tag `v1.18.31`, commit `014614d35b397775e5d397a490fc72368c894ec2` in `anomalyco/opencode`. | Source read, not run. |
| Herdr CLI | 0.9.1, installed. Verified (T). | `herdr --help`, `herdr worktree --help`, `herdr worktree create --help`, `herdr agent start --help`, `herdr pane --help`. |
| Herdr docs and source | Tag `v0.9.1`, commit `8544776216a8d28088db59a5344ea21ee2d05d2b`. | `llms.txt` points at 0.9.3, so this report reads the 0.9.1 tag instead. |
| Sandbox runtime | `anthropics/sandbox-runtime`, README on `main`, latest release `v0.0.78`. | Beta research preview. |
| Linux Landlock doc | `torvalds/linux` commit `172b6a6d8463562b0cbebfd66f770b078f81966b`. | Kernel doc, not a tool. |
| macOS | 26.6.2, `man sandbox-exec`. Verified (T). | Man page only. |
| Operator | `main` at `21888e6`. | Source read, not run. |

## Where a stray write can land

Herdr creates each checkout as `<worktrees.directory>/<repo>/<branch-slug>`, and the default directory is `~/.herdr/worktrees`. Verified (D) [h-config].
So the parent folder of one worktree also holds the sibling worktrees of the same repository. Unverified (I).
On this machine, `~/.herdr/worktrees/operator/` exists and is empty. Verified (T).

The default Operator path is `<parent of the controlling checkout>/<repo>-operative-<id>`. Verified (S) [op-plan].
With that default, the parent folder is the folder that holds the controlling checkout and the other projects of the user. Unverified (I).

Other known folders:

- The controlling checkout, and its `.git` folder, which linked worktrees share. Verified (D) [git-worktree].
- The home configuration folders of each host, for example `~/.claude`, `~/.config/opencode`, and `~/.local/share/opencode`. Verified (T).

## Claude Code

### Two layers, two boundaries

Permission rules apply to all tools and run before a tool runs. Verified (D) [cc-perm-sandbox].
The sandbox applies only to Bash, PowerShell, and Monitor commands and to their child processes. Verified (D) [cc-perm-sandbox].
Read, Edit, and Write use the permission system, not the sandbox. Verified (D) [cc-sandbox-scope].
Subagents run in the same process and use the same sandbox configuration. Verified (D) [cc-sandbox-scope].

### The sandbox, for Bash

The sandbox uses Seatbelt on macOS and bubblewrap on Linux. Verified (D) [cc-sandbox-os].
On Linux it needs the `bubblewrap` and `socat` packages. Verified (D) [cc-sandbox-linux].
On Ubuntu 24.04 and later, AppArmor can block the user namespaces that bubblewrap needs, and a root-installed profile is the fix. Verified (D) [cc-sandbox-linux].

By default a sandboxed command can write only to the working directory, the added directories, and a per-user temp directory. Verified (D) [cc-sandbox-fs].
In a linked worktree, the sandbox also permits writes to the shared `.git` folder of the main checkout, except `hooks/` and `config`. Verified (D) [cc-sandbox-fs].
So a sandboxed Bash command cannot write into the worktree parent folder or the controlling checkout work tree. Unverified (I).

What a Bash command can still write around the sandbox:

- A command that fails in the sandbox can retry outside it with `dangerouslyDisableSandbox`, unless `allowUnsandboxedCommands` is `false`. Verified (D) [cc-sandbox-escape].
- A command in `excludedCommands` runs outside the sandbox. Verified (D) [cc-sandbox-escape].
- When the sandbox cannot start, Claude Code shows a warning and runs commands with no sandbox, unless `failIfUnavailable` is `true`. Verified (D) [cc-sandbox-start].
- The `filesystem.disabled` key removes the file layer.
  Project settings cannot set it, but user settings and `--settings` can. Verified (D) [cc-sandbox-disable].
- Hooks and MCP servers run outside the sandbox. Verified (D) [cc-sandbox-protected].
- The Claude Code process itself writes to `~/.claude`, outside the sandbox. Verified (T): 33 files there changed in one hour of normal use on this machine.

The sandbox also isolates the network, and each new host prompts once unless `allowedDomains` lists it. Verified (D) [cc-sandbox-net].
This is a cost for an Operative that runs `bun install` or `gh`. Unverified (I).

### Permission rules and modes, for Write and Edit

In Manual mode, a file edit needs approval. Verified (D) [cc-perm-system].
`acceptEdits` approves edits only for paths in the working directory or the added directories. Verified (D) [cc-perm-modes].
In auto mode, edits in the working directory are approved, and other actions go to a classifier. Verified (D) [cc-auto-order].
The flow ran Claude Code with `--permission-mode auto`. Verified (S) [flow].
So in the flow, an edit outside the worktree went to the classifier, and the classifier could approve it. Unverified (I).

`dontAsk` denies every call that would prompt. Verified (D) [cc-perm-modes].
With `dontAsk`, an edit outside the working directories is denied, but an Operative also loses every Bash command that no rule allows. Unverified (I).

Deny rules hold in every mode, `bypassPermissions` included. Verified (D) [cc-mode-deny].
A deny rule cannot say "everything except this worktree".
A `!` carve-out cannot reach a rule anchored with `//` or `~/`. Verified (D) [cc-read-edit].
A deny rule can name a known folder, for example `Edit(//<worktree parent>/*)`, where `*` matches one path segment. Verified (D) [cc-read-edit].
That rule covers the file in the flow, but not a deeper path or a sibling worktree. Unverified (I).
Edit deny rules also enter the sandbox configuration, so they bind sandboxed Bash too. Verified (D) [cc-perm-sandbox].
Edit deny rules also match Bash commands that Claude Code knows, and redirect targets, but not a script that opens files itself. Verified (D) [cc-read-edit].

### Hooks

A PreToolUse hook runs before the permission prompt, for every tool except `EndConversation`. Verified (D) [cc-hooks-perm].
Exit code 2 blocks the call before permission rules run, and a JSON `allow` cannot override it. Verified (D) [cc-hooks-exit2].
For `Write`, `Edit`, and `Read`, `tool_input.file_path` is always absolute, with `~` and relative paths expanded. Verified (D) [cc-hooks-pretool].
So a hook can compare `file_path` with the worktree root and deny a path outside it. Unverified (I).
The input also carries `cwd` and `scratchpad_dir`, so the hook can permit the session scratchpad. Verified (D) [cc-hooks-input].
Hooks from settings files fire inside subagents too. Verified (D) [cc-hooks-locations].
The docs do not say that a hook runs in `bypassPermissions` mode. Unverified (U).

A PreToolUse hook on Bash sees only the command text.
The docs say that a Bash rule is not a security boundary around a program. Verified (D) [cc-bash-limits].
So a hook on Bash text is not a reliable guard, and the sandbox is the guard for Bash. Unverified (I).

`FileChanged` hooks use a file watcher and fire for any writer, but they watch named files in the working directory and cannot block. Verified (D) [cc-hooks-filechanged].
`bashEditDiff` in PostToolUse lists files a Bash command changed under the repository, is best effort, and is not for policy. Verified (D) [cc-hooks-bash].
Neither covers a write outside the worktree. Unverified (I).

### How Operator could apply it

Operator starts Claude Code with `herdr agent start ... -- <args>`, and it passes `--model` and `--effort` that way today. Verified (S) [op-start].
Herdr passes the arguments after `--` to the canonical executable. Verified (D) [h-agent-start].
`--settings <file-or-json>` loads extra settings above user, project, and local files, for one session. Verified (D) [cc-settings-session], [cc-settings-precedence].
It can set any key that user settings can set, which includes `filesystem.disabled` and `strictAllowlist`. Verified (D) [cc-settings-session], [cc-sandbox-disable].
So one extra launch argument can turn on the sandbox, turn off the escape hatch, require the sandbox to start, and add the hook. Unverified (I).
A `/path` rule in a `--settings` file anchors at the folder of that file, so rules for the worktree need `//` absolute paths. Verified (D) [cc-read-edit].

Two other files do not fit:

- `.claude/settings.local.json` in the worktree is not read.
  In a worktree, Claude Code uses the file at the root of the main checkout. Verified (D) [cc-settings-local].
- `.claude/settings.json` in the worktree is read, but it is a project file that appears in the diff and waits for workspace trust. Verified (D) [cc-settings-local], [cc-settings-scopes].

Keep the settings file and the hook script outside the worktree.
Claude Code applies edits of sandbox file lists to the running session. Verified (D) [cc-sandbox-config].
A file in `.operator/local/` is inside the worktree, so the Operative can edit it with the Edit tool. Unverified (I).
The sandbox protected paths cover `.claude/` files, not `.operator/`. Verified (D) [cc-sandbox-protected].

This is a new Operator-written input, like the brief, and not a file copied from the controlling checkout. Unverified (I).
The rule "no other file leaves the controlling checkout" still holds. Verified (S) [op-briefing], [op-inputs].

## OpenCode

OpenCode does not sandbox the agent. Verified (D) [oc-security].
Its security policy calls the permission system a UX feature and not a security boundary. Verified (D) [oc-security].
The source has no Seatbelt, bubblewrap, or Landlock code, and "sandboxes" in it names project checkouts. Verified (S) [oc-project].

### The `external_directory` permission

`external_directory` triggers when a tool touches a path outside the working directory, and it defaults to `ask`. Verified (D) [oc-permissions].
`opencode --auto` approves every request that no rule denies. Verified (D) [oc-permissions].
So in auto mode, only an explicit `deny` stops a write outside the worktree. Unverified (I).

The `edit`, `write`, and `apply_patch` tools call the external directory check on their target path. Verified (S) [oc-edit], [oc-write], [oc-patch].
The check treats a path as inside when it is under the session directory or the Git worktree root. Verified (S) [oc-contains].
For a Git project, the worktree root is the root of the linked worktree, not of the main checkout. Verified (S) [oc-resolve], [oc-instance].

The Bash tool checks paths only for a fixed list of commands: `cd` forms, `rm`, `cp`, `mv`, `mkdir`, `touch`, `chmod`, `chown`, `cat`, and some PowerShell verbs. Verified (S) [oc-shell-files], [oc-shell-collect].
It skips an argument that holds `$`, `$(`, or a backtick. Verified (S) [oc-shell-dynamic].
It does not read redirect targets. Verified (S) [oc-shell-parts].
So `echo x > ../note.md`, `tee`, `git -C`, or a script can write outside the worktree with no check. Unverified (I).

A subagent started with the task tool keeps the parent session's `external_directory` rules and deny rules. Verified (S) [oc-subagent].

### Plugins

A plugin can throw in `tool.execute.before` to block a tool call. Verified (D) [oc-plugins].
It sees the same tool arguments as the permission check, so it has the same Bash limit. Unverified (I).

### How Operator could apply it

Operator writes `.opencode/agents/operator-crew.md` and starts OpenCode with `--agent operator-crew`, but only when a reasoning effort is set. Verified (S) [op-plan-oc], [op-inputs], [op-start].
An agent file can carry a `permission` block, and agent rules take precedence over global rules. Verified (D) [oc-permissions], [oc-agents].
So Operator could add `external_directory: deny` to that file and always write and select it. Unverified (I).
The file is inside the worktree, so the Operative can edit it. When OpenCode reads the edit is not known. Unverified (U).

OpenCode writes a file named `opencode` into the shared Git folder of the repository. Verified (S) [oc-commit].
That is a normal write outside the worktree, and a scan must expect it. Unverified (I).

## Herdr 0.9.1

`herdr worktree create` has `--workspace`, `--cwd`, `--branch`, `--base`, `--path`, `--label`, `--focus`, `--no-focus`, and `--trust-repository`, and none of them confine the pane. Verified (T).
`herdr agent start` has `--kind`, `--pane`, and `--timeout`, and it passes other arguments to the agent. Verified (T), Verified (D) [h-agent-start].
The kind selects the canonical executable, so Operator cannot put a wrapper such as `srt` in front of the agent through `agent start`. Unverified (I) [h-agent-start].

Event subscriptions cover workspace, tab, pane, layout, and worktree lifecycle, not file changes. Verified (D) [h-socket-events].
Herdr plugins run as the user and Herdr does not sandbox them. Verified (D) [h-plugins].
The 0.9.1 manifest has no file watcher or sandbox crate. Verified (S) [h-cargo].
A prior note found that a Herdr worktree gives edit isolation, not file system isolation. Verified (S) [herdr-note].

## OS-level options

### macOS `sandbox-exec`

`sandbox-exec` runs a command in a Seatbelt profile, and its man page marks it deprecated. Verified (T).
Claude Code and the sandbox runtime still use it. Verified (D) [cc-sandbox-os], [srt].

### Linux bubblewrap

bubblewrap uses unprivileged user namespaces, and its setuid mode is no longer supported. Verified (D) [bwrap].
Claude Code uses it for the Linux sandbox. Verified (D) [cc-sandbox-os].

### Linux Landlock

Landlock lets an unprivileged process restrict its own file system access. Verified (D) [landlock].
Every child inherits the rules, and a process cannot remove them. Verified (D) [landlock-inherit].
It needs Linux 5.13 or later, built with `CONFIG_SECURITY_LANDLOCK=y` and enabled in the LSM list. Verified (D) [landlock-kernel].
It needs a launcher that applies the rules before it starts the agent.
Operator has none, and `agent start` cannot add one. Unverified (I).

### Sandbox runtime (`srt`)

`srt` wraps any process tree with Seatbelt on macOS or bubblewrap on Linux.
Writes are denied by default and allowed per path. Verified (D) [srt].
It is a beta research preview. Verified (D) [srt].
On macOS it can report sandbox violations from the system log. Verified (D) [srt].
It could wrap OpenCode, which has no sandbox of its own. Unverified (I).
The agent must still write its own state folders, so those folders stay open. Unverified (I).
Herdr `agent start` cannot put it in front of the agent. Unverified (I) [h-agent-start].

### File system events

inotify does not watch folders recursively, and its queue can overflow and lose events. Verified (D) [inotify].
Its event record has a watch descriptor, a mask, a cookie, and a name, but no process ID. Verified (D) [inotify].
Unprivileged fanotify, Linux 5.13 and later, can mark only inodes and does not give the writer's PID. Verified (D) [fanotify].
FSEvents on macOS reports changes at the folder level. Verified (D) [fsevents].
None of these tells Operator which Operative made a write without extra privilege, and each needs code for each OS. Unverified (I).
A watcher must also run for the whole attempt, which a scan does not need. Unverified (I).

### Before-and-after scan of known folders

Operator records a snapshot before the launch and compares it after the submission.
Suggested scope, all Unverified (I):

1. The worktree parent folder, one level deep: names, types, and modification times.
   An expected new entry is a worktree that `git worktree list --porcelain` names.
2. The controlling checkout: `git status --porcelain -uall` outside `.operator/`, plus the identity of `.git/hooks/` and `.git/config`.
3. No recursive home folder scan.

Cost, measured on this machine with `find -newermt` and read-only commands, Verified (T):

| Folder | Entries | Walk time |
| --- | --- | --- |
| `~/.herdr/worktrees` (recursive) | 60,328 | 0.27 s |
| `~/.claude` (recursive) | 4,265 | 0.05 s |
| Controlling checkout (recursive) | 6,547 | 0.02 s |

A one-level listing of the parent folder costs less than the recursive walk above. Unverified (I).

False positives:

- In one hour on this machine, 52 files changed in the controlling checkout, most in `.git/objects`, `.git/refs`, `.git/logs`, and `.git/worktrees`. Verified (T).
- Commits in a linked worktree write to the shared `.git` folder. Verified (D) [git-worktree].
- OpenCode writes `<shared .git>/opencode`. Verified (S) [oc-commit].
- The host writes its own home folders, 33 files in `~/.claude` in one hour. Verified (T).
- The user, the Operator session, and other Operatives write the same folders at the same time.
  The scan cannot tell them apart. Unverified (I).
- A write that the Operative removes before it submits leaves no trace.
  The flow saw exactly this, because the sub-agent removed its file. Verified (S) [flow].

So the scan must exclude `.git/` internals except hooks and config, and it must skip the home folders. Unverified (I).
A change it finds is a concern for review, not a proven fault. Unverified (I).
It misses a created-then-deleted file, and only a guard at write time catches that. Unverified (I).

## Comparison

| Option | Hosts | OS | Prevents or detects | Through current Operator inputs | Cost |
| --- | --- | --- | --- | --- | --- |
| Before-and-after scan | Both | Both | Detects | No host file needed. Runs in Operator. | Milliseconds. Noise from concurrent writers. |
| Claude Code sandbox via `--settings` | Claude Code | Both. Linux needs bubblewrap and socat. | Prevents, Bash only | New launch argument beside `--effort`. | Network prompts. Some tools fail in the sandbox. |
| Claude Code PreToolUse hook via `--settings` | Claude Code | Both | Prevents, file tools only | Same launch argument. Script lives outside the worktree. | One process per file tool call. |
| Claude Code deny rules for known folders | Claude Code | Both | Prevents, named paths only | Same launch argument. | Low. Misses paths it does not name. |
| OpenCode `external_directory: deny` | OpenCode | Both | Prevents file tools, a few Bash commands | The agent file Operator already writes. | Low. Agent can edit the file. |
| OpenCode `tool.execute.before` plugin | OpenCode | Both | Prevents file tools, same Bash limit | The plugin folder Operator already writes. | Low. Same limit as above. |
| `srt`, Landlock, or bubblewrap around the agent | Both | `srt` both, Landlock and bubblewrap Linux | Prevents, whole process | Not possible through `herdr agent start`. | High. Beta. State folders stay open. |
| File system event watcher | Both | Per OS | Detects, no writer | New long-running process. | Medium. Lost events. No attribution. |
| Herdr | Both | Both | Neither | Nothing to use. | Not applicable. |

## Ranked by fit

1. Before-and-after scan of the worktree parent and the controlling checkout.
   It catches the flow's case on both hosts, needs no host setting, and costs milliseconds.
2. Claude Code launch settings: the sandbox with `allowUnsandboxedCommands: false` and `failIfUnavailable: true`, plus a PreToolUse hook that denies file tools outside the worktree and its scratchpad.
3. OpenCode agent permission `external_directory: deny`, always written and always selected.
   It is a partial guard only.
4. Deny rules for the known folders in the Claude Code launch settings, as a cheap extra layer.
5. A whole-process sandbox (`srt`, Landlock, bubblewrap).
   It is the strongest guard, but Herdr cannot launch it today.
6. File system event watchers.
   They add cost and give no attribution.

## Open questions

- Does a PreToolUse hook run in `bypassPermissions` mode? Unverified (U).
- Does an Edit deny rule on the controlling checkout break the sandbox exception for the shared `.git` folder? Unverified (U).
- When does OpenCode reread an edited agent file in a running session? Unverified (U).
- Which commands of a normal Operative fail under the Claude Code sandbox, for example `bun install` or `gh`? Unverified (U).
- Can Operator start a wrapped agent through `herdr pane run` and still get a named Herdr agent? Unverified (U).

## Sources

[issue]: https://github.com/fveracoechea/operator/issues/73
[decision]: https://github.com/fveracoechea/operator/issues/72
[flow]: https://github.com/fveracoechea/operator/blob/research/integrated-pr-flow/docs/research/integrated-pr-flow.md "Local branch research/integrated-pr-flow, lines 96-97 and 151-155. The branch was not on the remote on 2026-09-30."
[herdr-note]: https://github.com/fveracoechea/operator/blob/research/herdr-capabilities/docs/research/herdr-capabilities.md
[op-plan]: https://github.com/fveracoechea/operator/blob/21888e6/modules/operative-dispatch/plan.ts#L369-L371
[op-plan-oc]: https://github.com/fveracoechea/operator/blob/21888e6/modules/operative-dispatch/plan.ts#L96-L121
[op-inputs]: https://github.com/fveracoechea/operator/blob/21888e6/modules/operative-dispatch/inputs.ts#L37-L186
[op-start]: https://github.com/fveracoechea/operator/blob/21888e6/modules/herdr-control/main.ts#L341-L368
[op-briefing]: https://github.com/fveracoechea/operator/blob/21888e6/skills/operator/BRIEFING.md#L69-L75
[cc-sandbox]: https://code.claude.com/docs/en/sandboxing
[cc-sandbox-linux]: https://code.claude.com/docs/en/sandboxing#set-up-linux-and-wsl2
[cc-sandbox-start]: https://code.claude.com/docs/en/sandboxing#get-started
[cc-sandbox-escape]: https://code.claude.com/docs/en/sandboxing#the-unsandboxed-retry-escape-hatch
[cc-sandbox-config]: https://code.claude.com/docs/en/sandboxing#configure-sandboxing
[cc-sandbox-disable]: https://code.claude.com/docs/en/sandboxing#which-settings-can-disable-it
[cc-sandbox-fs]: https://code.claude.com/docs/en/sandboxing#filesystem-isolation
[cc-sandbox-protected]: https://code.claude.com/docs/en/sandboxing#protected-paths
[cc-sandbox-net]: https://code.claude.com/docs/en/sandboxing#network-isolation
[cc-sandbox-os]: https://code.claude.com/docs/en/sandboxing#os-level-enforcement
[cc-sandbox-scope]: https://code.claude.com/docs/en/sandboxing#scope
[cc-perm-sandbox]: https://code.claude.com/docs/en/sandboxing#permission-rules
[cc-perm-system]: https://code.claude.com/docs/en/permissions#permission-system
[cc-perm-modes]: https://code.claude.com/docs/en/permissions#permission-modes
[cc-read-edit]: https://code.claude.com/docs/en/permissions#read-and-edit
[cc-bash-limits]: https://code.claude.com/docs/en/permissions#bash-rule-limits
[cc-hooks-perm]: https://code.claude.com/docs/en/permissions#extend-permissions-with-hooks
[cc-mode-deny]: https://code.claude.com/docs/en/permission-modes#available-modes
[cc-auto-order]: https://code.claude.com/docs/en/permission-modes#how-auto-mode-evaluates-actions
[cc-settings-scopes]: https://code.claude.com/docs/en/settings#settings-files-and-who-they-affect
[cc-settings-local]: https://code.claude.com/docs/en/settings#where-claude-code-keeps-the-local-file-in-a-git-repository
[cc-settings-session]: https://code.claude.com/docs/en/settings#change-a-setting-for-one-session
[cc-settings-precedence]: https://code.claude.com/docs/en/settings#settings-precedence
[cc-hooks-locations]: https://code.claude.com/docs/en/hooks#hook-locations
[cc-hooks-input]: https://code.claude.com/docs/en/hooks#common-input-fields
[cc-hooks-exit2]: https://code.claude.com/docs/en/hooks#exit-code-2
[cc-hooks-pretool]: https://code.claude.com/docs/en/hooks#pretooluse-input
[cc-hooks-bash]: https://code.claude.com/docs/en/hooks#bash
[cc-hooks-filechanged]: https://code.claude.com/docs/en/hooks#filechanged
[oc-security]: https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/SECURITY.md#L15-L19
[oc-permissions]: https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/web/src/content/docs/permissions.mdx
[oc-agents]: https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/web/src/content/docs/agents.mdx#L420-L470
[oc-plugins]: https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/web/src/content/docs/plugins.mdx#L244-L256
[oc-external]: https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/tool/external-directory.ts
[oc-contains]: https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/project/instance-context.ts#L13-L24
[oc-instance]: https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/project/instance-store.ts#L48-L57
[oc-project]: https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/project/project.ts#L214-L310
[oc-resolve]: https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/core/src/project.ts#L109-L121
[oc-commit]: https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/core/src/project.ts#L124-L126
[oc-edit]: https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/tool/edit.ts#L83
[oc-write]: https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/tool/write.ts#L44
[oc-patch]: https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/tool/apply_patch.ts#L74
[oc-shell-files]: https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/tool/shell.ts#L28-L50
[oc-shell-parts]: https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/tool/shell.ts#L91-L117
[oc-shell-dynamic]: https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/tool/shell.ts#L174-L179
[oc-shell-collect]: https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/tool/shell.ts#L378-L413
[oc-subagent]: https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/agent/subagent-permissions.ts
[h-config]: https://github.com/herdrdev/herdr/blob/v0.9.1/docs/next/website/src/data/config-reference.json
[h-agent-start]: https://github.com/herdrdev/herdr/blob/v0.9.1/docs/next/website/src/content/docs/cli-reference.mdx#L341-L348
[h-socket-events]: https://github.com/herdrdev/herdr/blob/v0.9.1/docs/next/website/src/content/docs/socket-api.mdx#L800-L842
[h-plugins]: https://github.com/herdrdev/herdr/blob/v0.9.1/docs/next/website/src/content/docs/plugins.mdx#L35-L52
[h-cargo]: https://github.com/herdrdev/herdr/blob/v0.9.1/Cargo.toml
[git-worktree]: https://git-scm.com/docs/git-worktree
[srt]: https://github.com/anthropics/sandbox-runtime/blob/main/README.md
[bwrap]: https://github.com/containers/bubblewrap/blob/main/README.md
[landlock]: https://github.com/torvalds/linux/blob/172b6a6d8463562b0cbebfd66f770b078f81966b/Documentation/userspace-api/landlock.rst#L7-L34
[landlock-inherit]: https://github.com/torvalds/linux/blob/172b6a6d8463562b0cbebfd66f770b078f81966b/Documentation/userspace-api/landlock.rst#L320-L410
[landlock-kernel]: https://github.com/torvalds/linux/blob/172b6a6d8463562b0cbebfd66f770b078f81966b/Documentation/userspace-api/landlock.rst#L837-L873
[inotify]: https://man7.org/linux/man-pages/man7/inotify.7.html
[fanotify]: https://man7.org/linux/man-pages/man2/fanotify_init.2.html
[fsevents]: https://developer.apple.com/library/archive/documentation/Darwin/Conceptual/FSEvents_ProgGuide/TechnologyOverview/TechnologyOverview.html
