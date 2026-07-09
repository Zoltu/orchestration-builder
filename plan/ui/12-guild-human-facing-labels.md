# UI step 12 — Guild human-facing label/description tiers

## Goal

Make the backend change the nailed-down visualization needs: add tiered human-facing `label` and `description` fields to every role and tool in the guild, so the live `/api/config` carries the friendly labels the UI already renders against fixture placeholders. `detailed` is required; `whimsical` and `friendly` are optional. This is the first phase-B step and the only backend/schema change in the sub-plan; it is done after the visualization is signed off (step 11) so we build exactly what the UI needs.

## Context

Read [`PLAN.md`](PLAN.md) ("Human-friendly node labels"), [`11-visualization-signoff-polish.md`](11-visualization-signoff-polish.md) (the signed-off visualization whose label needs this step meets), `source/executor/types.ts` (`RoleDefinition`, `ToolManifest`), `source/executor/validation.ts` (the `validateGuildConfig` / `validateToolManifest` guards), `source/executor/loader.ts` (how manifests and roles surface on `LoadedGuild`), `source/web/render.ts` (`renderConfig` — the safe `/api/config` subset), and the seed guild (`guild/guild.json`, `guild/tools/*.json`). Today roles carry `systemPrompt` + `tools` (+ optional `includeReasoning`); tools carry `name` + `description` + `parameters`. The phase-A fixtures already assume these tiered fields exist (with placeholder labels); this step makes them real. The guild is loaded once at server startup and never re-read or mutated, so surfacing these via `/api/config` is safe for every live run.

## Deliverables

1. **`source/executor/types.ts`** — add a shared tiered-text shape and apply it to roles and tools:
   ```ts
   export interface HumanFacingText {
   	datadetailed: string
   	whimsical?: string
   	friendly?: string
   }
   ```
   Add `label?: HumanFacingText` and `description?: HumanFacingText` to `RoleDefinition`. Add `humanLabel?: HumanFacingText` and `humanDescription?: HumanFacingText` to `ToolManifest` (named distinctly from the existing model-facing `description` string to avoid collision). Optional on the type so a minimal guild still validates; `detailed` is required *when the object is present* (enforced by validation).
2. **`source/executor/validation.ts`** — extend `validateGuildConfig` and `validateToolManifest` to validate the tiered-text shape when present: must be an object, `detailed` must be a non-empty string, `whimsical`/`friendly` when present must be strings. Surface a `ValidationError` with a path-based message on violation. Do **not** require the fields to be present (minimal guilds stay valid); only require `detailed` *inside* a present `HumanFacingText`.
3. **`source/executor/loader.ts`** — confirm the new fields ride along on `LoadedGuild` with no extra plumbing (the loader passes the validated config through). No behavior change.
4. **`source/web/render.ts`** — extend `renderConfig`'s safe subset to include each role's `label`/`description` and each tool's `humanLabel`/`humanDescription` (the full tiered objects, so the UI tier toggle switches client-side without a round-trip). These are not secrets. Update `renderConfig` tests in `source/web/render.test.ts` and the `/api/config` assertions in `source/web/server.test.ts` to cover the new fields (present, omitted, and the structural-omission-of-secrets still holds).
5. **Seed guild** — add `label` and `description` (all three tiers) to every role in `guild/guild.json` and `humanLabel`/`humanDescription` to every tool manifest in `guild/tools/*.json`. The `friendly` tier is what the UI shows by default; write it as a plain one-liner a non-developer understands (the phase-A placeholder labels are a starting point). Update `source/executor/seed-guild.test.ts` conformance assertions to require the tiered fields on every role and tool.

## Module boundaries

- Touches `source/executor/types.ts`, `source/executor/validation.ts`, `source/executor/loader.ts`, `guild/`, `source/web/render.ts`, and their tests. A data/schema change with no runtime behavior change.
- No endpoint changes beyond `/api/config` carrying more (non-secret) fields.
- The executor does not consume these fields at runtime — they are UI-facing only. No prompt or tool-dispatch logic reads them.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] A role/tool may carry tiered `label`/`description`; `detailed` is required when the object is present; `whimsical`/`friendly` are optional.
- [ ] A guild with no tiered fields still validates (backward compatible).
- [ ] `/api/config` surfaces the tiered fields for every role and tool; the existing secrets-omission (`apiKey`/`apiBase`) still holds.
- [ ] The seed guild carries all three tiers on every role and tool; `seed-guild.test.ts` enforces it.

## End-of-step evaluation

Re-read the validation guards and `renderConfig` against `AGENTS.md` (type safety, external-data validation, no typecasts). Confirm the tiered-text validator is a single reusable predicate used by both role and tool validation (no duplicated shape logic). Confirm no `as` casts were introduced.

## Operator handoff

Confirm `/api/config` now carries the friendly labels and the seed guild's labels read well. (The UI does not yet consume live data — that is step 13.)

## Closeout (2026-07-05)

Closed. `bun run typecheck` and `bun test source/` (672 tests) green. The tiered-text validator is a single reusable predicate (`isHumanFacingText`) used by both role and tool validation — no duplicated shape logic. No `as` casts introduced. The seed guild now carries all three tiers on every role and tool; `/api/config` surfaces them. Phase B proceeds to step 13 (live hookup).

