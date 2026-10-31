# GitHub and documentation

Pull requests, issues, review comments, commit messages, documentation, and code comments.
The reader is a teammate who reads the text later, with no chat history.

## Tone and length

- Write neutral and friendly, like a note to a colleague. Use "I" or "we" when it helps.
- Start with the point: what changed, what is wrong, or what the reader must do.
- Stop when the reader has what they need. Skip a summary of what you already said.

## Format

- Put one sentence on each line in Markdown, so a diff shows one changed sentence.
- Use a bullet list for three or more parallel items, and a numbered list for steps.
- Use a heading only in a long body, and write it in sentence case.
- Bold the one fact a reviewer must not miss, for example a breaking change. Bold nothing else in that paragraph.
- Put code, commands, file paths, and identifiers in backticks.

## Commit messages

- Write the subject in the imperative, for example "fix the date parser". Follow the repository's prefix convention.
- Write the body as the reason for the change. The diff already shows what changed.

## Review comments

- Give the defect, its file and line, and the fix, in that order.
- Mark a blocker as a blocker. Mark a small point as optional.

## Code comments

- Write a comment only for a reason the code cannot show, such as a constraint or a gotcha.
- Keep it to one line when you can.
