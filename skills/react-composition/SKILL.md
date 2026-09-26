---
name: react-composition
description: 'Use when designing, changing or reviewing the API of a React component: boolean props, render props, several parts that share state, or sibling component that must read state.'
---

# React composition

This skill owns the shape of a component API, and the state that the parts of one component share.
It answers one question: where do you cut a component, so that each use case builds the parts it needs?

**Compose the parts, do not add a mode.**
A boolean prop adds a mode, and three of them make eight states that the body must handle.
A part that the caller places, or leaves out, adds no state to the body.

## Pick the task

- **One component that has too many modes**: [component-api.md](component-api.md).
- **A component of several parts that share state**: [compound-components.md](compound-components.md).
