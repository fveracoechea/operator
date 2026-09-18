# GitHub tracker concurrency and lost-response recovery

Research for [Verify conflict-safe GitHub tracker updates, #13][ticket].
Status: result submission for separate review, not accepted completion or publication approval.
Research date: 2026-09-18 UTC, during the 2026-09-17 local session.
Scope: GitHub.com issue bodies, issue comments, closure, and the approved map-index update.

## Result

The reviewed GitHub contracts do not provide a supported conditional issue-body replacement.
GitHub explicitly states that conditional requests for unsafe methods, including `PATCH`, are unsupported unless the endpoint documents an exception.
The issue-update documentation and both reviewed REST version contracts contain no such exception.
The published GraphQL `UpdateIssueInput` has no expected-version field. [1][2][3][4][5]

Keep shared-body replacement blocked under the [approved tracker policy][policy].
A fresh read, a local request ID, a body hash, or a read after writing does not provide server-enforced rejection of a stale replacement.
This conclusion follows from the contracts and the race described below, not from a live mutation test.

The APIs provide useful evidence after a lost response, but no documented exactly-once comment creation or request-result lookup for these operations.
`clientMutationId` is a client identifier present in mutation input and output, not a documented uniqueness constraint or retry key.
Keep a verified resolution comment and verified closure when the map update cannot proceed. [5][6][7][policy]

## Evidence and versions

| Source | Revision or version inspected | Evidence limit |
| --- | --- | --- |
| GitHub REST OpenAPI | `github/rest-api-description` commit `d4278c869e367f5d6d4e0f46878119128abba77b`, committed 2026-09-17 17:22:09 UTC | Published contract, not GitHub server implementation. |
| REST version files | `descriptions/api.github.com/api.github.com.2022-11-28.json` and `api.github.com.2026-03-10.json` at that commit | Both versions were checked for issue-update and comment-create parameters and responses. [2][3] |
| GitHub documentation and GraphQL schema | `github/docs` commit `2320b38e746de554f7f3d2b83520bc0f26485abc`, committed 2026-09-17 20:32:58 UTC | The schema is `src/graphql/data/fpt/schema.docs.graphql`, the published GitHub.com schema, not live introspection. [1][5] |
| GitHub CLI source | `cli/cli` commit `0cf1092493af067646fc5f3db9421c6a6ec9c938`, committed 2026-09-15 14:11:20 UTC | Explains the inspected client's close workflow, not a server guarantee or a claim about the installed CLI revision. [9] |
| HTTP semantics | RFC 9110, June 2022 | Defines conditional request and retry semantics, not GitHub endpoint support. [10] |
| HTTP PATCH | RFC 5789, March 2010 | Defines PATCH and discusses collisions and lost responses. [11] |

GitHub documents `X-GitHub-Api-Version` as the REST version selector.
At retrieval, `2026-03-10` and `2022-11-28` were supported, and requests without this header defaulted to `2022-11-28`.
The listed end of support for `2022-11-28` was March 10, 2028.
The OpenAPI document's `info.version` value of `1.1.4` is not the REST date-version selector. [2][3][8]

GraphQL calls use `https://api.github.com/graphql` and schema-defined inputs.
This report pins the published schema revision rather than treating the REST version header as a GraphQL schema pin. [5][12]
Read-only source retrieval used `gh api`, official documentation, and RFC pages.
The source-retrieval requests did not specify a REST date-version header.
The version-specific JSON files, not the retrieval request's version, define the two contracts examined here.

## Capability matrix

In this table, "verified" means verified in the cited documentation, contract, or source.
It does not mean tested against a live mutation endpoint.

| Capability | Documented behavior | Pre-write rejection of a competing edit? | Finding |
| --- | --- | --- | --- |
| REST conditional issue read | `GET` with `If-None-Match` or `If-Modified-Since` can return `304`. [1][4] | No. It checks the read, not a later write. | Verified read capability. |
| REST issue-body replacement | `PATCH` accepts a `body` string or null. No documented conditional-write exception, expected body, or expected revision. [1][2][3][4] | No supported guarantee found. | Unsupported by the documented general rule. Actual handling of supplied conditional headers was not tested. |
| GraphQL issue-body replacement | `updateIssue` accepts `id`, `body`, and other update fields. No expected-version input. [5] | No documented comparison available. | Verified absence from the published input schema. |
| `updated_at`, `updatedAt`, body hash | Can describe an observation or support a client comparison. They are not issue-update preconditions. [2][5] | No. | Client observation only. |
| REST comment creation | `POST` accepts required `body`; success is `201` with a comment resource. No documented idempotency key. [2][3][6] | No duplicate-suppression guarantee. | Contract absence, not proof that all repeated bodies always create duplicates. |
| GraphQL comment creation | `addComment` accepts `subjectId`, `body`, and optional `clientMutationId`. [5] | No documented duplicate-suppression guarantee. | Identifier is not a promised deduplication mechanism. |
| Marker in comment body | Raw comment bodies and server comment IDs can be read and compared. [6][7] | No. Two callers can both observe absence before creating. | Possible client reconciliation convention, not an approved format or server constraint. |
| Issue closure | REST `state: "closed"` or GraphQL `closeIssue`; state and closure evidence can be read. [2][4][5] | No expected-state or expected-version guard in these inputs. | Desired state can be observed later, but operation attribution can remain uncertain. |
| Map-index replacement | Uses the same issue-body update contract. [2][5] | No supported guarantee found. | Block replacement under the approved policy. |

## Endpoint and field details

### REST issue update

The endpoint is `PATCH /repos/{owner}/{repo}/issues/{issue_number}` with an `application/json` request body.
`body` is the contents of the issue, as a string or null.
This is an update to the body field, not a documented append operation or JSON Patch operation with a `test` instruction. [2][3][4]

The `2026-03-10` request properties are `title`, `body`, `state`, `state_reason`, `duplicate_issue_id`, `milestone`, `labels`, `assignees`, `issue_field_values`, and `type`.
The `2022-11-28` contract also has the deprecated singular `assignee` field.
Neither contract declares `If-Match`, `If-Unmodified-Since`, an expected body, an expected timestamp, or an expected revision for this endpoint. [2][3]

The endpoint documentation recommends `Accept: application/vnd.github+json` and identifies the REST version header.
Its update section documents no conditional-write exception.
GitHub's explicit general rule is:

> Conditional requests for unsafe methods, such as `POST`, `PUT`, `PATCH`, and `DELETE` are not supported unless otherwise noted in the documentation for a specific endpoint. [1]

The published update responses are `200`, `301`, `403`, `404`, `410`, `422`, and `503`.
There is no documented stale-version `409` or `412` result for this operation.
Missing response entries alone would not prove impossibility, since endpoint response lists need not describe every operational error.
Here they support the explicit general rule rather than replace it. [1][2][3][4]

### GraphQL issue update

The mutation is `updateIssue(input: UpdateIssueInput!): UpdateIssuePayload`.
The complete input field list at the pinned revision is:

```text
agentAssignment, assigneeIds, assignees, body, clientMutationId, id,
issueFieldUpdates, issueType, issueTypeId, labelIds, labels, milestoneId,
projectIds, state, stateInput, title
```

`id: ID!` identifies the issue and `body: String` supplies the description.
There is no `expectedVersion`, `expectedUpdatedAt`, `expectedBody`, or equivalent input.
The output has `actor`, `clientMutationId`, and `issue`.
Reading `issue.updatedAt` or `issue.body` in that output is observation after the mutation, not an input condition. [5]

The same published schema has `expectedHeadOid: GitObjectID!` on `CreateCommitOnBranchInput`.
That field is specific to a Git branch commit and is absent from `UpdateIssueInput`.
It must not be borrowed as evidence of issue-body conflict safety or as a proposal to move the map. [5]

### Comments and closure

REST comment creation is `POST /repos/{owner}/{repo}/issues/{issue_number}/comments`.
Its only documented JSON property is required `body: string`.
A successful `201` returns a comment with identifiers and URLs, and the OpenAPI response declares a `Location` header.
Documented errors are `403`, `404`, `410`, and `422`.
Creation triggers notifications and is subject to secondary rate limiting.
The contract does not define `Idempotency-Key`, a client-selected comment ID, a deduplication window, or behavior for reusing a request key. [2][3][6]

GraphQL `addComment(input: AddCommentInput!)` accepts `subjectId: ID!`, `body: String!`, and optional `clientMutationId: String`.
`AddCommentPayload` exposes `clientMutationId`, `commentEdge`, `subject`, and `timelineEdge`.
GitHub describes `clientMutationId` as "A unique identifier for the client performing the mutation."
It does not promise uniqueness enforcement, replay of a stored response, rejection of changed input under that ID, or lookup of a previous result by that ID.
`IssueComment` has no `clientMutationId` field for later retrieval.
Treat the input/output identifier as correlation data, not server-supported idempotency. [5]

REST closure uses the issue-update endpoint with `state: "closed"` and, when needed, `state_reason`.
The REST contract says it ignores `state_reason` unless `state` changes.
Thus sending `state: "closed"` again is not a documented way to correct the reason on an already closed issue. [2][4]

GraphQL `closeIssue(input: CloseIssueInput!)` requires `issueId`.
Optional inputs are `clientMutationId`, `stateReason`, `duplicateIssueId`, `confidence`, `isSuggestion`, and `rationale`.
None is an expected-state or expected-version condition.
`isSuggestion: true` records a pending suggestion, not an applied closure.
The output has `clientMutationId` and `issue`. [5]

## Read validators are not write guards

GitHub documents ETag and Last-Modified use for conditional `GET` requests.
An unchanged selected representation can produce `304 Not Modified`.
That response can validate a cached read, but it does not reserve the issue or promise that the next write will see the same contents. [1][10]

HTTP defines stronger mutation conditions, but GitHub must support them on the endpoint before Operator can rely on them:

| Header or value | HTTP semantics | Consequence here |
| --- | --- | --- |
| `If-Match: "tag"` | Strong entity-tag comparison before the method. A false condition must not perform the requested method. The server may report `412`, or a success response when the change appears already applied. RFC 9110 section 13.1.1. | This is the kind of pre-write guard needed, but GitHub does not document support for issue updates. [1][4][10] |
| `W/"tag"` | A weak ETag does not satisfy strong comparison. RFC 9110 section 8.8.3.2. | Do not remove `W/` to manufacture a strong validator. No issue-specific validator strength was tested. [10] |
| `If-Match: *` | Tests whether a current representation exists. | Even with support, it would not check the revision of an existing issue. [10] |
| `If-None-Match` | Weak comparison is suitable for read revalidation. For unsafe methods, its defined condition is non-match, not match. | It is not a substitute for `If-Match`, and no issue-write support is documented. [1][10] |
| `If-Modified-Since` | Applies to `GET` or `HEAD`; recipients must ignore it on other methods. | It cannot guard PATCH. [10] |
| `If-Unmodified-Since` | Tests the last modification date before the method. It is ignored when `If-Match` is present or no modification date exists. | No issue-write support is documented. HTTP-date precision can also miss changes within one second unless the validator meets the standard's strength conditions. [1][10] |
| `updated_at` or `updatedAt` | Application response fields, not HTTP conditional request headers. | Their presence does not add an accepted precondition to the mutation contract. [2][5] |

RFC 5789 states that PATCH is not inherently idempotent.
It recommends conditional requests for changes that require a known base.
Its all-or-nothing patch requirement does not make a client's earlier GET and later PATCH one atomic operation. [11]

The following sequence shows the lost-update risk:

1. Operator reads body A and prepares A plus its map pointer.
2. Another writer replaces A with B.
3. Operator sends its replacement derived from A.
4. Without a server-enforced precondition, the write can replace B.
5. A later read can return exactly Operator's intended body, even though B was lost.

This is reasoning about the contract, not an observed test result.
A second read before step 3 moves the race window but does not remove it.
A read after step 3 can detect some later changes, but cannot establish that no prior edit was overwritten.
A local queue only serializes callers that use that queue.
It does not exclude a human, another installation, an old in-flight request, or another integration.
GitHub's recommendation to serialize requests for rate limits is not a cross-client lock. [1]

## Lost-response recovery

The approved workflow has separate resolution-comment, closure, and map-index steps. [policy]
A timeout or lost response after transmission leaves the remote effect uncertain.
It does not establish that GitHub rejected the operation.
RFC 9110 section 9.2.2 advises against automatic retry of a non-idempotent request without knowledge that retry is safe or that the first request was never applied. [10]
Recovery reads must obtain or revalidate current data rather than rely on an unchecked local cache.
RFC 5789 section 5 recommends a GET after a transport failure and notes the need to bypass caches when checking the result. [11]

### Resolution-comment creation

Read comments through `GET /repos/{owner}/{repo}/issues/{issue_number}/comments`.
The endpoint orders comments by ascending ID, defaults to 30 per page, and supports up to 100 per page.
Follow pagination links and compare raw `body`, not only rendered text.
`since` filters by last-update time, not by request identity or creation time. [2][7]

If a comment ID was recorded before the interruption, read `GET /repos/{owner}/{repo}/issues/comments/{comment_id}` and validate its issue, author, and contents. [6]
If no server ID survived, an approved operation marker in the body could help find the intended comment.
The client would need to persist that marker and exact intended contents before sending.
This is a possible reconciliation convention, not a feature already approved or enforced by GitHub.

| Observation after loss | What it establishes | Safe consequence under the existing policy |
| --- | --- | --- |
| One comment matches the recorded operation marker, expected actor, target, and contents | A matching comment exists at the time of the read. Attribution depends on the client marker convention. | Record its server ID and URL as recovery evidence. Do not create another comment merely because the response was lost. |
| A marker matches, but the contents or actor differ | The observed data do not establish the intended effect. | Report a conflict for review. Do not overwrite or delete the comment automatically. |
| More than one matching comment exists | Duplicate or ambiguous records exist. | Stop automatic creation and request a disposition. No automatic cleanup follows. |
| No matching comment is found | No match was observed in the accessible pages. | Keep the outcome uncertain. Absence is not proof that the original request never applied or cannot still apply. |
| A read fails, returns an access-related `404`, or pagination is incomplete | Observation is incomplete. | Do not treat this as absence or authorize a retry. |

The reviewed contracts provide no snapshot guarantee for a multi-page scan, visibility deadline, or request-status lookup that proves non-application.
Comments can also be edited or deleted. [5][6][7]
Two senders can both scan, find no marker, and then both create a comment.
The marker therefore supports observation, not exactly-once creation.
Sending the same `clientMutationId` again does not remove this risk under the published contract. [5]

### Issue closure

Read the issue's `state`, `state_reason`, `closed_at`, and `closed_by` where available.
For more context, the GraphQL schema exposes `ClosedEvent` and `ReopenedEvent` with actor, time, and event ID.
These events do not contain a `clientMutationId` that links them to the lost request. [2][5]

| Observation after loss | What it establishes | Recovery consequence |
| --- | --- | --- |
| Issue is closed with the intended reason | The desired state is currently present. | Avoid another close. Record state convergence, not proof that this request caused it. |
| Issue is closed with a different reason | The intended state-and-reason condition is not satisfied. | Report a conflict. Do not reopen and close merely to repair the reason without approval. |
| Issue is open | The desired state is absent now. The close may have failed, may still be in flight, or may have succeeded before a reopen. | Inspect available events and require reconciliation before another close. |
| State or events cannot be read | The outcome remains unknown. | Keep the closure step uncertain and preserve any verified comment. |

Repeated assignment of `closed` converges on the same state when no intervening writer exists.
It is not a guarantee of one closure event or safe behavior after another actor reopens the issue.
A later close can defeat that reopen, and no expected-state token prevents this in the reviewed inputs. [2][5]

The inspected `gh issue close --comment` implementation first reads the issue, returns early if it is already closed, otherwise creates the comment, then sends `closeIssue`.
It is not one atomic server operation.
If the comment succeeds and closure fails or its response is lost, blindly replaying the combined command can either repeat the comment or skip work because the issue is now closed.
The client's initial state check is not a server precondition. [9]

### Map-index replacement

Under the approved policy, no new replacement should be sent without a verified conflict guard.
The cases below explain recovery from an already uncertain write; they do not authorize one.

| Observation after loss | What it establishes | Recovery consequence |
| --- | --- | --- |
| Raw body equals the intended replacement | Those bytes are present now. | Record an observation, but do not claim conflict-safe preservation. A competing edit might already have been overwritten. |
| The intended pointer exists in a different body | The pointer is present alongside current contents. | Do not replay the old full body. Whether the map step can be accepted needs an explicit evidence rule. |
| Body differs or the pointer is absent | Current contents differ from the intended result. | Do not replace them from the old snapshot or automatically restore the old body. Keep the map step blocked or uncertain. |
| Body equals the old base | The old bytes are present now. | Do not infer that the write never occurred. A later edit or an in-flight request remains possible. |

Retain the original base, intended contents, and available observations as evidence if the operation records contain them.
Edit history can help an investigation, but the schema's `UserContentEdit` has nullable `diff` and deletion fields.
It is not a promised complete, immutable write receipt or a substitute for pre-write rejection. [5]
Never repeat the resolution comment or undo a verified closure because the map step failed. [policy]

## Practical consequences and follow-up decisions

These are consequences for the approved interface, not production implementation or a replacement map design.

1. Keep the body-replacement capability unavailable until its pre-write conflict guarantee is verified.
   The evidence required to change that status is an endpoint-specific supported contract for stale-write rejection, including the validator, comparison scope, and failure semantics.
   A successful read check or one successful mutation is not that evidence.
2. Preserve separate outcomes for the resolution comment, closure, and map update.
   Under the existing exit-code contract, an unavailable guard before dispatch fits blocked code `3`, an observed state conflict fits code `4`, and an uncertain transmitted effect fits code `5`.
   Exact tracker reason strings and evidence rules still require specification. [policy]
3. Decide whether to seek an endpoint-specific guarantee from GitHub or leave automatic map replacement blocked.
   If no guarantee is available, any change to the approved map or preservation rule requires a separate explicit decision.
   This report does not choose a new tracker, another map representation, or a manual-edit bypass.
4. Decide the comment recovery convention before relying on it.
   Specify the logical operation identity across attempts, marker format and scope, exact-content comparison, expected actor checks, and treatment of multiple matches or an edited marker.
   Also decide who can authorize another creation when absence cannot prove non-application, and what duplicate risk that authorization accepts.
5. Decide whether closure recovery accepts observed desired state or requires evidence that Operator caused the transition.
   Specify the handling of reason mismatches and intervening reopen events.
   State observation alone cannot meet an operation-attribution requirement.
6. Decide what completion and user-visible status mean while the authoritative decision is recorded but the map pointer remains blocked.
   The existing policy already preserves prior verified steps; it does not supply the exact tracker completion criteria for this case.
7. If empirical mutation checks are later needed, obtain separate approval for an isolated fixture and its writes.
   A useful check would include a stale conditional replacement, competing writers, repeated comment identity, and a lost-response recovery case.
   Such a check would establish observed behavior for the tested version and conditions, not convert undocumented behavior into a supported guarantee.

No elapsed timeout by itself proves that an in-flight request cannot later complete.
No local request-ID or database-revision rule creates atomicity across SQLite and GitHub. [policy]

## Verified findings and limits

Verified from primary sources:

- GitHub explicitly excludes conditional unsafe requests unless an endpoint documents an exception, and the reviewed issue-update documentation has no exception. [1][4]
- Both REST date-version contracts lack an issue-update precondition or comment-create idempotency key. [2][3]
- The pinned GraphQL issue-update input lacks an expected-version field, and the comment and closure inputs provide no documented retry guarantee. [5]
- Read APIs expose comment IDs, bodies, issue state, and event evidence useful for reconciliation. [2][5][6][7]
- The inspected CLI's comment-and-close workflow uses separate client steps. [9]
- HTTP distinguishes read revalidation, pre-write conditions, idempotence, and observation after a lost response. [10][11]

Not verified:

- Actual handling of `If-Match` or `If-Unmodified-Since` on GitHub issue PATCH requests, including whether an unsupported header is ignored or rejected.
- Live duplicate behavior for repeated REST comment bodies or GraphQL `clientMutationId` values.
- Server retention, visibility, and timing guarantees beyond the published contracts.
- A live stale-write, concurrent-writer, timeout, or recovery scenario.
- Any claim that a matching post-write read proves preservation of all competing edits.

No mutation tests, temporary GitHub issues, tracker writes, production changes, commits, pushes, pull requests, agent-configuration changes, or cleanup were performed.
No GitHub server implementation was inspected.
The only authored workspace artifact is this report.
The Operator retains authority for tracker updates, publication, and any follow-up approval.

## Sources

[ticket]: https://github.com/fveracoechea/operator/issues/13
[policy]: https://github.com/fveracoechea/operator/issues/10#issuecomment-5723397830

1. [GitHub REST best practices, pinned source](https://github.com/github/docs/blob/2320b38e746de554f7f3d2b83520bc0f26485abc/content/rest/using-the-rest-api/best-practices-for-using-the-rest-api.md#use-conditional-requests).
   See conditional requests, request serialization, pagination, rate limits, and `404` cautions.
2. [GitHub.com OpenAPI, REST `2026-03-10`, pinned JSON](https://github.com/github/rest-api-description/blob/d4278c869e367f5d6d4e0f46878119128abba77b/descriptions/api.github.com/api.github.com.2026-03-10.json).
   Inspect `paths["/repos/{owner}/{repo}/issues/{issue_number}"].patch`, `paths["/repos/{owner}/{repo}/issues/{issue_number}/comments"]`, `components.schemas.issue`, and `components.schemas["issue-comment"]`.
3. [GitHub.com OpenAPI, REST `2022-11-28`, pinned JSON](https://github.com/github/rest-api-description/blob/d4278c869e367f5d6d4e0f46878119128abba77b/descriptions/api.github.com/api.github.com.2022-11-28.json).
   Inspect the same issue-update and comment-create paths.
4. [GitHub REST issue endpoints, `2026-03-10`](https://docs.github.com/en/rest/issues/issues?apiVersion=2026-03-10#update-an-issue).
   Live documentation retrieved 2026-09-18 UTC; see Get an issue and Update an issue.
5. [GitHub.com GraphQL schema, pinned source](https://github.com/github/docs/blob/2320b38e746de554f7f3d2b83520bc0f26485abc/src/graphql/data/fpt/schema.docs.graphql).
   Entry lines at this revision: `AddCommentInput` 492, `AddCommentPayload` 512, `CloseIssueInput` 4979, `CloseIssuePayload` 5019, `ClosedEvent` 5064, `CreateCommitOnBranchInput` 8097, `IssueComment` 21016, `ReopenedEvent` 50735, `UpdateIssueInput` 70037, `UpdateIssuePayload` 70162, and `UserContentEdit` 73682.
6. [GitHub REST issue-comment endpoints, `2026-03-10`](https://docs.github.com/en/rest/issues/comments?apiVersion=2026-03-10#create-an-issue-comment).
   Live documentation retrieved 2026-09-18 UTC; see create, get, edit, and delete operations.
7. [GitHub REST list issue comments, `2026-03-10`](https://docs.github.com/en/rest/issues/comments?apiVersion=2026-03-10#list-issue-comments).
   Live documentation retrieved 2026-09-18 UTC; pagination and ordering also appear in source 2.
8. [GitHub REST API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions), retrieved 2026-09-18 UTC.
   See also the [pinned version table](https://github.com/github/docs/blob/2320b38e746de554f7f3d2b83520bc0f26485abc/data/tables/rest-api-versions.yml) and [pinned version-header guidance](https://github.com/github/docs/blob/2320b38e746de554f7f3d2b83520bc0f26485abc/content/rest/about-the-rest-api/api-versions.md).
9. [GitHub CLI issue close implementation, pinned source](https://github.com/cli/cli/blob/0cf1092493af067646fc5f3db9421c6a6ec9c938/pkg/cmd/issue/close/close.go).
   See `closeRun`, its already-closed check, `CommentableRun`, and `apiClose`.
10. [RFC 9110, HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html).
    Relevant sections are [8.8, validators](https://www.rfc-editor.org/rfc/rfc9110.html#section-8.8), [9.2.2, idempotence and retries](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2), and [13, conditional requests](https://www.rfc-editor.org/rfc/rfc9110.html#section-13).
11. [RFC 5789, PATCH Method for HTTP](https://www.rfc-editor.org/rfc/rfc5789.html).
    See section 2 for collisions and atomic application, section 2.2 for error handling, and section 5 for recovery after transport failure.
12. [GitHub, Forming calls with GraphQL](https://docs.github.com/en/graphql/guides/forming-calls-with-graphql), retrieved 2026-09-18 UTC.
    See the endpoint, input objects, and mutation payload descriptions.
