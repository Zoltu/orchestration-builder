## Privacy posture

This standard governs what a program depends on and what it does with user data, but it is the house default rather than the top authority. An explicit rule the project states about itself — its own conventions, its configuration, or an instruction in the task — overrides it, and the standard in turn overrides conventions merely inferred from neighboring code. Where nothing above it speaks, follow the conventions the project itself evidences (configuration files, neighboring code).

- Minimize dependencies; each one is code you did not write and must trust.
- Avoid deep transitive dependency trees — every transitive package widens the trust surface.
- Prefer built-ins and the standard library over a new package when they can do the job.
- Default to local processing; do not send user data to third parties.
- Prioritize privacy over convenience and over frivolous features.
- When a dependency is proposed, justify it explicitly, and prefer a small reimplementation when one is reasonable.
