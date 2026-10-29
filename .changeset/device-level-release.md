---
"@fveracoechea/operator": major
---

Replace the checkout-local Operator with one device-level release.
One installed release serves every registered project on the device, and projects select no release.
Install it globally from JSR with Bun, from the repository source at a full commit, or from the Nix flake.
Settings and state are on the device, and each project registers once with `operator project register`.
SuperAgents and WorkerAgents replace the old role names.
Assignment plans, dispatch, report assignments, the PR feedback loop with the guarded merge, review requests, and source reset and prune have new commands.
The old project setup, release selection, live probes, tracker operations, integration-branch publication, and project gates are removed.
The bundled `operator`, `operative`, and `parallel-pr-review` skills are removed.
`super-agent`, `worker-agent`, and `slack-pr-review-workflow` replace them.
There are no aliases or forwarding skills.

Before you update, finish all old crews and their work with the old release.
The new release does not migrate, repair, or delete legacy checkout-local `.operator` state.
It refuses to register a checkout that has that folder.
After the old work is done, remove the folder yourself.
