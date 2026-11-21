---
"@fveracoechea/operator": major
---

Map in-flight PR assignments to worker kinds from recorded facts and allow registered dispatch to fill remaining null kinds.
Do not assume every older assignment keeps a null kind.
For eligible null-kind PR records in open sources, the shipped migration uses these recorded facts:

- Unstarted or running work without a PR association or adoption becomes `implementation`.
- An active internal review or unfinished review handoff becomes `review`.
- Other associated PR-open work becomes `pr-feedback`, with migration-origin readiness and parking records when absent.

Reports, unassociated adopted PRs, ended assignments, and cleanup-only records remain null; registered plans and historical launch snapshots stay unchanged.
When `next` requests a kind, use `operator dispatch --source <id> --assignment <key> --kind <kind>`.
There is no general-kind fallback, and this fill cannot replace an existing kind.
Migration-origin unknown readiness heads remain unknown; the mapping invents no historical review or ready evidence.
