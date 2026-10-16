## Testability

This standard governs how code is structured so it can be verified, but it is the house default rather than the top authority. An explicit rule the project states about itself — its own conventions, its configuration, or an instruction in the task — overrides it, and the standard in turn overrides conventions merely inferred from neighboring code. Where nothing above it speaks, follow the conventions the project itself evidences (configuration files, neighboring code).

- Keep decision logic in functions that receive their inputs as parameters, so tests can call them directly.
- Keep code reachable from tests without touching the network, the filesystem, or a subprocess; push I/O to the edges.
- Prefer small, focused changes a test can exercise; new behavior lands with a test that proves it.
- Test the behavior the code claims, not the implementation detail behind it.
- When a unit is hard to test, that is a signal to restructure it, not to skip the test.
