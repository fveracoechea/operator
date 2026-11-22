# Commit review

Review the recorded task, intent, candidate and base without an implementer note.
Keep intermediate history.
Record findings before fixes with `operator commit round --file <findings.md>`.
Use `## Findings` and `- blocker|nice-to-have, Spec|Standards|Skills, location: claim`.
Commit fixes normally.
An applied blocker needs another round.
Two rounds maximum; final blockers stop automatic delivery.

Supply `## Dispositions` with each finding once: `- 1.1 applied` or `- 1.2 declined: reason`.
Run `operator commit deliver --file <dispositions.md>`.
Operator checks the exact candidate and publishes without a PR.
Retry partial effects with the pinned candidate.
Never force-push or bypass protections.
