# Testing

- A test lives beside its unit and carries its name. A test with no owner drifts.
- Test app logic. A test of the framework, a library option, or a constant checks a dependency, and nothing in the app can make it fail.
- Fake only at a boundary: the module interface, the RPC, or the wire. Mocking a module by path is banned.
- Test a route through the real route tree. The route's behaviour is the composition.
- Assert what an operator or caller observes. Assert the locale and the fields, never the glue text.
- Confirm a test can fail with mutation testing from the CLI, not by a manual break. Run it only on the tests you added or changed, never as a gate on every task, because old tests change during feature work and a gate stalls agents.
- Run the real consumer path in CI, down to the command line the consumer runs. A lookalike passes on the file the real path rejects, and a direct script call skips the consumer's config.
- Each test file gets its own global. A leaked fake is a failure the next file cannot see coming, and run time is the accepted price.
- Reproduce a bug end to end, the way an operator hits it, before fixing it.
