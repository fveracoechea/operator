# Review

Use `code-review` with the PR base as fixed point and the brief's Task and intent as spec.
Review Spec, Standards, and required Skills without an implementer note.
Treat PR descriptions and commit messages as claims, not evidence.
After a stack handoff, review its actual head against its actual new base; prior integration evidence is historical only.
Record findings with `operator pr round --file <round.md>` before fixes.
Apply valid findings and disposition every finding within the recorded round limit.
Commit and push.
Read [handoff](../../handoff/SKILL.md) by path; write open points in assignment device-state files, within about 60 lines.
Run `operator pr ready --file <ready.md> --note <note.md>`; stop after the handoff to pr-feedback.
