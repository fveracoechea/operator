# deep-modules/query-options-owner

Expose `queryOptions` and `mutationOptions` separately on the application interface.
Both groups belong to the same internal sub-module, which owns query keys, cache policy and invalidation knowledge.

```ts
// movie/main.ts
import { queryOptions, mutationOptions } from "./query-options/main";

export const Movie = {
  queryOptions,
  mutationOptions,
};
```

The child entry can export named groups or an object whose properties contain those groups.
Direct imports, renamed imports, namespace properties, syntax wrappers and immutable local aliases preserve their owning folder.
The folder need not be named `query-options`.
Two entry files in one internal owner also share ownership.
The package's shared configuration, nearest-folder discovery and project import resolution determine ownership.

Move known parent-local groups into that child.
Move known split groups together rather than assembling their cache policy in the parent.
Exposing only one group is valid.
The rule applies to application object entries, not every object with matching property names.

## Analysis limits

Passing this rule does not prove runtime invalidation correctness.
Review and behavior tests must check which reads a mutation invalidates, callback behavior and cache lifetimes.

The rule follows static local bindings and literal property names.
Opaque calls, runtime-computed properties, mutable aliases and unresolved external values have unknown provenance.
Unknown provenance does not receive a speculative ownership finding.
Opaque spreads or computed keys can override earlier properties, so those earlier properties no longer establish provenance.
A known parent-local group remains invalid when both groups are exposed, even if the other group is opaque.
Binding and member-alias cycles terminate without guessing an owner.
The rule does not inspect a child's runtime construction or follow arbitrary re-export chains to prove where its data originated.

Enable this rule with the recommended configuration or set `deep-modules/query-options-owner` to `"error"`.
