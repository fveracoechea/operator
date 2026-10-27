# React and TypeScript

## React

- Most effects are unnecessary. Derive during render, put interaction logic in the handler, fetch through the query layer, and use `useSyncExternalStore` for the outside world.
- A needed effect is a named function declaration.
- Compose parts instead of adding a mode. A boolean prop that selects what renders is a mode, and three of them make eight states. A boolean that reports one state or attribute is not a mode.
- Shared state between parts justifies a compound component. File size and dot notation do not, and one fixed, tightly coupled control does not split into parts that no caller asks for.
- The compound namespace ships its provider beside its parts, and the provider wraps its consumers and nothing else. The provider is the only place that reads the state source, so parts never know it.
- A part reads a narrow context of state, actions, and meta through `use()`. Shared state never travels down through a layout frame and a prop on each part, but per-item identity stays a prop.
- A capability keeps its internal compounds private and exposes the finished UI. An app caller that assembles the capability's provider and parts holds its implementation. A reusable design-system compound is different: its parts are the public interface.
- The React Compiler memoises. Manual `useMemo`, `useCallback`, or `React.memo` is a lint error that gets fixed, never suppressed.

## TypeScript

- Function declarations over named const arrows. Arrows are for one-off inline callbacks.
- Avoid classes and `this`. A class adds inheritance and binding complexity that functions and plain objects do not need.
- No unsafe type assertions. `satisfies`, predicates that check what they claim, and a typed `reduce` replace the cast.
- Do not mutate a value you do not own. `toSorted` over `sort`, Map and Set for repeated reads, `for...of` for real logic, `Object.keys` in place of `for...in`.
- A comment says why, never what. One short line per function, a little more on the module object, and only for a business rule, a trap, or a contract.
