# Create a TanStack route

## Add the Vite plugin before the first route, and edit only the route files

`tanstackRouter({autoCodeSplitting: true})` from `@tanstack/router-plugin/vite`, or `tanstackStart()`, which carries it with splitting on by default, compiles the routes directory into the route tree and splits every route.
A route file exports `Route = createFileRoute('<path>')({...})`, and the plugin fills in the types once the file exists.
Every rule in this file assumes the plugin.
Router also runs without Vite, on code-based routes or the CLI generator, and there the tree and the splitting are hand work; add the plugin instead.

## Use `createRootRoute` in `__root.tsx` only

Every other route file uses `createFileRoute`.

## Leave code splitting to the plugin

Automatic code splitting is on, so every `createFileRoute` route is already split.
A `createLazyFileRoute` or `.lazy.tsx` file predates that and adds nothing.

## Mirror the URL tree with one folder per segment

In a segment folder each file name has a fixed role:

| File                      | Route it creates     | Use for                                                                                                                                        |
| ------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `route.tsx`               | layout at `/segment` | shared chrome plus `<Outlet />` that renders on every child path, for example tabs or a shell. Add one **only** when a segment wraps children. |
| `index.tsx`               | `/segment/` exactly  | the landing content of the segment, or a `redirect` to a default child                                                                         |
| `<name>.tsx`              | `/segment/<name>`    | a leaf page in the segment, with no children                                                                                                   |
| `<name>/`                 | nests deeper         | a child segment, where you repeat the pattern                                                                                                  |
| `$param.tsx`              | `/segment/:param`    | a dynamic **leaf** (`Route.useParams()`, or `params` in the loader)                                                                            |
| `$param/`                 | `/segment/:param/*`  | a dynamic segment that has children (`$param/route.tsx` plus children)                                                                         |
| `_layout/`                | (no URL segment)     | a **pathless** layout: `_layout/route.tsx` wraps `_layout/<child>.tsx` to share UI without a path segment                                      |
| `-<name>/`, `-<name>.tsx` | **not a route**      | route-scoped helpers, which the `-` prefix keeps out of the tree                                                                               |

A leaf is a file, `<name>.tsx` or `index.tsx`.
A folder with `route.tsx` exists only when a segment wraps its children in a shared layout.

Worked examples:

```
routes/
  __root.tsx                 createRootRoute, the app shell
  index.tsx                  /
  settings.tsx               /settings                 (leaf)
  posts/
    route.tsx                /posts        layout with <Outlet />
    index.tsx                /posts                     (the list)
    $postId.tsx              /posts/:postId             (dynamic leaf)
  _authed/                   pathless, no URL segment
    route.tsx                shared auth gate + <Outlet />
    profile.tsx              /profile      (rendered inside _authed)
```

### Co-locate a route's helpers behind a `-` prefix

What one route alone imports (a table, its columns, a sub-component) goes in a `-` prefixed sibling; the `-` keeps it out of the tree.
Move it out when a second route needs it.

## Name a nested route by its folders, not by dots

A dot-route packs the URL into one file name (`posts.$postId.tsx`, or `foo_.bar.tsx` to un-nest from the parent layout), which hides the hierarchy from the folder tree and leaves helpers nowhere to sit.
Every case has a folder form:

| Flat dot-route      | Semantic folder     |
| ------------------- | ------------------- |
| `posts.index.tsx`   | `posts/index.tsx`   |
| `posts.$postId.tsx` | `posts/$postId.tsx` |
| `foo_.bar.tsx`      | `foo/bar.tsx`       |
| `a_.b.c.tsx`        | `a/b/c.tsx`         |

The mark is a `.` or trailing `_` between segments in one name.
`settings.tsx` and `posts/$postId.tsx` are plain leaves.

Leave existing dot-routes in place and add no more; migrating them is its own task.

## Finish in the neighbouring files

A search param the route reads or writes: [router-query-params.md](router-query-params.md).
On a Start app, the route's SSR mode and loader: [start-routes-and-ssr.md](start-routes-and-ssr.md).
