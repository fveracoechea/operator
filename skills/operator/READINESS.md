# Prove a project is ready

Configured is not ready.
Configured means the approved setup plan is complete and the selected files and settings validate.
Ready means the required checks passed for this exact selection and these exact inputs.

## Ask for readiness

```sh
bun run operator setup readiness --claude --operator-host claude-code --json
```

Name the installation targets the same way setup does.
Name the hosts and models you are about to launch.

The command reads the machine and the project and writes nothing.

## Selection

Each field is resolved on its own, in this order.

1. The session override flags: `--operator-host`, `--operator-model`, `--crew-host`, `--crew-model`.
2. The project configuration in `.operator/config.json`.
3. The host default. A missing Crew host follows the Operator host. A missing model stays with the selected host default, never the Operator model.

Operator never substitutes a host or a model.
An explicitly selected host that is not installed is a blocker.
A host that nothing names is reported as unverified, not guessed.

The reported selection reaches new launches only.
It never changes an agent that is already running.

## Result

`data.state` is one of three answers, and `data.configured` is reported beside it.

- `blocked`: a required check failed. Read `blockers` for the reason, the paths, and the next action.
- `unverified`: every required static check passed, and required live evidence is missing or stale.
- `ready`: every required check passed against the current inputs.

Static checks observe the selected hosts, Bun, Git, Herdr, the GitHub CLI, the instruction files, the discoverable skill contents, the Operator release, the selected installation, its lock data, and the project settings.

The `operator-installation` check is unverified until the project selects an exact release, and it is a blocker when the selected release is not the one installed and running.
Read [RELEASE.md](RELEASE.md) before you act on it.

A static check never proves a live capability.
Host termination, the native review sub-agents, and provider compatibility are proven only by a live probe.

## Live probe

A live probe launches agents, spends provider tokens, and writes to a tracker, so it needs its own approval.

```sh
bun run operator setup probe plan --claude --operator-host claude-code --crew-host opencode --json
bun run operator setup probe apply --claude --operator-host claude-code --crew-host opencode --approved-probe <probeId> --json
```

The plan shows what the run would use, before anything launches.

- The exact hosts and models.
- The provider use, and the credentials each host and the fixture need.
- What the fixture must already hold.
- The temporary resources and the expected costs.
- Each check, and the claims it feeds.
- The cleanup.

Show the whole plan to the user and get their approval before you apply it.
The approval is bound to the plan revision, so a change to the project, the selection, or what the plan declares makes a new `probeId` and refuses the old approval.

The probe acts only on resources it makes for itself and on the fixture named by `probe.githubFixture` in `.operator/config.json`.
A project with no fixture keeps every GitHub check skipped, so it stays unverified until the user names one.
Use the configuration commands in [SETUP.md](SETUP.md) to plan and apply the fixture fields.

The probe's approval covers the run and the removal of the Herdr test worktree, because removing that worktree is one of the checks.
It grants no authority to commit, push, merge, publish, or remove anything else.

## Probe cleanup

```sh
bun run operator setup probe cleanup --json
bun run operator setup probe cleanup --approved-cleanup <cleanupId> --json
```

The first command inspects any interrupted run, including its worktree, named agents, and fixture writes.
It makes no new probe run and sends no tracker write.
Show the listed resources and their status to the user first.
An approved cleanup stops only the agents of the named probe, verifies their panes, removes its Herdr worktree, then removes its scratch repository.
Cleanup stops if Herdr cannot confirm a resource or if the fixture changed while the probe was interrupted.
Run cleanup again to inspect the remaining resources after resolving a blocker.
Approval is bound to the inspected resources, so a changed status needs a new approval.
The recorded observations stay, so every failed attempt survives its resources.
An interrupted attempt without a readiness record stays unproven.
Another apply waits until the interrupted resources are settled or cancelled.

## Recorded evidence

A live probe records each attempt in `.operator/local/readiness.json`.
Attempts are appended and never rewritten, and each observation holds its state, the versions and inputs it ran against, its outputs, its evidence, and the state of what it left behind.
A record that names no approved probe has no provenance, and the whole file is then refused.

The result that stands for one check is the most recent attempt that ran it.
An attempt that never ran a check leaves the earlier result of it standing.

A later readiness check recomputes the fingerprints.
A record whose own inputs changed becomes `stale`, and unrelated records stay valid.
One proven host pairing does not prove another pairing, because the selection is one of the inputs.

A check that failed, and a check the probe attempted and could not run, both leave the claims they feed unproven.
Read `data.claims` for the readiness claim and the release claim separately.
A release is never provable while readiness is not proven.
Never report a project as ready, or a release as provable, while a check that feeds it is not proven.
