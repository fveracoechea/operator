# Review draft

The draft is one JSON object. The CLI refuses unknown fields and a wrong shape before any post.

```json
{
  "reviewedCommit": "<full 40-character PR head>",
  "summary": "One line about the change.",
  "blockers": [
    {
      "short": "Guard has no test",
      "detail": "The new refusal in src/a.ts has no test that fails without it.",
      "path": "src/a.ts",
      "line": 42,
      "breach": { "source": "opinions", "rule": "Verify every guard against a deliberate break." }
    }
  ],
  "niceToHaves": [{ "detail": "Name the constant for its use." }],
  "threadReplies": [
    { "threadId": "PRRT_kwDO...", "kind": "acknowledge", "body": "Your reason holds. The guard covers it." },
    { "threadId": "PRRT_kwDP...", "kind": "explain", "body": "The file still stays open on the error path." }
  ],
  "checks": [
    { "kind": "test", "command": "bun test src/a.test.ts", "exitCode": 0 },
    { "kind": "guard-break", "command": "bun test src/a.test.ts with the guard removed", "exitCode": 1 }
  ],
  "noise": [{ "check": "docs", "files": ["legacy/old.md"], "reason": "It fails on main too." }]
}
```

## Limits

- At most three `blockers` and three `niceToHaves`.
- A blocker's `short` has at most six words.
- Give `path` and `line` together, or neither. `path` is a file that the PR changes, relative to the repository root, with no `..`.
- `breach.source` is `opinions`, `project-skill`, or `architecture`.
- `checks[].kind` is `test`, `lint`, `typecheck`, `guard-break`, or `other`.
- The draft names no event. The CLI computes it.
- `threadReplies` names only threads that the posting account started, at most once each.

## Thread replies

In a later round, check each of your open review threads on the PR.

- A fixed defect needs no entry, also when the author resolved its thread.
- Valid pushback gets one `acknowledge` reply.
- A defect that remains gets one `explain` reply. The CLI reopens the thread when the author resolved it.
- A defect from an earlier round that the author did not answer stays in `blockers`, so the round cannot approve while it remains.

An `explain` reply keeps a blocker open, so the round cannot approve.
The CLI posts the review first, then each reply. A reply that lost its answer is found by its marker, so a repeated post does not reply twice.

## Required CI and noise

The CLI reads the required CI checks of the PR itself.
A failing required check becomes a blocker in the posted review.
Your `checks` stay reported evidence, and the CLI does not run them again.
A repository with no required CI gets only your reported checks.

A `noise` claim says that a failing required check fails only in files that the PR does not change.
It names the check and cites the files.
The post refuses a claim that cites a changed file, or that names no failing required check.
A valid claim removes that check from the blockers and shows it as noise.

## The event

The CLI computes the event in this order:

1. The PR author's own account posts, or the request is the reviewer of a PR assignment: `COMMENT`.
2. A blocker names a `breach`: `REQUEST_CHANGES`, and the body names the breach.
3. A blocker or a failing required check remains: `COMMENT`.
4. No blocker remains: `APPROVE`.

An approval waits until every required check has finished. While one runs, the post refuses with `review_ci_pending`. Post again after CI finishes.
A comment with no blocker says so plainly, so that the PR owner sees a clear result.
