---
name: collections-and-iteration
description: 'Use when code sorts, filters or looks up in an array, Set or Map, or loops over a collection or an object.'
---

# Collections and iteration

This skill is about the shape of a collection and the walk over it.

The build targets ES2023, so the immutable array methods are safe everywhere and no example needs a copy first.

## Sort a value you do not own

`sort()` reorders the array in place.
A value that arrives as a prop, a loader result, a cache entry or a return value is shared, so sorting it reorders it for every other reader.

Incorrect.
The caller's array comes back in a different order, and the caller never asked for that.

```ts
export function topEarners(employees: Employee[]) {
  return employees.sort((a, b) => b.salary - a.salary).slice(0, 5)
}
```

Correct.

```ts
export function topEarners(employees: Employee[]) {
  return employees.toSorted((a, b) => b.salary - a.salary).slice(0, 5)
}
```

Plain `sort()` is right when ownership is visible at the call site: a `.map()`, a `.filter()` or an `Object.keys()` in the same expression.

```ts
// Correct. The array is one expression old, and nobody else holds it.
const names = employees.map(employee => employee.name).sort()
```

A function's return value is a value you do not own, even when its implementation happens to build a fresh array.
That freshness is an invariant in another file, and `toSorted()` costs one copy to stop depending on it.

`toReversed()`, `toSpliced()` and `with()` follow the same instinct.

## Collapse a map that can miss into one typed `reduce`

A map that can miss produces `T | undefined`, and the filter that drops the misses needs a hand-written predicate to narrow it back.
A `reduce<T[]>` accumulator narrows on its own, and it walks the collection once.

Incorrect.
Two passes, and a cast the typechecker takes on trust.

```ts
const parsed = rows.map(row => parseId(row))
const ids = parsed.filter((id): id is Id => id !== undefined)
```

Correct.
The accumulator is the type you want, so nothing needs narrowing.

```ts
const ids = rows.reduce<Id[]>((acc, row) => {
  const id = parseId(row)
  if (id !== undefined) acc.push(id)
  return acc
}, [])
```

`reduce` earns its place only by removing a predicate cast or a pass.

```ts
// Correct. Nothing to narrow, so the chain is the finished form.
const activeNames = users.filter(user => user.isActive).map(user => user.name)
```

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

## Walk with `for...of` when the body has real logic

`map` and `filter` promise one value in and one value out.
A body with a branch, an early exit or several statements breaks that promise, and a `forEach` callback can neither `break` nor return from the function around it.

Incorrect.
Two passes, and the predicate is written twice, so the two lists drift apart the day one of them changes.

```ts
const parsed = rows.filter(isValid).map(toParsedRow)
const rejected = rows.filter(row => !isValid(row))
```

Correct.
One walk, one statement of the rule.

```ts
const parsed: ParsedRow[] = []
const rejected: Row[] = []

for (const row of rows) {
  if (!isValid(row)) {
    rejected.push(row)
    continue
  }
  parsed.push(toParsedRow(row))
}
```

## Walk an object with `Object.keys()`

`for...in` walks the prototype chain as well as the object, so a key from a base class or a polluted prototype reaches the body.
It also gives you nothing to type against, because every key arrives as a plain `string`.

Incorrect.

```ts
for (const code in statusLabels) {
  register(code, statusLabels[code])
}
```

Correct.
`Object.keys()` returns the object's own keys, and the loop reads like every other loop in the file.

```ts
for (const code of Object.keys(statusLabels)) {
  register(code, statusLabels[code])
}
```

Use `Object.entries()` when the body needs the value as well as the key.

```ts
for (const [code, label] of Object.entries(statusLabels)) {
  register(code, label)
}
```
