## Module boundaries

- Give each file and symbol one clear job, so a reader can say what it does without reading the whole thing.
- Keep dependencies between parts explicit and minimal; do not reach across a module boundary for an internal detail.
- Build only what the work needs; add no options or abstractions for imagined futures.
- An abstraction with a single caller earns its place only when it isolates an external system for testing.
- When two designs are equally plausible, choose the plainer one.
- Do not bolt new work onto a module it does not belong to; refactor first, then add.
