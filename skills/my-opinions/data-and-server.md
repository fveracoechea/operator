# Data and the server boundary

## Server functions and schemas

- Server functions, not internal API routes. A route exists only for callers outside the bundle.
- One named server function per operation. Its validator is the browser's allowlist by construction.
- Generate only Zod schemas from a contract. The generated schema is the only committed projection and is never hand-edited.
- Parse at the boundary, trust the types after it. Types flow from handler to call site with no assertion.
- Infer types from schemas. A hand-written interface beside a schema is a copy that drifts.
- Validate configuration at startup and fail loudly. No silent fallbacks.

## Working with a backend team

- App and UX logic belongs to the full-stack app, not to backend services, so both teams move in parallel.
- Tolerance for what a service really sends is a contract change negotiated with the backend, not a schema override.
- A protocol grows through a standard with extension points, not one new field per need. Each field is a permanent contract change on both teams.
- Tell another team what is missing, not how to build it. They own the design of their part.
- A known backend defect gets a workaround with a comment that names it, and an issue the backend team can read.
