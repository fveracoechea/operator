# @fveracoechea/operator

## 0.7.1

### Patch Changes

- 6db320b: A Claude Code Operative now starts with any number of write paths and allowed commands.
  Dispatch writes the allow list to `.operator/local/claude-settings.json` in the worktree and passes `--settings <file>` in place of `--allowedTools <entries...>`.
  The launch line has the same length for every brief, so it stays inside the 1024-byte terminal input limit of macOS.
  The permissions do not change: `dontAsk`, the same allow list, and no permission prompt.
  The launch identity covers the settings content, so a recovery starts with the same permissions.

## 0.7.0

### Minor Changes

- 77b8700: After you upgrade, run `setup plan` and apply the plan.
  Until you apply it, `setup readiness` reports `instructions_missing` and names the earlier Operator section of `AGENTS.md`.
  `setup plan` proposes the new section in place of the section that an earlier release wrote.
  The new section tells an agent to read and change Operator configuration and state only through CLI commands.
  It no longer names the configuration file.
  It says that an agent reads its dispatch brief, the fixed artifacts, and each file that a CLI result names.
  It also says that an agent may write JSON requests for `--input`.

### Patch Changes

- 6a086c7: `operator crew next` now names the submitted commit in the `dispatch_attempt` action of a review and of a findings or diagnostic rework.
  The `command` reads `operator attempt dispatch --attempt <id> --commit <sha>`, and the `detail` names the same commit.
  Before, the action named no commit, `attempt dispatch` with no `--commit` refused with `commit_required`, and the Operator had to read the commit from Git.
- 77b8700: `operator --version` now also shows the release that the project selected.
  `operator --version --json` reports it under `data.selection`.
  A selected release has its `delivery`, `version`, `commit`, `packageVersion`, and `invocation`.
  The `invocation` is the command that runs Operator in the project.
- 77b8700: `operator config plan` now ends with the exact `config apply` command to approve, with the same `--set` and `--unset` flags.
  Only `config plan` shows that command.
  When `config apply` refuses with `approval_required` or `approval_stale`, it shows the current plan and points to `config plan` again.
  So the person approves each changed plan before an agent can apply it.
- 649c40f: `operator gate run` now reports a started runner as `pending` with `gate_run_started`.
  Herdr accepts the runner line with exit 0 and an empty answer.
  Before, Operator read that empty answer as `uncertain` with `gate_runner_not_typed` while the runner ran.
  An answer that is lost, or that Operator cannot read, is still `uncertain`.
- 0d4cd77: A producer brief now states how to compute the content identity of a path artifact: the SHA-256 hex digest of the file bytes.
  The rule appears beside `attempt submit` with the `artifact_identity_changed` refusal, so an Operative builds its result from the brief alone.
- 86009c8: `operator cleanup close` no longer refuses an Operative because its checkout holds Git-ignored files, such as the `node_modules` that an install command of the gate writes.
  A closure deletes no file, and `operator cleanup remove` still refuses a checkout with ignored files that nobody registered.
  The `unexpected_work` and `unexpected_files` blockers now name the first 20 paths, and `omitted` counts the rest.
- 77b8700: In `--json` results, a missing configuration and a configuration that needs recovery now give a `nextAction`.
- 77b8700: In `--json` results, readiness next actions and the probe fixture credential now name the command that runs the selected release.
  The other commands already do this.
- 9f51c22: `attempt dispatch` no longer refuses a launch because crew work changed an Operator-owned skill that the project tracks.
  Before, a result that edited a tracked skill copy made every later launch at that commit fail at `input_preparation` with `skill_copy_conflict`, so the result could not be reviewed and no later production dispatch could start from the integration branch.
  Now a launch keeps a committed copy that changed after the integration base, and the launch snapshot and the brief name it.
  A skill directory that crew work removed after the integration base stays removed, so the worktree holds the commit under review.
  A copy that already differs at the integration base still refuses, so a copy that a person changed is never replaced.
- 77b8700: A cleanup that refuses with `identity_mismatch` now names a malformed control reference apart from a missing one.
  For a malformed reference, the `control-reference` mismatch reports `found` as `malformed:` with the problem and each field that has no usable value.
  A missing reference still reports `none`.
