# A drifted ADR and its decision form

An excerpt from an ADR about enabling React Compiler, as first written. Every line describes the
implementation, and every line went stale when the lint rules were renamed upstream and the library
it names was removed:

```md
1. Enable React Compiler in the Vite build. `@vitejs/plugin-react` v6 exposes it
   via the `reactCompilerPreset` helper, run through `@rolldown/plugin-babel`:

   babel({presets: [reactCompilerPreset()]})

   On React 19 the preset defaults to the built-in `react/compiler-runtime`, so
   no `target` option and no `react-compiler-runtime` polyfill package are required.

2. Remove the `react-perf` oxlint plugin and its
   `jsx-no-{jsx,new-array,new-function,new-object}-as-prop` rules.

## Amendment - 2026-08-19

- **The `react/react-compiler` oxlint rule no longer exists.** oxlint split it into
  granular per-diagnostic rules (`react/hooks`, `react/purity`, ..., see `.oxlintrc.jsonc`).
- **The incompatible-library case has no live instance.** `@tanstack/react-table`, the one
  library that once forced a bailout, is no longer a dependency.
```

The same decision in its decision form:

```md
## Decision

Enable React Compiler for the whole app in infer mode, so every component and hook is optimized
without opting in. Components that break the Rules of React are silently skipped by the compiler,
so lint enforces those rules and a lint error means "this component would not be optimized". Lint
rules that nag developers to hand-memoize inline props are removed: the compiler makes that a style
question, not a performance one.
```

Those sentences were true before the rename and are true after it. The amendment became one Status
clause: the lint rules were renamed upstream and the decision is unchanged. The plugin names, the
preset helper and the rule list live in the build and lint config, where a rename changes them in
place.

The pattern behind the drift: an ADR written in the same commit as the implementation, with the
whole implementation in view, records the implementation. Decide first whether a sentence is about
the decision or about the code, and put it where its clock runs.
