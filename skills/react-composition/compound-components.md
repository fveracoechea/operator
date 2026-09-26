# A component of several parts

The parts of one component share state, and prop drilling through a frame that does not use the state is the wrong way to give it to them.
Put the state in a provider, read it from a context in each part, and export the parts as one object.

The provider is the only place that knows where the state comes from.
The parts read an interface, so a second provider gives the same parts a different source with no change to them.

## Give the context three fields: `state`, `actions` and `meta`

Always the same three, so a second provider has a contract to satisfy.
`state` is what the parts read, `actions` is what they call, and `meta` is what they need but do not display, such as a ref.

```tsx
type TaskDraft = {
  title: string
  notes: string
}

type TaskPanelContextValue = {
  state: {draft: TaskDraft; isSaving: boolean}
  actions: {
    update: (change: Partial<TaskDraft>) => void
    save: () => void
  }
  meta: {titleRef: React.RefObject<HTMLInputElement | null>}
}

const TaskPanelContext = createContext<TaskPanelContextValue | null>(null)
```

## Throw from the provider hook, and name the provider in the message

Without it a part that a caller puts outside the provider reads `null` and fails on a property that is far from the cause.
The caller placed the part, so the caller can move it.

```tsx
function useTaskPanel() {
  const value = use(TaskPanelContext)
  if (!value)
    throw new Error('A TaskPanel part must be inside a TaskPanel provider.')
  return value
}
```

## Read a context with `use()`, not `useContext()`

`use()` also runs inside a condition, and the provider element is the context itself, with no `.Provider`.

```tsx
// Correct. use() reads the context, and it may run inside a condition.
const value = use(TaskPanelContext)

// Correct. The context itself is the provider element, with no .Provider.
function TaskPanelProvider({children}: {children: React.ReactNode}) {
  return <TaskPanelContext value={contextValue}>{children}</TaskPanelContext>
}
```

## Let each part read the context, and take no shared state as a prop

A part that takes the shared state as a prop puts the frame back in the middle.
Each part reads the context and renders one thing.

```tsx
function TaskPanelFrame({children}: {children: React.ReactNode}) {
  return <section>{children}</section>
}

function TaskPanelTitleInput() {
  const {state, actions, meta} = useTaskPanel()
  return (
    <input
      ref={meta.titleRef}
      value={state.draft.title}
      onChange={event => actions.update({title: event.target.value})}
    />
  )
}

function TaskPanelSave() {
  const {state, actions} = useTaskPanel()
  return (
    <button type="button" disabled={state.isSaving} onClick={actions.save}>
      Save
    </button>
  )
}
```

## Export the parts as one object

One import brings the whole set, and the `TaskPanel.` prefix at the call site says which set a part belongs to.

```tsx
export const TaskPanel = {
  Frame: TaskPanelFrame,
  TitleInput: TaskPanelTitleInput,
  Save: TaskPanelSave,
}
```

## Call `useState`, a Query hook or a store in the provider only

No part can then tell which one feeds it, so you swap the provider and the parts stay as they are.
A new task holds a draft in local state.
An existing task reads the server through Query.
The parts are the same in both.

```tsx
function NewTaskProvider({children}: {children: React.ReactNode}) {
  const [draft, setDraft] = useState<TaskDraft>({title: '', notes: ''})
  const titleRef = useRef<HTMLInputElement>(null)
  // Query owns the server call. See the tanstack-tools skill.
  const create = useMutation(createTaskOptions())

  return (
    <TaskPanelContext
      value={{
        state: {draft, isSaving: create.isPending},
        actions: {
          update: change => setDraft(prev => ({...prev, ...change})),
          save: () => create.mutate(draft),
        },
        meta: {titleRef},
      }}
    >
      {children}
    </TaskPanelContext>
  )
}

function EditTaskProvider({
  taskId,
  children,
}: {
  taskId: string
  children: React.ReactNode
}) {
  const {draft, update} = useTaskDraft(taskId)
  const titleRef = useRef<HTMLInputElement>(null)
  const save = useMutation(saveTaskOptions(taskId))

  return (
    <TaskPanelContext
      value={{
        state: {draft, isSaving: save.isPending},
        actions: {update, save: () => save.mutate(draft)},
        meta: {titleRef},
      }}
    >
      {children}
    </TaskPanelContext>
  )
}
```

## Put a sibling that shares the state inside the provider

The provider is the boundary, not the visual nesting, so a part works anywhere inside it and does not have to sit inside the frame.

```tsx
function EditTaskDialog({taskId}: {taskId: string}) {
  return (
    <EditTaskProvider taskId={taskId}>
      <Dialog>
        <TaskPanel.Frame>
          <TaskPanel.TitleInput />
          <TaskPanel.NotesInput />
        </TaskPanel.Frame>
        <TaskDiff />
        <Dialog.Actions>
          <TaskPanel.Save />
        </Dialog.Actions>
      </Dialog>
    </EditTaskProvider>
  )
}
```

`TaskPanel.Save` is in the dialog actions and `TaskDiff` is beside the frame, and both read the same state.

Two workarounds mean the state is in the wrong place.
Lift it into the provider instead.

```tsx
// Incorrect. An effect copies the child state up on every keystroke.
function EditTaskDialog() {
  const [title, setTitle] = useState('')
  return (
    <Dialog>
      <TaskPanel onTitleChange={setTitle} />
      <TaskDiff title={title} />
    </Dialog>
  )
}

// Incorrect. A ref hides the current state from the render.
function EditTaskDialog() {
  const draftRef = useRef<TaskDraft>(null)
  return (
    <Dialog>
      <TaskPanel draftRef={draftRef} />
      <SaveButton onClick={() => save(draftRef.current)} />
    </Dialog>
  )
}
```

## Wrap no more of the tree than the parts

The context value is a new object on each render of the provider, so every part renders again when the provider does.
A provider that wraps the whole route renders the whole route.

## Steps

1. Write the context type with `state`, `actions` and `meta`, and the hook that throws when the provider is missing.
2. Cut the component into parts, and let each part read the hook.
3. Move the state and the server calls into a provider component.
4. Put the provider where every part is inside it, and no more of the tree than that.
5. Export the parts as one object, and delete the props that carried the shared state.