- 17a1207: An Operative takes every fact of its attempt from its brief and from CLI results, and never opens the control reference.
  A command that an Operative runs now refuses with `attempt_reference_malformed` when the control reference is not a readable file, is not JSON, is not an object, or is not complete.
  The refusal names the problem and each field that has no usable value, and it no longer says that the directory carries no reference.
  Each brief now states each of these refusals beside each command that can give it: `attempt acknowledge`, `attempt submit`, `question raise`, `question acknowledge`, and `review report`.
  The answer that `question deliver` sends states the refusals of `question acknowledge` in the same words.
  The `operative` skill tells the Operative to read only the brief and the files it names under `.operator/local/`.
- 77b8700: The `operator` skill now reads the selected release from `operator --version --json` and takes the invocation from it.
  It no longer reads the release selection file.
  No shipped skill names the configuration, its editor schema, the release selection, the readiness evidence, the control reference, the launch record, the setup journal, or the crew database as a file to read.
  The skills and the README call a plan file that a CLI result names a CLI output.
- 77b8700: A missing probe fixture, an unnamed host, and an invalid configuration now name the `operator config` command that sets or shows the setting.
  The probe fixture message also names the flags that `operator config apply` takes.

## 0.6.0

### Minor Changes

- 0aaee1e: A project declares its project gate in `operator-gate.json` at the repository root: an ordered list of commands, each with a unique `name`, an `argv` array, and a required `timeoutSeconds`. The release publishes its schema as `gate.schema.json`.
  Operator reads the file at a commit and never from the working tree.
  The new readiness check `project-gate` reports a missing or invalid file at HEAD, and it does not hold back a live probe. Setup does not write the file.
  A production dispatch or replace refuses with `project_gate_missing`, `project_gate_invalid`, or `project_gate_unread` when its base commit holds no valid gate.
  The producer brief lists each gate command beside the submit command and permits it. `operator attempt submit` refuses a code result with `project_gate_not_passed` when its checks do not show each gate command, by name, as `passed`.
  A review brief permits the gate commands.
- 351f5ef: Complete the tickets of a code result only after its pull request merged.

  `crew next` no longer offers the tracker steps of an accepted code result. While a published pull request is open, it shows the wait `stack_open` with the read `operator publish status --source <id>`, which the Operator runs when the user reports a merge or a close. `crew next` never reads GitHub. `operator publish status` reads each pull request and records its state, head, base, merge commit, and merge method. After a merge commit, `crew next` offers `record_tracker`. The resolution of a code result is rendered from the merge and takes no body, and a body refuses with `code_resolution_body_not_allowed`. A step before the recorded merge refuses with `merge_not_observed`. The `publish` approval now names the resolution and the completion of each item as targets, and the plan file shows each resolution already rendered. When the source has a map issue, it also names the map amendment of each item. After the merge, the first record of a map amendment renders its exact comment to a local file, writes nothing, and refuses with `map_amendment_approval_required`, and the write runs only under a `map-amendment` approval of that exact text. A squash or rebase merge, a merge into another base, a moved head, and a close with no merge are each a stack fault: `crew next` offers `settle_publish` with the blocker `stack_fault`, and only the items of a squash or rebase merge still complete. A finished source has its gate checkout removed by an unforced Herdr removal, and every branch stays. The crew state moves to version 16.

- d37f63a: A new `operator work register` of a registered source records what changed on the tracker.
  A new open sub-issue is added at its stored position.
  A changed parent issue is a new source revision, and a changed item with no attempt takes its new content and has its dependencies checked for a cycle again.
  Both need the person's `registration-change` approval of the exact plan revision, which the preview reports as `approval`, and a registration without it is refused as `approval_required`.
  The preview names each item as new, updated, or unchanged, and its counts are `new`, `updated`, and `unchanged` in place of `items`.
  A changed item that has an attempt or is accepted is refused as `recorded_item_changed`, a recorded item that is closed and not accepted as `recorded_item_closed`, and another source kind as `source_kind_changed`.
  A recorded item is matched by its issue database id, so a renamed repository makes no second item.
- 0a95155: `work register` now refuses input that it accepted before.
  It reads the file of each path fixed input and refuses a missing file or other bytes, as `fixed_input_mismatch`, and a path outside the checkout, as `invalid_work_input`.
  `attempt dispatch` refuses a launch of production work whose base commit does not hold a path fixed input with its registered content identity, before any agent starts.
