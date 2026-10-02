---
"@fveracoechea/operator": minor
---

A new `operator work register` of a registered source records what changed on the tracker.
A new open sub-issue is added at its stored position.
A changed parent issue is a new source revision, and a changed item with no attempt takes its new content and has its dependencies checked for a cycle again.
Both need the person's `registration-change` approval of the exact plan revision, which the preview reports as `approval`, and a registration without it is refused as `approval_required`.
The preview names each item as new, updated, or unchanged, and its counts are `new`, `updated`, and `unchanged` in place of `items`.
A changed item that has an attempt or is accepted is refused as `recorded_item_changed`, a recorded item that is closed and not accepted as `recorded_item_closed`, a recorded item the read does not find as `recorded_item_missing`, and another source kind as `source_kind_changed`.
A recorded item is matched by its issue database id, so a renamed repository makes no second item.
