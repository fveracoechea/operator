---
"@fveracoechea/operator": minor
---

`operator work register` reads the structure of a new source from GitHub: a specification or a wayfinder map is a parent issue with its sub-issues, and a ticket is one issue.
The input holds only the execution fields, keyed by `<owner>/<repo>#<number>`, and the hand-written structure input is refused as `invalid_work_input`.
`work register --plan --input <path>` previews the registration, changes no crew state, and reports a summary, a `planRevision`, and the path of the full plan.
`work register --request <id> --owner-token <token> --input <path> --plan-revision <revision>` registers that plan and refuses `plan_revision_changed`, naming each changed part, when the tracker or the input changed.
Each refusal of the plan is reported at once, in item order and then by blocker key.
The crew state moves to version 9: each assignment records the identity of its issue text, and each tracker binding records its repository.
