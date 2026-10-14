# Transform query data with a named selector

`select` projects the cached data into the value a component reads.
Give it a named selector: an inline function is a new function on each render, and a projection with no name is one nobody can reuse or test.

## Write the selector as its own unit

- Write a `function` declaration named for what it returns, such as `overdueInvoices`, in its own file inside the module that owns the data.
- Type its argument against the wire shape the query function returns, and let inference give the return type.
- Return a new value, and leave the argument as it is: the cache owns it.
- Put its test beside it, fed a wire-shaped fixture.

```ts
// modules/invoices/overdue.ts
export function overdueInvoices(list: InvoiceList) {
  return list.items.filter(invoice => invoice.status === 'overdue')
}
```

## Pass it by reference from the query options

```ts
// modules/invoices/main.ts
export const invoices = {
  overdue() {
    return queryOptions({
      queryKey: ['invoices'],
      queryFn: listInvoices,
      select: overdueInvoices,
    })
  },
}
```

The reference is stable, so Query runs the selector again only when the data changes.
The component reads `useSuspenseQuery(invoices.overdue())`, and the selector stays inside the module.

## Call a selector that takes an argument in render

A value that render holds, such as a search param, is not an input to `select`.
Read the query, then call the selector with the value: `const shown = invoicesWithStatus(data, status)`.
The React Compiler memoises the call.
