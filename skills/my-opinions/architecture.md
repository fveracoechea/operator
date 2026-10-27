# Architecture

- A feature is a deep module with one interface object and one or two entry points. A second export is a second interface, and the module stops being deep.
- Structure by feature or capability, never by technical layer. A `server/` folder is the wrong axis in an isomorphic framework. The server-client seam is per file.
- A capability module ships a finished use case, not parts. It owns the state rules, the link policy, and the UI together, and a caller that assembles parts holds the module's state switches.
- A helper is a module that was not named. When a second caller wants the behaviour, the answer is the capability that owns it, not a function they both import.
- Write a one-line expression inline where it is used. A one-line helper hides one line behind a name the reader must look up, and such helpers multiply across the codebase.
- Build from the use case down. Name the interface and write the call site first, because code written from the bottom up produces helpers that no module owns.
- Moving exports to a new file, or grouping helpers under one name, adds no depth. The interface is deeper only when the caller has less to know.
- Shared policy lives in one implementation that the link and the imperative action both call. Search preservation, push or replace, scroll behaviour, and current-item resolution written twice answer differently.
- A factory whose arguments are all static imports exists only for a test. Declare the object directly and fake at the module boundary.
- Membership passes the deletion test. Machinery whose deletion costs nothing is not ported.
- One concept, one rendering, app-wide. Two files that agree on a signature and disagree on the answer typecheck perfectly.
- Import deeply. No barrel files, so a reader sees the real dependencies.
- Two update paths drift. Delete the old one when the new one lands.
- Server-only code carries a `$` prefix. Generated files carry `.generated.ts` or live in a `generated` folder, so provenance is visible at the call site.
- Local development scales to the whole team with no machine-specific hacks, and connects to real tenant environments instead of running the full stack.
