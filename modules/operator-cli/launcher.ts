import { GlobalLauncher } from "../global-launcher/main.ts";
import { respond } from "./output.ts";

const launcherExitCodes = {
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
  respond({
    operation: "install_launcher",
    result,
    exitCodes: launcherExitCodes,
    defect: "launcher_defect",
    json,
  });
  return true;
}
