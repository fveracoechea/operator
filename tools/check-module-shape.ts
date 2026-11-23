import { runStructureCommand } from "../packages/deep-modules/src/structure.ts";

process.exitCode = runStructureCommand(process.argv.slice(2), process.cwd());
