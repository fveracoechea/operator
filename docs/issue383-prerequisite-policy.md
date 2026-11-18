# Inactive worker-phase capability

This local prerequisite separates the pure worker-phase decision from PR406's command activation.
Its base is main at `95e936eeeab9916608280219c2f70466a2945748`.
The source pin is `f80119d1e8b631335e740567e2671a84f84dac18`.

The worker-kinds module owns the ordered report and PR tails, closed exit-guard catalog, typed facts, and built-in snapshot representation.
The result contract permits optional kind and phase fields without producing them.
Direct owner tests cover the pure decision and public kind interface.
No command gathers phase facts, calls the decision, enforces its guards, or emits phase metadata at this stage.
Existing command behavior, including null-kind behavior, remains unchanged.
Built-in work phases remain unguarded, and settings gain no person-defined kind support.

This stage is an intermediate-only exception to ADR-0003's rejection of unused machines.
The decision is deliberately inactive until the existing child activates it.
There is no runtime compatibility switch, alternate guard policy, or duplicate implementation to remove.
The child removes this note when it activates the decision.
The prerequisite adds no release changeset; the existing child retains its one activation changeset.

The intended actual comparisons count every changed path, including metadata and overlap:

- Main to prerequisite: six paths, comprising five capability/type/test paths and this temporary note.
- Prerequisite to existing child: 30 paths, comprising 29 activation paths and deletion of this note.
- Main to the original or final child: 34 paths, which is not a compliant standalone review comparison.

The existing child must merge this prerequisite through an ordinary two-parent merge.
Every original commit remains reachable, and the final tree must equal the source pin exactly.
Final hashes, path manifests, tree proofs, commands, and results belong in the local packaging artifact outside the tracked final tree.

This packaging supplies no independent review or qualification.
Historical heavy qualification failed with 534 kills and 58 survivors; this task does not remeasure it.
Full reviews, CI, qualification, publication, and native stack metadata remain pending and require separate authority.
