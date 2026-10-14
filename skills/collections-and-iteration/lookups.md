# Look up in a collection

## Index a collection you read more than once

`find()` and `includes()` walk the whole array for every call.
Inside a loop over a second collection, that walk repeats once per item.
A `Map` answers a lookup by key in one step, and a `Set` answers membership in one step.

Incorrect.
Every order walks every customer.

```ts
const enriched = orders.map(order => ({
  ...order,
  customer: customers.find(customer => customer.id === order.customerId),
}))
```

Correct.
One pass builds the index, and each lookup is one step.

```ts
const customerById = new Map(customers.map(customer => [customer.id, customer]))

const enriched = orders.map(order => ({
  ...order,
  customer: customerById.get(order.customerId),
}))
```

A `Set` is the same move for membership.

```ts
const blockedIds = new Set(blocked.map(entry => entry.id))
const visible = items.filter(item => !blockedIds.has(item.id))
```

Build the index outside the loop that reads it.
An index rebuilt on each iteration is slower than the `find()` it replaced.

One lookup over a short array stays a `find()`.
The index costs a pass and a name, and it pays for itself only when something reads it repeatedly.
