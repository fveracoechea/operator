---
name: lint-fixes
description: Use when an anti-slop or custom-tests oxlint rule reports a violation in this repository, or before you write code that parses input, asserts a type, builds an object, or replaces a test dependency.
---

# Lint fixes

Each custom lint message ends with `See lint-fixes/<topic>.md.`
Read that topic. Find the section that names the rule, then apply its fix.
Do not add a disable comment, a file exemption, or a violation baseline. ADR-0018 forbids them.

This is repository development guidance, not a bundled Operator skill.

## Pick the topic

- **Input is `unknown`, a function returns `unknown`, a parameter is `object`, or code uses a runtime `typeof`**: [parse-at-the-boundary.md](parse-at-the-boundary.md).
- **A type assertion chain, or a value widened and then asserted back**: [type-assertions.md](type-assertions.md).
- **A conditional empty-object spread, or a reducer that copies its accumulator**: [object-construction.md](object-construction.md).
- **A test replaces a module by path, or asserts on its own fixture**: [test-doubles.md](test-doubles.md).
