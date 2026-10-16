## Type safety

This standard governs how the type system is used to prevent errors, but it is the house default rather than the top authority. An explicit rule the project states about itself — its own conventions, its configuration, or an instruction in the task — overrides it, and the standard in turn overrides conventions merely inferred from neighboring code. Where nothing above it speaks, follow the conventions the project itself evidences (configuration files, neighboring code).

- Never use a typecast (`as`) to silence the type checker; if the types disagree, fix the types or narrow properly.
- Never use the non-null assertion (`!`) to declare a value present; handle the absent case explicitly.
- Narrow unknown values with type guards rather than assuming a shape.
- Prefer types that make invalid states unrepresentable.
- Let the compiler catch errors at compile time rather than at runtime.
