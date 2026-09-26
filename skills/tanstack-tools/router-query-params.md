# Validate query params with Zod

Search params (the query string) are untrusted input: anyone can type `?step=garbage`.
A route that reads or writes one gives `validateSearch` a Zod schema, which types `Route.useSearch()`, `navigate({search})` and `<Link search>`.

## Give `validateSearch` the schema itself

Keep the schema in the route file, or in a `-` sibling when helpers share it.
A hand-written `validateSearch: (search) => ({...})` is the schema in disguise; pass the schema itself, and delete the guard or cast it replaces:

```tsx
import {createFileRoute} from '@tanstack/react-router'
import {z} from 'zod'

const searchSchema = z.object({
  // clamp an unknown or absent value to a safe default instead of throwing
  view: z.enum(['grid', 'list']).catch('grid'),
  // optional filter, absent is fine
  q: z.string().optional(),
  // numeric param with a default
  page: z.number().int().min(1).catch(1),
})

export const Route = createFileRoute('/things/')({
  validateSearch: searchSchema,
  component: Things,
})

function Things() {
  const {view, q, page} = Route.useSearch() // fully typed
  const navigate = Route.useNavigate()
  // writes are type-checked against the schema
  const setView = (next: 'grid' | 'list') =>
    void navigate({search: prev => ({...prev, view: next})})
  // ...
}
```

## Derive the param types with `z.infer`

When the type needs a name, `type Search = z.infer<typeof searchSchema>`.
No hand-written interface beside the schema.

## Clamp a param that must degrade with `.catch()`

`.catch()` swaps bad input for a default (a view mode, a page number).
`.optional()` or `.default()` is for a param that may be absent.
Throw only when a bad param makes the route unusable.

## Build a closed set from its tuple with `z.enum`

When a `const` tuple (the tabs, the steps) is the source of truth, write `z.enum(THE_TUPLE)`.

## Read and write through the schema

Read with `Route.useSearch()`, write with `navigate({search})` or `<Link search>`.
Both are typed from the schema, so a new param starts as a schema change and the project's typecheck script names every call site to follow.
