# A live probe proves itself on its own resources, and every attempt is kept

A static check reads the machine and the project.
A live check has to launch agents, spend provider tokens, and write to a tracker, so it needs something to act on.

It acts on resources it creates for itself: a synthetic repository under the ignored Operator directory, one Herdr worktree of that repository, its own crew agents, its own crew state, and one tracker fixture named in configuration.
It never launches in the project checkout, never writes to a project issue, and never touches an Operative worktree, a branch, a remote, or a release.
So a probe that goes wrong costs a scratch directory and a fixture comment, and the approval a person gives covers exactly what the plan showed.

The probe plan states the hosts, the models, the provider use, the credentials each host and the fixture need, the temporary resources, the expected cost as the number of synthetic prompts each host sends, and what cleanup leaves behind.
The plan revision is part of the plan identity, so a change to what the plan declares makes every earlier approval stale rather than covering more than the person read.

Recorded evidence is a list of attempts, appended and never rewritten.
The result that stands for one check is the most recent attempt that ran it, and an attempt that never ran a check leaves the earlier result of it standing.
A failed attempt therefore stays readable after a later one replaces what it proved, which is what a person needs when a check passes only sometimes.

A check the probe attempted and could not run is recorded as skipped.
Skipped reads as unverified, exactly like a check no probe ever ran, so a missing fixture or a host that never answered holds back the claims that check feeds instead of disappearing from the report.

Each live check names the claims it feeds, and a static check feeds every claim.
The readiness claim and the release claim are reported apart, so a tracker check that fails holds back a release without pretending the machine is unusable.

## Considered options

Running the probe against the project repository and a project issue was rejected.
It needs no fixture configuration, and it proves the same behaviors.
It also puts a synthetic comment on real work, and it gives the probe a reason to hold a writer in the checkout a person is using.

Replacing the recorded evidence on every run was rejected.
It keeps the file small, and it answers the readiness question just as well.
It also deletes the record of the attempt that failed, which is the one a person reads when a check is not reliable.

Treating a skipped check as neutral was rejected.
A check that did not run proves nothing, so counting it as anything but unverified would let a claim stand on evidence nobody gathered.

Blocking a probe whenever readiness is blocked was rejected.
A failed live check is the reason to run a probe again, so only a failed static check, or evidence that cannot be read, holds a probe back.

## Consequences

The GitHub checks need `probe.githubFixture` in the project configuration.
A project without one keeps every tracker check skipped, so it is never ready and never releasable, and the probe plan says so before anything runs.

Removing a temporary probe resource needs its own approval, bound to the resources it would remove.
The probe's own approval covers the run and the removal of the Herdr test worktree, because removing that worktree is one of the checks.
It grants no authority to merge, publish, or remove anything else.

The recorded evidence keeps growing until a person approves a cleanup, and cleanup removes scratch directories only.
The observations stay, so preserved attempts outlive the resources they were made on.
