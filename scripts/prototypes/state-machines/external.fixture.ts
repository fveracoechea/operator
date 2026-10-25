import { z } from "zod";
import { open } from "./store.ts";

// This controlled external process changes scratch evidence, never GitHub or Herdr resources.
const [root, key, mode] = z
  .tuple([z.string(), z.string(), z.enum(["done", "not-applied", "unknown", "observe"])])
  .parse(process.argv.slice(2));
using state = open(`${root}/prototype.sqlite`);
state.run("BEGIN IMMEDIATE; ROLLBACK;");
if (mode === "observe") {
  let outcome = "unknown";
  if (await Bun.file(`${root}/external.sqlite`).exists()) {
    using external = open(`${root}/external.sqlite`);
    const record = external
      .query<{ applied: number }, [string]>(
        "SELECT applied FROM calls WHERE key = ? ORDER BY rowid DESC LIMIT 1",
      )
      .get(key);
    if (record) outcome = record.applied === 1 ? "done" : "not-applied";
  }
  console.log(JSON.stringify({ outcome }));
} else {
  using external = open(`${root}/external.sqlite`, true);
  external.run("CREATE TABLE IF NOT EXISTS calls (key TEXT NOT NULL, applied INTEGER NOT NULL)");
  external.query("INSERT INTO calls VALUES (?, ?)").run(key, mode === "not-applied" ? 0 : 1);
  console.log(JSON.stringify({ outcome: mode }));
}
