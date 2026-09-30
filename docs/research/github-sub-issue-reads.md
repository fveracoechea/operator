# GitHub reads for sub-issues and blocking links

Research for [Verify GitHub reads for sub-issues and blocking links, #71][ticket].
It feeds [Choose how a source is registered from a parent issue, #70][decision].
Research date: 2026-09-30 UTC.
Scope: GitHub.com reads only.
This research did not create, edit, or comment on an issue.

## Result

GitHub gives two equal read paths: REST `sub_issues` plus one `dependencies/blocked_by` call for each child, or one GraphQL query.
Both paths return the sub-issues in the same order, and that order is a stored position, not the issue number order and not always the add order.
The blocker lists have no documented order, and REST and GraphQL return them in opposite orders.
Registration must thus take the item order from the sub-issue list, and must read each blocker list as a set.
A sub-issue or a blocker can be in a different repository, so the issue number alone does not identify an item.
The present registration input keeps one repository for each source and a bare issue number for each item, so it cannot hold a cross-repository child.

Markers in this note:

- **Verified** means that a live response in this session showed the claim.
- **Unverified** means that only the documentation states the claim, or that the claim is an inference.

## Evidence and versions

| Source | Revision or version | Limit |
| --- | --- | --- |
| GitHub REST docs, retrieved as Markdown from `docs.github.com/api/article/body` | Retrieved 2026-09-30. The pages show `X-GitHub-Api-Version: 2026-03-10`. | Published contract, not server code. [1][2][6] |
| GitHub Issues docs and the GitHub changelog | Retrieved 2026-09-30. | Product text. [3][4][5][11] |
| `github/docs` repository | Commit `d45a621cbb91a7371c49ffbb35334ece98556c2f`, 2026-09-30 14:38 UTC. | Token permission data only. [8] |
| GraphQL schema | Live introspection on 2026-09-30. | The live schema, not the published schema file. [10] |
| GitHub CLI | Installed `gh` 2.101.0, and `cli/cli` commit `fc4b137cdef0a6bd28fd461b7cf9c84a5812a8cd`, 2026-09-30 02:18 UTC. | Client behavior, not a server guarantee. [9] |
| Live responses | `gh api` reads against `fveracoechea/operator` and against public repositories, 2026-09-30. | Probes P1 to P12 below. |

REST reads without a version header received `X-Github-Api-Version-Selected: 2022-11-28` (verified, P1).
A read with `X-GitHub-Api-Version: 2026-03-10` returned the same sub-issue list for #68 (verified, P1).

## Endpoints

### REST

| Read | Path | Page size | Source |
| --- | --- | --- | --- |
| List sub-issues | `GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues` | `per_page` default 30, max 100, `page` default 1 | [1] |
| Get parent | `GET /repos/{owner}/{repo}/issues/{issue_number}/parent` | Not paged | [1] |
| List blockers | `GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by` | `per_page` default 30, max 100 | [2] |
| List blocked issues | `GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocking` | `per_page` default 30, max 100 | [2] |

All four reads need the issue **number** in the path (verified, P1 to P3).
No list read accepts a sort or a direction parameter (unverified, docs [1][2]).
Each list item is a full issue object with `id`, `node_id`, `number`, `repository_url`, `repository`, `state`, `parent_issue_url`, `issue_dependencies_summary`, and `sub_issues_summary` (verified, P1).
A token needs the fine-grained permission "Issues" with read access for all four reads (unverified, docs [8]).
An unauthenticated read of a public repository also succeeds, with a limit of 60 requests (verified, P11).

### GraphQL

The `Issue` object has these fields (verified, P5):

| Field | Type | Arguments |
| --- | --- | --- |
| `subIssues` | `IssueConnection` | `first`, `last`, `after`, `before`. No `orderBy`. |
| `parent` | `Issue` | None |
| `blockedBy` | `IssueConnection` | `first`, `last`, `after`, `before`, `orderBy: IssueDependencyOrder` |
| `blocking` | `IssueConnection` | Same as `blockedBy` |
| `subIssuesSummary` | `SubIssuesSummary` | `total`, `completed`, `percentCompleted` |
| `issueDependenciesSummary` | `IssueDependenciesSummary` | `blockedBy`, `blocking`, `totalBlockedBy`, `totalBlocking` |

`IssueDependencyOrderField` has two values: `DEPENDENCY_ADDED_AT` and `CREATED_AT` (verified, P5).
The schema has the mutation `reprioritizeSubIssue`, which "Reprioritizes a sub-issue to a different position in the parent list" (verified, P5).
Each connection accepts `first` or `last` from 1 to 100, and one call can request at most 500,000 nodes (unverified, docs [7]).
A request for `first: 101` on `subIssues` failed with `EXCESSIVE_PAGINATION` (verified, P6).

## Identifiers

| Identifier | Example for #82 | Used by |
| --- | --- | --- |
| Issue number | `82` | Every REST read path, GraphQL `issue(number:)`, `gh issue view` |
| Database id (`id`, `databaseId`) | `5649175332` | REST writes: `sub_issue_id`, blocker `issue_id`, reprioritize `after_id` and `before_id` [1][2] |
| Node id (`node_id`, `id`) | `I_kwDOUYW6qM8AAAABULeTJA` | GraphQL mutations, for example `reprioritizeSubIssue` input `subIssueId` |

REST `id` and GraphQL `databaseId` were equal for every child of #68, and REST `node_id` and GraphQL `id` were equal (verified, P1 and P7).
The number is unique only in one repository.
For a cross-repository item, the stable key is `owner/repo#number`, or the database id, or the node id.
The REST list item gives the repository in `repository_url` and `repository.full_name`, and GraphQL gives `repository { nameWithOwner }` (verified, P1 and P8).

## Order

### Sub-issues

For #68, REST and GraphQL both returned `69` to `82` in ascending order (verified, P1 and P7).
That order is also the add order in the timeline `sub_issue_added` events (verified, P4).
Repeated REST reads of #68 returned the same ETag, so the body was the same byte for byte (verified, P10).

For #1 in this repository, the list is `3 8 4 2 7 5 11 9 10 6 12 13 14`.
That is not number order, but it is the add order (verified, P4).

In 14 public parents out of 53 that this session sampled, the list order was not the add order, and the set of issues was the same (verified, P9).
Examples: `aws/graph-explorer#1618`, `CERTCC/Vultron#3409`, `google-gemini/gemini-cli#22597`.
For four of these parents, REST and GraphQL returned the same order (verified, P9).
Thus the list order is a stored position, and it is not derived from number, creation time, or add time.

The REST docs say that reprioritize moves a sub-issue "to a different position in the parent list" (unverified, docs [1]).
That the web page shows the same order as the API is unverified.
The web page loads the sub-issue list with JavaScript, and this session did not render it.
The timeline shows no event for a reprioritize in the sampled parents, so a reprioritize is not visible in the history (unverified inference, P9).

### Blockers

For #82, REST returned `69, 72, 76`, and GraphQL with no `orderBy` returned `76, 72, 69` (verified, P2 and P7).
For #26, REST returned `21, 23, 24, 25`, and GraphQL returned `25, 24, 23, 21` (verified, P12).
The GraphQL default equals `DEPENDENCY_ADDED_AT` with `DESC` in every sampled case (verified, P12).
The REST order is not the timeline add order.
For #26 the timeline adds are `23, 21, 24, 25`, all in the same two seconds, and REST returns `21, 23, 24, 25` (verified, P12).
For #12 the REST order is `11, 9`, so it is not number order either (verified, P12).
No document states a blocker order (unverified, docs [2]).
Registration must not take the item order or a meaning from the blocker order.

## Pagination and limits

A parent can have at most 100 sub-issues, and the hierarchy can have at most eight levels (unverified, docs [3]).
An issue can have at most 50 issues for each relationship type, `blocked by` and `blocking` (unverified, changelog [5]).
Thus one page of 100 holds every sub-issue, and one page of 50 holds every blocker, if these limits hold.
A reader must still check `totalCount` or the `Link` header, because the limits are product text, not an API contract.

REST pages use a `Link` header with `rel="next"` and `rel="last"` (verified, P3).
The `Link` URLs use `/repositories/{repository_id}/issues/...`, not the owner and name (verified, P3).
A `per_page` value above the maximum is reduced with no error (unverified, docs [6]).
`per_page=200` on #68 returned all 14 items, which is consistent with that rule (verified, P3).

GraphQL cursors on `subIssues` are position numbers in base64.
For #68 with `first: 5`, the end cursors were `NQ`, `MTA`, and `MTQ`, which decode to 5, 10, and 14 (verified, P7).
REST pages are also position based (`page=N`).
Thus a reprioritize, an add, or a remove between two page reads can skip or repeat an item (unverified inference).
A single page read of at most 100 items avoids this problem.

## Cross-repository items

A cross-repository sub-issue is possible.
`alkem-io/alkemio#2138` has the sub-issue `alkem-io/client-web#10361`, and REST `parent` on the child returns #2138 (verified, P8).
`openmcp-project/backlog#635` has sub-issues in four repositories (verified, P9).
The REST docs require the sub-issue to "belong to the same repository owner as the parent issue" (unverified, docs [1]).

A cross-repository blocker is possible, and also a cross-owner blocker.
`microsoft/vscode-containers#623` is blocked by `dotnet/vscode-csharp#9802`, and the reverse `blocking` read shows the link (verified, P8).
No document states a limit on the blocker repository or owner (unverified, docs [2][4][5]).

In each case, the only sign of the other repository is the `repository_url` or `repository` field on the item (verified, P1 and P8).

## What a read can miss

| Case | Behavior | Status |
| --- | --- | --- |
| Closed sub-issues | Included in `sub_issues`, with `state: closed`. #1 returns 13 closed sub-issues. | Verified, P4 |
| Closed blockers | Included in `blocked_by`. #38 returns #36 (closed) and #37 (open). | Verified, P12 |
| `issue_dependencies_summary.blocked_by` | Counts **open** blockers only. #38 shows `blocked_by: 1`, `total_blocked_by: 2`. The GraphQL description of `totalBlockedBy` is "open and closed". | Verified, P5 and P12 |
| `sub_issues_summary.total` | Equals the full list length for every parent in this repository. | Verified, P4 |
| Summary against list | A summary is a count only. It cannot name the items, so it cannot replace the list. | Verified, P1 |
| Issue number that is a pull request | `sub_issues` on #66, a pull request, returns `200` and `[]`. | Verified, P2 |
| Issue with no sub-issues | Returns `200` and `[]`, the same answer as the pull request case. | Verified, P2 |
| Missing issue | Returns `404 Not Found`. | Verified, P2 |
| `parent` on a top-level issue | Returns `404` with `"No parent issue found"`, so a 404 here is not a missing issue. | Verified, P2 |
| Items in a repository the token cannot read | Not tested. The list can omit them, or a summary can count them while the list omits them. | Unverified |
| Deleted or transferred items | Not tested, because the test needs writes. | Unverified |
| Primary rate limit | REST `core` resource, 5,000 requests each hour for this token. GraphQL 5,000 points each hour. | Verified, P2 and P7; docs [7] |
| GraphQL cost | One query for #68 with 100 sub-issues, 50 blockers, and 50 blocking each cost 2 points. | Verified, P11 |
| GraphQL resource limit | A search of 100 issues with `subIssues(first: 100)` failed with "Resource limits for this query exceeded". One parent query did not fail. | Verified, P9 |
| Secondary rate limit | At most 100 concurrent requests, and 900 REST points each minute for one endpoint. | Unverified, docs [7] |
| Conditional read | `If-None-Match` with the ETag of `sub_issues` returned `304` and did not raise `X-Ratelimit-Used`. | Verified, P10 |

## `gh` commands

REST, every sub-issue of a parent, all pages:

```sh
gh api --paginate "repos/OWNER/REPO/issues/PARENT/sub_issues?per_page=100" \
  --jq '.[] | {repo: .repository.full_name, number, id, node_id, state}'
```

REST, every blocker of one child, all pages:

```sh
gh api --paginate "repos/OWNER/REPO/issues/CHILD/dependencies/blocked_by?per_page=100" \
  --jq '.[] | {repo: .repository.full_name, number, id, state}'
```

`--paginate` follows the `Link` header (verified, P3).
`--jq` runs on each page, and `--slurp` wraps the pages in one outer array (unverified, `gh api --help` [9]).
For a cross-repository child, the blocker read must use the child's own repository from `repository.full_name`.

GraphQL, one parent in one query:

```sh
gh api graphql -F owner=OWNER -F repo=REPO -F number=PARENT -f query='
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        id databaseId number
        subIssues(first: 100) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes {
            id databaseId number state
            repository { nameWithOwner }
            blockedBy(first: 50) {
              totalCount
              pageInfo { hasNextPage }
              nodes { id databaseId number state repository { nameWithOwner } }
            }
          }
        }
      }
    }
  }'
```

`gh api graphql --paginate` needs an `$endCursor` variable and `pageInfo { hasNextPage endCursor }` (unverified, `gh api --help` [9]).
It worked on `subIssues(first: 5, after: $endCursor)` for #68 (verified, P7).
It pages one connection only, so it does not page the nested `blockedBy` lists (unverified inference).

`gh issue view N --json subIssues,blockedBy,blocking,parent,subIssuesSummary` also reads these fields (verified, P2).
It asks for `subIssues(first:100)` and `blockedBy(first:50)` and `blocking(first:50)` with no paging (unverified, `cli/cli` source [9]).
It returns blockers in the GraphQL default order, `76, 72, 69` for #82 (verified, P2).
It gives `id` (node id), `number`, `state`, `title`, and `url`, and no database id (verified, P2).

## What Operator calls today

`modules/github-api/main.ts` exposes `GithubApi.call`, which runs `gh api --include` and sorts each answer into succeeded, failed, or uncertain by HTTP status.
It has no GraphQL helper, but `call` can pass `graphql` and `-f` arguments as `args`.

`modules/github-tracker/main.ts` already has the two REST reads:

- `readSubIssues` reads `repos/{repository}/issues/{issue}/sub_issues`.
- `readBlockedBy` reads `repos/{repository}/issues/{issue}/dependencies/blocked_by`.

Both use `readPages`, with `per_page=100`, at most 20 pages, and an explicit coverage record.
A read with fewer than 100 rows on a page ends as complete.
Today only `modules/live-probe/tracker.ts` calls these two reads, to prove that the API answers.
`modules/operator-cli/fake-gh.ts` fakes both paths for tests.

The parsed `Issue` type keeps `number`, `state`, `stateReason`, `closedBy`, `closedAt`, `updatedAt`, `title`, and `body`.
It drops `id`, `node_id`, and the repository.
Thus a caller cannot tell a cross-repository item from a local one, and cannot match a blocker to a sibling in a different repository.

The registration input in `modules/crew-state/work-input.ts` has one `source.location.repository` and an item `trackerIssue` that is a positive integer.
It has no field for the item repository.

`docs/agents/issue-tracker.md` already names the native links as the canonical blocking representation.
It uses `issue_dependencies_summary.blocked_by` as the open-blocker gate, and that matches P12.

## How the new reads would fit

These are options for #70, not decisions.

1. Keep the REST path.
   Add the repository and the database id to the parsed `Issue`, or add a separate parsed shape for link reads.
   One registration then costs 1 + N REST calls for N children, which is 15 calls for #68.
2. Add one GraphQL read to `GithubTracker`, through `GithubApi.call` with `graphql` arguments.
   One registration then costs one call and about 2 points.
   The read must check `subIssues.totalCount` and each `blockedBy.totalCount` against the nodes it received, and report incomplete coverage when they differ.
3. In both options:
   - Take the item order from the sub-issue list position.
   - Treat each blocker list as a set.
   - Key items by `owner/repo#number` or by database id, not by number alone.
   - Decide what a blocker outside the parent's sub-issues means. For #68, every blocker is a sibling (verified, P7).
   - Decide how to treat closed sub-issues and closed blockers, because the lists include them.
   - Consider the `sub_issues` ETag as one part of the source revision. It changes when the list body changes, but it does not cover the blocker lists (unverified inference).

## Probes

All probes are reads.
Scratch outputs are not committed.

- **P1.** `gh api -i repos/fveracoechea/operator/issues/68/sub_issues`, and the same read with `X-GitHub-Api-Version: 2026-03-10`.
  14 items, numbers 69 to 82, with ids, node ids, `repository_url`, and both summaries.
- **P2.** `gh api repos/fveracoechea/operator/issues/82/dependencies/blocked_by` returned 69, 72, 76.
  `.../69/dependencies/blocking` returned 76, 77, 78, 82.
  `.../82/parent` returned #68.
  `.../82/sub_issues` and `.../66/sub_issues` returned `[]`, `.../99999/sub_issues` returned 404, `.../68/parent` returned 404 "No parent issue found".
  `gh issue view 82 --json blockedBy,blocking,parent,subIssues,subIssuesSummary`.
- **P3.** `sub_issues?per_page=5` with the `Link` header, `page=3`, `--paginate`, and `per_page=200`.
  `blocked_by?per_page=1` with `--paginate`.
- **P4.** Sub-issue lists of #1, #15, #35, #40, #50, and #68 against their timeline `sub_issue_added` events, in REST and GraphQL.
- **P5.** GraphQL introspection of `Issue`, `IssueDependenciesSummary`, `SubIssuesSummary`, `IssueDependencyOrder`, `IssueDependencyOrderField`, `ReprioritizeSubIssueInput`, and the mutation list.
- **P6.** `subIssues(first: 101)` on #68, error `EXCESSIVE_PAGINATION`.
- **P7.** One GraphQL query of #68 with every sub-issue and its blockers, cost 1.
  `blockedBy` on #82 with each `orderBy` value.
  `--paginate` on `subIssues(first: 5)`.
- **P8.** `alkem-io/alkemio#2138` sub-issues and `alkem-io/client-web#10361` parent.
  `microsoft/vscode-containers#623` blockers and `dotnet/vscode-csharp#9802` blocking.
- **P9.** GraphQL issue search for public parents, then REST `sub_issues` against timeline add order for 53 parents, and REST against GraphQL order for four of them.
- **P10.** Two reads of `sub_issues` on #68 with `If-None-Match`, both `304`, `X-Ratelimit-Used` unchanged.
- **P11.** Unauthenticated `curl` of `sub_issues` on #68, `x-ratelimit-limit: 60`.
  GraphQL query of #68 with `blockedBy(first: 50)` and `blocking(first: 50)` on 100 sub-issues, cost 2.
- **P12.** For every issue in this repository with more than one blocker: REST `blocked_by`, timeline `blocked_by_added` events, and GraphQL `blockedBy` with each order.
  `issue_dependencies_summary` on #38 and #42.

## Sources

1. [REST API endpoints for sub-issues](https://docs.github.com/en/rest/issues/sub-issues)
2. [REST API endpoints for issue dependencies](https://docs.github.com/en/rest/issues/issue-dependencies)
3. [Adding sub-issues](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues)
4. [Creating issue dependencies](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies)
5. [Dependencies on issues, GitHub changelog, 2025-08-21](https://github.blog/changelog/2025-08-21-dependencies-on-issues/)
6. [Using pagination in the REST API](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)
7. [Rate limits and query limits for the GraphQL API](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)
8. [`github/docs` fine-grained token permissions, `src/github-apps/data/fpt-2026-03-10/fine-grained-pat-permissions.json`](https://github.com/github/docs/blob/d45a621cbb91a7371c49ffbb35334ece98556c2f/src/github-apps/data/fpt-2026-03-10/fine-grained-pat-permissions.json)
9. [`cli/cli` `api/query_builder.go`](https://github.com/cli/cli/blob/fc4b137cdef0a6bd28fd461b7cf9c84a5812a8cd/api/query_builder.go) and `gh api --help` in `gh` 2.101.0
10. GraphQL introspection at `https://api.github.com/graphql`, 2026-09-30
11. [Browsing sub-issues](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/browsing-sub-issues)

[ticket]: https://github.com/fveracoechea/operator/issues/71
[decision]: https://github.com/fveracoechea/operator/issues/70
