# Tools and toolchain

## Tools should make good choices easy

- Ergonomics matter. A good architecture that is hard to use correctly still produces slow, brittle code.
- Prefer opinionated defaults, optimized in one place, with an escape hatch for advanced users.
- Prefer terminal-centered workflows, such as grep, fzf, and Neovim-style editing, with low visual clutter.
- Reproducible environments turn fragile manual memory into repeatable systems.
- Clear ownership boundaries between tools beat forcing everything through one layer.
- A framework or abstraction earns its complexity by matching the problem's shape.
- Developer tools deserve visual craft when it improves comprehension.
- The platform's own mechanism beats a bespoke loader. Someone maintains the platform, and nobody maintains the wrapper.

## Toolchain

- Bun is runtime, package manager, and test runner. The manifest refuses npm, and a hook denies npm, npx, pnpm, and yarn.
- Node APIs are a legacy layer. Reach for Bun natives first. Each remaining `node:` import states why Bun has no equivalent.
- One runtime everywhere, so CI runs what production runs. A hosted test runner puts its own transform between the code and the engine it ships on.
- Publish TypeScript sources with no build step when nobody bundles the output. A build buys stale-output bugs.
- No nightly dependencies in production. Pin exactly, upgrade on a schedule. A break is cheaper on a schedule than at random.
- Everything is TypeScript under Bun, lint config included. A `.mjs` file or a JSDoc-typed config is a workaround for Node, and Bun runs TypeScript as is. Shell is fine only in short run blocks.
- Add a workspace, a generator, or a utility library when the second case arrives.
