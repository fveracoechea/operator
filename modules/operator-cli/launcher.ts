import { GlobalLauncher } from "../global-launcher/main.ts";
import { failure } from "./output.ts";

const exitCodes = {
  launcher_unsupported: 3,
  launcher_version_unpinned: 3,
  launcher_bun_failed: 3,
  launcher_conflict: 4,
  launcher_global_manifest_invalid: 1,
  launcher_io_failed: 1,
};

export async function runLauncher(args: string[], json: boolean) {
  const flags = args.slice(2);
  if (
    args[0] !== "install" ||
    args[1] !== "launcher" ||
    flags.length > 1 ||
    flags.some((flag) => flag !== "--json")
  )
    return false;
  const result = await GlobalLauncher.install();
  if (result.tag === "Ok") {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          operation: "install_launcher",
          outcome: "completed",
          reason: result.value.reason,
          blockers: [],
          data: result.value.data,
        },
        null,
        json ? undefined : 2,
      ),
    );
    process.exitCode = 0;
  } else if (result.tag === "Err")
    failure(
      "install_launcher",
      result.error.reason,
      result.error.detail,
      exitCodes[result.error.reason],
      json,
    );
  else failure("install_launcher", "launcher_defect", String(result.cause), 1, json);
  return true;
}
