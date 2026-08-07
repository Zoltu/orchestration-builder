# Step 34 — Researcher role

## Goal

Add a `researcher` role to the seed Guild: a read-only role that digests exploration into compact briefs so the `planner` and `coder` do not fill their own context windows with raw search results, whole files, and fetched pages. This is the one role addition the step-29 brainstorm approved — the seed set's only judged gap — and the last Guild change before the Foundry (step 35) begins optimizing.

## Context

Read the step-29 closeout in [`29-guild-improvement-brainstorm.md`](29-guild-improvement-brainstorm.md) (the role-set discussion, the decision to seed `researcher`, and the review pipeline that landed in that step), the thirteen current prompts in `guild/prompts/` (especially `orchestrator.md` — the role that routes all top-level work), `guild/guild.json` (role schema, the tiered `label`/`description`/`workingLabel` fields the UI renders), and `source/tools/validate-data.ts` (the data-validity gate that pins the role set — the seed-guild conformance moved there when the operator refactored it out of `bun test`; see step 31's closeout).

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
5. **`source/tools/validate-data.ts` (update).** Add `researcher` to `expectedRoles` and assert its tool list; assert its prompt carries the compact-brief guidance (the same style of content assertion the orchestrator/recovery prompts get there).
6. **Real-LLM validation.** Run two research-flavored tasks against the local model (one workspace-exploration task, one external-doc task) through the service and record in the closeout: whether the orchestrator delegated to `researcher`, whether the brief stayed compact, and whether the downstream role used it without re-reading everything.

## Module boundaries

- Guild-only step: one new prompt, `guild.json` entries, small prompt edits, the conformance test. No executor code, no new tools, no schema changes.
- The `researcher` gets no write capability and no `agent` — it is a leaf role by design, so it cannot delegate or mutate.
- Overlap with the `coder`'s `fetch_url` is resolved in prompts, not by removing the tool: `researcher` owns broad/multi-source digestion; the `coder`'s `fetch_url` stays for a single known page mid-implementation.

## Acceptance criteria

- [x] `bun run typecheck` and `bun test source/` pass, and `bun run validate-data` passes with the updated guild conformance checks.
- [x] The `researcher` role loads through the Guild loader with a valid tool list and complete tiered labels.
- [x] The orchestrator prompt teaches when to delegate to `researcher`; the planner/coder prompts teach the "needs research" request loop; no two prompts contradict each other on who reads external material.
- [x] The real-LLM validation runs are recorded in the closeout (delegation happened, brief compact, downstream role consumed it).
- [x] The seed role set is final for the Foundry: sixteen roles in `guild.json` — the fourteen work roles (the thirteen from step 29's review-pipeline build plus `researcher`) plus the two step-31 platform handlers (`loop_detector`, `inquiry_responder`).

## End-of-step evaluation

Re-read every role prompt for consistency: does any role still claim it must do its own broad exploration? Does the orchestrator's delegation list match the roles that actually exist? Confirm `validate-data.ts`'s `expectedRoles` matches `guild.json` exactly. Confirm nothing in the step touched `source/` outside the validate-data gate.

## Estimated effort

Medium — mostly prompt writing plus the conformance update; the real-LLM validation is the open-ended part. Budget one or two prompt iterations against the local model.

## Operator handoff

Run two or three research-heavy real-world tasks (operator-chosen: e.g. "explain what this project does and where X lives", "build a small page using library Y's current docs") and judge: does the orchestrator reach for `researcher` at the right times, are the briefs genuinely compact, and does the division of labor with the `coder`'s own `fetch_url` feel right? Report mis-delegations and prompt weaknesses for iteration before the Foundry begins.

Two residual small-model behaviors from the in-environment validation (below) are worth judging against the real model: `search_text`-on-URL confusion persisted at 9b despite explicit prompt teaching, and the orchestrator skipped the acceptance loop on both Q&A-flavored tasks (a pre-existing 9b tendency recorded in step 29's closeout, not introduced here). One researcher instance also re-fetched the same 404 URL ~35 times before exiting honestly with `needs_clarification` — the effort-scaled loop cadence (48 calls at effort 3) never fired; watch whether the real model needs a tighter "do not re-fetch" teaching or a lower cadence.

## Closeout (2026-08-06)

Complete. `bun run typecheck`, `bun test source/` (831 tests across 41 files), and `bun run validate-data` (16 roles, 20 tool manifests) all pass. The seed role set is final for the Foundry.

Changed files:

- `guild/prompts/researcher.md` (new) — the role: effort-mode branching (fast targeted look / balanced coverage / careful survey noting what was *not* found), map-then-read investigation, the compact-brief contract (answer first, cite every finding by path or URL, quote short excerpts, summary-sized), read-only/no-delegation hard rules, honest exits (`success` with an "I found nothing" brief; `needs_clarification` when the question is unanswerable as posed).
- `guild/guild.json` — the `researcher` role (after `coder`): tools `list_directory`, `glob_files`, `read_file`, `read_file_partial`, `search_text`, `fetch_url`, `finish`; tiered `label`/`description`/`workingLabel` in all three tiers (whimsical: "Scout").
- `guild/prompts/orchestrator.md` — a **Research** paragraph opening the pipeline (exploration-heavy goals start with the `researcher`; mid-run "needs research: …" gaps are filled and re-delegated; never send `planner`/`coder` to do broad exploration) and a `researcher` bullet in the delegation list contrasting the `coder`'s own `fetch_url` (single known page mid-implementation — not a research delegation).
- `guild/prompts/planner.md`, `guild/prompts/coder.md` — the request loop: state "needs research: …" in the summary rather than speculating or reading far beyond the step.
- `source/tools/validate-data.ts` — `researcher` added to `expectedRoles`; a dedicated block pins its exact tool set and asserts the prompt carries the compact-brief (`brief`) and citation (`cite`) guidance, in the style of the existing orchestrator/recovery content assertions.
- `docs/foundry.md` — the Seed Guild enumeration updated to the final set (adds `researcher` and the step-31 platform handlers, which the paragraph had never listed).

### Real-LLM validation (local Ollama `qwen3.5:9b`, throwaway workspaces, effort 3)

**Task 1 — workspace exploration** ("explain what this project does … write your findings to EXPLANATION.md" against a small CLI project): the orchestrator's *first* delegation was the `researcher`, which surveyed the tree and returned a 926-char cited brief; the orchestrator folded it into a `coder` delegation that read two small orientation files and wrote `EXPLANATION.md` from the brief — no re-survey. The first attempt ended differently: the orchestrator finished straight after the brief, *claiming* the file existed when nothing had written it. One prompt iteration ("only the `coder` writes; a brief is input to the pipeline, never the deliverable") fixed it — the rerun produced the file through a real coder delegation. That was iteration one of the two the step budgets.

**Task 2 — external docs** ("research Bun.serve() and Bun's test runner from bun.sh/docs … write BUN_NOTES.md"): the orchestrator again opened with the `researcher` and, across twelve research delegations chasing the right documentation URL, every brief stayed compact (300–2,500 chars, cited) while the raw pages (~20k tokens each) stayed inside researcher conversations — the orchestrator's own context peaked at ~8k tokens, the absorption the role exists for. The `coder` then wrote `BUN_NOTES.md` (verified on disk) from the final brief with zero re-fetching. The iteration-two additions (the "only the coder writes" strengthening, plus teaching that `search_text` cannot search fetched pages) held: no hallucinated deliverable, and two researcher instances that hit dead ends exited honestly with `needs_clarification` rather than inventing content.

Residual small-model weaknesses (recorded for the operator handoff above, not iterated further — the step budgets two iterations): `search_text`-on-URL confusion persisted at 9b despite the new sentence; one instance re-fetched a 404 ~35 times (under the 48-call effort-scaled loop cadence) before its honest exit; the orchestrator skipped the acceptance loop on both tasks — the same 9b acceptance-skip tendency step 29 recorded and chose to codify rather than fight.

### Deviations from the plan wording

- **The conformance check lives in `source/tools/validate-data.ts`, not `source/executor/seed-guild.test.ts`** — the step's deliverable 5 and context section referenced the latter, which the operator's earlier refactor folded into the validate-data gate (recorded in step 31's closeout). The step file's wording was updated to match before implementation; the conformance assertions landed in the gate.
- **The acceptance criterion's role count was imprecise**: it said "fourteen roles … with `loop_detector` arriving as the interrupt handler in step 31", omitting step 31's `inquiry_responder`. Corrected to sixteen (fourteen work roles plus two platform handlers) in the criterion itself.
- **`docs/foundry.md` gained a one-sentence update** (the seed enumeration), which the step's deliverables did not list — the step's own acceptance criterion makes the seed final here, and the Foundry doc is where that set is named.

### Operator handoff iteration (2026-08-07)

The operator ran the handoff task (tiny Bun web app built from the Bun docs, empty workspace, effort 3) against the real endpoint (`llama-server`, "Agents A1") and reported the route `orchestrator → coder` with no `researcher`. The extracted run log showed three distinct weaknesses: (1) the orchestrator read "check the official Bun docs at bun.sh/docs" as the coder's `fetch_url` carve-out and re-tasked the coder with the docs instruction intact but unrouted — the coder then wrote the app from parametric memory with zero fetches; (2) the acceptance loop never ran — the never-skipped mandate failed on the real model too, not just at 9b; (3) `typecheck` reported "Script not found tsc" on the empty workspace and the coder proceeded on `test` alone.

Prompt iterations (Guild-only, as the step budgets):

1. **Research boundary sharpened** (`orchestrator.md`): gathering external material explicitly includes "points at a documentation site without naming the exact pages"; the `fetch_url` carve-out narrowed from "a single known page" to an *incredibly targeted lookup* — exact URL already known, small expected response (an API response, a registry version check, a status ping); the same charter sentence now lives in `coder.md` so both sides of the delegation make the same call, and a coder handed a broad lookup self-defers with "needs research: …". Research delegations are taught to stay question-shaped (a question to answer, never a document to read).
2. **Acceptance anti-pattern named** (`orchestrator.md`): never finish straight from a `coder` delegation — if no `acceptance_lead` verdict is in the conversation, that is the missing step.
3. **Checker-that-never-ran clause** (`coder.md`): "Script not found" means the toolchain is missing — install it and re-run; never claim a checker that did not run.

**Re-validation against the real endpoint** (verbatim operator task, effort 3, two runs): the first run confirmed the acceptance fix (orchestrator → acceptance_lead → reviewer → "satisfied after 1 round (clean)") but still routed coder-direct — the first boundary wording moved `qwen3.6:35b` but not "Agents A1". After the identical-charter iteration, the second run landed the whole intended shape: **orchestrator → researcher first** (3 fetches → 2,560-char cited brief), **coder with zero `fetch_url` calls** building from the brief, then the acceptance loop (2 rounds: 1 blocking gap closed, 1 suggestion addressed) before success. `bun run validate-data` and `bun test source/` (831) green after all edits.

Residual observations (recorded, not fixed — small-model whack-a-mole beyond the step's iteration budget): the acceptance-driven fix round shuffled the test file to a name bare `bun test` does not discover (`test.ts`), so tests pass only via `bun test ./test.ts` while the README claims bare `bun test` — the read-only reviewer cannot run checkers to catch that class of regression (deliberate step-29 separation; noted as Foundry evidence to revisit); the coder ran `typecheck` twice, got "Script not found tsc" both times, and never installed the toolchain — the no-false-claim half of the clause held (it never claimed a typecheck pass), the install half did not; one coder instance finished via implicit finish with an empty summary. Operator decisions during this iteration: do not optimize for context windows below ~100k (150k–200k is the realistic local band, 256k the consumer upper end); the filtered-fetch tool (`pattern`-parameter fetch) will **not** be built — the operator has separate plans for the context-thrash problem, to be worked on later — and per-role egress blocking was rejected as unenforceable (`run_shell` leaks it; the deployment image confirmed to ship no `curl`) and undesirable (the needle-lookup exception is legitimate). The operator also repointed `guild.json`'s model at `Agents A1`, the model most commonly loaded on the target endpoint, so validation and deployment run the same model.
