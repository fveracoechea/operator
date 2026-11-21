# Functional deep-module fixture

This records a same-agent evaluation for #437, using the edited canonical sources.
It checks generated behavior and test seams, not Markdown formatting.
It is not an independent fresh-session or host-discovery evaluation.
The evaluating model was `openai/gpt-6.1-sol`.

## Prompt

> Implement a server operation that sends an overdue invoice reminder, plus Bun tests.
> The application already has public `invoice-store/main.ts`, `mailer/main.ts`, and `invoice-events/main.ts` collaborators.
> `InvoiceStore.find(id)` reads the existing database and returns an invoice or `undefined`.
> An invoice has `id`, `email`, `dueOn` as an ISO calendar date, and `balanceCents`.
> `Mailer.send({to, subject})` returns `{id}`.
> Send only when the balance is positive and the due date precedes the supplied date.
> Return the missing, skipped or sent outcome.
> Also expose an invoice listener for a request.
> `InvoiceEvents.subscribe(id, callback)` returns an unsubscribe function.
> The request can end normally or abort.
> Explain state ownership and test seams.
> Use the edited deep-modules and my-opinions guidance.
> This fixture host permits named function exports.
> Implement only the consumer, not those existing adapters.

## Generated operation

Save this block as `main.ts` in an isolated directory.

```ts
import {InvoiceStore} from './invoice-store/main.ts'
import {Mailer} from './mailer/main.ts'
import {InvoiceEvents} from './invoice-events/main.ts'

type Invoice = {id: string; email: string; dueOn: string; balanceCents: number}

function reminderDecision(invoice: Invoice, today: string) {
  if (invoice.balanceCents <= 0) return {status: 'skip', reason: 'settled'} as const
  if (invoice.dueOn >= today) return {status: 'skip', reason: 'not-due'} as const
  return {status: 'ready', to: invoice.email, subject: `Invoice ${invoice.id} is overdue`} as const
}

export async function sendReminder(invoiceId: string, today: string) {
  const invoice: Invoice | undefined = await InvoiceStore.find(invoiceId)
  if (!invoice) return {status: 'missing'} as const
  const decision = reminderDecision(invoice, today)
  if (decision.status !== 'ready') return decision
  const receipt = await Mailer.send({to: decision.to, subject: decision.subject})
  return {status: 'sent', messageId: receipt.id} as const
}

export function watchInvoice(invoiceId: string, onChange: () => void, signal: AbortSignal) {
  if (signal.aborted) return () => {}
  const unsubscribe = InvoiceEvents.subscribe(invoiceId, onChange)
  let disposed = false
  function dispose() {
    if (disposed) return
    disposed = true
    signal.removeEventListener('abort', dispose)
    unsubscribe()
  }
  signal.addEventListener('abort', dispose, {once: true})
  if (signal.aborted) dispose()
  return dispose
}
```

The database owns invoice data across requests and process restarts.
The operation keeps only local decision data and does not copy invoices into a process-global store.
The request owns the returned listener disposer and calls it in `finally` on normal completion or failure.
The abort signal also invokes disposal.
The listener closure owns only its disposal flag, and removes its abort listener and subscription once.
The application owns the collaborators' connections and closes them at shutdown.
The fixture promises no durable delivery deduplication.
That would need an existing persistent store's atomic operation, not an in-memory sent-ID set.

## Generated tests

Save this block as `main.test.ts` beside the operation.
The mocks supply the existing public adapters without implementing new infrastructure.
They register before the dynamic import, so no real database or mail adapter loads.

