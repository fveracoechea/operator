# One component that has too many modes

A `TaskPanel` with `isCreating`, `isReadOnly` and `showComments` has eight states, and the body must handle all of them.
The caller cannot see what it gets, and the next mode doubles the count again.

Write a component for each use case, and let each one compose the parts it needs.

## Make each choice its own part, not a flag

A boolean that selects which parts render is a mode.

Incorrect.
Each flag adds a branch, and the branches multiply.

```tsx
type Props = {
  taskId?: string
  isCreating?: boolean
  isReadOnly?: boolean
  showComments?: boolean
  onSave?: () => void
}

function TaskPanel({
  taskId,
  isCreating,
  isReadOnly,
  showComments,
  onSave,
}: Props) {
  return (
    <section>
      {isReadOnly ? <TaskTitleText /> : <TaskTitleInput />}
      {isReadOnly ? <TaskNotesText /> : <TaskNotesInput />}
      {showComments ? <TaskComments taskId={taskId} /> : null}
      {isReadOnly ? null : (
        <footer>
          {isCreating ? (
            <CreateButton onSave={onSave} />
          ) : (
            <SaveButton onSave={onSave} />
          )}
        </footer>
      )}
    </section>
  )
}
```

Correct.
Each use case names itself, and the parts it does not need are absent.

```tsx
function NewTask() {
  return (
    <TaskPanel.Frame>
      <TaskPanel.TitleInput />
      <TaskPanel.NotesInput />
      <TaskPanel.Footer>
        <TaskPanel.Create />
      </TaskPanel.Footer>
    </TaskPanel.Frame>
  )
}

function EditTask({taskId}: {taskId: string}) {
  return (
    <TaskPanel.Frame>
      <TaskPanel.TitleInput />
      <TaskPanel.NotesInput />
      <TaskComments taskId={taskId} />
      <TaskPanel.Footer>
        <TaskPanel.Cancel />
        <TaskPanel.Save />
      </TaskPanel.Footer>
    </TaskPanel.Frame>
  )
}

function TaskSummary() {
  return (
    <TaskPanel.Frame>
      <TaskPanel.TitleText />
      <TaskPanel.NotesText />
    </TaskPanel.Frame>
  )
}
```

Read only is a different part, not a flag on the same part.
`TaskPanel.TitleText` and `TaskPanel.TitleInput` are two small components, and neither one has a branch.
A part with no branch in it goes in any variant, which is what makes the next use case cheap.

## Keep a boolean that sets one attribute of one part

Such a boolean is not a mode, because the part always renders.

```tsx
// Correct. The button always renders, and the flag sets one attribute.
<TaskPanel.Save disabled={isSaving} />
```

## Name the component after the use case

Give the component the name of the use case, and let it compose the parts.
The name then tells the reader what it renders, and a list of flags does not.

```tsx
// Incorrect. The reader must find the body to know what this is.
<TaskPanel taskId="t-12" isReadOnly showComments />

// Correct.
<TaskSummary taskId="t-12" />
```

## Use `children` for structure, and a callback for data

Use `children` when the caller places static JSX.
Use a `renderX` prop only when the component must pass a value back.

Incorrect.
The caller must learn a callback for each slot, and a slot the component forgot is unreachable.

```tsx
type Props = {
  renderHeader?: () => React.ReactNode
  renderFooter?: () => React.ReactNode
}

function TaskPanel({renderHeader, renderFooter}: Props) {
  return (
    <section>
      {renderHeader?.()}
      <TaskTitleInput />
      {renderFooter ? renderFooter() : <DefaultFooter />}
    </section>
  )
}
```

Correct.
The caller writes JSX in the place the JSX goes.

```tsx
function TaskPanelFrame({children}: {children: React.ReactNode}) {
  return <section>{children}</section>
}

function TaskPanelFooter({children}: {children: React.ReactNode}) {
  return <footer>{children}</footer>
}

function TaskWithCustomHeader() {
  return (
    <TaskPanel.Frame>
      <TaskHeader />
      <TaskPanel.TitleInput />
      <TaskPanel.Footer>
        <TaskPanel.Cancel />
        <TaskPanel.Save />
      </TaskPanel.Footer>
    </TaskPanel.Frame>
  )
}
```

A render prop is correct when the component must give data back to the caller, because `children` as JSX cannot receive an argument.

```tsx
// Correct. The row is the argument, so a callback is the only way.
<TaskList tasks={tasks} renderRow={task => <TaskRow task={task} />} />
```

## Declare `ref` in the props, with no `forwardRef`

React 19 passes `ref` like any other prop, so a part that gives the caller its DOM node takes `ref` as a prop and the wrapper goes away.

```tsx
// Correct. No forwardRef, and the caller writes <TaskPanel.TitleInput ref={...} />.
function TaskPanelTitleInput({ref}: {ref: React.Ref<HTMLInputElement>}) {
  return <input ref={ref} />
}
```

## Steps

1. List the booleans of the component, and mark each one as a mode or as an attribute.
2. Write one component for each use case the modes encode, and name it after the use case.
3. Cut the body into parts, one for each choice a mode was making.
4. Replace every `renderX` prop that places static JSX with `children`.
5. Move each caller to the component of its use case, and delete the flags.
