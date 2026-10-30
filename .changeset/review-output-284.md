---
"@fveracoechea/operator": minor
---

A posted review is shorter and requests changes less often.
The main comment gives the result, the counts, and one short bullet for each finding. The detail of an anchored finding is only in its line comment.
`REQUEST_CHANGES` now needs a blocker with an `impact` of `breaking` or `security`. A breach of style or design is a comment.
Each finding in a review draft can name its `source`, such as a skill, the project code style, an ADR, or best practice. It replaces the `breach` field, which the draft now refuses.
A nice to have now needs a `short` of at most six words.
The `pr-review` skill asks for a snippet, a `suggestion` block, or a diagram in most line comments.
