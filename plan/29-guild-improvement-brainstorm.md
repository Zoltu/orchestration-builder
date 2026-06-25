# Step 28 — Guild improvement brainstorm

## Goal

After the seed Guild (step 25) has been built and exercised, step back with the operator and brainstorm further improvements: prompt patterns that did not survive real-world use, missing roles, tool-list gaps, budget tuning, and any executor limitations the build-out surfaced. Produce a concrete backlog that may spawn follow-up steps before Foundry work begins.

## Context

Read [`25-seed-guild-buildout.md`](25-seed-guild-buildout.md) and its closeout (the iterations and operator sign-off), the current `guild/` contents, and recent run logs from the build-out's real-world tasks. This step is intentionally reflective: the build-out step is heads-down prompt work; this step is the retrospective that decides whether the executor+Guild are truly ready for the Foundry or whether more work is needed first.

The Foundry (step 33) will optimize the Guild automatically, but only within the space the seed Guild defines. If the seed is missing a role, has a fundamentally broken prompt pattern, or hits an executor ceiling, the Foundry cannot fix it — it can only tune what exists. This step is the last human-judgment gate before automated optimization.

## Deliverables

1. A **brainstorm document** (written into this step's closeout, or `docs/guild-roadmap.md` if it grows) capturing, with the operator:
   - Prompt patterns that failed under real-world load and the proposed fixes.
   - Missing or redundant roles (e.g. is `recovery` pulling its weight? is a `reviewer`/`tester` role needed?).
   - Tool-list gaps (any role that needed a tool it did not have, or had a tool it never used).
   - Budget tuning (any role that hit `tool_budget_exceeded` or `token_budget_exceeded` too early or too late).
   - Interrupt-channel gaps (did the planner handle inquiries/plan-mods as intended?).
   - Executor limitations surfaced (these become follow-up executor steps, not Guild work).
2. A **backlog** derived from the brainstorm: each item is either a follow-up step proposal (with enough detail to scope it) or a recorded "deferred to Foundry" decision (the Foundry will tune this automatically, no manual work needed). Each follow-up-step proposal is inserted into the plan (renumbering forward steps per the hygiene rule) or explicitly deferred with a reason.
3. **Operator sign-off** that the brainstorm is complete and the backlog is correctly prioritized. The closeout records which follow-up steps were inserted (if any) and which were deferred.

## Module boundaries

- This step changes only plan/docs: the brainstorm document and the plan backlog. No `source/` or `guild/` changes (those happen in any follow-up steps the brainstorm spawns).
- If the brainstorm concludes no follow-up steps are needed and the executor+Guild are ready for the Foundry, the deliverable is just the documented sign-off.

## Acceptance criteria

- [ ] A brainstorm document exists (in the closeout or `docs/guild-roadmap.md`) recording the operator collaboration.
- [ ] Each brainstorm item is either a proposed follow-up step (inserted into the plan) or a recorded "deferred to Foundry" decision with a reason.
- [ ] The operator has signed off on the backlog and prioritization.
- [ ] If follow-up steps were inserted, `plan/README.md`'s status table and implementation order are updated and forward steps renumbered.

## End-of-step evaluation

Confirm the brainstorm did not silently expand into code changes (it is a planning step). Confirm every proposed follow-up step is session-sized and has a clear goal, not a vague "improve prompts" placeholder. Confirm the "deferred to Foundry" decisions are genuinely Foundry-shaped (tunable parameters, prompt wording the optimizer can search) rather than executor bugs hiding as Guild issues.

## Estimated effort

Small to medium — mostly discussion and writing. The value is in the operator collaboration, not in code.

## Operator handoff

This step *is* operator collaboration. The agent facilitates the brainstorm, drafts the backlog, and proposes the follow-up/deferred split; the operator validates and signs off. Success looks like: a documented, prioritized backlog and a clear go/no-go decision on whether Foundry work (step 33) can begin or whether follow-up steps must land first.
