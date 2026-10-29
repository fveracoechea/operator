# Environment

## `operator/env-through-schema`

Only `modules/environment/main.ts` reads or writes the process environment.
Read validated values with `Environment.read()`, and build a child process environment with `Environment.child(overrides)`.
Never change the parent environment. Give CLI children isolated `HOME`, `XDG_CONFIG_HOME`, and `XDG_STATE_HOME` values.

```ts
// Wrong
const home = process.env.HOME;

// Right
const home = Environment.read().HOME;
Bun.spawn(command, { env: Environment.child({ HOME: `${root}/home` }) });
```
