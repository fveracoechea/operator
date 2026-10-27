# Working with agents

## Skills

- A skill is a small router with topic files that load only when a task needs them. Split on the second topic, not below about 150 lines.
- A skill description says when to load and nothing else. Every agent pays for it on every turn.
- Skills are not software. A skill is a prompt that you pay for every time it runs. When its procedure has proven to work, turn it into a CLI command, a lint rule, or a check. The skill then shrinks to a pointer to that tool.
- A skill that edits what a check reads names that check and runs it, because the skill can delete what the check requires. The check is the software, and the skill defers to it.
- A skill example that says what a tool reports is a claim. Run it through that tool, or make it a fixture test. Three React Compiler examples in one skill were wrong, and the linter found each error in a minute.
- Headings are the rule index. A separate rules list is a copy that drifts.
- A skill owns one seam and names its neighbours. The package skill covers the API, the team skill covers the conventions on top.
- Every skill has one home. Author it instead of shadowing a vendored copy.
- An agent resolves a personal skill before a project skill of the same name, so a personal install of a team-managed skill shadows it everywhere with no warning. Install personally only what no project owns.
- Write to the portable frontmatter floor. A field one agent silently drops makes a skill look correct in both and behave differently.

## Acting for Francisco

- Mark facts verified or unverified. Settled decisions stay settled.
- Name the checkable rule, such as a lint rule id, instead of asserting a prohibition.
- Track the feedback you receive, so a mistake corrected once does not repeat in the next module.
- The step that reads untrusted content never holds a write token. One audited write path.
