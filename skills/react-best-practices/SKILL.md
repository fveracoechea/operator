---
name: react-best-practices
description: 'Use when writing, reviewing or changing client side React: useEffect, useState, Suspense, derived state, re-render, a lazy chunk, or data waterfall.'
---

# React best practices

**Tooling comes first, and this skill is the other half of it.**
The project runs the React Compiler and the compiler lint rules at error level.
oxlint tells you what you must not write, and this skill tells you what to write instead.

**What this skill owns.**
When a component renders, when an effect runs, and when the data and the code arrive.
It owns when a route or a query waits, and not how you write one, so it says nothing about the shape of a route, a search param, a mutation or a form.

## Reach for the React primitives, not a loading flag

This rule holds in every topic file below, so it is stated once here.
A loading boolean, a second copy of resolved data, and an effect that asks whether the data is ready are all hand-rolled versions of something React already gives you.

## Pick the task

- **An effect, or state that mirrors a prop**: [effects.md](effects.md).
- **A component that renders more than it should**: [rendering-work.md](rendering-work.md).
- **Data or code that arrives later than it should**: [loading.md](loading.md).
