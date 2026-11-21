---
"@fveracoechea/operator": major
---

Replace JSON input for `operator pr round`, `operator pr ready`, and `operator obligation add`.
All three commands read files or stdin through `--file <path|->`; `--json` still selects output, not input.

For `pr round`, write `## Findings` followed by `- <severity>, <axis>, <location>: <claim>` bullets.
Severity is `blocker` or `nice-to-have`; axis is `Spec`, `Standards`, or `Skills`.
For `pr ready`, write a prose `## Overview`, then `## Dispositions`.
Disposition bullets use `- <round>.<finding> applied` or `- <round>.<finding> declined: <reason>`, with numbering starting at 1.
Keep the Findings or Dispositions heading without bullets when there are no findings.
Malformed review input reports line-numbered errors.

Use `operator obligation add --source <id> --key <key> --kind <kind> [--reference <ref>] --file <path|->`.
The file contains only the plain-text summary, not the former JSON envelope.
The trimmed summary must contain 1 to 2000 characters.
JSON documents, including JSON strings and scalar values, are refused.
