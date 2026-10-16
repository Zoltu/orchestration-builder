## Security posture

This standard governs what the program trusts and how it defends itself, but it is the house default rather than the top authority. An explicit rule the project states about itself — its own conventions, its configuration, or an instruction in the task — overrides it, and the standard in turn overrides conventions merely inferred from neighboring code. Where nothing above it speaks, follow the conventions the project itself evidences (configuration files, neighboring code).

- Minimize dependencies; each one is code you did not write and must trust.
- Avoid deep transitive dependency trees — every transitive package widens the trust surface.
- Prefer built-ins and the standard library over a new package, and when a dependency is proposed, justify it explicitly and prefer a small reimplementation when one is reasonable.
- Treat every value that crosses a trust boundary — user input, files, environment, arguments, network responses — as untrusted, and validate its shape before use.
- Never interpolate untrusted input into a shell command, a SQL query, a template, HTML, or a file path; use argument arrays, parameter binding, and escaping instead.
- Keep secrets out of code, configuration, and logs; read them from the environment or a secret store, and never log a credential or token.
- Fail safe and closed: deny by default and require an explicit grant rather than assuming permission.
- Apply least privilege: request the narrowest scope, permission, or authority the work needs, and no more.
- Use vetted, standard cryptographic primitives; never invent your own scheme.
- Keep the attack surface small: no unnecessary network listeners, ports, subprocesses, or privileged operations.
- Error messages and diagnostics must not leak secrets or internal detail that aids an attacker.
