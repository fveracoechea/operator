# ADRs, documentation, and releases

## ADRs

- Record a decision only when it is hard to reverse, surprising without context, and a real trade-off.
- Write the decision, not the implementation. Every sentence passes the rename test.
- Name the rejected alternative and the accepted cost. A record of only what was chosen is worthless to the reader deciding whether to revisit it.
- Record the follow-up a decision creates without pretending to resolve it.
- On a rewrite, delete and renumber old ADRs. A restart carries no old decisions forward.
- Spec and ADRs come before the build, so every implementation change lands under them.

## Documentation

- A rule lives where the next author meets it. Convention in the style guide, gotcha in a code comment citing the ADR, operator fact in the README.
- A glossary fixes the words and lists the words to avoid. The rest of the stack uses its words exactly.

## Releases

- The author decides what a change does to a consumer, through changesets, not the commit history.
- One product, one version, one immutable tag. A bad release is replaced, never corrected in place.
- A path a consumer names is a public contract. Moving it is a major, adding one is a patch.
- Prose that reaches other repos is a release artifact. An edit that ships no tag reaches nobody.
