import { expect, test } from "bun:test";
import { qualifyStateFailure, stateFailure } from "./failures.ts";

function coded(code: string) {
  return Object.assign(new Error(`failure ${code}`), { code });
}
function asDefect(cause: Error) {
  return { defect: cause };
}

test.each([
  {
    reason: "state_missing",
    next: {
      command: "operator project register",
      why: "Register a project explicitly to initialize device state.",
    },
  },
  {
    reason: "state_backup_failed",
    next: {
      decider: "super-agent",
      question: "How should the backup failure be corrected before the upgrade is retried?",
    },
  },
  {
    reason: "state_migration_blocked",
    next: {
      decider: "super-agent",
      question: "How should the recorded live operations finish before the upgrade is retried?",
    },
  },
  {
    reason: "controller_mismatch",
    next: {
      command: "operator project list",
      why: "Find the recorded controlling checkout and run the command there.",
    },
  },
  {
    reason: "controller_identity_mismatch",
    next: {
      decider: "super-agent",
      question: "How should the controlling checkout's recorded GitHub remote be restored?",
    },
  },
] as const)(
  "state owner supplies recovery for $reason without replacing checked facts",
  ({ reason, next }) => {
    expect(stateFailure(reason, "The guard refused.", { checked: false })).toEqual({
      reason,
      detail: "The guard refused.",
      state: { checked: false },
      next,
    });
  },
);

test("qualifies known SQLite and filesystem failures as input failures", () => {
  for (const code of [
    "ENOENT",
    "EEXIST",
    "EACCES",
    "EPERM",
    "EROFS",
    "EIO",
    "ENOSPC",
    // A recursive removal that a permission stops reports a folder that is not empty.
    "ENOTEMPTY",
    "EBUSY",
    "EISDIR",
    "ENOTDIR",
    "SQLITE_CANTOPEN",
    "SQLITE_READONLY",
    "SQLITE_IOERR",
    "SQLITE_FULL",
  ]) {
    const cause = coded(code);
    expect(qualifyStateFailure(cause, asDefect), code).toEqual({
      reason: "state_io_failed",
      next: {
        decider: "super-agent",
        question: "How should the device state IO failure be corrected without overwriting state?",
      },
      state: { code },
      detail: String(cause),
    });
  }
});

test("qualifies busy, damaged, and unsupported state with the fact that nothing was written", () => {
  for (const code of ["SQLITE_BUSY", "SQLITE_LOCKED"])
    expect(qualifyStateFailure(coded(code), asDefect), code).toEqual({
      reason: "state_busy",
      next: {
        decider: "super-agent",
        question: "When has the active state operation finished so this command can be retried?",
      },
      state: { code },
      detail: "The device database stayed busy for 5000 ms. No command write was committed.",
    });
  for (const code of ["SQLITE_CORRUPT", "SQLITE_NOTADB"])
    expect(qualifyStateFailure(coded(code), asDefect), code).toEqual({
      reason: "state_corrupt",
      next: {
        decider: "person",
        question: "How should the damaged device state be recovered without overwriting it?",
      },
      state: { code },
      detail: `The device database is damaged and was not replaced. Error: failure ${code}`,
    });
  expect(qualifyStateFailure(coded("STATE_UNSUPPORTED"), asDefect)).toEqual({
    reason: "state_incompatible",
    next: {
      decider: "person",
      question: "Which compatible Operator release should be used for this device state?",
    },
    state: { code: "STATE_UNSUPPORTED" },
    detail: "Error: failure STATE_UNSUPPORTED",
  });
});

test("keeps defects and unknown codes separate from state failures", () => {
  const cause = new TypeError("implementation defect");
  expect(qualifyStateFailure(cause, asDefect)).toEqual({ defect: cause });
  const numeric = Object.assign(new Error("numeric"), { code: 5 });
  expect(qualifyStateFailure(numeric, asDefect)).toEqual({ defect: numeric });
  const unknown = coded("EUNKNOWN");
  expect(qualifyStateFailure(unknown, asDefect)).toEqual({ defect: unknown });
});
