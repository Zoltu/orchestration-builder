# Security

## Threat model

The executor runs a language model against a Guild that exposes tools such as file system access and shell command execution. The primary assumption is that anything the model generates is untrusted — tool names, arguments, file contents, and reasoning. The goal is to contain damage to the mounted workspace, not to trust the model to behave safely.

## Attack surface

- **Model-generated shell commands.** `run_shell` runs arbitrary commands. A confused model can run destructive commands by mistake. This is the same risk as any local coding agent that runs generated code.
- **Prompt injection.** A task description or a file in the workspace can attempt to override system prompts, instruct the model to ignore safety rules, or exfiltrate data. The executor cannot prevent all prompt injection, so isolation is the defense.
- **Network egress.** A compromised model could read workspace files and send them to a remote host via a network-capable command. Egress should be restricted in production.
- **File traversal.** File read/write tools must not escape the workspace.
- **Supply-chain inputs.** A workspace may contain scripts, binaries, or package manifests. The executor treats these as untrusted inputs.
- **Vendored web client dependency.** The web client (`source/web/static/app.js`) is built on `hyperapp@2.0.0`, vendored as a single self-contained file at `source/web/static/vendor/hyperapp.js` (no runtime `import` of anything outside the file). This is an approved, one-time exception to the no-dependencies policy. Untrusted run content (task text, log payloads, summaries, question text, answers) is interpolated only as `h()` children or text-node arguments, which hyperapp places into text nodes and DOM properties — never into markup — so it cannot break out of the DOM. There is no raw-HTML/`unsafe()` export in hyperapp; if one is ever added to the vendored file it must not be used without revisiting this note.

## Mitigations

- **Workspace isolation.** The executor modifies the mounted project at `/workspace` in place. File tools canonicalize paths and reject any that resolve outside the workspace. Runs are sequential (one at a time), so there is no concurrent-run isolation concern.
- **Path canonicalization.** File tools resolve paths relative to the workspace, canonicalize them, and reject any that escape.
- **Tool exposure is a Guild decision.** The executor only exposes tools to a role if the role explicitly lists them. A Guild author can remove `run_shell` if it is not needed.
- **`run_shell` containment.** `run_shell` ships only after per-run environment isolation lands. Containment comes from the isolation environment, not from an in-tool command allowlist. An in-tool allowlist is a deferred enhancement, not the v1 path.
- **Secrets.** API keys are passed through environment variables, not stored in the Guild or workspace.

## What the design does not prevent

- A deliberately destructive task given by a legitimate user. The executor does not second-guess the user; it only contains execution to the workspace.
- A model that destructively modifies files inside the workspace. This is expected behavior for coding tasks; isolation prevents damage elsewhere.
- Resource exhaustion within budget limits. The executor enforces timeouts and budgets, but a motivated adversary could still trigger expensive computations within those limits.

## Foundry implications

The Foundry may propose Guild changes that expose new tools or broaden existing ones. A branch that weakens isolation should fail validation before reaching the baseline. Review of Foundry reports should include checking which tools were added or removed.
