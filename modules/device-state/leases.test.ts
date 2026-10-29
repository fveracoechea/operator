import { expect, test } from "bun:test";
import { ownerGone } from "./leases.ts";

// A process that already exited has an identifier that no live process holds.
const stoppedPid = Bun.spawnSync([process.execPath, "--version"]).pid;

test("a stopped owner or a stale lease holds nothing", () => {
  const now = Date.now();
  const fresh = new Date(now).toISOString();
  expect(ownerGone({ ownerPid: process.pid, leaseAt: fresh }, now)).toBe(false);
  expect(ownerGone({ ownerPid: stoppedPid, leaseAt: fresh }, now)).toBe(true);
  expect(
    ownerGone({ ownerPid: process.pid, leaseAt: new Date(now - 300001).toISOString() }, now),
  ).toBe(true);
  expect(ownerGone({ ownerPid: null, leaseAt: fresh }, now)).toBe(true);
});

test("an owner with no lease is gone, the stale limit is strict, and another user's process is alive", () => {
  const now = Date.now();
  expect(ownerGone({ ownerPid: process.pid, leaseAt: null }, now)).toBe(true);
  expect(
    ownerGone({ ownerPid: process.pid, leaseAt: new Date(now - 300000).toISOString() }, now),
  ).toBe(false);
  // The first process belongs to the system, so a signal check reports EPERM.
  expect(ownerGone({ ownerPid: 1, leaseAt: new Date(now).toISOString() }, now)).toBe(false);
});
