## Error handling

- Check preconditions before acting, and handle the expected case explicitly rather than catching its error.
- Fail fast: when input or state is wrong, stop with a message that says what was expected and what arrived.
- Never swallow an error, and never continue toward a wrong answer when a precondition is unmet or a value is missing.
- Use try/catch only for failures you cannot prevent — a genuine I/O or network fault — never for control flow.
- When an operation can still fail despite your checks, handle the failure and surface it rather than guessing around it.
