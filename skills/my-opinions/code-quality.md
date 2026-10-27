# Code quality

- Less is more. Before you build, look for an implementation that gets the same result with less code, because every line is a line someone maintains. A PR that removes code and keeps the behaviour untouched is a good PR.
- Simple, modular code that is easy to read and change beats pretty and complex abstractions.
- Cyclomatic complexity is capped at 15 for every function, React components included. A component over the cap needs composition, in its own stacked PR.
- Code is not cheap. A codebase that is hard to change locks you out of everything AI can offer.
- Codebases drift toward entropy unless senior engineers hold the bar.
- A layer, wrapper, or factory must justify itself against what the platform or library already does.
- Authors explain how they tested. Reviewers do not rediscover every bug.
- Solo ownership burns people out. Shared context and contributor growth produce better code.
