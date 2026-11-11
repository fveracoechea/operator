---
"@fveracoechea/operator": minor
---

Add `operator review slack-drop <effect-id> --person-instructed`, which drops one pending Slack effect without sending it, so a stale reply no longer has to post as the person.
The effect is recorded `dropped` and never returns from `review wait --slack`.
It refuses without `--person-instructed`, for an unknown effect, and for an effect that is already done or dropped.
