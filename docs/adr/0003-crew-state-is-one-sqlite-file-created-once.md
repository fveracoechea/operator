# Crew state is one SQLite file that Operator creates once and never replaces

Assignments, attempts, ownership, source revisions, fixed inputs, dependencies, permissions, and request records are one consistent picture.
A frontier answer reads all of them together, so they live in one SQLite database, `.operator/local/crew-state.sqlite`, read and written through Drizzle and Bun SQLite.

The file carries one integer state version.
`operator crew own` is the only command that creates it, because a crew begins when an Operator takes ownership.
Every other command refuses a missing, damaged, or newer state file and changes nothing.
A newer version blocks with a definite failure, because this release cannot know what a later release wrote.

Creation builds the tables in a temporary file and links the finished file into place.
A failed creation therefore leaves nothing, and two Operator processes that start the same crew produce one file instead of a half-built one.

The create statements and the Drizzle table definitions are two renderings of one schema.
A test creates the tables and compares every column and null rule against the Drizzle definitions, so the two cannot disagree.

A request record is the recovery record of a local mutation.
It holds the caller's request identity, the identity of the input, and the outcome, and it is written in the same transaction as the effect.
An interrupted caller therefore repeats its request and reads the recorded result instead of repeating the effect.

A mutation that changed nothing records nothing, because its transaction rolled back.
A repeat of a refused request is therefore checked again against the current state, and it can succeed once the blocker is gone.
That is the behaviour a recovering Operator needs, because a recorded refusal would replay forever.
The reported `repeated` field is how a caller tells a replay from a fresh effect.

An external operation that leaves an effect outside this database needs its own record, which the workflow that performs it will add.

## Considered options

Generated migration files were rejected.
They add a second tool and a generated directory to a schema that has one version, and they answer a question this release does not yet have.

`create table if not exists` on every open was rejected.
It repairs a damaged file in silence, which is the behaviour the specification forbids.

One database file per feature was rejected.
The frontier reads assignments, dependencies, and attempts in one transaction, and separate files cannot give it one consistent answer.

## Consequences

A change to the tables needs the state version to change, and a version change needs a migration path before the release that makes it.
Until that path exists, the drift test is the only guard that the two renderings of the schema agree.

`skipLibCheck` is on, because `drizzle-orm` ships type errors for the Gel and MySQL dialects whose peer packages this project does not install.
The cost is that library type errors are silenced for every dependency, so a dependency upgrade is checked by the tests rather than by the compiler.

Every mutation runs in one immediate transaction.
Two Operator processes therefore serialize on a write instead of interleaving, and a partial write cannot survive an interrupted command.
