# Step 34 — Researcher role

## Goal

Add a `researcher` role to the seed Guild: a read-only role that digests exploration into compact briefs so the `planner` and `coder` do not fill their own context windows with raw search results, whole files, and fetched pages. This is the one role addition the step-29 brainstorm approved — the seed set's only judged gap — and the last Guild change before the Foundry (step 35) begins optimizing.

## Context

Read the step-29 closeout in [`29-guild-improvement-brainstorm.md`](29-guild-improvement-brainstorm.md) (the role-set discussion, the decision to seed `researcher`, and the review pipeline that landed in that step), the thirteen current prompts in `guild/prompts/` (especially `orchestrator.md` — the role that routes all top-level work), `guild/guild.json` (role schema, the tiered `label`/`description`/`workingLabel` fields the UI renders), and `source/executor/seed-guild.test.ts` (the conformance test that pins the role set).

Why this role, in one paragraph: the target tasks ("what does this project do?", "build me a website using library X") involve broad, multi-source exploration whose raw material is context-expensive. Today the `planner` inspects the workspace itself and the `coder` holds `fetch_url` for rare targeted reads — both then carry everything they read for the rest of their (long) conversations. A `researcher` returns a *digest*: findings with paths/URLs, short key excerpts, and a direct answer. The delegating role keeps the digest, not the raw material. The executor is unchanged — this is Guild-only work (a new prompt, `guild.json` entries, the conformance test).

Delegation reality check: the four review leads and `recovery` hold `agent`, but the leads delegate only inside their own review loops — top-level routing stays with the orchestrator, so only the orchestrator can invoke `researcher`. A `planner` or `coder` that needs research says so in its result card (its summary), and the orchestrator decides whether to delegate research and re-delegate the step. The prompts must teach exactly this loop and nothing fancier.

## Deliverables

1. **`guild/prompts/researcher.md` (new).** The role: given a research question or area by the orchestrator, inspect the workspace (`list_directory`, `glob_files`, `read_file`, `read_file_partial`, `search_text`) and external documents (`fetch_url`, sparingly — only when the task needs material not in the workspace), and return a compact brief. The prompt teaches:
   - Answer the question asked; do not wander. Cite every finding by workspace-relative path or URL. Quote short excerpts rather than paraphrasing when exact wording matters.
   - Keep the brief summary-sized — the whole point is that the caller does not read the raw material. Prefer `read_file_partial`/`search_text` over whole large files.
   - Effort-mode branching like the other roles (restated in the task text by the orchestrator): fast mode = a quick targeted look and a short answer; careful mode = a thorough survey covering alternatives and noting what was *not* found.
   - Never write files, never guess at unread contents, finish with `status: "success"` and the brief in `summary` (`needs_clarification` if the question is unanswerable as posed).
2. **`guild/guild.json`.** Add the `researcher` role with tools `list_directory`, `glob_files`, `read_file`, `read_file_partial`, `search_text`, `fetch_url`, `finish` (no `write_file`, no `agent`, no checker tools) and tiered `label`/`description`/`workingLabel` in all three tiers, matching the style of the existing roles.
3. **`guild/prompts/orchestrator.md` (update).** Add `researcher` to the delegation list and teach when to use it: before planning, when the goal is exploration-heavy (understanding an unfamiliar project, comparing approaches, gathering external material); after a child reports missing information, to fill the gap and re-delegate. Contrast with the `coder`'s own `fetch_url` (a single known page mid-implementation) so the two do not overlap.
4. **`guild/prompts/planner.md` and `guild/prompts/coder.md` (small updates).** Teach the request loop: if material is missing, say so explicitly in the result summary ("needs research: …") so the orchestrator can delegate it — do not speculate or read far beyond the step.
5. **`source/executor/seed-guild.test.ts` (update).** Add `researcher` to `expectedRoles` and assert its tool list; assert its prompt carries the compact-brief guidance (the same style of content assertion the orchestrator/recovery prompts get).
6. **Real-LLM validation.** Run two research-flavored tasks against the local model (one workspace-exploration task, one external-doc task) through the service and record in the closeout: whether the orchestrator delegated to `researcher`, whether the brief stayed compact, and whether the downstream role used it without re-reading everything.

## Module boundaries

- Guild-only step: one new prompt, `guild.json` entries, small prompt edits, the conformance test. No executor code, no new tools, no schema changes.
- The `researcher` gets no write capability and no `agent` — it is a leaf role by design, so it cannot delegate or mutate.
- Overlap with the `coder`'s `fetch_url` is resolved in prompts, not by removing the tool: `researcher` owns broad/multi-source digestion; the `coder`'s `fetch_url` stays for a single known page mid-implementation.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass, including the updated seed-guild conformance test.
- [ ] The `researcher` role loads through the Guild loader with a valid tool list and complete tiered labels.
- [ ] The orchestrator prompt teaches when to delegate to `researcher`; the planner/coder prompts teach the "needs research" request loop; no two prompts contradict each other on who reads external material.
- [ ] The real-LLM validation runs are recorded in the closeout (delegation happened, brief compact, downstream role consumed it).
- [ ] The seed role set is final for the Foundry: fourteen roles (the thirteen from step 29's review-pipeline build plus `researcher`), with `loop_detector` arriving as the interrupt handler in step 31.

## End-of-step evaluation

Re-read every role prompt for consistency: does any role still claim it must do its own broad exploration? Does the orchestrator's delegation list match the roles that actually exist? Confirm the conformance test's `expectedRoles` matches `guild.json` exactly. Confirm nothing in the step touched `source/` outside the conformance test.

## Estimated effort

Medium — mostly prompt writing plus the conformance update; the real-LLM validation is the open-ended part. Budget one or two prompt iterations against the local model.

## Operator handoff

Run two or three research-heavy real-world tasks (operator-chosen: e.g. "explain what this project does and where X lives", "build a small page using library Y's current docs") and judge: does the orchestrator reach for `researcher` at the right times, are the briefs genuinely compact, and does the division of labor with the `coder`'s own `fetch_url` feel right? Report mis-delegations and prompt weaknesses for iteration before the Foundry begins.
