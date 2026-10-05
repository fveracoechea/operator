---
"@fveracoechea/operator": patch
---

`operator cleanup close` no longer refuses an Operative because its checkout holds Git-ignored files, such as the `node_modules` that an install command of the gate writes.
A closure deletes no file, and `operator cleanup remove` still refuses a checkout with ignored files that nobody registered.
The `unexpected_work` and `unexpected_files` blockers now name the first 20 paths, and `omitted` counts the rest.
