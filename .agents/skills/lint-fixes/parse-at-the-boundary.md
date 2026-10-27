# Parse at the boundary

Parse external input once, where the code reads it: the file read, the tool output, the HTTP body, or the caught error.
After that point, code receives named domain types and never checks the representation again.
Do not move the parse into a wrapper only to get past a rule.

## The validator exception

One form may take `unknown` and use a runtime `typeof`: an explicit, non-generic `value is T` validator.

- The return annotation is `value is T`, not `asserts value is T`.
- The function has no type parameters, and `T` uses no type parameter of an enclosing function, class, or type.
- `value` is a plain parameter annotated exactly `unknown`.
- `T` is a specific type. `any`, `unknown`, `object`, `Object`, `{}`, `Record<string, unknown>`, and an intersection of only these do not qualify.
- `typeof` may check only `value` or a member chain of `value`, such as `value.name`.
- The check must be in the validator itself. A nested callback, an alias variable, and a sibling parameter get no exception.

```ts
function isText(value: unknown): value is string {
  return typeof value === "string";
}

const entries = Object.values(record).every(isText);
```

The linter checks only the shape. A review and tests must prove that the validator checks every part of `T`.
A partial object check that claims a complete domain type is wrong, even when lint passes.
A validator does no writes and no domain actions.

## `anti-slop/no-unknown-parameters`

Accept a named domain type. Run the schema where the input enters, before the call.

```ts
// Wrong: the caller passes raw input, and the helper parses it.
function draftId(body: unknown) {
  return draftSchema.parse(body).id;
}

// Right: the I/O owner parses, and the helper takes the parsed type.
const parsed = draftSchema.safeParse(outcome.value.body);
const id = parsed.success ? parsed.data.id : null;
```

A caught error is input too. There is no exception for a parameter named `cause`.
At an unthrown boundary, narrow the caught value in the inline callback, then give a typed helper the `Error`:

```ts
function qualify<T>(cause: Error, defect: (cause: Error) => T) {
  if (isCodedError(cause) && cause.code === "ENOENT") return { reason: "missing", detail: String(cause) };
  return defect(cause);
}

fromPromise(work, (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)));
```

In a `catch` block, use `isCodedError` from `lib/coded-error.ts` to read an error code.
Use `try` and `catch` instead of a `.catch((cause: unknown) => ...)` callback.

## `anti-slop/no-unknown-returns`

Return the parsed type. If a function reads text for several schemas, give it the schema:

```ts
function parse<T>(text: string, schema: z.ZodType<T>): T | undefined {
  const value = fromThrowable(
    () => JSON.parse(text) as unknown,
    (cause, defect) => (cause instanceof SyntaxError ? "invalid" : defect(cause)),
  )().getOr(undefined);
  return schema.safeParse(value).data;
}
```

A callback that returns nothing has the type `() => void`, not `() => unknown`.

## `anti-slop/no-object-parameters`

Name the shape the function reads.
Use `Record<string, V>` for a dictionary, and a named object type for a fixed shape.

```ts
function finish(counts: Partial<{ blockers: number; niceToHaves: number }>) {
  return { ...counts };
}
```

## `anti-slop/no-runtime-typeof`

Branch on a domain value, not on a representation.
Give a result union a key that tells the members apart, and test that key:

```ts
function git(args: string[]): { output: string } | { error: string } {
  // ...
}

const names = git(["diff", "--name-only"]);
if ("error" in names) return names;
```

A comparison with `"undefined"`, such as `typeof Bun !== "undefined"`, is an existence probe and stays legal.
A `typeof` in a type position, such as `type Settings = typeof settings`, stays legal.
For a scalar check, write a validator as shown in the validator exception.

## `anti-slop/no-unknown-type-aliases`

Write `unknown` where the parse boundary is, not behind a name.
Replace the alias with the parsed domain type, or keep the explicit `unknown` on the boundary value.

```ts
// Wrong
type Payload = unknown;

// Right
type Payload = z.infer<typeof payloadSchema>;
```

## `anti-slop/no-reflect-get`

Read a field through its typed property. Parse external data with a schema first, then read `parsed.data.field`.

```ts
const id = draftSchema.parse(body).id;
```

## `anti-slop/no-reflect-apply`

Call the typed function directly, so that the compiler checks the arguments.

```ts
const total = sum(left, right);
```
