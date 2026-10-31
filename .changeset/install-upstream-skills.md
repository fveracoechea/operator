---
"@fveracoechea/operator": major
---

`operator install --opencode | --claude` now also installs the upstream skills globally, so one command follows each install or update of Operator.
After the owned skills, it installs Matt Pocock's productivity and engineering skills, `unslop` from `cursor/plugins`, and `show-me` from `humanlayer/skills`.
Each repository is pinned to its current full commit, and the pinned `skills` installer gets one positive skill list for each repository.
An owned refusal stops the command before the upstream install, and `--check` checks only the owned skills.
The JSON result adds an `upstream` field with the installer version, the hosts, and the repository, commit, and skills of each source.
`operator install matt` is removed, with no alias. Run `operator install` instead.
`operator ready` still requires only `code-review` from the upstream skills.
