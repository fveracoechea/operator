---
"@fveracoechea/operator": minor
---

Add a read-only `operator healthcheck` that checks the selected release, configuration, host selection, Herdr connection and wake plugin, and GitHub access. It lists live checks that still lack proof and states the dispatch gate. Add an approved `--stale-only` probe mode that rechecks stale evidence without running unrelated host or tracker groups.