- 104e1fe: Each source now has one integration branch, `operator/integration/<source slug>`. The first code dispatch of a source creates it at the integration base, after that base passed the project gate, and records its name, its base, and the project gate on the source. Nothing pushes it.
  Every later production dispatch of the source starts from the recorded tip, so `operator attempt dispatch` takes no `--commit` for it. A `--commit` that differs refuses with `dispatch_base_not_tip`. A branch that holds another commit refuses with `integration_branch_moved` and names both tips and each worktree that has it checked out. A branch of that name that exists before the first code dispatch refuses with `integration_branch_exists`. Operator never resets or adopts a branch.
  Two sources never share a source slug: an id that loses a part in the slug, by its punctuation or by the cut at 40 characters, ends with a short identity of the whole id. A branch name that another source records refuses with `integration_branch_held`.
  The brief and the submit check of every attempt of the source read the project gate fixed on the source.
  `operator work register` refuses a new production item with `blocker_completed_after_base` when its blocker in another source completed after the integration base was fixed.
  The crew state moves to version 12. `operator update` migrates it.
- 36623a8: `operator attempt dispatch` now writes a planning records section into the brief.
  It holds the planning record of each accepted planning assignment that the assignment directly depends on, and dispatch copies the artifacts of those records into `.operator/local/planning/` in the worktree, each checked against its content identity.
  Planning work that an earlier release accepted has no record, and the brief says that it has no recorded decision.
  A recovery and a replacement attempt carry the planning records that the launch plan recorded, so they restore the same words, also after a later acceptance.
  The spec copy that a result review reads holds the same planning records as the producer brief, and the reviewer receives the same artifact copies.
  The crew state moves to version 8, so run `operator update` to migrate it.
- 7da0ae6: `operator work invalidate` of executable work now opens its correction cycle in the same change.
  The brief of that cycle carries the defect, the accepted submission, and the landed commit, and its dispatch starts on the parent of the landed commit.
  A dispatch that names another commit refuses with `correction_base_changed`.
  The cycle counts against the shared budget of three correction cycles.
  An invalidation that finds that budget spent still records the defect, pauses what read it, and records a direction request, and the claim after the user answers opens the cycle.
  A direction that the user already gave no longer withholds a dispatch or appears as `direct_limit`.
  Planning work opens no cycle.
- a4911d3: The brief is now the contract of one attempt.
  Each rule that a command refuses is one line beside that command, with its refusal name.
  A review brief names a fixed copy of the spec, the fixed point it diffs from, and the read-only `git` commands of `code-review`, which it also authorizes.
  A rework brief renders one fixed sentence for its reason, and the Operator instruction no longer reaches it.
  Every brief tells the Operative never to address the person directly.
  The `operative` skill now holds only the method of the work.
- 0c8b24f: The acceptance of a correction of a landed commit rewrites the integration branch in place. The correction takes the place of the landed commit, each later commit lands again with an equal patch after it passed the project gate at its new place, and the branch moves once. A later commit whose patch changes, that fails the gate, or that needs a commit taken out returns to awaiting review and lands again on the tip later. A correction now starts at the landed commit. Cleanup refuses with `rewrite_pending` while a rewrite has no recorded outcome, and a withdrawal refuses while a landing or rewrite intent moves the commit of the item. The crew state moves to version 17.
- 03379c8: An integration cycle now answers a result that no longer lands as it was reviewed. `operator work rework` with the reason `integration` plans the landing again and names no revision in its input: it combines the submitted commit with the recorded tip, carries a failed gate run as a fixed artifact, and refuses with `lands_cleanly` when the commit lands cleanly and no failed or flaky run exists. `crew next` offers `delegate_rework` with no blocker after a conflict, a changed patch, or a failed or flaky candidate. The cycle dispatch starts from the recorded tip, and the review of the new commit receives the reviewed patch and the interdiff.
- d79a847: `operator work accept` of planning work now records a planning record, named with `--input`.
  An acceptance with no record refuses with `planning_record_required`, also for invalidated planning work, and planning work whose own dependencies are not accepted refuses with `dependency_pending`.
  Each entry is a `human-answer`, a `requirement` whose quote is checked against its source, or an `operator-decision`, which only a `research` item may record.
  A requirement can quote the recorded revision of a work source with `{ "kind": "source-revision", "sourceId": "<id>", "revision": "<revision>" }`, and a revision that is no longer recorded refuses with `source_revision_changed`.
  The `resolve_planning` action of `operator crew next` names the record of each direct planning dependency by id, identity, and entry count, and the new read-only `operator work record --assignment <id> [--record <id>]` prints a record in full.
  `operator tracker record` renders the resolution of planning work from its record and refuses a free body with `planning_body_not_allowed`.
  A comment over the GitHub limit refuses with `comment_too_long` before the write.
  A refused requirement quote no longer stores a copy of its source.
  The crew state moves to version 7, so run `operator update` to migrate it.
