# Validate forms with Zod

**Every form that posts to a server gets a Zod schema in its validators**, so the values parse before they leave the client.
A form that writes only local state or local storage needs none.
TanStack Form (`@tanstack/react-form`) owns the form state, and field errors come from the schema.

## Gate submission on `validators.onSubmit`

The schema on `validators.onSubmit` blocks the network call:

```tsx
import {useForm} from '@tanstack/react-form'
import {z} from 'zod'

const contactSchema = z.object({
  name: z.string().min(1, 'Required'),
  email: z.email(),
  seats: z.number().int().min(1),
})
type ContactValues = z.infer<typeof contactSchema>

const defaultValues: ContactValues = {name: '', email: '', seats: 1}

function useContactForm() {
  return useForm({
    defaultValues,
    // Whole-form gate: submission won't fire until values parse.
    validators: {onSubmit: contactSchema},
    onSubmit: async ({value}) => {
      // `value` is validated here, so it is safe to send.
      await api.createContact(value)
    },
  })
}
```

For inline errors, bind the same schema, or a subset of it, to `validators.onChange` or `validators.onBlur` on `form.Field`.
A field-level validator adds to the experience and replaces nothing; `onSubmit` stays the gate.

## Type `defaultValues` with `z.infer`

`defaultValues: z.infer<typeof schema>` cannot drift from the shape the server accepts, and the project's typecheck script names every value that does.
Write no values `interface`.

## Send the validated `value`

`onSubmit` receives the parsed `value`.
Send it; do not re-parse or read `form.state.values`.

## Reuse the schema on the response

When the response mirrors the request, parse it with the same schema.
