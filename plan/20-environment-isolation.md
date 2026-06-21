# Step 20 — Per-run environment isolation (operator-collaboration step)

## Goal

Give each benchmark run a hermetic, reproducible environment so that (a) the agent can install dependencies and use a full toolchain, (b) `run_shell` (step 21) can ship safely behind containment, and (c) the suite is no longer constrained to no-install, Bun-validatable tasks. This step also unlocks multi-language toolchains later — the interface is designed language-agnostically now, but only the Bun/TypeScript profile is implemented.

## ⚠️ This step requires operator collaboration — do not implement isolation alone

**This is not a normal in-environment step.** Solving per-run isolation almost certainly requires actions the agent cannot take on its own: building/container images, deciding egress policy, provisioning toolchains, and making security trade-offs that belong to the operator, not the agent.

The agent implementing this step must:

1. **Propose, not impose.** Write up a concrete proposal of the isolation options (the three listed in `docs/architecture.md`'s "Benchmark isolation and environments" section, plus any discovered during investigation), with a recommended approach and the trade-offs of each. Do **not** pick one unilaterally and start building it.
2. **Surface the decisions only the operator can make.** At minimum: egress policy for `bun install`/dependency fetches (network egress is a security risk per `docs/security.md` — the operator decides what is allowed); whether to use a container runtime (and which) versus the non-container filesystem/PATH isolation path; the trust boundary for benchmark-supplied code; and any system-tool installation the chosen approach needs.
3. **Work with the operator on the chosen approach.** Iterate the design with the operator until they sign off, then implement only what was agreed. If the agreed approach needs images built, binaries installed, or privileges the environment lacks, the agent leaves that as an explicit **Operator handoff** with exact commands and success criteria — the in-environment portion (code, in-memory tests, typecheck) is still complete and green before handoff.
4. **Never silently expand scope.** If investigation reveals the problem is bigger than one step (e.g. full multi-language containerization), insert a new step and renumber per the plan README's hygiene rule rather than ballooning this one.

If at any point the agent cannot make progress without operator input, it stops, writes the open questions into the step's handoff section, and hands back. Forcing a solo implementation here would produce a fragile, insecure, or non-reproducible isolation layer — the opposite of the goal.

## Context

Read `docs/architecture.md` ("Benchmark isolation and environments (unsolved)") in full — it lists three options (Docker-in-Docker, Docker Sandbox, per-run filesystem + toolchain isolation without containers) and the long-term expectation. Read [`13-dockerfile-deployment.md`](13-dockerfile-deployment.md) (the deployment container; per-run isolation runs *inside* it in deployment), [`21-run-shell-tool.md`](21-run-shell-tool.md) (the tool this step unblocks), and [`04-typecheck-tool.md`](04-typecheck-tool.md) / [`05-test-tool.md`](05-test-tool.md) (the checker tools whose hardcoded commands this step generalizes — see tracked debt).

The no-installs constraint currently in force exists *only* because isolation is unsolved. Lifting it is the point of this step. Until this step lands, the suite stays constrained to no-install, Bun-validatable tasks, `run_shell` stays unshipped, and the checker tools stay hardcoded to `bun`/`tsc`.

## Deliverables (proposed — finalize with the operator)

These are the candidate deliverables. The agent refines them with the operator before implementing.

1. A **design proposal** (written into this step's closeout, or a `docs/isolation.md` if it grows) covering: the chosen isolation mechanism, egress policy, the per-run workspace lifecycle, the toolchain profile concept, and how it runs inside the step-19 deployment container. The operator signs off before code lands.
2. A per-run isolated workspace setup: `HOME` set to a scratch directory inside the workspace, `PATH` stripped to a vetted toolchain directory, workspace-scoped `bun install` enabled, no global pollution. (The non-container option from the architecture doc — the likely recommendation for the single-language local case, with full containerization deferred to a future multi-language step.)
3. A **toolchain profile** the run environment provides, initially the Bun/TypeScript profile (`bun` + `tsc` + `bun test`). An optional `environment`/`toolchain` field on `eval.json` declares what a benchmark needs; the runner sets up the hermetic env per the spec. Only the Bun/TS profile is implemented now; the field is the language-agnostic seam for other-language support (shape now, impl later).
4. Generalize the checker-tool commands (remove the step-04/05 tracked debt): `typecheck` and `test` read the workspace's toolchain command from the profile instead of hardcoding `bun --bun tsc --noEmit` / `bun test`.
5. `source/benchmarks/validation.ts` `parseEvalConfig` + `docs/benchmarks.md` — accept the optional `environment`/`toolchain` field.
6. Update `docs/architecture.md:138-151` from "unsolved/deferred" to "solved for single-language local; containerization for multi-language deferred," keeping the long-term text.
7. Enable `run_shell` (step 21) to land on top of this — the two steps are sequenced 20 → 21.

## Module boundaries

- Isolation setup is a **leaf** (touches the process environment / container runtime / filesystem). Exported as a factory. Not unit-tested for the container path (operator-verified); the non-container path's pure helpers (PATH construction, env scrubbing) are tested.
- The toolchain-profile resolution is pure logic — tested.
- `run-shell.ts` (step 21) composes against the isolated environment; this step provides the env, step 21 provides the tool.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass (the in-environment portion: pure helpers, profile resolution, validation-field acceptance).
- [ ] A written, operator-approved design proposal exists in this step's closeout (or `docs/isolation.md`).
- [ ] The operator has signed off on the egress policy and the chosen mechanism.
- [ ] The non-container path (or agreed equivalent) lets a benchmark run `bun install` and `bun test` hermetically, verified by the operator.
- [ ] `docs/architecture.md` isolation section is updated with the current decision and explicit deferral of full containerization to a future multi-language step.
- [ ] The step-04/05 tracked debt (hardcoded checker commands) is removed and the debt rows deleted from `plan/README.md`.

## End-of-step evaluation

Confirm the agent did not implement isolation unilaterally — the closeout records the operator decisions and sign-off. Confirm the egress policy is explicit, not implicit. Confirm the interface is language-agnostic in shape (so a future multi-language step slots in without rewriting the runner) even though only the Bun/TS profile ships. Re-read the updated `docs/architecture.md` and `docs/security.md` for consistency.

## Estimated effort

Large, and partly non-coding. The in-environment coding is medium (pure helpers, profile resolution, validation field); the isolation mechanism itself is operator-driven and may span image builds, privilege decisions, and security review.

## Operator handoff

This step *is* largely operator handoff. The agent delivers: the design proposal, the in-environment code (pure helpers + profile resolution + validation field, all green), and a precise handoff describing what the operator must run/provision to bring the chosen isolation mechanism online (build the image, grant the runtime, configure egress). Success looks like: a benchmark that requires `bun install` runs to completion in an isolated per-run environment, with no host pollution and no unapproved network egress, and `run_shell` (step 21) can then be built on top.
