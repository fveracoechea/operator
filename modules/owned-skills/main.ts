import { fromPromise, Ok, Err } from "unthrown";
import { z } from "zod";
import { checkOnly, install, type Request } from "./install.ts";
// Bun has no realpath API.
import { realpath } from "node:fs/promises";
import path from "node:path";
import { OperatorHome } from "../operator-home/main.ts";
import { Environment } from "../environment/main.ts";
import { contents, identity } from "./content.ts";
import { isCodedError } from "../../lib/coded-error.ts";

const source = Bun.fileURLToPath(new URL("../../skills/", import.meta.url));

/** Owns personal copies and their device ledger. Check mode follows consumer-owned links. */
export const OwnedSkills = {
  async names() {
    const names = [];
    for await (const file of new Bun.Glob("*/SKILL.md").scan({ cwd: source }))
      names.push(path.dirname(file));
    return names.toSorted();
  },
  /** Content identities of the running release's skills, for a launch snapshot. */
  async identities() {
    const identities = [];
    for (const name of await OwnedSkills.names()) {
      identities.push({ name, identity: identity((await contents(`${source}${name}`)) ?? {}) });
    }
    return identities;
  },
  install(input: Omit<Request, "source">) {
    return fromPromise(
      async () => {
        OperatorHome.guardTemporaryTests(
          Environment.read(),
          input.hosts.map((host) => input.paths.skillHosts[host]),
        );
        return install({
          ...input,
          source,
          check: checkOnly(await realpath(source), input.check),
        });
      },
      (cause, defect) => {
        if (cause instanceof SyntaxError || cause instanceof z.ZodError)
          return { reason: "skills_ledger_invalid" as const, detail: String(cause) };
        if (
          isCodedError(cause) &&
          [
            "EACCES",
            "EPERM",
            "EROFS",
            "EIO",
            "ENOENT",
            "EISDIR",
            "ENOTDIR",
            "EEXIST",
            "ENOSPC",
            "ELOOP",
            "ENOTEMPTY",
            "SQLITE_BUSY",
            "SQLITE_CANTOPEN",
            "SQLITE_CORRUPT",
            "SQLITE_NOTADB",
          ].includes(cause.code)
        )
          return { reason: "skills_io_failed" as const, detail: String(cause) };
        return defect(cause);
      },
    ).flatMap((result) => ("detail" in result ? Err(result) : Ok(result)));
  },
};
