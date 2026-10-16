## Type safety

- Never use a typecast (`as`) to silence the type checker; if the types disagree, fix the types or narrow properly.
- Never use the non-null assertion (`!`) to declare a value present; handle the absent case explicitly.
- Narrow unknown values with type guards rather than assuming a shape.
- Prefer types that make invalid states unrepresentable.
- Let the compiler catch errors at compile time rather than at runtime.
