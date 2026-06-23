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

- [ ] A documented, operator-approved UI feature inventory exists in this step's closeout.
- [ ] Plan steps have been created for any agreed features that warrant dedicated work.
- [ ] `bun run typecheck` and `bun test source/` still pass (this step produces no code changes unless small fixes are agreed with the operator).

## End-of-step evaluation

Confirm the agent did not decide UI features unilaterally — the closeout records the operator's input and sign-off. Confirm any new steps are consistent with the plan's ordering and the product vision (Docker image serving a webpage, all interaction through the UI).
