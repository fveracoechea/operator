#!/usr/bin/env bun

import { OperatorCli } from "./modules/operator-cli/main.ts";

export async function main(args: string[]): Promise<void> {
  await OperatorCli.main(args);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
