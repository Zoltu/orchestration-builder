## External data validation

This standard governs what the program trusts from outside itself, but it is the house default rather than the top authority. An explicit rule the project states about itself — its own conventions, its configuration, or an instruction in the task — overrides it, and the standard in turn overrides conventions merely inferred from neighboring code. Where nothing above it speaks, follow the conventions the project itself evidences (configuration files, neighboring code).

- Treat every value that crosses a trust boundary — user input, files, environment, arguments, network responses, parsed JSON — as untrusted until validated.
- Validate or parse external data at the boundary before use; never assume its structure.
- Reject malformed input at the boundary rather than compensating for it deeper in the code.
- Never interpolate untrusted input into a shell command, a SQL query, a template, HTML, or a file path; use argument arrays, parameter binding, and escaping instead.
- Do not trust a value to be present, correctly typed, or in range merely because a schema or an API documents it.
