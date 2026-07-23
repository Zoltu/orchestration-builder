# Step 29 — Guild improvement brainstorm

## Goal

After the seed Guild (step 25) has been built and exercised, step back with the operator and brainstorm further improvements: prompt patterns that did not survive real-world use, missing roles, tool-list gaps, budget tuning, and any executor limitations the build-out surfaced. Produce a concrete backlog that may spawn follow-up steps before Foundry work begins.

## Context

Read [`25-seed-guild-buildout.md`](25-seed-guild-buildout.md) and its closeout (the iterations and operator sign-off), the current `guild/` contents, and recent run logs from the build-out's real-world tasks. This step is intentionally reflective: the build-out step is heads-down prompt work; this step is the retrospective that decides whether the executor+Guild are truly ready for the Foundry or whether more work is needed first.

The Foundry (step 35) will optimize the Guild automatically, but only within the space the seed Guild defines. If the seed is missing a role, has a fundamentally broken prompt pattern, or hits an executor ceiling, the Foundry cannot fix it — it can only tune what exists. This step is the last human-judgment gate before automated optimization.

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

This step *is* operator collaboration. The agent facilitates the brainstorm, drafts the backlog, and proposes the follow-up/deferred split; the operator validates and signs off. Success looks like: a documented, prioritized backlog and a clear go/no-go decision on whether Foundry work (step 35) can begin or whether follow-up steps must land first.

## Closeout (2026-07-21)

The brainstorm ran in three parts, all with the operator. The first part (early July) produced the **UI redesign sub-plan** at [`ui/PLAN.md`](ui/PLAN.md) — the flow-graph run view — which was executed as its own track (steps 01–16 complete, step 17 deferred until step 30 unfreezes the executor). The second part (this session) was the Guild retrospective proper, run against the step-25 closeout, the current `guild/` contents, the tracked-debt table, and a fresh inspection of the prompts against the real executor surface. The operator reported **no new real-world task observations** since the buildout (the step-25 real-world sign-off remains pending), so the retrospective rests on recorded evidence and inspection. The third part (same session) was a design discussion that grew out of the role-set question — a full review-pipeline redesign — which the operator directed be **implemented immediately** rather than scheduled as a future step. That implementation, its smoke-test iterations, and the revised role set are recorded below.

### Brainstorm findings, by area

**Prompt patterns.** One genuine defect, found by inspection rather than under load: `orchestrator.md` told the model the `agent` tool accepts an optional `budget` that "tightens the child's tool-call or token limits." No such parameter exists in `guild/tools/agent.json`, and step 26 removed the per-role cumulative caps it would have tightened — a model following the prompt would pass an argument that is silently ignored. Fixed in this session (one sentence deleted; see Deviations). Two patterns were checked and judged healthy: `recovery.md`'s teaching of `loop_detected` is forward-compatible (the kind exists in the schema; nothing emits it until step 31's loop detector — intentional pre-teaching, not a mismatch), and the effort-mode restatement pattern (orchestrator restates the mode in every child's task text) was validated end-to-end in step 25's smoke test.

**Roles.** The six-role set was reviewed for gaps and dead weight. `context_manager` is currently **dead weight for its stated purpose**: `edit_context` mutates only the caller's own conversation, and a `context_manager` spawned as a fresh child has no long conversation to compact — the one structural gap the retrospective confirmed (already tracked as debt; write half scheduled as step 32). The operator asked what additional roles could be valuable and, through the discussion that followed, replaced the single generic `critic` with a **specialized review pipeline** (implemented in this session — see "Review pipeline (implemented)" below) and chose to also **seed `researcher`** (read-only + `fetch_url`, digesting broad multi-source exploration into compact briefs so `planner`/`coder` keep small contexts — scheduled as step 34). The interrupt-use agents (loop detector, on-task checker, post-hoc reviewer) need no seeding decision: step 31 makes them prompt-only additions on its platform.

**Tool lists.** `run_shell` is already step 30. Two candidate gaps were decided deliberately: the review roles stay **read-only** (no checker tools, no `write_file` — "reviewers review, the coder verifies and fixes"; a separation-of-concerns decision, recorded so the Foundry does not treat it as an oversight), and the overlap between the `coder`'s `fetch_url` and the step-34 `researcher` role is resolved by convention (`researcher` owns broad digestion; the coder's `fetch_url` stays for a single known page mid-implementation — written into step 34). The `planner` gained `write_file` for the plan-file convention (`.orchestration/plan.md`) as part of the pipeline build.

