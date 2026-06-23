# Step 16 — UI feature brainstorm (operator-collaboration step)

## Goal

Step back with the operator and figure out what features the web UI should have before investing in guild build-out and interrupt mode. The current UI (step 14) is a minimal multi-run view: run list, create-run form, per-run view, and `ask_human` answering. This step decides what else the UI needs to be genuinely useful as the primary interface for giving tasks, monitoring progress, and seeing results.

This step is intentionally collaborative and reflective — the agent does not decide UI features unilaterally. It proposes, the operator validates, and follow-up steps are created as needed.

## Context

Read [`14-multi-run-ui.md`](14-multi-run-ui.md) (the current UI surface and its debt), [`13-long-running-service-mode.md`](13-long-running-service-mode.md) (the API the UI consumes), and [`docs/architecture.md`](../docs/architecture.md) ("Execution model"). Read `source/web/static/app.js` and `source/web/server.ts` to understand the current UI capabilities and limitations.

The UI is the primary interface — the user should never need the API. Step 14 built the minimum viable UI; this step figures out what's missing.

## Deliverables

1. **Propose a UI feature inventory.** Walk through the user journey (submit a task → monitor progress → respond to questions → review results → start a new task) and identify gaps. Consider: better run progress visualization (role tree, current activity), result review (what files were created/modified), run history navigation, task templating, settings/configuration exposure, error surfacing, and anything else the operator identifies.
2. **Collaborate with the operator.** Present the inventory, get feedback, and prioritize. Not every gap needs a step — some may be quick fixes, some may be deferred, some may not be worth building.
3. **Create plan steps for agreed features.** Insert new steps (renumbering per the plan README's hygiene rule) for features that warrant dedicated work. Small fixes can be folded into the step that builds the feature they depend on.
4. **Document decisions.** Record what was proposed, what was accepted/deferred/rejected, and the rationale, in this step's closeout.

## Acceptance criteria

- [x] A documented, operator-approved UI feature inventory exists in this step's closeout.
- [x] Plan steps have been created for any agreed features that warrant dedicated work.
- [x] `bun run typecheck` and `bun test source/` still pass (this step produces no code changes unless small fixes are agreed with the operator).

## End-of-step evaluation

Confirm the agent did not decide UI features unilaterally — the closeout records the operator's input and sign-off. Confirm any new steps are consistent with the plan's ordering and the product vision (Docker image serving a webpage, all interaction through the UI).

## Closeout (2026-06-23)

Complete. This is an operator-collaboration step; no source code changed. `bun run typecheck` and `bun test source/` both pass (unchanged — only `plan/` changed).

### UI feature inventory (proposed, walked through the user journey)

The agent reviewed the step-14 surface (`source/web/static/app.js`, `source/web/static/index.html`, `source/web/render.ts`, `source/web/server.ts`) and the data the API and persisted artifacts actually expose (`RunMeta`, `log.jsonl`, `ResultCard`, the loaded Guild). Gaps identified, by journey stage:

- *Monitor progress* — recent log renders as raw `JSON.stringify(payload)` (unreadable for the non-developer target user); no "what is it doing now" indicator; hard budgets (`maxToolCallsPerRole`/`maxTokensPerRole`/`maxRunTimeSeconds`) are enforced but never surfaced. (The role-*tree* gap is already tracked debt, gated on step 22's executor events, so it was not re-proposed here.)
- *Respond to questions* — a pending `ask_human` is a quiet panel entry a 24/7 operator can miss; answered questions vanish, leaving no per-run Q&A history.
- *Review results* — `RunMeta.error` (kind + message) exists but the summary shows only `result.summary`; `ResultCard.artifacts` exist but are never rendered; the workspace is mutated in place with no UI view of what changed; only the last 200 log lines are reachable.
- *History navigation* — no re-run of a past task; no run-list search/filter; the selected run is lost on reload.
- *Settings* — no view of the loaded Guild (model name, budgets, roles/tools).

### Operator decisions (sign-off)

The operator selected ten features for dedicated work and deferred two:

- **Accepted (10):** human-readable log; error surfacing; question-arrival notification; current-activity indicator; artifacts display; re-run a past task; full-log pagination/export; past Q&A history; budget & elapsed-time display; read-only config/about panel.
- **Deferred (not selected):** changed-files / diff view (highest review value but the most work and may need a backend endpoint — left for a later proposal); run-list search/filter + persist-selection (low value until many runs accumulate).

### New plan steps (17–21)

The ten accepted features were grouped into five session-sized steps by area and backend-dependency:

- **Step 17 — Per-run view readability:** human-readable log, error surfacing, artifacts display, current-activity indicator. Client + `render.ts`; no backend.
- **Step 18 — `ask_human` UX:** arrival notification + past Q&A history. Client + `render.ts` (plus an optional additive `human_answer` log event if answers are not otherwise log-recoverable).
- **Step 19 — Full log access:** pagination / load-more + export. New `GET /api/runs/:id/log` endpoint + client.
- **Step 20 — Budget & elapsed-time display:** remaining tool/token/time budgets + elapsed. Client + `render.ts` (plus an optional additive `usage` field on `llm_call` events if token usage is not already logged).
- **Step 21 — Runs panel & config:** re-run a past task + read-only config/about panel. Client + a new `GET /api/config` endpoint.

### Plan renumbering

The operator chose to insert the five UI steps at 17–21 (keeping UI polish — the primary interface — immediately after this brainstorm, before executor-freeze/Foundry work) and renumber the affected steps forward: 17→22, 18→23, 19→24, 20→25, 21→26, 22→27, 23→28. Step files were renamed and their internal cross-references updated; `plan/README.md`'s tracked-debt table and implementation-order bullets were updated to the new numbers.

During the renumber the agent discovered that several *completed* steps already carried stale/broken step references from a prior renumber that had not been swept (e.g. `00`, `04`, `05`, `07`, `08`, `11`, `15` referenced a non-existent `16-environment-isolation.md` and `17-run-shell-tool.md`, and called `run_shell` "step 17" when the current plan had it at 22 — environment isolation having been folded into the Foundry step). The operator directed a full sweep, so these stale references were corrected in `00`, `04`, `05`, `07`, `08`, `11`, `13`, and `15`: `run_shell` now points at step 27, per-run environment isolation at the Foundry (step 31), and the role-tree debt at step 22. No completed-step *closeouts* (the authoritative record) were rewritten; only forward-looking context/body references and the markdown links were corrected.

### Verification

`bun run typecheck` and `bun test source/` pass (no source changes). End-of-step evaluation: the agent did not decide UI features unilaterally — every accepted feature and the renumbering approach were operator decisions recorded above; the new steps are consistent with the product vision (Docker image serving a webpage, all interaction through the UI).

### Follow-on proposal (2026-06-23, same step)

The operator proposed a project-wide speed-vs-quality slider: a per-run setting the operator adjusts before each task, persisted in `.orchestration/settings.json`, read on project load, and not adjustable mid-run. The executor had no such concept, so this required both an executor channel and a UI control. The operator and agent agreed on:

- **Representation: integer 0–5 with quality-graded labels** (quality, not thoroughness — thoroughness is a subset of quality). The slider snaps to six stops; the stored/threaded value is the integer.
- **Executor provides the channel only.** It logs the effort, persists it, and injects a directive into the entry role's context; the effort→behavior mapping (review passes, iteration, plan granularity) lives in the Guild prompts (step 25) so the Foundry can later tune it. The executor makes no domain decisions about what each level means.
- **Project-wide default, per-run override.** Default read from `.orchestration/settings.json` at submission; overridable per task; the Foundry sets effort per benchmark (benchmarks must be comparable).
- **Two new steps:** step 23 (executor channel — persistence, threading, context injection, `POST /api/runs` effort field, `GET|PUT /api/settings`) and step 24 (UI slider). Both land before the seed-Guild buildout so prompts are written against the real channel.

The operator also directed a reordering: the run-interrupt channel is **v2** (not required to start using the tool in the real world) and the Foundry is the last step (built after every other desired feature). The inquiry and plan-modification steps land at 28 and 29 (after `run_shell`); the Foundry lands at 31 (last). The new effort steps take 23 and 24. The seed-Guild buildout (step 25) drops its "teach the interrupt contract" deliverable (the channel does not exist when it runs) and adds an effort-branching deliverable instead; the v2 interrupt steps each include a small prompt-revisit deliverable teaching the contract the buildout could not anticipate. `plan/README.md`'s implementation order, debt table, step 13's interrupt reference, step 25's deliverables, and the moved steps' internal cross-references were updated to the new numbering. No `source/` changes; `bun run typecheck` and `bun test source/` still pass.
