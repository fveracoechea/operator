# Architecture

- For application interface objects, constant exports and functional implementations, use [module-shape.md](../deep-modules/module-shape.md).
- For internal object or namespace interfaces, use [sub-modules.md](../deep-modules/sub-modules.md).
- Structure top-level modules by feature or capability, never by technical layer. A `server/` folder is the wrong axis in an isomorphic framework. The server-client seam is per file.
- A capability module ships a finished use case, not parts. It owns the state rules, the link policy, and the UI together, and a caller that assembles parts holds the module's state switches.
- Keep feature policy with the feature or capability that owns it. A second caller does not make that policy ownerless.
- Inline a one-line expression used once unless its name captures a tested domain rule. Otherwise, the extra lookup buys no meaning.
- Build from the use case down. Name the interface and write the call site first, because code written from the bottom up produces helpers that no module owns.
- Shared policy lives in one implementation that the link and the imperative action both call. Search preservation, push or replace, scroll behaviour, and current-item resolution written twice answer differently.
- Membership passes the deletion test. Machinery whose deletion costs nothing is not ported.
- One concept, one rendering, app-wide. Two files that agree on a signature and disagree on the answer typecheck perfectly.
- Two update paths drift. Delete the old one when the new one lands.
- Server-only code carries a `$` prefix. Generated files carry `.generated.ts` or live in a `generated` folder, so provenance is visible at the call site.
- Local development scales to the whole team with no machine-specific hacks, and connects to real tenant environments instead of running the full stack.
