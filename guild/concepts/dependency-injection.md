## Dependency injection

This standard governs how you construct and connect the pieces of a program, but it is the house default rather than the top authority. An explicit rule the project states about itself — its own conventions, its configuration, or an instruction in the task — overrides it, and the standard in turn overrides conventions merely inferred from neighboring code. Where nothing above it speaks, follow the conventions the project itself evidences (configuration files, neighboring code).

- Construct dependencies at the edge, in a composition root, and pass them into the code that uses them; do not construct them deep in the call graph.
- Pass dependencies in explicitly through constructor or function parameters; never reach for a hidden global, an ambient singleton, or module-level mutable state.
- Make each dependency injectable as a narrow, configurable factory, so a test can substitute a fake without touching the code under test.
- Depend on the smallest interface the unit actually uses, not on a concrete implementation.
- Keep wiring in the composition root and behavior in the units it wires, so every unit stays testable in isolation.
