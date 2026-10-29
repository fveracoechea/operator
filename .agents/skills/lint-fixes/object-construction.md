# Object construction

Build objects so that a reader sees which properties exist, and so that a loop does no quadratic copying.

## `anti-slop/no-conditional-empty-object-spread`

A spread such as `...(flag ? { key } : {})` hides an omitted property behind an empty object.
Build the object in separate statements, and add the property only when it is present.

```ts
// Wrong
const request = { url, ...(token ? { token } : {}) };

// Right
const request: Request = { url };
if (token) request.token = token;
```

## `anti-slop/no-reduce-accumulator-copy`

A reducer that copies its accumulator on each step does quadratic work.
Mutate a fresh accumulator that the reducer owns, or use a loop, `Map`, or `flatMap`.

```ts
// Wrong
const byId = items.reduce((all, item) => Object.assign({}, all, { [item.id]: item }), {});

// Right
const byId = new Map(items.map((item) => [item.id, item]));
```
