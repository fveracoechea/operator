# One release is one matched version, delivered twice and never replaced

A release is one version of the CLI code and the Operator-owned skills together.
They ship from one commit, under one version, because a project that ran one release of the code against the workflow instructions of another would follow rules its CLI does not enforce.

A published copy cannot be read through its package manifest.
The registry writes that manifest itself and drops the fields a consumer would otherwise read the version and the supported runtime from.
So a release carries its own record beside the code it ships, and every reading of the running version, the supported runtime, and the commit goes through that record.

There are two delivery paths and one commit.
The source path delivers the repository as it stands, and runs TypeScript directly, so it needs no build at all.
The registry path delivers an artifact of runnable ESM, public declarations, the complete owned-skill directories, and the generated configuration schema, so retrieval runs no build either.
The artifact ships exactly what the command entry point reaches, because following the imports keeps a test double out of a published version without anyone maintaining a list.

A project names the exact release it coordinates with, and `operator update` is the only path that changes that record.
An update is explicit, refuses while work is in flight, copies every durable record aside and reads each copy back before a recorded format moves, and writes the code and the skills together.
A missing installation, a mismatched one, and missing lock data stop the work that depends on them; Operator never answers them with the installation that happens to be at hand.

Lock data belongs to the installation that holds the package.
The search for it stops at that installation, because an ancestor lock describes another project's dependencies and would let an unfrozen Operator look frozen.

Crew state records the release it was written under.
A file an earlier release wrote is left exactly as it stands until an approved update migrates it, so a command that happened to run first never rewrites a format nobody has backed up.

Publication is automatic.
The author decides what a release is through changesets, so merging the version pull request is the decision to publish that version.
The release job then publishes from the merged commit, and only after the quality gate and the release smoke passed on that same commit.
A push that carries a version both paths already hold publishes nothing.
A published tag is never moved and a published version is never replaced, so changed content is a new version.
What a release has already delivered is recorded, so a partial publication carries the same artifact to the missing path and leaves the delivered one alone.
An answer that never came stays uncertain, because a timeout does not prove that the effect did not happen.

The registry client is the official `jsr` client, pinned in the development dependencies.
It runs Deno as a publishing tool inside the release job only.
Operator never runs on Deno, and no consumer needs it.
The client publishes a staged copy of the artifact, so the artifact the release identity covers never gains a file.
It authenticates with the short-lived credential the release job is issued, and no publishing token is stored.

## Considered options

Reading the running version from the package manifest was rejected.
It needs no second record, and it is correct in a checkout and on the source path.
It is also wrong on the registry path, where the manifest is regenerated without those fields, which is exactly the path a consumer is most likely to use.

Publishing the repository source to the registry, with no build, was rejected.
It matches how the source path already works, and it removes the build this repository otherwise avoids.
The registry then has to infer the public types itself, which the approved contract refuses to paper over, so the accepted cost is one generated artifact whose declarations are checked as a consumer receives them.

Letting project setup own the release record was rejected.
Setup already owns the other local files, so the record would sit with them.
Setup cannot retrieve a package and cannot know which commit the running code came from, so it would record a selection it never verified.

Migrating a recorded format on first read was rejected.
It needs no separate command, and a project would never meet a state file it cannot open.
It also rewrites durable records under whichever command happened to run first, with no backup and no approval behind it.

Republishing every path on a retry was rejected.
It is simpler, and it needs no record of what already happened.
It also moves a tag and replaces a version, which is the one thing a published release must never do.

Approving each publication by hand was rejected.
It let a person check the exact bytes before they left, and it kept a merge from publishing anything.
It also made every release a second step that a person had to remember after the merge, and the version pull request already states what the release is.
The accepted cost is that a merged version pull request publishes with no check beyond the ones that commit passed.

Owning the registry client was rejected.
It kept Deno out of the release job, and a fake endpoint proved it against the documented API.
Nothing ever proved it against the live registry, and it copied a client the registry maintains.
Deno runs only as a publishing tool in the release job, so the accepted cost is one more download in that job.

Falling back to a stored publishing token when the short-lived credential is absent was rejected.
It would make a release succeed more often.
It would also keep a credential that outlives the job, so anyone who could read it could publish a version outside the release workflow.

## Consequences

The official client is exercised only in the release job.
The tests put a fake client on the path, so a change in the behaviour of the real client shows up in the first release after the pinned version moves.
A failed client does not prove that nothing landed, so the release reads the registry before it records the path as failed.

The registry accepts the short-lived credential only from a repository linked to the package, so that link is set up on JSR before the first release.

A project that has selected no release is unverified, never ready.
That is one more step before a crew can start, and it is the step that makes a launch snapshot mean something.

The artifact is built with the TypeScript compiler, which this repository otherwise uses only to check types.
A release therefore needs the development dependencies present, and the release tooling stays out of the user-facing CLI.

A migration step exists for every recorded state version this release can read.
A version with no step is refused and reported, never repaired in silence, so an unforeseen format stays the maintainer's decision.