**Budgets.** The post-step-26 surface is thin by design (`maxAgentDepth` 8, `maxCompactionAttempts` 5, `maxToolOutputChars` 50k, model `maxTokens` 32k). One candidate was decided deliberately: `defaultToolTimeoutSeconds: 30` hard-caps `typecheck`/`test` (callers may lower, never raise), and real test suites can exceed 30s — the operator chose to **keep 30s**: long checker runs should time out and be re-delegated in smaller pieces, which is exactly the behavior the recovery path teaches. Recorded so the Foundry does not treat the cap as an oversight (it may still tune it from evidence).

**Interrupt channel.** v2 by design; fully covered by step 31's existing scope (operator/API interrupt as a trigger source; inquiry and plan-modification as handler prompts). No new gap.

**Executor limitations.** Two surfaced since the buildout: the multiple-`system`-message chat-template incompatibility (fixed 2026-07-10, recorded in `plan/README.md` — no follow-up needed) and the cross-role compaction limitation (the write half, now scheduled as step 32). Nothing else surfaced in inspection.

### Backlog (operator-approved)

Inserted follow-up steps (plan renumbered accordingly):

- **Step 32 — Cross-role context compaction (write half)** ([`32-cross-role-context-compaction.md`](32-cross-role-context-compaction.md)). A context-pressure trigger on the step-31 platform suspends the active role at the safe point and invokes `context_manager`, which compacts that role's history via a cross-role `edit_context`; the role resumes and never overflows. Reactive `context_budget_exceeded` handling (finish + re-delegate smaller) stays as the backstop. Depends on step 31's registry/drain/inspect tools; lands before the Foundry so the optimizer works against a real compaction mechanism. Removes the "Cross-role context compaction" debt row.
- **Step 34 — Researcher role** ([`34-researcher-role.md`](34-researcher-role.md)). Guild-only: new prompt, `guild.json` entry (read tools + `fetch_url` + `finish`, tiered labels), orchestrator/planner/coder prompt updates teaching the delegation/request loop, conformance test update, real-LLM validation. Placed last before the Foundry so it is written against the final executor surface.

Renumbered: run persistence 32→33, Foundry 33→35; all cross-references in `plan/` (including historical closeouts, which named "step 33" for the Foundry) and the debt table updated. `docs/foundry.md`'s stale "step 23" self-reference was de-numbered ("the final step") so it survives future renumbering. The review-pipeline work below was implemented in this session at the operator's direction, so it consumed no step number.

Recorded deliberate decisions (no work to schedule; guard against the Foundry treating them as oversights):

- The review roles stay read-only; verification and fixes are the coder's job.
- `defaultToolTimeoutSeconds` stays 30s; oversized checker runs are re-delegated in smaller pieces.

Deferred to the Foundry (genuinely Foundry-shaped: tunable values and prompt wording the optimizer can search):

- Prompt wording/tuning across all roles, including the effort-mode mappings and the review-lead round caps.
- Per-role tool-list exploration (e.g. whether a checker-wielding reviewer scores better despite the deliberate read-only decision — evidence may override the decision).
- `guild.json` numeric tuning (`maxAgentDepth`, `maxCompactionAttempts`, `maxToolOutputChars`, model sampling params).
- Role-set hypotheses beyond the seed (the Foundry may propose wholesale `guild.json` edits; the seed it starts from is now final at thirteen roles plus step 34's `researcher`, with step 31's `loop_detector` as the interrupt handler).

UI sub-plan step 17 (token-level streaming flow) remains deferred inside [`ui/PLAN.md`](ui/PLAN.md), gated on step 30's executor unfreeze; no main-plan renumbering for it.

**Go decision:** proceed with step 30 (`run_shell`) → 31 (interrupt platform) → 32 (compaction write half) → 33 (persistence) → 34 (researcher) → 35 (Foundry).

## Review pipeline (implemented in this session)

The retrospective's role-set question grew into a full redesign of how reviews work, directed and decided by the operator and implemented immediately (guild prompts + `guild.json` + the seed-guild conformance test; no executor changes).

**The workflow.** The orchestrator sizes the task from its text (tiny / small / large), delegates planning for large tasks (the planner writes `.orchestration/plan.md` and returns a digest), then per step delegates `coder` → `architecture_lead` → `style_lead` → `security_lead`, and finishes with `acceptance_lead` reviewing the whole workspace against the original task. A tiny task skips the per-step leads at fast and balanced effort (its acceptance loop is review enough); the acceptance loop is never skipped, at any size or effort.

