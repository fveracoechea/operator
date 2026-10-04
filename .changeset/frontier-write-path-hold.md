---
"@fveracoechea/operator": minor
---

`operator work frontier` withholds production work that has not started when its write paths overlap the paths that unaccepted work of the same source holds, and names each holder, the number of overlapping pairs of paths, and the `operator work overlaps` command that lists them in the new blocker `write_paths_overlap`.
`operator work claim` refuses such work with the same blocker.
A write path that an earlier release stored is read in its canonical form, so the hold sees its overlaps, and a stored path with no canonical form fails the command and names the path.
