# Review

Load `code-review` against the PR base and the brief's spec.
Read the router's internal review topic.
Review the PR without an implementer note.
Record findings with `operator pr round --file <round.md> --json`.
Fix or disposition each finding within the recorded round limit.
Leave an optional note of open points for the next worker, not review evidence.
Run `operator pr ready --file <ready.md> --note <note.md> --json` to start fresh pr-feedback.
Omit `--note` when none is needed.
After a person-approved skip, run `operator pr ready --json` without rounds or a summary.
Stop after the handoff.