**The loop pattern (uniform across all four review types).** Each `*_lead` holds `agent` and runs the loop itself: spawn a fresh `*_reviewer` (clean eyes — best findings), read its digest, accept/decline findings (all `blocking`; `suggestion`s per effort), spawn a fresh `coder` to apply accepted fixes (which re-runs the checkers), and repeat. The lead is the warm judge: its continuous memory makes A→B→A flapping impossible and owns the diminishing-returns call. Guardrails in every lead prompt: severity tags, the narrowing gate (round 2+ is `blocking`-only), the settled-decision rule (a declined direction may only be re-raised if a file it depends on changed), the effort-scaled round cap (operator-set: fast 1, balanced 3, careful 5), and a reported stop reason (`clean`/`converged`/`cap`). Termination is backstopped by the lead's own context window and `maxAgentDepth` even if a cap is ignored.

**Orchestrator context discipline.** Artifacts in the workspace (the plan file), digests in result cards: the orchestrator never reads findings, plans, or file contents — per step it holds ~5 small verdict cards, so it can coordinate a days-long build in a few thousand tokens. Step 32's context-pressure compaction becomes its safety net, not its primary defense.

**Role set.** Retired: `critic`. Added: `architecture_lead`/`architecture_reviewer`, `style_lead`/`style_reviewer`, `security_lead`/`security_reviewer`, `acceptance_lead`/`acceptance_reviewer` (operator decisions: split roles rather than self-delegation — leaves hold no `agent` so they cannot mis-nest; `_lead`/`_reviewer` naming). Kept: `orchestrator`, `planner` (+`write_file`), `coder`, `recovery`, `context_manager`. The leaf prompts are specialist files (Foundry-editable, conformance-pinned), not a generic task agent steered by task text — runtime-generated review standards would be invisible to the Foundry's file-based hypotheses.

**Smoke tests (real LLM, local Ollama `qwen3.5:9b`).** Three in-environment runs via `runExecutor` against a temp workspace: (1) tiny task — the orchestrator wrongly generalized the tiny-task exception and skipped the leads *and* acceptance; fixed by sharpening the pipeline wording and repeating the acceptance mandate in the Finishing section. (2) small website task — the **full pipeline ran**: `coder` → architecture lead (2 rounds: a suggestion found, fixed by the coder, then `converged`) → style lead (clean; one lead instance misfired by trying to review without read tools — it holds none by design — and the orchestrator recovered by re-delegating a fresh lead, which ran correctly) → security lead (clean) → acceptance lead (clean). (3) tiny task — clean `coder` → acceptance run under the codified rule. One calibration recorded for the operator: the model persistently read "tiny tasks skip reviews only at fast effort" as "tiny tasks skip reviews"; the rule was codified to the defensible behavior (tiny skips leads at fast **and** balanced; careful still runs them) rather than escalating wording against the model's judgment — override this if the pipeline should run reviews even on tiny tasks at balanced effort.

**Conformance.** `source/executor/seed-guild.test.ts` pins the thirteen-role set and the split-role invariants (leads delegate and hold no workspace tools; reviewers are read-only leaves holding no `agent`, and their prompts carry the shared severity-tag contract). `bun run typecheck` and `bun test source/` green (757 tests).

### Deviations from the plan wording

- **`guild/` (and the conformance test) changed in this step, substantially.** The module boundary says this step changes only plan/docs. With the operator's explicit approval it landed: the one-line stale-`budget` fix in `orchestrator.md`, and then — when the role-set discussion concluded — the full review pipeline (eight new prompts, the orchestrator/planner/coder rewrites, the `guild.json` role set, and the `seed-guild.test.ts` conformance update), implemented in-session at the operator's direction rather than scheduled as a follow-up step. No executor code changed; `bun run typecheck` and `bun test source/` are green.
- **The brainstorm document lives in this closeout**, not `docs/guild-roadmap.md` — it stayed compact enough.
- The file's stale title ("Step 28", left over from an earlier renumbering) was corrected to "Step 29".

### Operator sign-off

The backlog and prioritization above were decided item-by-item with the operator in-session (no real-world observations to fold in; insert the write half at step 32; fix the prompt defect now; keep the 30s checker cap; reviewers stay read-only; seed `researcher`; then the pipeline decisions: split roles, `_lead`/`_reviewer` naming, 1/3/5 round caps, leads fresh per plan step). The operator directed the pipeline's immediate implementation — that direction, and their review of the smoke-test outcomes above, constitutes sign-off. **Confirmed 2026-07-21.**
