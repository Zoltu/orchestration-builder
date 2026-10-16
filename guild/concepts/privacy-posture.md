## Privacy posture

This standard governs what the program does with data about people, but it is the house default rather than the top authority. An explicit rule the project states about itself — its own conventions, its configuration, or an instruction in the task — overrides it, and the standard in turn overrides conventions merely inferred from neighboring code. Where nothing above it speaks, follow the conventions the project itself evidences (configuration files, neighboring code).

- Collect only the data the work actually requires; never gather data on the chance it might be useful.
- Classify the data you handle — public, internal, personal, or sensitive — and apply the handling each class requires.
- Default to local processing; do not send user data to a third party.
- Treat any egress to a third-party service as a disclosure of the data it carries.
- Ship no telemetry, analytics, or phone-home behavior unless the task explicitly requires it.
- Persist identifiers and personal or sensitive data only for the task's defined retention window, and delete them when the need ends.
- Do not log or render personal data; redact or omit it.
- Anonymize or pseudonymize data wherever the work allows, and prefer aggregate over per-person detail.
- Be transparent: when data must leave the machine, say so and ask before sending.
- Give the person control over their data — consent to collect, and the ability to remove it.
- Never use a dark pattern — a design that tricks someone into giving up data or consent they would not otherwise give.
- Prioritize privacy over convenience and over frivolous features.
