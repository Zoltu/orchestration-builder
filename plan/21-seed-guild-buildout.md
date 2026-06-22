# Step 21 — Seed Guild build-out

## Goal

Build out the initial real Guild: write and refine every role's system prompt, validate the Guild end-to-end against the benchmark suite, and iterate with the operator on real-world behavior before declaring the executor+Guild ready for the Foundry. This step also teaches the planner to handle the run-interrupt channel (steps 18–19): inquiry acknowledgment and plan-modification integration.

## Context

Read every prior step's closeout (the executor is now fully complete: tools, service, isolation, `run_shell`, role-tree events, interrupt channel). Read `docs/reference.md` (the Guild format), `docs/reference.md` (the tool/role contract), and the current `guild/` contents (the foundation-era seed prompts). Read [`19-run-interrupt-inquiry.md`](19-run-interrupt-inquiry.md) and [`20-run-interrupt-plan-mod.md`](20-run-interrupt-plan-mod.md) — the planner prompt must teach the interrupt contract those steps establish.

The executor is done; this step is where the Guild catches up. The foundation Guild (`guild/prompts/*.md`) was written before the executor's final shape existed (no `run_shell`, no interrupt channel, no service mode, single-run activity logs). The prompts need a grounded rewrite against the real executor surface, then real-world iteration.

## Deliverables

1. `guild/prompts/orchestrator.md` (rewrite) — the entry role. Delegates to planner/coder/critic/context_manager/recovery via `agent`; integrates plan-modification interrupts (step 20) by re-deriving a resume strategy; answers inquiry interrupts (step 19) with current-plan context. Owns the top-level plan and the decision to finish.
2. `guild/prompts/planner.md` (rewrite) — produces and revises the plan; the primary consumer of plan-mod interrupts. Defines what "integrate a modification and decide how to resume" means concretely (restart a sub-task vs. continue vs. abort).
3. `guild/prompts/coder.md` (rewrite) — uses `read_file`/`write_file`/`search_text`/`run_shell`/`typecheck`/`test`; prefers dedicated checker tools over `run_shell` for test/typecheck; reads failing output rather than guessing; handles `context_budget_exceeded` via `context_manager`.
4. `guild/prompts/critic.md` (rewrite) — reviews work products, reads files, returns a result card.
5. `guild/prompts/context_manager.md` (rewrite) — uses `context_info`/`edit_context` to compact; the compaction strategy the Foundry will later optimize.
6. `guild/prompts/recovery.md` (rewrite) — handles `llm_unavailable`, `tool_budget_exceeded`, loop detection by re-delegating or escalating.
7. `guild/guild.json` (refine) — confirm tool lists, budgets, generation params match the rewritten prompts and the real executor surface (e.g. add `run_shell` to `coder` per step 17). No schema changes expected.
8. Validation: run the benchmark suite (`benchmarks/`) through the service (step 13) against the rewritten Guild. Record pass/fail per benchmark in this step's closeout. The suite is the no-install TS set plus whatever step 16 (isolation) unlocked.
9. **Operator iteration (required before close):** the agent runs representative tasks (operator-chosen, real-world flavor, not just the benchmark fixtures), surfaces failures and prompt weaknesses, and iterates the prompts with the operator until the operator signs off. The closeout records the iterations and the operator's sign-off.

## Module boundaries

- This step changes only `guild/` (prompts + maybe `guild.json` tool lists) and writes nothing in `source/`. If a prompt weakness reveals an executor bug, that is a separate fix — do not patch the executor here; record it and propose a follow-up step.
- No new executor code, no new tools.

## Acceptance criteria

- [ ] Every role prompt is rewritten against the real executor surface (tools, interrupt channel, role-tree events, service mode) — no foundation-era assumptions remain.
- [ ] The planner prompt concretely defines inquiry-acknowledgment and plan-modification-integration behavior matching the step-18/19 contract.
- [ ] The benchmark suite runs through the service against the rewritten Guild; pass/fail per benchmark is recorded.
- [ ] The operator has signed off after real-world iteration; the closeout records the iterations and sign-off.
- [ ] `bun run typecheck` and `bun test source/` still pass (no source changes; seed-guild conformance tests must still pass against the refined `guild.json`).

## End-of-step evaluation

Confirm no `source/` changes were made (executor is frozen at this point). Confirm the seed-guild conformance tests (`source/executor/seed-guild.test.ts`) still pass — if a prompt change requires a `guild.json` tool-list change, update the conformance test's expected set. Re-read each prompt for internal consistency (do any two roles contradict each other on tool use?). Confirm the interrupt-contract markers the prompts reference exactly match the markers the engine injects (steps 18–19).

## Estimated effort

Large, and partly non-coding. The prompt writing is creative work; the real-world iteration with the operator is open-ended and may surface follow-up steps. Budget for several iteration rounds.

## Operator handoff

This step *is* largely operator handoff. The agent delivers the rewritten Guild + benchmark results, then iterates with the operator on real-world tasks until the operator signs off. The operator should choose tasks representative of the intended use (not just the benchmark fixtures) and report prompt weaknesses, unexpected role behavior, interrupt-handling gaps, and any executor bugs (the latter become follow-up steps, not in-scope fixes). Success looks like: the operator is confident the executor+Guild handle realistic tasks well enough to begin Foundry work, and has signed off to that effect.
