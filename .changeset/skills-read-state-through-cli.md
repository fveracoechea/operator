---
"@fveracoechea/operator": patch
---

The `operator` skill now reads the selected release from `operator --version --json` and takes the invocation from it.
It no longer reads the release selection file.
No shipped skill names the configuration, its editor schema, the release selection, the readiness evidence, the control reference, the launch record, the setup journal, or the crew database as a file to read.
The skills and the README call a plan file that a CLI result names a CLI output.
