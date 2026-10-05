---
"@fveracoechea/operator": patch
---

`operator gate run` now reports a started runner as `pending` with `gate_run_started`. Herdr accepts the runner line with exit 0 and an empty answer, and before, Operator read that empty answer as `uncertain` with `gate_runner_not_typed` while the runner ran. An answer that is lost or that Operator cannot read is still `uncertain`.
