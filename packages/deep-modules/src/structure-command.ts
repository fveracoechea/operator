#!/usr/bin/env node
import { runStructureCommand } from "./structure.ts";

process.exitCode = runStructureCommand(process.argv.slice(2), process.cwd());