- 357176d: `operator work take-out --source <id> --plan-revision <revision>` takes every withdrawn commit out of the integration branch of a source. It rebuilds the branch in the same order with nothing in the place of the withdrawn commits, lands each later commit again with an equal patch after it passed the project gate at its new place, and moves the branch once. It is bound to the registration plan revision that recorded the withdrawals, and the plan now lists the later commits that the take-out rebuilds under `rebuilds`. `crew next` offers `run_gate` with `operator gate run --source <id>` for each commit that lands again, then `take_out_commit` ahead of every landing of the source, and `settle_landing` for a take-out whose move stopped. While a take-out waits, the frontier withholds the production work of the source with `take_out_pending`, `work accept` of a code result of the source refuses with `take_out_pending`, and a registration that withdraws more landed work refuses with `take_out_pending`. A later accepted result that does not land again returns to awaiting review. A rewrite or a take-out that would return a result to awaiting review while a tracker step of it is recorded refuses with `rewrite_tracker_recorded`.
- 917dab7: The CLI now runs the project gate itself. `operator gate run` starts one gate run on a commit of a source. An Operator runner in the pane of the gate checkout of the source spawns each command from its arguments with no shell, records each outcome and its output, and wakes the Operator at the end. `operator gate show --run <id>` reports the outcome of each command and where its output is stored.
  The first code dispatch of a source refuses with `gate_pending`, `gate_running`, `gate_failed`, or `gate_flaky` until its base commit passes the gate. `operator crew next` offers the new action `run_gate`, shows the new wait `gate_running`, and names the new blockers `gate_failed` and `gate_flaky`.
  A failed run blocks, and a later pass at the same key makes the key flaky. Only a person starts a fresh series at a key, with an approval that names the key and each failed run.
  The crew state moves to version 10. `operator update` migrates it.
- 27402f7: `operator question answer` checks the exact words of a `requirement` against a stored copy of its source.
  The `source` of a requirement is now `{ "kind": "copy", "path": ... }` or `{ "kind": "approved-scope", "assignmentId": ... }`, and the old `{ "id", "revision" }` shape is refused.
  A quote that is not in the source refuses with `quote_not_in_source`.
  The crew state moves to version 3, so run `operator update` to migrate it.
- c067ebc: Dispatch records a scan of the folder that holds an Operative worktree and of the controlling checkout before a production agent starts.
  After the submit checks pass, `operator attempt submit` scans them again and records each difference on the submission as an outside change. It never refuses for one.
  The scan leaves out every worktree that `git worktree list` names, reads no home folder, and does not walk below one level.
  `operator work accept` refuses with `outside_changes_undisposed` until each outside change is disposed.
  The new `operator work dispose` command records `explained`, with a reason and the evidence, or `removed`, which passes only when a new scan no longer finds the change. It never deletes a file.
  A change in `.git/hooks/` or `.git/config` is kept only under an `outside-change-keep` approval of the user, and `operator crew next` offers `dispose_outside_changes` with the `approval_required` blocker for it.
  `operator review show` lists each outside change.
  The crew state moves to version 5.
- 5667e41: A person withdraws a registered item by removing its issue from the parent.
  The next `operator work register --plan` lists each recorded item that the read does not find under `withdrawals`, with its state and its recorded landing, and counts it as `withdrawn`.
  The withdrawal is recorded only under the person's `registration-change` approval of the exact plan revision, and Operator writes nothing to the tracker for it.
  The plan refuses while an attempt of the item or of a review of its result is active (`withdrawal_attempt_active`), while a tracker step of the item has no recorded outcome (`withdrawal_effect_unsettled`), and while a recorded dependent still names it as a blocker (`withdrawal_dependent_pending`).
  `withdrawn` is a terminal assignment state: it never satisfies a dependency, the frontier lists it under `withdrawn`, and a claim of it is refused as `assignment_withdrawn`.
  Its open cycle, open invalidation, open direction request, and each review of it that no attempt holds close with it, and its history stays.
  A withdrawn issue added to its parent again is refused as `withdrawn_item_readded`, and a new link to withdrawn work as `blocker_withdrawn`.
  The refusal `recorded_item_missing` is removed.
  A registration now reports only `counts` of the registered, updated, and withdrawn assignments and the command `operator work frontier`, and no longer lists each assignment.
  `operator cleanup remove` refuses a checkout of withdrawn work that holds a commit as `unlanded_work`, and `operator cleanup show` lists it under `unlanded`. Only the person removes it.
  The crew state moves to version 11, which records the plan revision of each withdrawal.
