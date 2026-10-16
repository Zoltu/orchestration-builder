## Module boundaries

This standard governs how a program is divided into parts, but it is the house default rather than the top authority. An explicit rule the project states about itself — its own conventions, its configuration, or an instruction in the task — overrides it, and the standard in turn overrides conventions merely inferred from neighboring code. Where nothing above it speaks, follow the conventions the project itself evidences (configuration files, neighboring code).

- Give each file and symbol one clear job, so a reader can say what it does without reading the whole thing.
- Keep dependencies between parts explicit and minimal; do not reach across a module boundary for an internal detail.
- Build only what the work needs; add no options or abstractions for imagined futures.
- An abstraction with a single caller earns its place only when it isolates an external system for testing.
- When two designs are equally plausible, choose the plainer one.
- Do not bolt new work onto a module it does not belong to; refactor first, then add.
