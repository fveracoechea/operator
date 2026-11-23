# deep-modules/synchronous-selectors

Selectors have a synchronous contract. This rule rejects explicit asynchronous syntax, not impurity.
It reports async functions, awaited selector values, awaits in implementations and explicit `Promise` return contracts.
It also checks returned predicate and projection functions.

## Recognized contracts

The shared `settings["deep-modules"]` configuration has `selectorSubmodules: ["selectors"]` by default.
These are behavior-directory names, not paths or file globs.
Set another list to declare your project's selector sub-modules.
An empty list disables directory-name recognition without disabling exposed selector groups.
Shared module roots, library-root precedence, production-file discovery and exclusions still apply.
Tests and declaration files do not create selector implementations.

The rule checks exported implementations from those sub-modules.
It also checks statically traceable `selector` and `selectors` groups on exported objects, including nested groups.
For example:

```ts
import * as selectors from "./selectors/main";

export const Movie = {
  async play(id: string) {
    return loadAndPlay(id);
  },
  selector: selectors,
};
```

`Movie.play` is not a selector. These named domain selectors are synchronous and valid:

```ts
export function isReleased(movie: MovieSummary) {
  return movie.status === "released";
}

export function budgetIsBiggerThan(minimum: number) {
  return function hasBudget(movie: MovieSummary) {
    return movie.budget > minimum;
  };
}

export function toCast(predicate: (person: Person) => boolean) {
  return function selectCast(movie: MovieSummary) {
    return movie.cast.filter(predicate);
  };
}
```

Methods, function references and curated objects also pass.
Making the returned `hasBudget` or `selectCast` function async fails.
Direct `Promise<T>` and `globalThis.Promise<T>` return annotations fail, including unions and returned function signatures.
Explicit function annotations on selector variables and syntax assertions receive the same check.

## Static tracing

The rule follows named imports, namespace imports and properties, immutable local aliases, named re-exports and syntax wrappers.
It uses the package's shared project-relative, configured-alias and package-self import resolution.
It parses local dependencies without executing them.
Imported violations point to the exposing selector group in the linted file.
Binding and export cycles stop tracing.

Computed properties, mutable aliases, destructuring aliases, call-initialized values and opaque dependencies can stop tracing.
Type aliases are not a type-checker substitute.
An opaque value receives no invented synchrony or purity finding.
An unused async function elsewhere in the module does not become a selector.

## Behavioral limits

Passing this rule does not prove purity, absence of IO, unchanged inputs or hidden promise behavior.
Behavioral tests and review own those properties.
Do not replace those tests with a lint assertion or silence this rule by hiding async behavior behind an opaque factory.