- 0b692f6: The brief of a rework cycle now carries what the crew state recorded about the earlier rounds of the assignment.
  It holds the concerns, the decisions, and the behavior changes of the submission that the cycle corrects, every question that an earlier attempt asked with its exact words, its interpretation, and its authority, and every earlier finding with its disposition, its reason, and the rework cycle that delegated it.
  Dispatch derives these records and the brief identity covers them, so a replacement attempt of the cycle receives the same text.
  The review brief also names the rework cycle that delegated each earlier finding.
  `operator work rework` no longer takes an `instruction`, and an input that names one refuses with `invalid_rework_input`.
- 49e3f1f: Recall an open published range before a change, and publish it again.

  `work invalidate` of a commit in an open pull request, or a withdrawal of an item whose commit is in one, makes `crew next` offer `recall_stack` with `approval_required`. `operator publish recall --source <id>` plans the recall and changes nothing. With an approval of action `stack-recall` bound to its plan revision, `operator publish recall --source <id> --plan-revision <revision>` turns each open pull request from the affected part up into a draft and adds one comment, rendered from the defect or the withdrawal record. The parts below stay open. Until the recall is done, the rewrite and `work take-out` refuse with `rewrite_published_range`.

  The next stack publication has a new number and new remote names, starts above the parts that stay open after they merge (`stack_part_open` until then), and closes each recalled pull request with a pointer to its replacement, under its own publish approval. When every code item above the recalled point is withdrawn, the recall also closes the pull requests.

  A merge before the recall is the stack fault `merged_before_recall`, and `work invalidate` of a merged commit refuses with `invalidation_merged`. When the person settles that fault, the open invalidation closes with no correction, its paused dependents return to their earlier state, and the merged part counts as landed. A close of a replaced pull request whose head is not the published commit writes nothing to it. After a settled fault that ends a part, `crew next` offers `publish_stack` for a new publication. A conflict that a retarget, a recall, or a close finds names a `stack-fault` settlement, and the person's approval of it ends the conflict.

- ab7a7b9: Publish the integration branch of a source as one integrated pull request.

  `operator publish plan --source <id>` changes nothing. It reports every refusal at once, in a fixed order, and writes every title and body in full to `.operator/local/publish-plans/<revision>.md`. `operator publish apply --source <id> --plan-revision <r>` plans again, refuses with `plan_revision_changed` when anything that ships differs, needs a `publish` approval of that revision, pushes the new remote branch `operator/<source slug>/<n>/1` in one atomic push with no force option, and opens the pull request ready for review. A repeat settles an unfinished publication by reading GitHub first. `crew next` offers `publish_stack` and `settle_publish`. The branch reviewer writes the published text in its report, and for a source with one code commit the result reviewer writes it, or the report refuses with `review_published_text_missing`. Operator never merges, never turns on auto-merge, and deletes no branch. The crew state moves to version 15.

- cb87846: Every `operator attempt submit` input now requires a `behaviorChanges` list, for code and non-code results. `[]` states that there is no behavior change.
  Each entry is `{ statement, basis }`. The basis is the approved scope, one acceptance requirement by its position, or one answered question of the assignment whose answer is a requirement or a human answer. An Operator decision is never a basis.
  Submit refuses with `behavior_change_basis_missing` when a basis does not exist, as the last check after the write paths, and names each entry.
  Each axis of a result review must state `behavior-changes` in `checked`, or `operator review report` refuses with `review_coverage_incomplete`.
  The brief numbers the acceptance requirements, states the basis rule beside the submit command, and the review brief lists each behavior change with its basis.
  The crew state moves to version 6. A submission recorded before this release keeps no list, and its review does not require the token.
- 2847a13: The Herdr plugin installs the dependencies of each new worktree from its bun or npm lockfile, so agent hooks that run a package bin work in the checkout.
  Relink the plugin from this release to get the new hook.
