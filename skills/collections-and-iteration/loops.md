# Walk a collection or an object

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
