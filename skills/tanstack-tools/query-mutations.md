# Let a mutation own its cache work

A mutation invalidates or writes the queries it makes stale, and it already holds everything it needs.
**Every mutation callback receives a `MutationFunctionContext`**, `{client, meta, mutationKey}`.
`client` is the QueryClient the mutation was built against, the one `useQueryClient()` returns.

## Read the `QueryClient` off the mutation context

The context is the **last** argument of a lifecycle callback, and the **second** argument of the two that take variables:

| Callback     | Signature                                           |
| ------------ | --------------------------------------------------- |
| `mutationFn` | `(variables, context)`                              |
| `onMutate`   | `(variables, context)`                              |
| `onSuccess`  | `(data, variables, onMutateResult, context)`        |
| `onError`    | `(error, variables, onMutateResult, context)`       |
| `onSettled`  | `(data, error, variables, onMutateResult, context)` |

Destructure `{client}` off it, and prefix each positional argument you skip with `_`:

```ts
settings: {
  put() {
    return mutationOptions({
      mutationFn: async (vars: {agentKey: string; body: SettingsInput}) =>
        api.putSettings(vars.agentKey, vars.body),
      onSuccess: async (_data, vars, _onMutate, {client}) =>
        client.invalidateQueries({
          queryKey: ['insights', 'settings', vars.agentKey],
        }),
    })
  },
}
```

The call site is then the factory alone, with no `useQueryClient()` and no import:

```tsx
const save = useMutation($.insights.settings.put())
```

## Give a mutation-options factory only the operation's inputs

Its parameters are what the operation varies on, an id or a scope.
The cache is not one of them, because the callbacks already hold `client`, and a `queryClient` parameter would cost every consumer a `useQueryClient()` call for nothing.

## Keep `useQueryClient()` in a component for direct cache work

The hook is for `setQueryData`, `getQueryData` and an `invalidateQueries` outside a mutation.
Delete it when a mutation was its only consumer.

## Take `context.queryClient` in a route loader

`beforeLoad` and `loader` get the client from the router, and a helper they call may take a `QueryClient` parameter, because there is no mutation context there.
That is the one place a `QueryClient` travels as an argument.

## Order the cache work in `onSuccess`

A read in flight lands after your write and overwrites it with stale data.
Cancel, write, then invalidate:

```ts
onSuccess: ({turn}, variables, _onMutate, {client}) => {
  const {queryKey} = conversations.messages(variables.threadId)
  void client.cancelQueries({queryKey})
  client.setQueryData(queryKey, previous => appendTurn(previous, turn.messages))
  void client.invalidateQueries({queryKey: THREADS_KEY})
}
```

Do not await the `invalidateQueries`: the mutation would stay pending through the refetch and hold the optimistic rows on screen past the write.

## Set `retry: false` on a mutation that is not idempotent

A retried POST that already persisted its row persists a second one.
Set `retry: false` on any mutation whose replay duplicates data.
A streamed turn is a mutation for the same reason: a query re-sends it on every remount, focus and invalidation.

## Assert the invalidation, not that the mutation resolves

A test that only awaits the mutation misses a `ctx.client` wired to the wrong cache.
Read, write, read on one client; with `staleTime: Infinity` the third request can only come from the invalidation:

```ts
const client = new QueryClient({
  defaultOptions: {queries: {retry: false, staleTime: Infinity}},
})
const read = $.insights.settings.get(agentKey)

await client.query(read)
await client.query(read) // cached, no request
await runMutation(client, $.insights.settings.put(), {agentKey, body: settings})
await client.query(read) // invalidated, requests again
```

Confirm that the test can fail: delete the `onSuccess` invalidation, and it must go red.
`getMutationCache().build(queryClient, options)` supplies `ctx.client`, so a helper built on a real client needs no change.
