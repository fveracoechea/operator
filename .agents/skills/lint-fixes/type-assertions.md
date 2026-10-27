# Type assertions

An assertion tells the compiler to trust a type that no code checked.
Keep the precise type from the start, or parse the value with a schema.

## `anti-slop/no-chained-type-assertions`

A chain such as `value as unknown as Draft` throws away every type fact the compiler had.
Parse untrusted input at its boundary instead. For trusted values, keep the original precise type.

```ts
// Wrong
const draft = JSON.parse(text) as unknown as Draft;

// Right
const draft = draftSchema.parse(JSON.parse(text));
```

## `anti-slop/no-widen-then-assert`

A `const` that widens a known value and later asserts it back loses the type it had.
Keep the precise type through the flow, and use `satisfies` to check a shape without widening it.

```ts
// Wrong
const options: Record<string, unknown> = { depth: 1 };
const depth = options.depth as number;

// Right
const options = { depth: 1 } satisfies Record<string, number>;
const depth = options.depth;
```
