## Verification and evidence

This standard governs what counts as proof that work is correct, but it is the house default rather than the top authority. An explicit rule the project states about itself — its own conventions, its configuration, or an instruction in the task — overrides it, and the standard in turn overrides conventions merely inferred from neighboring code. Where nothing above it speaks, follow the conventions the project itself evidences (configuration files, neighboring code).

- Verification means running the project's real checks and observing the result, not asserting that it works.
- Treat a reported pass as a claim, not evidence; behavior with no exercising test or inspectable result is unproven.
- A checker that could not run is not a pass — say so rather than reporting success.
- Do not claim a check ran when it did not, and do not present a plan to verify as if it were verification.
- When you cannot verify something, state the gap plainly instead of implying coverage.
