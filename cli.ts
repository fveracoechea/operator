#!/usr/bin/env bun

/**
 * Run the Operator CLI under Bun from an installed release or a source checkout.
 * The CLI uses the current working directory as the project.
 * @module
 */

import { OperatorCli } from "./modules/operator-cli/main.ts";

/**
 * Run one CLI command with arguments that do not include the executable name.
 * The command writes its result to standard output and reports failure with a process exit code.
 *
 * @example
 * ```ts
 * import { main } from "@fveracoechea/operator/cli";
 * await main(["--version", "--json"]);
 * ```
 */
export async function main(args: string[]): Promise<void> {
  await OperatorCli.main(args);
}

if (import.meta.main) {
  await main(Bun.argv.slice(2));
}
