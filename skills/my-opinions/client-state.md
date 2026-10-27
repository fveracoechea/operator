# Client state and loading

## State

- The query cache is the state, and the URL keeps what the URL owns. A store or context holding a copy beside either is a second source of truth, and the two copies go out of sync.
- A context derives values and exposes actions and link options. A persistent copy, or an effect that synchronises one source to the other, is that second source again.
- Transient interaction state, such as a drag preview, stays local to the interaction that owns it.
- Identity lives in the query key. An imperative invalidation is a side effect that must fire from one place and never be missed.
- Polling is the wrong trigger for a once-a-day event. Window focus plus a slow visible-tab interval catches it.
- A data transform is a named, tested selector in its own module, typed against wire shapes. Keep `select` free of inline transforms.
- Data-module functions take one object argument named `input`, destructured on the first line. Elsewhere it is good practice, not a rule.
- Components do not know how data is fetched. Errors surface on the query error path, never during render.

## Loading

- A spinner belongs to a control the operator touched. It never stands for a page or a section.
- A surface loads behind a skeleton that mirrors its populated layout, so nothing jumps when data lands.
- A change to visible data is a transition. The old content stays dimmed and marked stale, never emptied into a second first load.
- The suspending read is the default. A non-suspending read states its reason at the call site.
- Honour reduced motion. No timer imitates a state. Every moment on screen is a frame or the operator's action.
