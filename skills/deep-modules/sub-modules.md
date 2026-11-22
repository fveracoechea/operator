# Split a module into sub-modules

A sub-module is a folder inside a feature or capability that owns a cohesive part of its behavior.
It provides an internal seam without making outside callers learn the module's parts.
A sub-module can be a deep module in its own right; nesting describes its current ownership, not lesser depth.

## Give every sub-module an entry file and its test

Use `main.ts` and `main.test.ts`, including for selectors, query options and UI.
A server-only entry uses `main.server.ts` with `main.server.test.ts`.
Other implementation files remain private and can have focused beside-tests.

```text
modules/movies/
  main.ts
  main.test.ts
  schemas.ts
  media/
    main.ts
    main.test.ts
  selectors/
    main.ts
    main.test.ts
  query-options/
    main.ts
    main.test.ts
  ui/
    main.ts
    main.test.ts
```

The parent and sibling sub-modules import only these entry files.
Imports point downward; a sub-module never imports the parent's interface object.
It may parse the parent's schemas or use a sibling through that sibling's entry file.

## Choose an object or namespace for the internal seam

A cohesive behavior such as `Media` can use an explicit object interface.
A set of selectors can export named functions, consumed through `import * as selectors from './selectors/main'`.
Named function exports are also valid for a single-consumer internal sub-module.
Reuse is a reason to consider an object, not a threshold that requires one.
Tests do not count as another production consumer.

The entry file deliberately defines the internal interface.
Neither choice permits imports from private implementation files.

## Let the parent expose selected capabilities and hide the rest

```ts
// movies/main.ts
import {Media} from './media/main'
import * as selectors from './selectors/main'
import {queryOptions, mutationOptions} from './query-options/main'
import * as UI from './ui/main'

export const MOVIE_TIMEOUT = 500

export const Movie = {
  async play(id: string) {
    const video = await Media.find(id)
    return Media.play(video)
  },
  selector: selectors,
  queryOptions,
  mutationOptions,
  UI,
}
```

Callers use `Movie.play(id)` without knowing `Media` exists.
The parent owns that orchestration rather than exposing `find` and `play` as steps for every caller.
Selected capabilities remain reachable as `Movie.selector.isReleased`, `Movie.queryOptions.findOne`, `Movie.mutationOptions.publish`, and `Movie.UI.Carousel`.
Outside callers never import `movies/media/main` or `movies/selectors/main` directly.

## Keep selectors pure and named for domain rules

A selector is a named, tested function that transforms or scopes domain data.
Selectors are synchronous, perform no IO and leave their inputs unchanged.
They can return a predicate or projection function when the caller supplies a parameter.

```ts
// movies/selectors/main.ts
import type {MovieSummary, Person} from '../schemas'

export function isReleased(movie: MovieSummary) {
  return movie.status === 'released'
}

export function budgetIsBiggerThan(minimum: number) {
  return function hasBudget(movie: MovieSummary) {
    return movie.budget > minimum
  }
}

export function toCast(predicate: (person: Person) => boolean) {
  return function selectCast(movie: MovieSummary) {
    return movie.cast.filter(predicate)
  }
}
```

Callers can use `movies.filter(Movie.selector.isReleased)` or `movies.filter(Movie.selector.budgetIsBiggerThan(5_000_000))`.
`movies.flatMap(Movie.selector.toCast(person => person.age > 21))` returns the matching cast members.
Keep these rules independent of UI and storage.
For Query's `select` integration, use the `tanstack-tools` topic [query-select.md](../tanstack-tools/query-select.md).

## Keep query and mutation options in one owning sub-module

`query-options/main.ts` can export both `queryOptions` and `mutationOptions`.
Expose them separately on the parent's object while keeping their implementation in the same sub-module.
That sub-module owns shared query keys, cache policy, and the knowledge of which reads a mutation invalidates.
Callers use `useQuery(Movie.queryOptions.findOne({id}))` and `useMutation(Movie.mutationOptions.publish({id}))`.
Callers do not assemble invalidation keys.

For builder and callback details, use the `tanstack-tools` topic [query-mutations.md](../tanstack-tools/query-mutations.md).

## Promote a sub-module when another feature needs its behavior

`Media` can belong privately to `Movie` while movies are its only feature consumer.
If `TvShows` later needs that same media behavior, extract it into `src/modules/media/`.
It becomes a shared capability with its own `Media` object, public entry file and tests.
Both `Movie` and `TvShows` then import that entry rather than reaching into each other's private folders.

Keep the playback policy and implementation together in `Media` during the move.
The existing internal seam makes that extraction possible without duplicating its logic across features.
Until the second feature needs it, keep its current ownership rather than building a speculative shared module.

## Add a sub-module when a group of files hides something

Without `media/`, playback callers learn the asset lookup, format selection and playback protocol.
With it, those decisions stay behind `Media`, and changes to playback remain local.
That is the deletion test in [interface-design.md](interface-design.md), one level down.

A feature's selector or query-options sub-module centralizes rules about that feature's data.
A cross-feature folder that merely sorts unrelated functions by technical role hides no such knowledge.

## Test the chosen internal interface

`main.test.ts` calls the sub-module's object or named exports, whichever production uses.
Selector tests assert concrete transformations, predicates and unchanged inputs.
A test of `Movie` runs `Media`, selectors and the other internal sub-modules real.
[module-tests.md](module-tests.md) owns collaborator fakes and focused private-function tests.
