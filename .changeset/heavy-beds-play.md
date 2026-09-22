---
"@fveracoechea/operator": minor
---

Update and release one matched Operator version.

`operator update` selects the exact release a project coordinates with, refuses while work is in
flight, verifies a backup before it migrates a recorded format, and installs the CLI code and the
owned skills together.
The release artifact carries runnable ESM, public declarations, the complete owned-skill
directories, and the generated configuration schema, so neither delivery path runs a build.
