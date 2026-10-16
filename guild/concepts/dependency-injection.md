## Dependency injection

- Construct dependencies at the edge, in a composition root, and pass them into the code that uses them; do not construct them deep in the call graph.
- Pass dependencies in explicitly through constructor or function parameters; never reach for a hidden global, an ambient singleton, or module-level mutable state.
- Make each dependency injectable as a narrow, configurable factory, so a test can substitute a fake without touching the code under test.
- Depend on the smallest interface the unit actually uses, not on a concrete implementation.
- Keep wiring in the composition root and behavior in the units it wires, so every unit stays testable in isolation.
