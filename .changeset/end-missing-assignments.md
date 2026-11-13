---
"@fveracoechea/operator": patch
---

End assignments whose worker resources are gone, and add `operator abandon` to end one assignment without deleting work or closing its PR. Cleanup ignores ignored output except changed environment files. State migrations no longer block on assignment state alone.
