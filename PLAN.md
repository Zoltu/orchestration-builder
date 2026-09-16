# Adaptive Orchestrator — Foundry Development Plan

This plan covers the **Foundry**: an offline meta-optimizer that improves the Guild by proposing, testing, and merging changes against the benchmark suite. It is a standalone program — an HTTP client of the executor service that never imports from the executor codebase — and it uses a large language model for hypothesis generation and merging. The complete design (architecture, optimization loop, scoring, branch management, guardrails, promotion/rollback, reporting, data layout) lives in [`docs/foundry.md`](docs/foundry.md); this document plans the work of building it, not the design. Every change, in every milestone, follows [`AGENTS.md`](AGENTS.md).

Milestones are sequential: the design decisions must land before the harness, the harness before the loop. Within a milestone, work follows the usual hygiene rules — `bun run typecheck` and `bun test source/` green at every close.

## Before the Foundry

A small set of operator-only verifications is open. None blocks design or harness work, but all should close before an optimization cycle is trusted:

- Exercise the streaming client end-to-end against the bundled Guild endpoint (`llama-server`, model "Agents A1"); verify the endpoint's llama.cpp build serves the streaming API first.
- Build the Docker image and run the smoke test outside this environment (Docker is unavailable in-environment): submit a task via the UI or API, confirm the service stays up after the run, and confirm the hardened invocation (`--read-only`, dropped capabilities, non-root) behaves.
- Verify checkpoint/resume across a container restart (`docker stop` mid-run, restart, confirm the run resumes), if desired.
- Operator sign-offs open on the shipped product: real-world Guild tasks (representative tasks beyond the benchmark fixtures), full benchmark-suite runs against a real endpoint, and the run visualization in both light and dark themes.

## Tracked technical debt

| Debt | To be removed in | Notes |
|---|---|---|
| `typecheck` hardcodes `bun --bun tsc --noEmit`. | Evaluation harness | Named generically + fixed command so the Guild cannot over-fit to TypeScript; generalize to a per-workspace toolchain command when per-run environment isolation lands. |
| `test` hardcodes `bun test`. | Evaluation harness | Same shape as the `typecheck` debt. |
| No shell allowlist/denylist for `run_shell`. | The Foundry work | Containment comes from the deployment environment (non-root, restricted egress, read-only filesystem), not from an in-tool filter. An in-tool allowlist lands only if per-run environment isolation surfaces a concrete need. |

When you add a row, also update the target milestone's deliverables to describe the removal work. When you remove the debt, delete the row.

## Backlog

Unbuilt features. None is scheduled; each needs a fresh scoping before work begins.

- **Token-level streaming cues in the flow view.** The executor provides `llm_call_start` and the streaming client: the flow view can key the active node's state on whether the latest received bytes are reasoning, content, or a tool call, and carry a live token counter on the active node.
- **Changed-files / diff review view.** The highest-value result-review surface to build — what did the run actually change on disk — and the largest: it likely needs a small backend endpoint that lists or diffs the run's changed files before the client can render it.
- **Run-list search/filter and persistent selection.** The run list has no search or filter, and the selected run is lost on page reload. Low value until many runs accumulate; cheap when needed.
- **Filtered-fetch tool.** A `pattern`-parameter fetch to tame context thrash on large pages. The operator owns this idea and a separate approach to the context-thrash problem — coordinate with the operator before building anything here.
- **Parked micro-items:** a sequence-view minimap (zoom/pan exist; the minimap waits for a real need), flow-view rows for parallel children (the design anticipates them, but the executor is sequential; each active child gets its own row when parallelism lands), dollar pricing on cost displays (a small addition once a price source exists), and mobile support (desktop-first by design; a separate design pass if it is ever wanted).

## Milestone 1 — Discovery and design decisions (operator collaboration)

**Goal.** Turn the design doc into buildable, operator-approved decisions: where the Foundry lives, how the modules decompose, and how benchmark runs are isolated. No production code in this milestone.

**Deliverables.**

1. **Project structure decision.** Decide with the operator whether the Foundry lives as an in-repo subpackage (its own `package.json`/`tsconfig`, consuming the executor only as an HTTP client) or as a separate repository that consumes the executor's published image and API. Document the decision and its rationale.
2. **Validate the design against the code.** [`docs/foundry.md`](docs/foundry.md) is the authoritative design reference. Read it against the code as it stands, adjust the doc where reality demands, and agree on the module decomposition — the doc names the pieces (branch management, scoring, evaluation, hypothesis generation, merge, reporting, promotion, loop, entry point); the right breakdown is decided here, together.
3. **Per-run environment isolation design.** Design the hermetic per-run environment for benchmark evaluation: scoped `PATH`/`HOME`, no global pollution, no unapproved egress for installs and dependency fetches, the toolchain-profile concept that lets each workspace name its own checker commands, and the container boundary (one container per benchmark). The egress policy, the trust boundary, and any container-runtime decisions belong to the operator — propose, don't impose.

