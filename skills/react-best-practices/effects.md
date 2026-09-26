# An effect, or state that mirrors a prop

An effect runs after the render that schedules it.
So it adds a second render pass, a second source of truth, and a cleanup that the next person must keep correct.
Most effects in a client side application are not necessary.

Work down these five statements in order, and stop at the first one that applies.
An effect that survives all five is a real effect, and the sixth statement says how to write it.

## 1. Derive during render

A value you can compute from props and state is not state.

Incorrect.
The list is stored twice, and the first paint shows the stale copy.

```tsx
function TaskList({tasks, filter}: {tasks: Task[]; filter: string}) {
  const [visible, setVisible] = useState<Task[]>([])
  useEffect(() => {
    setVisible(tasks.filter(task => task.title.includes(filter)))
  }, [tasks, filter])
  return <List tasks={visible} />
}
```

Correct.
One source of truth, and one render.

```tsx
function TaskList({tasks, filter}: {tasks: Task[]; filter: string}) {
  const visible = tasks.filter(task => task.title.includes(filter))
  return <List tasks={visible} />
}
```

The React Compiler memoises `visible` for you, so an expensive derivation needs no hand-rolled `useMemo`.

State that must start again when a prop changes is a change of identity, not a change of value, so give the subtree a new `key` and delete the effect.

```tsx
// Incorrect. The draft is cleared one render after the new task is shown.
useEffect(() => setDraft(''), [taskId])
// Correct. A new key gives the subtree a new identity, and its state starts fresh.
<TaskEditor key={taskId} taskId={taskId} />
```

## 2. Interaction logic lives in the event handler

An effect that watches state a click has just set is a click handler written backwards.
Put the logic where the interaction is, even if the state must lift up to reach it, because lifting state is cheaper to maintain than an effect that copies it.
A mutation, a POST and the callback of the parent all fire from the handler, since the interaction causes them and not a value changing.

Incorrect.
The effect fires on every reason `task` can change, including a refetch.

```tsx
function TaskForm({onCreated}: {onCreated: (task: Task) => void}) {
  const [task, setTask] = useState<Task | null>(null)
  useEffect(() => {
    if (task) onCreated(task)
  }, [task, onCreated])
  return <button onClick={() => setTask(buildTask())}>Create</button>
}
```

Correct.
The handler builds the task, sends it, and tells the parent.

```tsx
function TaskForm({onCreated}: {onCreated: (task: Task) => void}) {
  const {mutate} = useCreateTask()
  return (
    <button onClick={() => mutate(buildTask(), {onSuccess: onCreated})}>
      Create
    </button>
  )
}
```

## 3. Data comes from TanStack Query

Never fetch in an effect: it has no cache, no deduplication, no retry, and a race the cleanup cannot win.

```tsx
// Correct. The route loader warms the cache, and the component reads it.
const {data: task} = useSuspenseQuery(taskOptions(taskId))
```

## 4. Read the world outside React with `useSyncExternalStore`

A browser event or a store React does not own is a subscription, not an effect plus a `useState`.
Write the store once, at module scope, and every component that calls the hook shares the one listener.

```tsx
function subscribeToViewport(onChange: () => void) {
  globalThis.addEventListener('resize', onChange)
  return () => globalThis.removeEventListener('resize', onChange)
}

function getViewportWidth() {
  return globalThis.innerWidth
}
export function useViewportWidth() {
  return useSyncExternalStore(subscribeToViewport, getViewportWidth)
}
```

A `wheel` or a `touch` listener is passive, so the browser scrolls without waiting for the handler.

```tsx
element.addEventListener('wheel', onWheel, {passive: true})
```

## 5. Run once per app, at module scope

A component can unmount and mount again, so `useEffect(fn, [])` is not "once".

```tsx
// Incorrect, in a component. A second mount starts the client twice.
useEffect(() => analytics.start(), [])
// Correct, in src/main.tsx. The module body runs once.
analytics.start()
```

## 6. A real effect takes a named function declaration

An effect that reaches this line synchronises with something outside React, so give it a name that says with what.
Two benefits, and only two: the stack frame is labelled when the body throws synchronously, and the React DevTools Components panel shows the name.

An effect that must read a fresh value without running again reads it through `useEffectEvent`, and not through a ref.

```tsx
// Incorrect. A ref that mirrors a prop is the workaround from before useEffectEvent.
const themeRef = useRef(theme)
themeRef.current = theme

// Correct. The effect event always reads the latest render.
const onConnected = useEffectEvent(() => log(theme))

useEffect(
  function connectToRoom() {
    const conn = connect(roomId)
    conn.on('connected', onConnected)
    return () => conn.close()
  },
  [roomId]
)
```
