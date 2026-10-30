# Parts that share state with phases

When the parts of a compound share state with phases, such as closed and open, or running and failed, that state is a state machine.
This topic adds what a machine changes in a compound, so read [compound-components.md](compound-components.md) first.

The general machine rules are when state is a machine, and how to write its states, its events and its transition function.
They are in the project's code style document, such as `CODE_STYLE.md`, because each project has its own machine runner.
This topic does not repeat them.

The examples are a document search: a find field in the page bar, and a viewer that counts the matches.

## Run a state machine in the provider

The provider is the only place that runs the machine.
The context is the machine's interface to the parts:

- `state` is the machine's state union, plus the values that the provider reads from Query.
- `actions` are named operations that send events.
- `meta` holds refs, and never machine state.

```tsx
type SearchState =
  | {status: 'closed'}
  | {status: 'open'; query: string; current: number; count: number}

function DocumentSearchProvider({
  file,
  children,
}: {
  file: DocumentFile
  children: ReactNode
}) {
  // Run the machine with the repo's machine runner. useReducer stands in for it here.
  const [search, send] = useReducer(searchTransition, {status: 'closed'})
  const {data: textLayer} = useSuspenseQuery(textLayerOptions(file.id))
  const fieldRef = useRef<HTMLInputElement>(null)

  return (
    <DocumentSearchContext
      value={{
        state: {...search, searchable: textLayer.hasText},
        actions: {
          open: () => send({type: 'opened'}),
          close: () => send({type: 'closed'}),
          changeQuery: query => send({type: 'queryChanged', query}),
          step: direction => send({type: 'stepped', direction}),
          reportCount: count => send({type: 'counted', count}),
        },
        meta: {fieldRef},
      }}
    >
      {children}
    </DocumentSearchContext>
  )
}
```

## Give no part `send`

The parts call the named operations in `actions`.
A second provider can then fill the same context from another source, and no part changes.

```tsx
// A story fills the context with a fixed state, and SearchField renders it as it is.
<DocumentSearchContext
  value={{state: openWithMatches, actions: noActions, meta}}
>
  <SearchField />
</DocumentSearchContext>
```

## Let the transition refuse an event, not the part

The transition decides what each event does in each status.
A part calls an action with no check that the status accepts it.
A part reads the status only to choose what it renders, or which action it calls.

## Give each value one home, and no `useState` beside the machine

A value that belongs to a machine state lives in that state.
Query data and a mutation's pending and error state stay in Query.
The provider passes them in `state` beside the machine state, as `searchable` above, and the machine holds no copy.
[compound-components.md](compound-components.md) shows a mutation's pending state in `state`.

## Narrow on `status`, then read only that state's fields

Only the `open` branch reads `query`, `current` and `count`, because the closed state has no such fields.

```tsx
function SearchField() {
  const {state, actions, meta} = useDocumentSearch()
  switch (state.status) {
    case 'closed':
      return null
    case 'open':
      return (
        <>
          <Input
            ref={meta.fieldRef}
            disabled={!state.searchable}
            value={state.query}
            onChange={event => actions.changeQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter')
                actions.step(event.shiftKey ? 'previous' : 'next')
            }}
          />
          <Text size="xs" numeric>
            {state.count > 0
              ? `${state.current + 1} of ${state.count}`
              : 'No results'}
          </Text>
        </>
      )
  }
}

/** The viewer's search: none while the field is closed. */
function useViewerSearch() {
  const {state, actions} = useDocumentSearch()
  switch (state.status) {
    case 'closed':
      return undefined
    case 'open':
      return {
        query: state.query,
        current: state.current,
        onCount: actions.reportCount,
      }
  }
}
```

## Let the parent only place the provider

```tsx
const DocumentSearch = {
  Provider: DocumentSearchProvider,
  Field: SearchField,
  useViewer: useViewerSearch,
}

function DocumentPage({file}: {file: DocumentFile}) {
  return (
    <DocumentSearch.Provider file={file}>
      <PageBar>
        <DocumentSearch.Field />
      </PageBar>
      <DocumentViewer file={file} />
    </DocumentSearch.Provider>
  )
}

function DocumentViewer({file}: {file: DocumentFile}) {
  return <Viewer file={file} search={DocumentSearch.useViewer()} />
}
```

A parent above the provider that runs the machine is a misplaced machine.
It renders the whole page on each event, and gives `send` to the parts.
Move the machine into the provider.

```tsx
// Incorrect. The page runs the machine and passes send down.
const [search, send] = useReducer(searchTransition, {status: 'closed'})
return (
  <DocumentSearchProvider state={search} send={send}>
    {/* ... */}
  </DocumentSearchProvider>
)
```

## Run no second machine in a part for the same state

A part that runs the machine for state that another part reads is also a misplaced machine.
The other parts cannot see that state, and a second copy of it drifts from the first.
Move the machine into the provider.

```tsx
// Incorrect. The field runs the machine, so useViewerSearch cannot read the query.
function SearchField() {
  const [state, send] = useReducer(searchTransition, {status: 'closed'})
  // ...
}
```
