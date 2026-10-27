# Concurrent quality runs (#220)

## Result

The historical hang did not reproduce.
Sixteen `bun run quality` runs, in eight rounds of two concurrent runs in separate worktrees, all finished in 234 to 262 seconds.
No run stalled, and no process stayed after a run.
The root cause of the historical hang is not proven.

The reproduction found two defects that are not concurrency defects.
Both fail in a single run too. Commit `b4d75b5` (#262) fixes both.

- On commit `0beb138`, every run failed `the protected wal snapshot blocks a process writer until migration completes`. It fails since commit `a1540b5` added it. A SQLite read-only open cannot create the WAL index, so startup refused a closed WAL device database as `state_io_failed`.
- With the default macOS `TMPDIR` under `/var/folders`, 33 tests failed, because `/var` is a symbolic link and the path guards refuse a linked ancestor. The rounds below used a `TMPDIR` under `/private/tmp`, which has no link.

## Reproduction

The two runs of a round share only the source commit and, in `shared` rounds, `TMPDIR`.

1. `git worktree add --detach <scratch>/wt-a <commit>` and the same for `wt-b`.
2. `bun install --frozen-lockfile` in each worktree.
3. Start both runs at the same time, each in its own process session:
   `HOME=<root>/home XDG_CONFIG_HOME=<root>/config XDG_STATE_HOME=<root>/state TMPDIR=<tmp> bun run quality`.
   Each run has its own `<root>`, and every `<root>` and `<tmp>` is under `/private/tmp`.
   `shared` rounds give both runs one `<tmp>`, `split` rounds give each run its own `<tmp>`.
4. A 600 second watchdog records `ps`, `lsof`, and `sample` for a run that does not finish, then kills that process group.
5. After the rounds, `pgrep -f <round directory>` must list no process.

Environment: macOS 26.6.2 arm64, 18 cores, 48 GiB, Bun 1.4.4 (`38afee6c8`), Git 2.55.0, system SQLite 3.51.0.

| Rounds | Commit | Outcome |
| --- | --- | --- |
| 1 to 5, shared and split | `0beb138` | All 10 runs finished, exit 1 only from the WAL test. |
| 6 to 8, shared and split | `66577b6`, the watchdog and a WAL fix that moved to #262 | All 6 runs finished with exit 0. |

## Investigation

- Paths: every test root comes from `mkdtemp` or a random UUID under `TMPDIR`. Shared and split `TMPDIR` rounds had the same outcome.
- Ports: test servers bind port 0 only.
- Sockets: no test uses a fixed socket path.
- Herdr: readiness only looks up `herdr` on `PATH`. No test starts a Herdr session or uses a Herdr namespace.
- Child processes: no process stayed after any round.
- Runner configuration: `--timings=test-timings.json` resolves in each worktree and is read only. Only `test:timings` writes it.
- Environment: each run had its own `HOME` and XDG roots. Tests pass explicit child environments.

## Observed limit

Eight rounds cannot exclude a rare runner defect.
The historical signature matches open Bun defects:

- [oven-sh/bun#39987](https://github.com/oven-sh/bun/issues/39987): a `bun test --parallel` worker deadlocks with every thread parked, the run stays silent, and the rate was about 7% per run on a large suite.
- [oven-sh/bun#41024](https://github.com/oven-sh/bun/issues/41024): on macOS, a `--parallel` worker loses a subprocess exit notification.

## Bounded failure

`bun run test` runs `scripts/test-watchdog.ts`.
The watchdog runs `bun test` with the dots reporter, which writes one byte for each test.
Each test is bound by its 30 second timeout, but module load and hooks with their own timeouts also count toward silence.
The slowest file in `test-timings.json` takes 14 seconds, so 120 seconds with no output means a stalled runner.
The watchdog then prints the processes, working directories, sockets, and pipes of its own run, kills only the descendants of its own `bun test` process, and exits with code 124.
On SIGINT or SIGTERM it kills the same processes and exits with 130 or 143.
It adds no queue, quota, retry, or skipped test.
`scripts/test-watchdog.test.ts` blocks two real workers with `Atomics.wait` and proves the exit code, the diagnostics, and that every listed process is gone.
It also proves that SIGTERM stops the workers and gives exit 143.

## Verification

- `bun run test scripts/test-watchdog.test.ts`: 4 pass.
- The stall test fails when the watchdog kills only the root process.
- The signal test fails with exit 137 when the watchdog returns the status of the killed child.
- `bun run quality` on `b4d75b5` with the default macOS `TMPDIR`: static checks pass, and 737 tests pass with 0 failures.
