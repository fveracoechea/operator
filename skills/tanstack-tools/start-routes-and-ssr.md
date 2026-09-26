# Routes under Start: SSR and loaders

Start runs the route tree on the server for the document request and again in the browser.
Each route's `ssr` option sets how much of it the server runs.

## Choose the SSR mode per route

Start from `ssr: 'data-only'` on the root: `beforeLoad` and the loaders run on the server, the components in the browser.
The first load ships its data with the HTML, a signed-out visitor gets an HTTP redirect before any script, and nothing hydrates.

Full SSR is per route, for a crawler or a first paint, and every component on that path then runs in both environments.
`ssr: false` is for a loader that needs a browser API, and for nothing slow: a slow read streams (next section).

## Stream a slow read through Suspense, and keep `data-only`

The router awaits every loader before the document goes out, so an awaited slow read holds the first byte under `data-only` as much as under full SSR.
Leaving SSR for that route does not remove the wait; it moves the read to after the script loads, one round trip later.

Start the read in the loader, and do not await it:

```ts
loader: ({context, params}) => {
  // Started, not awaited: the first byte goes out and the result streams in.
  void context.queryClient
    .query(strategyOptions(params.strategyId))
    .catch(() => undefined)
},
pendingComponent: StrategyPending,
```

Read it in the component with `useSuspenseQuery` on the same options.
The SSR query integration (below) streams the pending result into the browser's cache as it resolves, and the component waits on that fetch instead of starting a second one.
A failed read surfaces through `useSuspenseQuery` in the browser and reaches the route's `errorComponent`.

The `.catch` is not optional: `query()` rejects where the old `prefetchQuery` swallowed, and a floating rejection on the server is still an unhandled rejection.

The boundary is the route's `pendingComponent`, or a local `<Suspense>` around the one part that reads, so the rest of the page paints first (`react-best-practices`, loading).
Under `data-only` the browser draws that fallback, since nothing renders on the server; the gain is that the document, its scripts and the read run at the same time instead of in sequence.

## Put `beforeLoad` before `headers` and `loader` in the options object

TypeScript infers the `headers` and `loader` context from `beforeLoad`; the other order infers `never` and fails somewhere unrelated in the route.
Leave a one-line comment so nobody tidies the order.

## Gate the session in the root route's `beforeLoad`

The one session gate redirects a signed-out document request to the identity provider on the server, and navigates there itself in the browser after an app reset.

Set a handoff marker cookie on the bounce, expiring within a minute.
A visitor back with the marker and still no session is a failed handoff: the gate **fails closed** and shows the route error instead of looping.
Only the gate spends the marker.

### Give the router a `defaultErrorComponent`

A gate that fails closed renders there.
Without one, the app renders on whatever fallback identity the user query returned.

## Warm the cache in the loader, and read it in the component

The loader calls `queryClient.query(options)`, or `infiniteQuery` for pages.
It fetches when the data is older than `staleTime` and answers from the cache otherwise, so the default `staleTime` of 0 refetches on every call, and `staleTime: 'static'` never refetches, even after an invalidation (the old `ensureQueryData` behavior, a trap on a route you invalidate).

Await the call only when the loader itself needs the value, for a redirect or to pick a branch.
A value the component renders is started and not awaited, and the component suspends on it (the streaming section above).
Either way, catch it when the component has its own pending and error states:

```ts
loader: async ({context}) =>
  context.queryClient
    .infiniteQuery(strategiesOptions(args))
    .catch(() => undefined),
```

### Wire the SSR query integration once in the router factory

It dehydrates the request's `QueryClient` into the document and streams in-flight queries.
Without it the browser refetches everything on hydration.

## Keep a filter out of `loaderDeps`

The package skill puts a search param the loader reads in `loaderDeps`.
The match id hashes the deps, so a filter there makes each keystroke a new match and a full route reload.

Read the filter from `location.search` inside the loader instead.
The match stays stable, a cold filtered URL still warms its key, and the query cache, keyed on the value, carries the later changes.

## Mint per-request values in a request middleware

A request middleware runs on the document request, the same request that runs the loaders, so it mints what the root route needs per request: a CSP nonce, the facts the session gate reads.
A server-function middleware runs only for an RPC.
Register them in `createStart` and read their context from the global start context in the router factory.

## Set the document's headers in the root route

`headers()` on the root route owns the document's policy.
A per-request value reaches it through `ssr.nonce`, not a module-level variable.