- 2f70420: `operator work register` refuses a write path that is not in its canonical form, and a production item with no write path, and reports every refusal at once.
  The registration report gives the number of pairs of production items of one source whose write paths overlap and that no dependency orders, and the new read-only `operator work overlaps --source <id>` lists each pair.
- 5a1a234: A person can grant more write paths to one assignment with one `write-paths-grant` approval.
  `operator work write-paths` prints the effective write paths of an assignment, and for asked paths the exact approval and each started assignment of the same source that the grant would overlap.
  `operator approval grant` refuses a grant target that is not a canonical write path.
  The brief, `operator attempt submit`, and the crew frontier read the registered write paths plus every current grant, and the grant covers rework until the registered write paths change.
- 0cf7f39: `operator work rebase --source <id> --base <commit>` rebuilds the integration branch of a source on a new base, a fetched tip of its target branch, behind one `integration-rebase` approval of its plan revision. The plan is a summary with the full plan in a local file. The new base and each commit that lands again pass the project gate first, through `operator gate run --source <id> --base <commit>`, so a failing new base is never recorded. A commit whose pull request merged into the target leaves the branch, a commit whose patch changes is taken out and returns as an integration cycle, and the new head gets a new branch review. A rebase refuses while a published pull request of the source is open, unless the person settled every stack fault of its publication; then the next stack publication carries the stopped commits and closes each pull request it replaces, with one comment that names the replacement. A pull request whose head a person moved gets no write: the plan only names it. `crew next` offers `rebase_integration` and `settle_rebase`, and a landing and cleanup refuse with `rebase_pending` while a rebase has no recorded outcome. The crew state moves to version 18.
- 584eb63: `operator cleanup remove` proves the handed-over work from the local integration branch, and it reads no remote, so a removal never waits for publish.
  The checkout must be on its attempt branch at the submitted commit, or at the dispatch base for a review. Any other head, and a detached head, refuses as `head_moved`, which names both.
  An accepted result passes when the integration branch is at its recorded tip and holds the recorded commit that carries the result, also after a merge landing.
  A moved branch refuses as `integration_branch_moved`, a deleted branch as `integration_branch_missing`, and a landing of the same source with no recorded outcome as `landing_pending`.
  A replaced commit, whose assignment was accepted through a different submission, now holds unlanded work: `cleanup remove` refuses it as `unlanded_work` with the cause `replaced`, `cleanup show` lists it under `unlanded`, and `crew next` offers no removal of it. Only the person removes it.
  The `unpushed_commits` blocker is removed, and each `unlanded` entry and each `unlanded_work` blocker names its `cause`.
- d23ae4a: Publish a pull request stack of more than one part.

  The branch review report now takes `published.cuts`: each cut names the commit `after` which the part below ends, the reason for the cut, and the text of the part above it. A cut that does not fall between two neighbouring commits of the head refuses the report with `review_cut_not_between_commits`, and the plan with `cut_not_between_commits`. The plan file shows each cut with its reason. Part `k` gets the remote branch `operator/<source slug>/<n>/<k>`, the pull requests are created from the bottom up, the lowest one targets the target branch, and each higher one targets the branch below it. Each body covers only its own commits, has a stack section, and says "Based on #m. Merge #m first." for the part below.

  After `operator publish status` records a merge commit of part `k`, `crew next` offers `retarget_pull_request` for part `k+1`. `operator publish retarget --source <id> --part <k>` changes its base to the target under the publish approval, reads GitHub first, and writes nothing when GitHub already changed it. A fault on one part stops every part above it, and the retarget refuses with `stack_fault`.

  A person settles a stack fault with an approval of action `stack-fault`, which `publish status` names under each fault. A settled squash or rebase merge counts as landed, so the source can finish. Any other settled fault ends its part, and the parts above it stay stopped.

- 07cba4b: `operator attempt submit` reads the Operative worktree with Git and refuses a result that breaks its authority limits.
  It names each refusal at once, in this order, and the first one is the reason of the result: `result_not_one_commit` when a code result is not exactly one commit on the base commit of its dispatch, `uncommitted_work` for each file that is not committed, `outside_write_paths` for each file a commit touches outside the write paths, and `result_check_not_run` for a check that could not run.
  A refusal records nothing, so the attempt keeps running and its Operative can submit again.
  A submission no longer names a pull request, and `pr_authority_missing` is gone.
  The brief states the one-commit rule beside the submit command, with its refusal name.
  The crew state moves to version 4. `operator update` refuses with `code_submission_waiting` while a code submission waits for review or acceptance, and names each one.
