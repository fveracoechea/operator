# Shape a deep module

## Give the module a few named entry files, and keep every other file private

The rest of the app imports a module only through its entry files.
Every other file is private, and files inside the module import each other with relative paths.
Export constants and functions that hide application logic, including an operation object when that suits the caller.
An object is a constant too.
Export count and object shape do not establish depth.
Use the caller's knowledge and the deletion test in [interface-design.md](interface-design.md) to judge depth.

Follow the host application's interface-object convention when it requires one PascalCase object per entry file.
The examples below permit named functions; the UI and sub-module examples use that object convention.
Neither form makes private implementation files public.

| File                                   | Holds                                                                  | Environment                        |
| -------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------- |
| `main.ts`                              | public constants, functions and caller-facing types                    | a module that callers import       |
| `main.server.ts`                       | server-only public operations and types                                | full-stack                         |
| `schemas.ts` or `schemas.generated.ts` | the wire shapes as Zod, and the types inferred from them               | a module whose data crosses a wire |
| `$functions.ts`                        | the server functions and server-function middleware                    | TanStack Start                     |

A module has only the entry files its callers need.
A server-only module is usually `main.ts` and `schemas.ts`, because the HTTP routes that call it live outside the module.
An SPA module is `main.ts`, plus `schemas.ts` for the responses it parses.
The wire schemas are an interface of their own, because routes, handlers and fixtures parse against them.

### Let `$functions.ts` be the interface when every caller crosses the RPC

In a full-stack app, a module that only the browser calls, through its server functions, has no `main.ts` or `main.server.ts`.
Its interface is `$functions.ts` and its wire schemas.
The server-side code behind the server functions is private, and its file is named after what it does, such as `invoices.server.ts`, so the name does not read as an entry file.

Add `main.server.ts` when another module's server code must call the module, such as the `Auth.requireSession()` that every other module's server code calls.
Add `main.ts` when a route places the module's UI or calls it in the browser.

### Pick the entry file by where the code runs

This applies to a full-stack app, where one module holds code for both sides.

- `main.server.ts` holds server-only operations.
- `main.ts` holds isomorphic or browser operations. TanStack Start renders every component in the route tree on the server, even under `ssr: 'data-only'`, so a `.client.ts` file on that path fails the SSR build.
- A module with callers on each side can have both entry files.

The file name tells where code runs.
`.server.ts` and `.client.ts` mark a file that belongs to one environment, and a plain `.ts` file runs on both.
A `$` prefix marks a server function or middleware.
A `.generated.ts` suffix marks generated output, which nobody edits by hand.

## Compose functions around mostly pure application logic

Prefer functions and composition over application classes and inheritance.
Keep decisions pure where practical, and compose reads, policy and effects in procedural operations.
Import ordinary collaborators directly, or pass a dependency to the function that needs it.
An application-operation factory solely for dependency injection or test convenience is not the default.
Avoid factories that only receive static imports and return methods around them.

Construct genuine effect/IO adapters and initialize necessary data state where their ownership requires it.
A database client constructor, a library class, or a `create`/`prepare` name is not itself a problem.
[server-state.md](server-state.md) owns state lifetime and cleanup.
[module-tests.md](module-tests.md) owns test seams.

### Pure policy with concrete inputs and outputs

This policy uses ISO calendar dates, `YYYY-MM-DD`.
It has no clock, database or mail dependency.

```ts
export type Invoice = {
  id: string
  email: string
  dueOn: string
  balanceCents: number
}

export function reminderDecision(invoice: Invoice, today: string) {
  if (invoice.balanceCents <= 0) {
    return {status: 'skip', reason: 'settled'} as const
  }
  if (invoice.dueOn >= today) {
    return {status: 'skip', reason: 'not-due'} as const
  }
  return {
    status: 'ready',
    to: invoice.email,
    subject: `Invoice ${invoice.id} is overdue`,
  } as const
}

const invoice = {
  id: 'inv-42',
  email: 'ada@example.com',
  dueOn: '2026-11-20',
  balanceCents: 12500,
}

reminderDecision(invoice, '2026-11-21')
// {status: 'ready', to: 'ada@example.com', subject: 'Invoice inv-42 is overdue'}
reminderDecision({...invoice, balanceCents: 0}, '2026-11-21')
// {status: 'skip', reason: 'settled'}
```

### Function-level dependency injection

Inject only the dependency the operation needs, without constructing an application object.
Production callers use the real store by default.
The preview owns the lookup and missing-invoice policy.

```ts
import {InvoiceStore} from '@/modules/invoice-store/main.server'

export async function reminderPreview(
  invoiceId: string,
  today: string,
  readInvoice: (id: string) => Promise<Invoice | undefined> = InvoiceStore.find,
) {
  const invoice = await readInvoice(invoiceId)
  if (!invoice) return {status: 'missing'} as const
  return reminderDecision(invoice, today)
}

await reminderPreview('inv-42', '2026-11-21', async () => invoice)
// {status: 'ready', to: 'ada@example.com', subject: 'Invoice inv-42 is overdue'}
await reminderPreview('absent', '2026-11-21', async () => undefined)
// {status: 'missing'}
```

### Procedural server operation

The server operation reads stored invoice data through `reminderPreview`, applies its policy, and sends mail through a collaborator.
The caller asks for the finished use case rather than sequencing those steps.

```ts
import {Mailer} from '@/modules/mailer/main.server'

export async function sendReminder(invoiceId: string, today: string) {
  const decision = await reminderPreview(invoiceId, today)
  if (decision.status !== 'ready') return decision
  const receipt = await Mailer.send({
    to: decision.to,
    subject: decision.subject,
  })
  return {status: 'sent', messageId: receipt.id} as const
}
```

With the stored `invoice` above, `sendReminder('inv-42', '2026-11-21')` sends one mail to `ada@example.com`.
If the mailer returns `{id: 'mail-7'}`, the operation returns `{status: 'sent', messageId: 'mail-7'}`.
A settled invoice returns `{status: 'skip', reason: 'settled'}` without sending mail.

Under an interface-object convention, keep the functions private as needed and export `const InvoiceReminders = {preview: reminderPreview, send: sendReminder}`.
The grouping adds no depth; the hidden lookup, policy and effect sequence do.

## Expose the UI as finished use cases on a `UI` object

This applies to an SPA or a full-stack module that has a UI.

```ts
export const InvoicesUI = {
  /** What the overdue list renders: the empty state, then the rows. */
  OverdueList: OverdueListRoot,
}
```

The route places the member whole: `<Invoices.UI.OverdueList />`.
Each member decides what it shows from its own state.
Keep the module's `.tsx` files under its `ui/` folder.
The internal compound, its provider and its parts, follows the `react-composition` skill.

## Point every import downward

- A feature module uses infrastructure modules, such as `Http`, `Cache` and `Auth`.
- An infrastructure module never imports a feature module.
- A module imports the shared library (`src/lib`) and the app's shared components (`src/components`).
- A module never imports a route or a handler. Routes and handlers are the callers.

`import/no-cycle` catches a cycle between files, not a cycle between two modules whose files form no loop.
Check the direction yourself before you add an import from another module.
