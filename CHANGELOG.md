# @fveracoechea/operator

## 0.1.1

### Patch Changes

- 6b9db67: Keep concurrent GitHub calls in the release test log and locate Bash through the test environment, so quality checks do not fail on a lost log entry or a machine without `/bin/bash`.

## 0.1.0

### Minor Changes

- 90574e6: Update and release one matched Operator version.

  `operator update` selects the exact release a project coordinates with, refuses while work is in flight, verifies a backup before it migrates a recorded format, and installs the CLI code and the owned skills together.
  The release artifact carries runnable ESM, public declarations, the complete owned-skill directories, and the generated configuration schema, so neither delivery path runs a build.

- 8474842: Review a pull request on a design axis beside Standards and Spec.

  The `pr-review` skill asks where the functionality landed, which module owns the use case, and what a caller must now know.
  It runs that pass whether or not `code-review` is available, because `code-review` judges lines and this axis judges placement.
  The rules arrive as `DESIGN.md` inside the installed skill, and the three axes compete for the same caps of three blockers and two nice to haves.
