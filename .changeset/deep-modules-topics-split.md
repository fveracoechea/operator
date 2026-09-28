---
"@fveracoechea/operator": patch
---

Split the `deep-modules` skill into smaller topics, and point `tanstack-tools` at it.

`deep-modules` now states the find-the-feature steps in its router, and moves sub-modules, the entry-file lint rule, and environment and per-request state into topics of their own.
An entry file may export one interface object, and a sub-module follows the same rule one level down.
In `tanstack-tools`, a feature's own components import its query slice through a relative path, and the `$` aggregator is for route loaders and other modules.
