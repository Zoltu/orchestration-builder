## Error handling

This standard governs how a program responds when something goes wrong, but it is the house default rather than the top authority. An explicit rule the project states about itself — its own conventions, its configuration, or an instruction in the task — overrides it, and the standard in turn overrides conventions merely inferred from neighboring code. Where nothing above it speaks, follow the conventions the project itself evidences (configuration files, neighboring code).

- Check preconditions before acting, and handle the expected case explicitly rather than catching its error.
- Fail fast: when input or state is wrong, stop with a message that says what was expected and what arrived.
- Never swallow an error, and never continue toward a wrong answer when a precondition is unmet or a value is missing.
- Use try/catch only for failures you cannot prevent — a genuine I/O or network fault — never for control flow.
- When an operation can still fail despite your checks, handle the failure and surface it rather than guessing around it.
