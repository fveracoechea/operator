# Prove a project is ready

Configured is not ready.
Configured means the approved setup plan is complete and the selected files and settings validate.
Ready means the required checks passed for this exact selection and these exact inputs.

## Ask for readiness

```sh
operator setup readiness --claude --operator-host claude-code --json
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

Static checks observe the selected hosts, Bun, Git, Herdr, the GitHub CLI, the instruction files, the discoverable skill contents, the Operator release, its lock data, and the project settings.

A static check never proves a live capability.
Host termination, the native review sub-agents, and provider compatibility are proven only by a live probe.

## Live probe

A live probe launches agents and spends provider tokens, so it needs its own approval.

```sh
operator setup probe plan --claude --operator-host claude-code --json
operator setup probe apply --claude --operator-host claude-code --approved-probe <probeId> --json
```

The plan shows the hosts, the models, the provider use, the temporary resources, and the checks before anything launches.
Show it to the user and get their approval before you apply it.

A changed project or a changed selection makes a new `probeId`, and the old approval is refused.
Test-worktree deletion still needs its own separate approval.

## Recorded evidence

A live probe records each proven check in `.operator/local/readiness.json`, together with the approved probe that produced it and the fingerprints of the inputs it was proven against.
A record that names no approved probe has no provenance, and the whole file is then refused.

A later readiness check recomputes those fingerprints.
A record whose own inputs changed becomes `stale`, and unrelated records stay valid.
One proven host pairing does not prove another pairing, because the selection is one of the inputs.
