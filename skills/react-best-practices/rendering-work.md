# A component that renders more than it should

The React Compiler memoises the values and the components you write, so a wasted render here is not a missing `useMemo`.
It is a decision the compiler cannot make for you: what a component subscribes to, when an update is urgent, and what stays mounted while it is hidden.
The two remaining statements are about the work one render does, and the shape it returns.

## 1. Subscribe to the narrowest thing you read

A component renders when a value it subscribes to changes.
So subscribe to the value you read, and not to the object that holds it.

Incorrect.
The toolbar renders on every keystroke, and it reads the draft only when the user clicks.

```tsx
function ClearButton() {
  const [draft, setDraft] = useAtom(draftAtom)
  return <button onClick={() => setDraft('')}>Clear ({draft.length})</button>
}
```

Correct.
A setter is not a subscription.

```tsx
function ClearButton() {
  const setDraft = useSetAtom(draftAtom)
  return <button onClick={() => setDraft('')}>Clear</button>
}
```

The same holds for a value you narrow.
Subscribe to the derived boolean, so the component renders when the answer changes and not when the list does.

```tsx
// Incorrect. Every field of every task renders this badge again.
const tasks = useAtomValue(taskListAtom)
const hasOverdue = tasks.some(task => task.isOverdue)

// Correct.
const hasOverdue = useAtomValue(hasOverdueAtom)
```

A value that changes every frame and never reaches the JSX is not state at all.

```tsx
// Correct. The pointer position drives a measurement, not a render.
const lastPointerX = useRef(0)
```

## 2. Pass a function to `useState`, to build the initial value and to update it

Incorrect.
`buildIndex(items)` runs on every render, and React throws the result away after the first one.

```tsx
const [index, setIndex] = useState(buildIndex(items))
```

Correct.
The function form runs once, when the state is created.

```tsx
const [index, setIndex] = useState(() => buildIndex(items))
```

An update that reads the previous value takes the function form too.
Two calls in one batch both see the current value, so the count below ends at 1.

```tsx
// Incorrect.
setCount(count + 1)
setCount(count + 1)

// Correct. The count ends at 2.
setCount(previous => previous + 1)
setCount(previous => previous + 1)
```

This is correctness inside a batch, and not a memoisation trick.

## 3. Stay responsive with the two deferral primitives

An update that the user does not wait for is not urgent, and it must not block the one the user does wait for.

Incorrect.
The typed character waits for the whole result list to render, and the flag is hand-rolled.

```tsx
const [isFiltering, setIsFiltering] = useState(false)

function handleChange(value: string) {
  setIsFiltering(true)
  setQuery(value)
  setIsFiltering(false)
}
```

Correct.
The input updates first, and `isPending` comes from the transition.

```tsx
const [isPending, startTransition] = useTransition()

function handleChange(value: string) {
  setInput(value)
  startTransition(() => setQuery(value))
}
```

When the fast-changing value is a prop or a state you do not own, defer the render instead of the update.

```tsx
// Correct. The input stays sharp, and the heavy list renders one step behind.
const deferredQuery = useDeferredValue(query)
return <ResultList query={deferredQuery} />
```

## 4. Hide with `<Activity>`, do not unmount

A conditional unmount throws away the state, the scroll position and the DOM of the subtree.

```tsx
// Incorrect. The panel forgets everything each time the tab changes.
return tab === 'preview' ? <PreviewPanel /> : null

// Correct. The panel keeps its state, and it does no work while hidden.
return (
  <Activity mode={tab === 'preview' ? 'visible' : 'hidden'}>
    <PreviewPanel />
  </Activity>
)
```

## 5. Keep the conditional out of the JSX

JSX is the shape of the output, so a decision inside it hides the shape.
Lift the decision into an early return, a named variable or a helper, and use a ternary where one has to stay.

Incorrect.
Two states and an operator that renders a number.

```tsx
return (
  <section>
    {isLoading && <Spinner />}
    {items.length && <ItemList items={items} />}
  </section>
)
```

Correct.
The decisions are above the JSX, and the operator is gone.

```tsx
if (isLoading) return <Spinner />

return (
  <section>
    {items.length > 0 ? <ItemList items={items} /> : <EmptyState />}
  </section>
)
```

Use a ternary, never `&&`.
`items.length && <ItemList/>` renders the `0` when the list is empty, because React renders the number.