**Acceptance criteria.**

- [ ] A written, rationale-carrying decision on project structure.
- [ ] [`docs/foundry.md`](docs/foundry.md) matches the agreed design; the module breakdown is agreed with the operator.
- [ ] An isolation design the operator has approved: egress policy, trust boundary, toolchain profiles, container boundary.

## Milestone 2 — Evaluation harness

**Goal.** Be able to score a Guild: run the benchmark suite through the executor's HTTP API, each benchmark in its own isolated environment, and collect validated, aggregated results.

**Deliverables.**

1. **Benchmarks through the executor HTTP API.** Submit runs via `POST /api/runs`, poll to completion, and read the final workspace — never importing from `source/executor/`. Each benchmark run gets its own environment (the isolation design from the discovery milestone) so benchmarks that install packages or download tooling cannot pollute each other.
2. **Generalized checker commands.** Replace the hardcoded `typecheck`/`test` commands with per-workspace toolchain commands resolved through the toolchain profile, removing both debt rows from the table above.
3. **Validation reuse.** Reuse the benchmark validation helpers (`source/benchmarks/`) rather than duplicating them; they are the same checks the standalone suite runner applies.
4. **Result collection and teardown.** After each run, validate the final workspace and record a per-benchmark result (status, tokens, ask count, context-pressure events, errors, wall time, run id). Teardown (stop the environment, remove temporaries) happens on every exit path, including a run that hits the configurable timeout without terminating.

**Acceptance criteria.**

- [ ] A suite run executes every benchmark in its own environment through the HTTP API and produces validated, aggregated results.
- [ ] Checker commands come from the workspace's toolchain profile, not hardcoded Bun commands; both debt rows are removed.
- [ ] `bun run typecheck` and `bun test` pass (for the project(s) the Foundry lives in); teardown is verified on success, error, and timeout paths.

## Milestone 3 — The optimization loop

**Goal.** Close the loop: propose concrete changes to the Guild, evaluate them with the harness, and merge and promote what measurably improves the baseline.

**Deliverables.**

1. **The loop itself:** observe (baseline Guild + recent run logs) → hypothesize (the large model clusters failures and proposes concrete, testable edits) → branch (candidate Guilds, filesystem-only, validated end-to-end with the Guild loader) → evaluate (the harness from the previous milestone) → score (adjusted score, improvement margin, regression flag) → merge (the large model resolves conflicting accepted branches) → report → promote (the sole writer of the baseline Guild, with history and rollback) → repeat under guardrails (cycle budget, cost budget, plateau). The full mechanics — scoring formula, branch operations, guardrail termination, report format — follow [`docs/foundry.md`](docs/foundry.md).
2. **The tuning space.** The loop optimizes: prompt wording across all roles, the effort-mode mappings, the review-round caps, per-role tool lists, the Guild's numeric values (`maxAgentDepth`, `maxCompactionAttempts`, `maxToolOutputChars`, model sampling parameters), and role-set hypotheses (including wholesale `guild.json` edits). Deliberate seed decisions — reviewers hold no workspace tools, the fixed 30-second checker timeout — are decisions with recorded rationale, not oversights; the loop may revisit them, but only on evidence.
3. **Human simulation.** When a candidate Guild uses `ask_human`, answer questions through the executor's answer endpoint — deterministic benchmark answers on near-exact matches, then the persona-configured large model — so optimization runs stay reproducible, with the per-question penalty applied in scoring.

**Acceptance criteria.**

- [ ] A full optimization cycle runs end-to-end against the executor service and the benchmark suite: it produces a report and, when a branch improves on the baseline by the configured margin, promotes it.
- [ ] The Foundry never imports from `source/executor/`.
- [ ] Hypotheses whose edits produce an invalid Guild are dropped with the reason recorded; a regressing merged candidate is never promoted.
- [ ] `bun run typecheck` and `bun test` pass (for the project(s) the Foundry lives in).

## Milestone 4 — A real optimization cycle (operator collaboration)

**Goal.** Prove the Foundry against reality: a real big-model endpoint, real benchmark runs, real money-and-time cost.

**Deliverables.** With the operator's endpoint configured, run a genuine optimization cycle: the loop generates hypotheses with the real large model, evaluates them through the executor service against the benchmark suite, and produces the report and (if any branch wins) a promoted baseline Guild. The "Before the Foundry" verifications should be closed first, so a surprising result can be attributed to the optimization rather than to an unverified platform. Bugs the real cycle surfaces come back to the agent for fixing.

**Acceptance criteria.**

- [ ] A real optimization cycle completes: report delivered, baseline promoted or an honest plateau recorded.
- [ ] [`docs/foundry.md`](docs/foundry.md) matches the implementation.
- [ ] Bugs surfaced by the real run are recorded and fixed, with the fix re-verified by a cycle or a targeted evaluation.