```ts
import {beforeEach, expect, mock, test} from 'bun:test'

const invoice = {id: 'inv-42', email: 'ada@example.com', dueOn: '2026-11-20', balanceCents: 12500}
const find = mock(async (_id: string): Promise<typeof invoice | undefined> => invoice)
const send = mock(async (_mail: {to: string; subject: string}) => ({id: 'mail-7'}))
const unsubscribe = mock(() => {})
const subscribe = mock((_id: string, _callback: () => void) => unsubscribe)

mock.module('./invoice-store/main.ts', () => ({InvoiceStore: {find}}))
mock.module('./mailer/main.ts', () => ({Mailer: {send}}))
mock.module('./invoice-events/main.ts', () => ({InvoiceEvents: {subscribe}}))
const {sendReminder, watchInvoice} = await import('./main.ts')

beforeEach(() => {
  find.mockReset()
  find.mockImplementation(async () => invoice)
  send.mockReset()
  send.mockImplementation(async () => ({id: 'mail-7'}))
  unsubscribe.mockClear()
  subscribe.mockClear()
})

test('reads the invoice and sends its reminder', async () => {
  expect(await sendReminder('inv-42', '2026-11-21')).toEqual({status: 'sent', messageId: 'mail-7'})
  expect(find).toHaveBeenCalledWith('inv-42')
  expect(send).toHaveBeenCalledTimes(1)
  expect(send).toHaveBeenCalledWith({to: 'ada@example.com', subject: 'Invoice inv-42 is overdue'})
})

test('missing invoices send no mail', async () => {
  find.mockResolvedValueOnce(undefined)
  expect(await sendReminder('absent', '2026-11-21')).toEqual({status: 'missing'})
  expect(send).not.toHaveBeenCalled()
})

test.each([
  [0, '2026-11-20', 'settled'],
  [-100, '2026-11-20', 'settled'],
  [12500, '2026-11-21', 'not-due'],
  [12500, '2026-11-22', 'not-due'],
])('balance %i due %s skips as %s', async (balanceCents, dueOn, reason) => {
  find.mockResolvedValueOnce({...invoice, balanceCents, dueOn})
  expect(await sendReminder('inv-42', '2026-11-21')).toEqual({status: 'skip', reason})
  expect(send).not.toHaveBeenCalled()
})

test('mail failure reaches the caller without a false sent result', async () => {
  send.mockRejectedValueOnce(new Error('mail offline'))
  await expect(sendReminder('inv-42', '2026-11-21')).rejects.toThrow('mail offline')
})

test('request completion disposes its listener once', () => {
  const controller = new AbortController()
  const onChange = () => {}
  const dispose = watchInvoice('inv-42', onChange, controller.signal)
  expect(subscribe).toHaveBeenCalledTimes(1)
  expect(subscribe).toHaveBeenCalledWith('inv-42', onChange)
  try {
    expect(unsubscribe).not.toHaveBeenCalled()
  } finally {
    dispose()
  }
  controller.abort()
  dispose()
  expect(unsubscribe).toHaveBeenCalledTimes(1)
})

test('request abort disposes its listener once', () => {
  const controller = new AbortController()
  const dispose = watchInvoice('inv-42', () => {}, controller.signal)
  controller.abort()
  dispose()
  expect(unsubscribe).toHaveBeenCalledTimes(1)
})

test('an aborted request creates no subscription', () => {
  const controller = new AbortController()
  controller.abort()
  watchInvoice('inv-42', () => {}, controller.signal)()
  expect(subscribe).not.toHaveBeenCalled()
})
```

Run with `bun test --isolate ./main.test.ts` from the isolated directory.
The isolated global contains the module replacements.
No private implementation file is mocked or exported for tests.

## Behavioral assessment

| Check | Observation |
| --- | --- |
| Hidden application complexity | `sendReminder` owns lookup, policy and mail; callers do not sequence those steps. |
| Functions and composition | The output uses a private pure policy and public procedural functions, without an application factory or inheritance. |
| Public constants or functions | The host permits named exports, so the output does not manufacture an interface object. |
| Test seams | Tests replace only public collaborator entries and assert returned outcomes and effects. |
| Shared state | The existing database remains the invoice owner; no durable data moves into a module map. |
| Transient state | Each listener owns one disposal flag; the request owns normal cleanup, and abort also disposes it. |
| Legitimate initialization | Subscription construction remains because it acquires a real lifecycle resource. |

The worked `reminderPreview` example separately exercises function-level injection.
The fixture chooses public-entry mocks because its operation imports ordinary collaborators.
This sample does not establish reliability across models or prove database and mail adapter integration.

## Executed checks

The first execution found an unsupported `toHaveBeenCalledExactlyOnceWith` matcher in this checkout's Bun 1.4.4.
The tests above use separate call-count and argument assertions after that correction.
No architecture change was necessary.

- The generated fixture passed 10 tests with `bun test --isolate ./main.test.ts`.
- Six additional tests executed the three worked examples from `skills/deep-modules/module-shape.md`.
  Only the collaborator import aliases changed to relative public-entry paths in the temporary fixture.
  They checked concrete policy results, injected reads, the default store read, mail contents, and missing or settled invoices without mail.
- The combined fixture run passed 16 tests with 38 assertions.
- `bun run lint:skills` passed.
- After updating to current `main`, `bun run test src/modules/operator-release` passed 65 tests across 10 files, with 826 assertions.
  The first attempt lacked locked dependencies; `bun install --frozen-lockfile` resolved that setup failure.
- `OperatorRelease.build` built a local artifact from the working sources.
  A byte comparison and SHA-256 check matched all six changed skill files against their artifact copies.
  This built no published release and changed no installed skills.
- `git diff --check` passed.
