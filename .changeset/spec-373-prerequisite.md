---
"@fveracoechea/operator": major
---

Upgrade the dependency toolchain and move application sources to src and development tools to tools before Spec #373 implementation.
Preserve installed CLI, plugin, migration, and built artifact paths.
For direct source execution, replace `bun cli.ts` with `bun src/cli.ts`.
Update direct development-script paths from `scripts/` to `tools/`, and use `tools/drizzle.config.ts` for Drizzle configuration.
The installed `operator` command and the package's exported `./cli` entry remain unchanged.
Require explicit authorization before release publication; ordinary main merges only prepare the version PR.
