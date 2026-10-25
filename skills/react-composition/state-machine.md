# Parts that share state with phases

When the parts of a compound share state with phases, such as closed and open, or running and failed, that state is a state machine.
This topic adds what a machine changes in a compound, so read [compound-components.md](compound-components.md) first.

The general machine rules are when state is a machine, and how to write its states, its events and its transition function.
They go in the project's code style document, such as `CODE_STYLE.md`.
This topic does not repeat them.

## Run a state machine in the provider

The provider is the only place that runs the machine.
The context is the machine's interface to the parts:

- `state` is the machine's state union, plus the values that the provider reads from Query.
- `actions` are named operations that send events, or that run the machine's actions.
- `meta` holds refs, and never machine state.

```tsx
type FindState =
  | {status: 'closed'}
  | {status: 'open'; query: string; current: number; count: number}

type FindContextValue = {
  state: FindState
  actions: {
    open: () => void
    close: () => void
    changeQuery: (query: string) => void
    step: (delta: number) => void
    reportCount: (count: number) => void
  }
  meta: {fieldRef: React.RefObject<HTMLInputElement | null>}
}

function FindProvider({children}: {children: React.ReactNode}) {
  // findTransition is the machine. The code style document says how to write it.
  const [state, send] = useReducer(findTransition, {status: 'closed'})
  const fieldRef = useRef<HTMLInputElement>(null)

  return (
    <FindContext
      value={{
        state,
        actions: {
          open: () => send({type: 'opened'}),
          close: () => send({type: 'closed'}),
          changeQuery: query => send({type: 'queryChanged', query}),
          step: delta => send({type: 'stepped', delta}),
          reportCount: count => send({type: 'counted', count}),
        },
        meta: {fieldRef},
      }}
    >
      {children}
    </FindContext>
  )
}

function FindField() {
  const {state, actions, meta} = useFind()
  switch (state.status) {
    case 'closed':
      return null
    case 'open':
      return (
        <>
          <input
            ref={meta.fieldRef}
            value={state.query}
            onChange={event => actions.changeQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') actions.step(event.shiftKey ? -1 : 1)
            }}
          />
          <span>
            {state.count > 0
              ? `${state.current + 1} of ${state.count}`
              : 'No results'}
          </span>
        </>
      )
  }
}

function FindShortcut() {
  const {state, actions, meta} = useFind()
  const onFindKey = useEffectEvent(() => {
    if (state.status === 'open') meta.fieldRef.current?.focus()
    else actions.open()
  })

  useEffect(function listenForFindKey() {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'f' || !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      onFindKey()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return null
}

/** The search props of the document viewer, which counts the matches. */
function useFindViewer() {
  const {state, actions} = useFind()
  switch (state.status) {
    case 'closed':
      return {
        query: undefined,
        current: undefined,
        onCount: actions.reportCount,
      }
    case 'open':
      return {
        query: state.query,
        current: state.current,
        onCount: actions.reportCount,
      }
  }
}

function DocumentViewer({file}: {file: DocumentFile}) {
  return <Viewer file={file} {...Find.useViewer()} />
}

function DocumentPage({file}: {file: DocumentFile}) {
  return (
    <FindProvider>
      <PageBar>
        <Find.Field />
      </PageBar>
      <Find.Shortcut />
      <DocumentViewer file={file} />
    </FindProvider>
  )
}
```

## Give no part `send`

The parts call the named operations in `actions`.
So a second provider can fill the same context from another source, and no part changes.

## Give each value one home, and no `useState` beside the machine

A value that belongs to a machine state lives in that state.
Query data and a mutation's pending and error state stay in Query.
The provider passes them in `state` beside the machine state, and the machine holds no copy.

## Narrow on `status`, then read only that state's fields

`FindField` and `useFindViewer` switch on `state.status`.
Only the `open` branch reads `query`, `current` and `count`, because the closed state has no such fields.

## Let the parent only place the provider

A parent above the provider that runs the machine is a misplaced machine.
It renders the whole page on each event, and gives `send` to the parts.
Move the machine into the provider.

```tsx
// Incorrect. A parent above the provider runs the machine and passes send down.
function DocumentPage({file}: {file: DocumentFile}) {
  const [find, send] = useReducer(findTransition, {status: 'closed'})
  return (
    <FindProvider state={find} send={send}>
      <PageBar />
      <DocumentViewer file={file} />
    </FindProvider>
  )
}
```

## Run no second `useReducer` in a part for the same state

A part that runs the machine for state that another part reads is also a misplaced machine.
The other parts cannot see that state, and a second copy of it drifts from the first.
Move the machine into the provider.

```tsx
// Incorrect. The field runs the machine, so useFindViewer cannot read the query.
function FindField() {
  const [state, send] = useReducer(findTransition, {status: 'closed'})
  // ...
}
```
