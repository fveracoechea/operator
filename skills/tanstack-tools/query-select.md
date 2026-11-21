# Transform query data with a named selector

`select` projects the cached data into the value a component reads.
Give it a named selector: an inline function is a new function on each render, and a projection with no name is one nobody can reuse or test.

## Use the owning feature's selector sub-module

The `deep-modules` topic [sub-modules.md](../deep-modules/sub-modules.md) owns selector purity, placement and tests.
Type a Query selector against the wire shape the query function returns, and let inference give its return type.

```ts
// modules/invoices/selectors/main.ts
import type {InvoiceList} from '../schemas'

export function overdueInvoices(list: InvoiceList) {
  return list.items.filter(invoice => invoice.status === 'overdue')
}
```

## Pass it by reference from the query options

```ts
// modules/invoices/query-options/main.ts
import {queryOptions as defineQueryOptions} from '@tanstack/react-query'
import * as selectors from '../selectors/main'
import {listInvoices} from '../requests'

export const queryOptions = {
  overdue() {
    return defineQueryOptions({
      queryKey: ['invoices'],
      queryFn: listInvoices,
      select: selectors.overdueInvoices,
    })
  },
}
```

The reference is stable, so unchanged data and the same selector do not trigger another projection.
The parent exposes the options as `Invoices.queryOptions`.
The component reads `useSuspenseQuery(Invoices.queryOptions.overdue())`.
The parent may also expose its selector namespace as `Invoices.selector`.

## Call a selector that takes an argument in render

A value that render holds, such as a search param, is not an input to `select`.
Read the query, then call the selector with the value: `const shown = invoicesWithStatus(data, status)`.
The React Compiler memoises the call.
