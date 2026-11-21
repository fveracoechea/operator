---
"@fveracoechea/operator": major
---

Hand draft PRs to the recorded next worker kind without an implementer note. Recover failed handoffs through dispatch instead of a separate handoff command.
Replace the removed `operator handoff --source <id> --assignment <key>` with `operator dispatch --source <id> --assignment <key>`.
Use dispatch only when the recorded next step requires handoff recovery; do not start the successor through host commands.
The outgoing worker stops after its closing command starts the handoff.
