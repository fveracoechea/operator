---
"@fveracoechea/operator": major
---

Replace JSON question, message, and report inputs with plain text or Markdown.
Move identifiers out of JSON envelopes into flags:

- Use `operator question ask --key <key> --file <path|->` for plain-text questions.
- Use `operator question answer --source <id> --assignment <key> --key <key> --by super-agent|person --file <path|->` for plain-text answers.
- Use `operator message send --source <id> --assignment <key> --key <key> --file <path|->` for plain-text messages.
- Use `operator message ack --key <key> --file <path|->` for optional plain-text replies.
- Use `operator report submit --file <path|->` for Markdown reports.

The answer and message commands no longer accept `--text`.
`--file -` reads stdin; use a quoted heredoc to preserve literal shell punctuation.
JSON input is not a compatibility format.
The `--json` output flag remains supported.

Reports require these level-two headings: Conclusion, Evidence, Unresolved points, Supporting files, Human answers, and SuperAgent decisions.
Write the conclusion as prose and the other sections as bullets, using `- None.` for empty sections.
Use absolute supporting-file paths and `<question> Answer: <answer>` for decision bullets.
Keep human answers separate from SuperAgent decisions.
Source plans and report-promotion files remain JSON.
