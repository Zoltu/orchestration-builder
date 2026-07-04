# MVC step 03 — Label localization registry + tier resolver + toggle

## Goal

Build the localization layer that keeps prose out of the model. A registry mapping participant `role`/`kind` and operation `kind` → `{ fun, helpful, detailed }` tiers, a resolver that interpolates source/destination role labels into operation templates, and a tier toggle in the demo harness. The model stays prose-free; the views (landing in steps 04/06) will call the resolver to render short labels, and render the model's `details` markdown separately for rich tooltip content.

## Context

Read [`PLAN.md`](PLAN.md) ("Labels (settled design)"). The three tiers serve different audiences: **fun** is playful (children/playful users), **helpful** is informative-but-imprecise (non-technical), **detailed** is precise (technical). The tier toggle swaps the registry without touching the model — a view concern, like locale switching. Operation labels are templated off `kind` + the referenced roles so the model never carries display prose; the per-call `details` markdown (arguments/results/summaries) is runtime data the adapter formats, not localization, so it lives on the model and is untouched by the toggle.

## Deliverables

1. **`source/web/static/mvc/labels.js`** — the registry + resolver, browser-pure:
   - A participant-label table keyed by `role`/`kind` → `{ fun, helpful, detailed }`, seeded with the demo guild's roles and tools plus the `human` ("You" across tiers, or playful variants) and `interrupt` pseudo-roles. `fun` entries are deliberately playful and may sacrifice precision; `detailed` entries are precise.
   - An operation-label table keyed by `kind` (`call`, `return`, `observe`) and a discriminator (e.g. role→role, role→tool, role→human) → templated entries per tier that interpolate the source/destination role labels.
   - `resolveParticipantLabel(participant, tier)` and `resolveOperationLabel(operation, participants, tier)` — return the chosen tier, falling back `detailed → helpful → fun` (or the title-cased role name) when a tier is absent, so a guild author who omits a tier still gets a readable line.
   - The registry is data (an object literal); the resolver is a small pure function over it.
2. **`source/web/labels.test.ts`** — covers the three tiers for participants and operations, the fallback chain when a tier is missing, and the template interpolation (source/destination labels appear in the rendered operation label).
3. **`source/web/static/demo.js`** — add the tier toggle (fun / helpful / detailed) to the harness chrome; re-render the debug text view with the selected tier so the registry is iterable end-to-end. (The SVG views pick it up in steps 04/06.)

## Module boundaries

- Web-only. Browser-pure JS module + TS test, mirroring the model's convention.
- The registry is the single source for short display prose; the views import the resolver and never hardcode a label string.
- No model changes — `InteractionModel` carries no prose. No backend.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] All three tiers render for every demo-scenario participant and operation; the fallback chain works when a tier is omitted.
- [ ] Operation labels interpolate source/destination role labels per tier (a `call` from chef to baker reads playfully in `fun`, precisely in `detailed`).
- [ ] The demo tier toggle re-renders the debug view without touching the underlying model.
- [ ] No prose strings hardcoded in the model or (eventually) the views; the registry is the only label source. No plan/step references in source.
