# Sort and narrow an array

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
