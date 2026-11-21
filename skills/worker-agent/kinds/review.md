# Review

Use `code-review` with the fixed PR base and the brief's Task/intent as spec.
Review Spec, Standards, and required Skills without an implementer note.
Treat PR descriptions and commit messages as claims, not evidence.
After stack handoff, review the actual head/base; prior integration evidence stays historical.
Record findings with `operator pr round --file <round.md>` before fixes.
Apply valid findings and disposition every finding within the recorded round limit.
Commit and push.
Read [handoff](../../handoff/SKILL.md) by path; write open points in assignment device-state files, within about 60 lines.
Run `operator pr ready --file <ready.md> --note <note.md>`; stop after pr-feedback handoff.
