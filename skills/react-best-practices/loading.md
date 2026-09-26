# Data or code that arrives later than it should

A waterfall is work that waits for work it does not need.
Each statement below removes one waterfall, and the last one keeps the code that draws the screen out of the first chunk.

## 1. Independent awaits run together

Incorrect.
The screen waits for the sum of the two requests.

```ts
const user = await fetchUser(userId)
const teams = await fetchTeams()
```

Correct.
The screen waits for the slower one.

```ts
const [user, teams] = await Promise.all([fetchUser(userId), fetchTeams()])
```

A partial dependency needs no library.
Start every request you can start now, and await the dependent one after the value it needs arrives.

```ts
// Correct. fetchTeams starts before the user arrives, and fetchPosts cannot.
const userPromise = fetchUser(userId)
const teamsPromise = fetchTeams()
const user = await userPromise
const posts = await fetchPosts(user.teamId)
const teams = await teamsPromise
```

## 2. Await inside the branch that needs the value

Incorrect.
The cheap answer is known before the request starts, and the request runs anyway.

```ts
const task = await loadTask(taskId)
if (!canEdit(user)) return null
```

Correct.
The synchronous check comes first, and the `await` moves into the branch that reads it.

```ts
if (!canEdit(user)) return null

const task = await loadTask(taskId)
if (!showComments) return {task}
return {task, comments: await loadComments(taskId)}
```

## 3. `beforeLoad` stays synchronous

The matched loaders of a route run in parallel, and `beforeLoad` runs serially from the root down.
So async work in `beforeLoad` is the one real waterfall left in a TanStack SPA: every child waits, and no loader has started.

```ts
// Incorrect. Each route in the match adds its own round trip before any loader runs.
beforeLoad: async () => ({session: await fetchSession()}),

// Correct. beforeLoad decides and redirects, and the loader does the async work.
beforeLoad: ({context}) => {
  if (!context.session) throw redirect({to: '/login'})
},
```

## 4. `loaderDeps` returns only what the loader reads

`loaderDeps` is the cache key of the loader, so a wide key reloads the route for a search param the loader never reads.

```ts
// Incorrect. Opening a tab reloads the whole page of results.
loaderDeps: ({search}) => search,

// Correct.
loaderDeps: ({search}) => ({page: search.page}),
```

## 5. A query key states every variable the query function reads

The key is what the cache compares, so it decides both what a read waits for and what it gets back.
A variable the key omits gives two different results one cache entry, so the second read returns the first result without waiting, and never fetches its own.

```ts
// Incorrect. Every filter reads the first filter's result.
queryOptions({queryKey: ['tasks'], queryFn: () => fetchTasks(filter)})

// Correct.
queryOptions({queryKey: ['tasks', filter], queryFn: () => fetchTasks(filter)})
```

## 6. One component, one suspending read

A component suspends at the first read, so a second `useSuspenseQuery` below it does not start until the first resolves.

```tsx
// Incorrect. Two round trips, one after the other.
const {data: task} = useSuspenseQuery(taskOptions(taskId))
const {data: comments} = useSuspenseQuery(commentsOptions(taskId))

// Correct. Both start together.
const [{data: task}, {data: comments}] = useSuspenseQueries({
  queries: [taskOptions(taskId), commentsOptions(taskId)],
})
```

Splitting the reads into two sibling components under their own boundaries works too, and it also lets each part paint when it is ready.

## 7. A suspending route needs a boundary, on purpose

A route that suspends with no boundary of its own blanks the nearest ancestor boundary, so the user loses a screen that was already painted.
The boundary is a `pendingComponent`, `wrapInSuspense`, or a local `<Suspense>`.

```tsx
// Correct. The route owns its pending state.
export const Route = createFileRoute('/tasks/$taskId')({
  component: TaskPage,
  pendingComponent: TaskPageSkeleton,
})
```

A spinner that flashes for 80 milliseconds is worse than no spinner, and the router owns that timing.
Set `defaultPendingMs` and `defaultPendingMinMs` on the router, rather than writing a delay into a component.

## 8. Split the code the first screen does not draw

`autoCodeSplitting` already splits the routes, so the decision left to you is a heavy leaf component.
Load it with `React.lazy` when the feature turns on.

```tsx
// Correct. The editor bundle arrives when the user opens the editor.
const MarkdownEditor = lazy(() => import('./markdown-editor'))

return isEditing ? (
  <Suspense fallback={<EditorSkeleton />}>
    <MarkdownEditor />
  </Suspense>
) : (
  <MarkdownPreview />
)
```

The import path must be a literal string.
Vite documents the constraint and does not enforce it, so `import(path)` builds and then fails as a 404 for the user.

```ts
// Incorrect. Nothing warns you, and the chunk does not exist at runtime.
const Panel = lazy(() => import(panelPath))
```
