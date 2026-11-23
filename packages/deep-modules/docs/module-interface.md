# Fix `deep-modules/module-interface`

At an application object entry, export one named PascalCase object.
Expose operations and selected internal groups as its properties.
Keep caller-facing types and meaningful data constants alongside it.

```ts
import { play } from "./play";
import * as selectors from "./selectors/main";
import { MovieScreen } from "./ui/main";

export type MovieId = string;
export const MOVIE_TIMEOUT = 500;
export const Defaults = { autoplay: false };
export const GENRES = ["drama", "comedy"];
export const Movie = {
  play,
  selectors,
  UI: { Screen: MovieScreen },
};
```

Methods, function references, shorthand properties and nested groups are valid.
Neither freezing nor `as const` is required.
Parentheses, assertions, non-null assertions and `satisfies` do not change the classification.
Data-only objects and arrays remain constants, not additional operation interfaces.
An interface can itself contain only data.

Move a standalone function onto the object:

```ts
function play() {}
export const Movie = { play };
```

Exported function declarations, arrow functions, function expressions and known local callable aliases fail.
Local export specifiers receive the same check.
Default exports and wildcard exports are not named application interface objects.
Use one application interface rather than several operation objects.

The check follows local bindings and guards binding cycles.
It does not infer imported values or the return types of calls.
Opaque imported, computed and call-initialized constants receive no speculative callable finding.
Passing lint does not prove that an opaque constant is non-callable or that a module is deep.

Internal sub-module entries can use object or curated named-function exports.
Schemas, framework server-function entries and ownerless library functions keep their named exports.
The rule does not require an object entry to exist for a server-function-only module.
It checks configured existing object entries, not missing files.
The pinned no-barrel rule remains enabled in the Movie command fixtures without an entry exception.

## Compose and promote capabilities

Movie can own an internal Media object, a selector namespace, UI and one query-options owner:

```ts
import { Media } from "./media/main";
import * as selectors from "./selectors/main";
import { queryOptions, mutationOptions } from "./query-options/main";
import * as UI from "./ui/main";

export const Movie = {
  async play(id: string) {
    const video = await Media.find(id);
    return Media.play(video);
  },
  selector: selectors,
  queryOptions,
  mutationOptions,
  UI,
};
```

Internal Media can export its object. Selectors can export named predicates and projections.
Curated named exports and `export * as Cast` remain compatible with pinned `oxc/no-barrel-file`.
Each internal entry has its own corresponding behavior beside-test.
Other top-level features cannot import Movie's internal Media entry.

When TvShows also needs Media, promote Media into a sibling top-level module.
Movie and TvShows then import `../media/main`, not Movie's private child.
Keep the Media interface and its behavior tests together during promotion.
The packed acceptance test checks both layouts before and after this move.

For an invalid-configuration finding, correct the `settings["deep-modules"]` object.
See the [configuration contract](../README.md#consumer-configuration).
Paths resolve from the consumer command's working directory and its configured project root.
