---
"@fveracoechea/operator": minor
---

A person can grant more write paths to one assignment with one `write-paths-grant` approval.
`operator work write-paths` prints the effective write paths of an assignment, and for asked paths the exact approval and each started assignment of the same source that the grant would overlap.
`operator approval grant` refuses a grant target that is not a canonical write path.
The brief, `operator attempt submit`, and the crew frontier read the registered write paths plus every current grant, and the grant covers rework until the registered write paths change.
