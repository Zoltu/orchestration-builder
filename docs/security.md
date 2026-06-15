# Security

## Threat model

The executor runs a locally-hosted language model against a Guild configuration that exposes powerful tools such as file system access and shell command execution. The primary security assumption is that anything the model generates is untrusted. This includes tool names, arguments, file contents, and reasoning.

The design treats the user task, benchmark workspace files, and any external data the model can read as potentially adversarial. The goal is to contain damage to the per-run workspace, not to trust the model to behave safely.

## Attack surface

### Model-generated shell commands

The most dangerous tool in a typical Guild is `run_shell`. A role may ask the model to generate arbitrary shell commands. This is the same risk as any local coding agent that runs generated code. Even if all roles are well-intentioned, a confused model can run destructive commands by mistake.

### Prompt injection through the task or workspace files

A task description or a file in the benchmark workspace can attempt to override system prompts, instruct the model to ignore safety rules, or exfiltrate data. The executor cannot prevent all prompt injection, so isolation is the defense.

### Network egress

If the process has unrestricted network access, a compromised model could read workspace files and send them to a remote host by invoking a network-capable command. Network egress should be disabled or tightly controlled in production.

### File traversal

File read/write tools must not escape the per-run workspace. Paths are canonicalized and any path outside the workspace is rejected.

### Supply-chain inputs

A benchmark workspace may contain scripts, binaries, or package manifests. The executor treats these as untrusted inputs. Running tests or build commands supplied by the workspace is part of normal benchmarking, but it happens inside the isolated workspace.

## Architectural mitigations

### Per-run workspace isolation

Every run receives its own `data/runs/<run_id>/workspace/` directory. Tools operate only inside that directory. The original benchmark workspace is not modified. This ensures one run cannot corrupt another or read unrelated runs.

### Path canonicalization

File tools resolve paths relative to the run workspace, canonicalize them, and reject any path that resolves outside the workspace.

### Tool exposure is a Guild decision

The executor only exposes tools to a role if the role explicitly lists them in its `tools` array. A Guild author can remove `run_shell` from all roles if it is not needed. The Foundry may add or remove tools as it optimizes.

### Shell tool policy

The Guild describes `run_shell` but the executor applies a configurable shell policy. The default design assumes:

- A timeout on every shell invocation.
- Execution only under the host process user or a dedicated runtime user.
- Optional allowlist/denylist of commands.

The strongest isolation is expected to come from the deployment environment, not the executor code.

### Container and network isolation

The final product ships as a single Dockerfile. The recommendation is to run the container with:

- No network egress for the executor process.
- A non-root user.
- A read-only filesystem except for the per-run workspace volume.
- Optional further isolation via user namespaces, seccomp, or a separate sandbox wrapper.

The executor itself is not a container runtime; it relies on the surrounding environment for strong isolation.

### Secrets

API keys for the model endpoint are passed through environment variables, not stored in the Guild or workspace. The Foundry’s large-model endpoint key, if any, is also passed through environment variables.

## What the design does not prevent

- A deliberately destructive task given by a legitimate user. The executor does not second-guess the user; it only contains execution to the workspace.
- A model that destructively modifies files inside the workspace. This is expected behavior for coding tasks; isolation prevents damage elsewhere.
- Resource exhaustion. The executor enforces timeouts and budget limits, but a motivated adversary with access to the model could still trigger expensive computations within those limits.

## Foundry implications

The Foundry may propose Guild changes that expose new tools or broaden existing ones. A branch that weakens isolation should fail validation before reaching the baseline. Review of Foundry reports should include checking which tools were added or removed.
