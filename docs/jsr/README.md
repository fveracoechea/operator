# Operator

Operator is a Bun CLI and a set of skills for coordinating coding agents in OpenCode and Claude Code through [Herdr](https://herdr.dev/).

## Install from JSR

Use Bun 1.4.0 or later. Install the package in the project where you will run Operator:

```sh
bunx --bun jsr add --bun @fveracoechea/operator
```

The JSR package exports `@fveracoechea/operator/cli`. Run its `main` function with CLI arguments, for example:

```sh
bun --no-install -e 'const { main } = await import(Bun.pathToFileURL(Bun.resolveSync("@fveracoechea/operator/cli", process.cwd())).href); await main(Bun.argv.slice(1))' -- --version
```

Run `install --opencode` or `install --claude` in place of `--version` to copy the Operator-owned skills into the project. For example:

```sh
bun --no-install -e 'const { main } = await import(Bun.pathToFileURL(Bun.resolveSync("@fveracoechea/operator/cli", process.cwd())).href); await main(Bun.argv.slice(1))' -- install --opencode
```

For coordinated work, Operator records an exact release and installs it under `.operator/install/`, separate from the application's dependencies. See the [project guide](https://github.com/fveracoechea/operator#project-installation-and-setup) for setup, updates, and the full CLI workflow.

Operator runs on Bun. Git and [Herdr](https://herdr.dev/) are needed for crew work; GitHub CLI and OpenCode or Claude Code are needed for their respective integrations.
