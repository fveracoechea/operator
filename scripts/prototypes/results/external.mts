import { z } from "zod";
import { open } from "./store.mts";
import { Database } from "bun:sqlite";

const [root, key, mode] = z
  .tuple([
    z.string(),
    z.string(),
    z.enum(["applied", "rejected", "invalid", "tool", "lost", "timeout", "observe"]),
  ])
  .parse(Bun.argv.slice(2));
// The external process must acquire this lock, so a caller cannot hide an open write transaction.
using local = open(root);
local.run("BEGIN IMMEDIATE; ROLLBACK;");
using external = new Database(`${root}/external.sqlite`, { create: true, strict: true });
external.run(
  "PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS calls (key TEXT NOT NULL, applied INTEGER NOT NULL)",
);
if (mode === "observe") {
  const record = external
    .query<{ applied: number }, [string]>(
      "SELECT applied FROM calls WHERE key=? ORDER BY rowid DESC LIMIT 1",
    )
    .get(key);
  console.log(
    JSON.stringify({
      evidence: record ? (record.applied === 1 ? "applied" : "not-applied") : "unknown",
    }),
  );
} else {
  external.query("INSERT INTO calls VALUES (?,?)").run(key, mode === "rejected" ? 0 : 1);
  if (mode === "timeout") {
    process.send?.("external-started");
    console.log("started");
    await Bun.sleep(60000);
  }
  if (mode === "tool") {
    console.error("controlled tool failure after application");
    process.exit(7);
  }
  console.log(
    mode === "invalid" || mode === "lost"
      ? "{}"
      : JSON.stringify(
          mode === "rejected"
            ? {
                status: "rejected",
                terminal: true,
                detail: "Controlled terminal rejection. No request remains in flight.",
              }
            : { status: "applied", reference: `external:${key}` },
        ),
  );
}
