# Return each expected failure as a value

- A **Result** is what a call that can fail returns: a success or a failure.
- A **tagged error** is a failure with a tag, a string that names it. The failures of one call are a union of tagged errors.
- A **defect** is a failure that no caller can act on, such as a bug. It is not in the union.
- The **fold** turns a Result into the value its caller reads, once.

## Follow the four principles

- **Explicit signatures.** The return type of a function says that it can fail, and how.
- **No hidden control flow.** A failure goes back along the normal return path. It does not jump up the call stack to a `catch`.
- **Compiler and linter enforcement.** A new tag fails the typecheck at each consumer that does not handle it, and lint rules catch a dropped Result. "Annotate the return type" below lists the gaps.
- **Two outcomes.** A call gives a success or a failure. There are no `try`, `catch` and `finally` branches.

## Return a Result from each module method that can fail

Give each expected failure a tagged error, and name their union in the return type.

```ts
// Every snippet here uses unthrown 5.12.2, the current implementation. Its skill holds the API.
import {P, TaggedError, fromPromise, type AsyncResult} from 'unthrown'

class InvoiceNotFound extends TaggedError('InvoiceNotFound')<{id: string}> {}
class InvoiceLocked extends TaggedError('InvoiceLocked')<{id: string}> {}

type ApproveFailure = InvoiceNotFound | InvoiceLocked
```

## Fold the Result at the client boundary, and throw only at a framework edge

- The boundary to the client, such as a server function or an HTTP handler, folds the Result once. The fold records each error with its tag, and each defect with its cause. It returns the shape that crosses the wire.
- The framework edges throw, because the query library, the router and an error boundary act on a throw only. The client code that reads the wire shape throws for the query's error path.
- A component never sees a Result.

## Sort each rejection where it happens

Code that throws or rejects enters the module at one call, such as a fetch. Sort the cause at that call:

- A failure that the caller can act on, such as a missing record or a conflict, is a tagged error.
- Anything else is a defect. It stays out of the error union, so the union lists only failures a caller can act on.

```ts
function approve(id: string): AsyncResult<Invoice, ApproveFailure> {
  return fromPromise(Billing.approve(id), (cause, defect) => {
    if (!(cause instanceof HttpError)) return defect(cause)
    if (cause.status === 404) return new InvoiceNotFound({id})
    if (cause.status === 409) return new InvoiceLocked({id})
    return defect(cause)
  })
}
```

## Match each tag, with no catch-all

A consumer handles each tag in its own arm.
A catch-all arm, or a check for one tag with an else, takes each tag added later with no compile error.
Put tags that share a handler in one arm.

```ts
type ApproveAnswer = {ok: true; invoice: Invoice} | {ok: false; reason: string}

function approveAnswer(id: string): Promise<ApproveAnswer> {
  return approve(id).match({
    ok: invoice => ({ok: true, invoice}),
    errCases: matcher =>
      matcher
        .with(P.tag('InvoiceNotFound'), error => failed(error, 'not_found'))
        .with(P.tag('InvoiceLocked'), error => failed(error, 'locked')),
    defect: cause => {
      log.error('invoice_approve_defect', {cause})
      return {ok: false, reason: 'unknown'}
    },
  })
}

function failed(error: ApproveFailure, reason: string): ApproveAnswer {
  log.warn('invoice_approve_failed', {tag: error._tag, id: error.id})
  return {ok: false, reason}
}
```

## Annotate the return type, and keep each Result you get

- Annotate the return type of each function that returns a Result. The lint rules find a dropped Result only from an annotated function in the same file, and an inferred type can split into a union of two Result types.
- A Result from a function in another file passes the typecheck and the lint rules when the caller drops it. Return it, bind it or fold it.
- A statement that ends in a chain, such as `result.map(toRow);`, builds a new Result and drops it. Return the chain.
