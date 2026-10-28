---
name: performance-highlights
description: Update Francisco's yearly performance highlights workbook with his work since the last update.
disable-model-invocation: true
---

# Performance highlights

Francisco shares this workbook with his manager and leadership:
`~/Documents/Francisco-Performance-Highlights.xlsx`. Ask for the path only if the file is missing.

The workbook is the source of truth, because Francisco edits it by hand.
Always export it, edit the JSON, then build it again.
Run the script from this skill's directory. It makes its own venv with openpyxl on the first run.

```sh
sh scripts/workbook export <workbook.xlsx> <data.json>
sh scripts/workbook build <data.json> <workbook.xlsx>
```

The JSON holds `last_updated`, `notes` (each note starts with its year, for example `2026: ...`) and `years[]`, newest first.
Each year has `rows[]` with `rank`, `title`, `category`, `repos`, `start`, `latest`, `status`, `decision`, `result`, `why`, `cross_team`, `evidence`, `main_link`, `cross_team_link`.
Dates are `YYYY-MM-DD`. A `status` of `Shipped` shows green, any other value yellow.

## Steps

1. Export the workbook to JSON in a temp directory. The update window starts at `last_updated` and ends today.
   If today's year has no entry in `years[]`, add one and add a note for it.
2. Collect Francisco's work in the window (GitHub login `fveracoechea`). Run one read-only subagent for each source, in parallel:
   - `terzo-ai/cerebro` (the app), `terzo-ai/mystique` (design system), `terzo-ai/jarvis` (shared frontend tooling):
     merged PRs (`gh pr list --author fveracoechea --state merged --search "merged:>=DATE" --json title,body,mergedAt,additions,deletions,url,author`),
     issues he opened (specs, RFCs, maps) and ADRs added in `docs/adr`.
   - Cross-team: `gh search issues` and `gh search prs` with `--author fveracoechea --owner terzo-ai` outside those three repos,
     issues he opened that other people built,
     and Slack threads he started with other teams (backend, Nebula, NirvanAI, Design, Product) through the Slack MCP search tools.
   - The subagents only search and read. They post, react and comment on nothing.
3. Group the PRs and issues into initiatives: one decision, many PRs.
   For each initiative, update an existing row (extend `latest`, change `status`, add a result or cross-team text) or add a new row.
4. Rank the rows with the ranking rules below. Set `rank` from 1.
5. Show Francisco the proposed changes in the terminal: new rows, changed rows with before and after, and the new ranking.
   Wait for his approval. He edits the wording and the order here.
6. Set `last_updated` to today, build the workbook to the same path, and export it again.
   Compare the row counts and links with the JSON you built. Report what changed.
   Tell Francisco to open the workbook and check the Years row on `Home`.

## Ranking

- Rank first the work that makes money or makes the product better for users.
- Rank platform and tooling work high only when the product depends on it,
  for example the TanStack Start migration, or server functions and deep modules on generated schemas.
- Cross-team leadership counts a lot, for example the AG-UI chat contract with the NirvanAI backend.
  Put cross-team work in the `cross_team` field of the row it belongs to. There is no cross-team tab.
- Bundle related work into one row. Jarvis and the lint-enforced code style are one row.
  Charting and the animation engine with Design are one row.
- Put small items in one "Also worth a mention" row at the bottom.
- Francisco removed these, so keep them out: React Compiler adoption, the Figma token pipeline, the Design deltas v2 epic.

## Row rules

- Every claim has evidence: a PR, an issue, an ADR or a Slack thread. Drop a claim that has no evidence. Do not inflate.
- Check the author of every PR you credit. A PR can look like his and be by another engineer (cerebro #1137).
- Write pushback and scope cuts honestly in cross-team text: "led the negotiation", not "my design won".
- Dates: a PR merge date, or the creation date of an issue or thread. `start` is the earliest evidence, `latest` the newest.
- Write in ASD-STE100 Simplified Technical English. Use no em dashes.

## Gotchas

- Cerebro PR #1144 (2026-09-10) deleted most pre-migration product work and renumbered the ADRs,
  so `git log` shows another author on ADRs 0003 to 0011. Read the history before that commit to find the real author.
- The built file has no cached formula values. Excel, Google Sheets and Numbers compute them on open,
  but Quick Look and email previews can show the Years cells empty.
- Slack links open only for the Terzo workspace, GitHub links only for terzo-ai org members.