- 9b60e7e: `operator work accept` now lands a code result on the integration branch of its source as its last step. Every other gate of acceptance passes first, then the gate run on the planned commit, then the branch moves, then acceptance is recorded. A commit whose parent is the tip lands as itself. Any other commit lands as one new unsigned commit with an equal patch, which copies the author, the committer, both dates, and the message. A commit whose equal patch the branch already holds lands nothing and is only accepted.
  `--pr-head` is removed and is refused as an unknown option, and so are the `pr_head_required` and `pr_head_changed` refusals.
  `operator gate run --assignment <id>` gates the planned commit of one landing. `work accept` refuses with `gate_pending`, `gate_running`, `gate_failed`, or `gate_flaky` until it passes, and with `integration_branch_moved`, `integration_branch_checked_out`, `landing_conflict`, `landing_patch_changed`, or `landing_pending` when the branch cannot take the commit. Each refusal lands nothing.
  `operator crew next` offers `run_gate` for a reviewed code result, and `settle_landing` for a landing whose outcome was not recorded. Its command is a repeat of `work accept`.
  Readiness refuses a Git older than 2.40.0 with `git_too_old`.
  The crew state moves to version 13. `operator update` migrates it.
- 22bc35b: Register one branch review of each integration branch when the branch becomes final.

  The acceptance or the withdrawal that leaves every code assignment of a source accepted or withdrawn now registers a branch review in the same change, and `work accept` and `work register` report it as `branchReview`. A source with one code commit registers none. The branch reviewer starts at the head of a recorded branch snapshot, reads the fixed text of the source, which `work register` now stores, the spec copy of every item, and every earlier review of the source, and names the target commits of each finding. Its report refuses with `snapshot_drift`, `review_finding_untargeted`, or `review_finding_target_unknown`. A corrected branch finding names one `target` assignment and invalidates it in the same change, and `review dispose` refuses with `correction_target_required`, `correction_target_unknown`, or `correction_target_not_expected`. A fourth branch review of one source waits on a direction request of the scope `limit:branch_reviews`. The crew state moves to version 14.

- fb13ae9: `operator work register` reads the structure of a new source from GitHub: a specification or a wayfinder map is a parent issue with its sub-issues, and a ticket is one issue.
  The input holds only the execution fields, keyed by `<owner>/<repo>#<number>`, and the hand-written structure input is refused as `invalid_work_input`.
  `work register --plan --input <path>` previews the registration, changes no crew state, and reports a summary, a `planRevision`, and the path of the full plan.
  `work register --request <id> --owner-token <token> --input <path> --plan-revision <revision>` registers that plan and refuses `plan_revision_changed`, naming each changed part, when the tracker or the input changed.
  Each refusal of the plan is reported at once, in item order and then by blocker key.
  The crew state moves to version 9: each assignment records the identity of its issue text, and each tracker binding records its repository.
- d61175d: `operator work frontier` withholds production work that has not started when its write paths overlap the paths that unaccepted work of the same source holds, and names each holder, the number of overlapping pairs of paths, and the `operator work overlaps` command that lists them in the new blocker `write_paths_overlap`.
  `operator work claim` refuses such work with the same blocker.
  A write path that an earlier release stored is read in its canonical form, so the hold sees its overlaps, and a stored path with no canonical form fails the command and names the path.

### Patch Changes

- 7c89644: The `operator` skill router now states the five rules of the person, R1 to R5, as a whole, before every topic: the Operator is read-only, nothing merges a pull request without the explicit approval of the person, nothing tears down unlanded work, an Operative never addresses the person directly, and the Operator keeps its own context as low as possible. When a topic or a report seems to ask for something that a rule forbids, the Operator obeys the rule and brings the conflict to the user.
- d9716b5: `install matt plan` and `install matt apply` now refuse a symbolic link at a file inside a skill folder, before any write, as they refuse a link at the skill folder.
  The refusal is `upstream_unavailable` with the detail `Symbolic link in skill path: <path>`.
