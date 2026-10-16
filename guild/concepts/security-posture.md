## Security posture

- Minimize dependencies; each one is code you did not write and must trust.
- Avoid deep transitive dependency trees — every transitive package widens the trust surface.
- Prefer built-ins and the standard library over a new package, and when a dependency is proposed, justify it explicitly and prefer a small reimplementation when one is reasonable.
- Pin dependencies through a lockfile and commit the lockfile, so a build is reproducible and a package cannot change under you.
- Review dependency updates and known advisories before adopting them; do not add a package that is unmaintained or carries an unresolved vulnerability.
- Never execute fetched code — a downloaded script, binary, or model — without first verifying its source and integrity.
- Keep secrets out of code, configuration, and logs; read them from the environment or a secret store, and never log a credential or token.
- Fail safe and closed: deny by default and require an explicit grant rather than assuming permission.
- Apply least privilege: request the narrowest scope, permission, or authority the work needs, and no more.
- Use vetted, standard cryptographic primitives; never invent your own scheme.
- Bound the resources a request can consume — rate-limit, cap sizes, and set timeouts — so untrusted input cannot exhaust the system.
- Keep the attack surface small: no unnecessary network listeners, ports, subprocesses, or privileged operations.
- Do not write outside the locations the program owns; refuse or confirm before a destructive or out-of-scope write.
- Error messages and diagnostics must not leak secrets or internal detail that aids an attacker.
