# Return each expected failure as a value

Expected failures are outcomes callers must account for, such as a missing invoice or a payment conflict.
Return them as values so the operation's contract states how it can fail.
Keep programming defects and unexpected failures separate from those expected outcomes.

## Make the failure contract explicit

- Include expected failures in the return type, with enough information for callers to distinguish and act on them.
- Use the project's existing error representation and tooling. The intent does not require a particular library or result type.
- Keep implementation details private. Describe failures in terms the module's callers understand.

## Convert failures at boundaries

- Convert recognized dependency failures into the module's expected failures where the dependency enters the module.
- Preserve unexpected causes for the project's defect-handling path. Do not disguise them as ordinary expected failures.
- Translate module failures into the consuming framework's required behavior at that boundary, following project conventions.

## Handle or propagate every expected failure

- Handle each expected case deliberately, or propagate it to a caller that owns the decision.
- Use exhaustive checking where the project's tools support it, so new failure cases require a decision.
- Group cases that share a response explicitly. Avoid catch-all handling that silently absorbs future cases.
- Keep failure-bearing return values until they are handled or propagated. Do not silently discard them.