- a31b7de: Crew state now waits for a lock that another Operator process holds while it opens the state file. Before, the open failed at once with "database is locked". A gate runner that started while the `gate run` process still held the file then left its run running with no outcome.
- 01614d0: Dispatch starts a Claude Code Operative with `--permission-mode dontAsk` and an allow list built from its brief: the Operator CLI commands the brief names, its allowed commands, its write paths, and an outbox for `--input` files.
  The Operative never stops on a permission prompt that nobody answers.
  It raises a blocked report for each tool that its host refuses.
  A producer may also run `git status`, `git add`, and `git commit`, so it can commit its result, and a reviewer may not.
- 1dd1c64: `operator work accept` accepts an invalidated planning assignment again, so the dependents that the invalidation paused resume.

## 0.5.1

### Patch Changes

- 62038e0: Split the `deep-modules` skill into smaller topics, and point `tanstack-tools` at it.

  `deep-modules` now states the find-the-feature steps in its router, and moves sub-modules, the entry-file lint rule, and environment and per-request state into topics of their own.
  An entry file may export one interface object, and a sub-module follows the same rule one level down.
  In `tanstack-tools`, a feature's own components import its query slice through a relative path, and the `$` aggregator is for route loaders and other modules.

## 0.5.0

### Minor Changes

- 9bbd987: Run the selected JSR devDependency through a project-local Bun script. Check the project installation and reject a different running release before a live probe starts.
- 39e9704: Add a read-only `operator healthcheck` for the selected release, configuration, host selection, Herdr connection, and GitHub access.
  It lists live checks that still lack proof and reports the optional wake plugin separately.
  Add an approved `--stale-only` probe mode that declares the cost of each selected group and avoids unrelated host or tracker groups.

### Patch Changes

- 91fcbe3: Show an Operative's project, ticket, task, and role in Herdr workspace, tab, and agent labels. Name probe repository and worktree workspaces by project, while keeping attempt and agent handles stable.
- ae384c3: Record live probe resources and fixture write identities before external effects. Block repeated applies after an interruption, show remaining resources, and require scoped approval to stop probe agents and remove their worktree and scratch repository.

## 0.4.0

### Minor Changes

- d94e6c3: Let projects set Operative reasoning effort and change Operator configuration through approved CLI plans.

### Patch Changes

- 95f554c: Use an absolute worktree path for partial results and recognize the returned shell in live readiness probes.
  Give each probe run a distinct fixture amendment section so reruns do not conflict.
- 6061af2: Catch unsafe type assertions, copied reducer accumulators, conditional empty-object spreads, and high-complexity functions during lint.

## 0.3.0

### Minor Changes

- f89ce93: Ship an Operative skill for production and rework assignments.
  Add an approved CLI plan to install and update Matt Pocock skills from a pinned upstream commit.
  Pass the selected model to Herdr when launching crew agents and live probes.
- 9a8944b: Resume Operator after crew changes through a one-shot Herdr wake binding.
  Keep new Operative worktrees in the Operator pane's Herdr workspace.
  Ship the Herdr plugin with the release artifact.

## 0.2.0

### Minor Changes

- 6de2ec8: Ship six more skills: `adr`, `bun`, `deep-modules`, `react-best-practices`, `react-composition`, and `tanstack-tools`.

  `operator setup` copies them into a project beside the skills Operator already ships.
  `adr` records and maintains architecture decisions in `docs/adr/`, `bun` points an agent at current Bun docs and Bun-native APIs, and `deep-modules` sorts a TypeScript app into one module per feature or capability.
  The three frontend skills carry conventions for React effects, rendering and loading, for component API shape, and for the TanStack libraries.

## 0.1.1

### Patch Changes

- 6b9db67: Keep concurrent GitHub calls in the release test log and locate Bash through the test environment, so quality checks do not fail on a lost log entry or a machine without `/bin/bash`.
- Ship an installation guide and CLI documentation with the JSR release.

## 0.1.0

### Minor Changes

- 90574e6: Update and release one matched Operator version.

  `operator update` selects the exact release a project coordinates with, refuses while work is in flight, verifies a backup before it migrates a recorded format, and installs the CLI code and the owned skills together.
  The release artifact carries runnable ESM, public declarations, the complete owned-skill directories, and the generated configuration schema, so neither delivery path runs a build.

- 8474842: Review a pull request on a design axis beside Standards and Spec.

  The `pr-review` skill asks where the functionality landed, which module owns the use case, and what a caller must now know.
  It runs that pass whether or not `code-review` is available, because `code-review` judges lines and this axis judges placement.
  The rules arrive as `DESIGN.md` inside the installed skill, and the three axes compete for the same caps of three blockers and two nice to haves.
