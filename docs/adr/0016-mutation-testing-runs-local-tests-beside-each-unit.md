# ADR-0016: Mutation testing runs local tests beside each unit

## Status

Accepted - 2026-10-24.
Decided in #229.
Implemented in #238.

## Context

Mutation testing could expose weak assertions, but some command tests took minutes.
Stryker had no official Bun runner, and the evaluated community integration did not preserve the required runtime behavior.
The model came from private company tooling that the public repository could not copy or install.
Interface-only tests also could not satisfy a test-beside-unit mutation policy for private logic.

## Decision

Operator independently implements local repository mutation testing with Stryker's command runner under Bun.
Each mutant runs the repository's own tests beside its unit in a fresh process, without coverage analysis or incremental mode.
The tool is development tooling, not a command supplied to projects coordinated by Operator.

A unit's same-folder tests cover that unit, including scenario tests.
Interface tests cover the interface unit, not every private file in its module.
Private files with logic also have direct tests beside them, while module tests still assert the interface behavior that callers observe.
Missing beside-tests mean untested work, not credit from a test in another folder.
Tests, fixtures, and generated content are not mutation targets.
Files with no logic can declare that fact and opt out.

Mutation testing is local and is not part of the quality or CI gate.
It accepts explicit units or changed lines relative to a ref and reports survivors and untested units as nonzero outcomes without blocking ordinary work.
No implicit whole-repository run or score threshold substitutes for an explicit target.
A development-only unit-testing skill explains test design and mutation work and does not ship with Operator's owned skills.
Its guidance and the module-testing guidance must agree on private-file tests.

The final implementation cleanup tests the changed lines of all affected units.
It kills survivors or records justified equivalent or unspecified-behavior cases after first trying simpler code.
Unknown suppression reasons are refused, and the PR identifies each accepted suppression.
The cleanup finishes only with no remaining reported survivors or untested targets.

## Consequences

- Mutation runs can remain slow because a fresh command process supplies the actual Bun test behavior.
- Local testing has no continuous mutation gate, so authors must request the check.
- Direct private-file tests add maintenance alongside public module behavior tests.
- The public implementation and skill wording need their own maintenance rather than copying private source.
- Justified suppressions document behavior the tool cannot distinguish instead of claiming that tests killed those mutants.

## Alternatives considered

- Installing or copying private Jarvis code and text was rejected because Operator is public and the source is private company work without a license.
- A consumer-facing mutation command was rejected because Operator is a workflow tool and other tooling already provides that capability.
- A community Bun runner was rejected because the command runner preserves the project's own runtime and test invocation.
- Every module test covering every private unit was rejected because it runs too much work and defeats the beside-unit rule.
- Quality-gate or changed-lines CI mutation runs were rejected because the slow command tests cost too much agent time.
- Score thresholds and an ignore-list setting were rejected in favor of explicit targets and justified local suppressions.

Related: ADR-0002, development skill guidance uses the same disclosure policy without becoming a bundled skill; ADR-0010, CI is the PR merge gate; ADR-0018, lint enforcement is separate from local mutation analysis.
