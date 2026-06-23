# Step 23 — Effort channel (executor)

## Goal

Add a per-run `effort` setting that lets the operator choose a point on a speed-vs-quality axis before each task, and carry that choice through the executor as a stable value the Guild prompts can branch on. The executor provides the **channel only** — it logs the effort, exposes it to the entry role's context, and persists it on the run; the mapping from effort to concrete behavior (generation overrides, critic-skip rules, retry thresholds) lives entirely in the Guild prompts (taught in step 25) and is tunable by the Foundry. The executor makes no domain decisions about what "fast" or "thorough" means.

## Context

Read [`13-long-running-service-mode.md`](13-long-running-service-mode.md) (the service API and the one-task-at-a-time submission contract this extends), `source/executor/executor.ts` (`runExecutor`, `RunOptions`), `source/executor/types.ts` (`RunOptions`, `RunMeta`), `source/executor/engine.ts` (`runRole` — where the entry role's initial messages are assembled), and `source/executor/run-submission.ts` (`submit(task)` — the submission boundary that will accept the effort). Read `source/executor/persistence.ts` for the existing leaf-factory pattern; the project-settings file this step adds is a new peer.

The product is a Docker image left running 24/7 on one project; the operator submits tasks one at a time. Not all tasks warrant the same care — a quick typo fix versus a multi-file refactor versus a careful migration have different speed/quality tradeoffs. Today the only knob is the Guild's fixed generation config; there is no per-task way to say "be quick" or "be careful." This step adds that knob as a persisted, loggable, context-injected value, without the executor deciding what it means.

### Design decisions (operator-approved)

- **Representation: integer 0–5, with quality-named labels.** The UI slider snaps to six stops; the stored and threaded value is the integer `0`–`5`. The labels are quality-graded (e.g. `0` = "fastest", `5` = "highest quality") — *quality*, not thoroughness, since thoroughness is one subset of quality. The integer is the contract; labels are a UI concern (step 24).
- **Executor provides the channel only.** It logs the effort, persists it on `RunMeta`, and injects a directive into the entry role's context. It does **not** map effort to `temperature`/`maxTokens`/budgets — that mapping is Guild behavior (step 25) so the Foundry can later tune it. Hardcoding it in `llm.ts` would conflict with the Foundry's job and violate "the executor makes no domain decisions."
- **Project-wide default, per-run override.** The default is read from `.orchestration/settings.json` at run submission; the operator can override it per task via the API/UI. The Foundry sets effort per benchmark and ignores the project setting (benchmarks must be comparable, so evaluation fixes the effort).
- **Not adjustable mid-run.** Effort is a run-submission field, like `task`. It is read once at submission and threaded into the run; the API rejects changing it while a run is active.

## Deliverables

1. `source/executor/types.ts` — add `effort: number` (0–5) to `RunOptions` and `RunMeta`. Add an `EffortLevel` type alias and a `isEffortLevel` type guard validating an `unknown` is an integer in `[0, 5]`.
2. `source/executor/persistence.ts` — a new project-settings leaf: `createReadProjectSettings(workspaceRoot)` reading `<workspaceRoot>/.orchestration/settings.json` (returns a validated `ProjectSettings` or a default when the file is absent or malformed — a malformed file is treated as absent, like `meta.json`'s torn-read handling, so a mid-write read does not crash submission). Add `createWriteProjectSettings(workspaceRoot)` writing it atomically (write-temp + rename). `ProjectSettings` carries `effort` (optional; absent until first set).
3. `source/executor/run-submission.ts` (extend) — `submit(task, effortOverride?)` accepts an optional per-run effort override; when omitted, it reads the project default via an injected `readProjectSettings` leaf (added to `RunSubmissionDependencies`). The chosen effort becomes part of the started run's `RunOptions`. Rejects changing effort while a run is active are unnecessary — the single-active-run invariant means a second `submit` is already rejected with `409 run_in_progress`.
4. `source/executor/executor.ts` — thread `options.effort` into `RunMeta` and into the entry role's initial context. The entry role receives the effort as a clearly-marked system/user directive (e.g. a system message: "Quality level: 3 of 5 (higher = more careful, slower, more thorough; lower = faster, more direct).") so prompts can branch on it. The exact marker string is a documented contract the Guild prompts depend on; record it in `docs/reference.md`.
5. `source/executor/engine.ts` — when assembling the entry role's messages, prepend the effort directive (the entry role only; child roles receive whatever their parent delegates, not a global effort directive — the parent decides how to translate effort into delegation instructions). Log an `effort_set` event `{ effort }` once at run start so the run trace records the chosen level.
6. `source/web/server.ts` — extend `POST /api/runs` to accept `{ task, effort? }` where `effort` is validated by `isEffortLevel` (omitted → project default; invalid → `400 invalid_body`). Add `GET /api/settings` returning the current project settings (the effort default) and `PUT /api/settings { effort }` updating it (atomic write). `GET /api/runs/:id` includes the run's `effort`.
7. `source/web/render.ts` — a pure `renderProjectSettings(settings)` shaper and inclusion of `effort` in `RunView`/`RunSummary`. `renderProjectSettings` must not leak anything beyond the safe settings fields (currently just `effort`).
8. `source/web/server.test.ts` — cover: `POST /api/runs` with and without `effort` (default applied when omitted; `400` on out-of-range/non-integer); `GET /api/settings`; `PUT /api/settings` (persists, atomic); `GET /api/runs/:id` includes effort; the malformed-settings-file-is-default path.
9. `source/executor/run-submission.test.ts` — extend the in-memory coverage: per-run override wins over project default; project default applied when override omitted; the effort is threaded into the started run's `RunOptions`.
10. `docs/reference.md` — document the effort channel: the 0–5 scale, the marker string injected into the entry role, the `effort_set` log event, the project-settings file, and the `POST /api/runs` / `GET|PUT /api/settings` endpoints. Note that the effort→behavior mapping is Guild-defined (step 25) and Foundry-tunable, not executor-defined.

## Module boundaries

- The executor provides the channel (persistence, threading, logging, context injection); it makes no effort→behavior decisions.
- The settings file is a new leaf factory in `persistence.ts` (read + write), injected into `run-submission.ts` and the server.
- The server is a thin HTTP leaf; shaping is in `render.ts` (testable).
- The UI is step 24; this step exposes the API a UI would call but ships no client.
- The effort→behavior mapping is Guild work (step 25); this step's prompts must not be written here (the Guild is frozen until step 25).

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass, including the extended `run-submission.test.ts`, `server.test.ts`, and any new validation tests.
- [ ] `POST /api/runs { task, effort }` threads the effort into the run; omitted `effort` falls back to the project default; out-of-range/non-integer returns `400`.
- [ ] The entry role's initial context contains the effort directive; child roles do not receive a global effort directive.
- [ ] An `effort_set` event is logged once at run start.
- [ ] `GET|PUT /api/settings` reads/writes `.orchestration/settings.json` atomically; a malformed file is treated as default.
- [ ] `RunMeta` and `GET /api/runs/:id` carry the run's effort.
- [ ] No `as` casts; external input (`POST`/`PUT` bodies, the settings file) is validated with type guards.
- [ ] `docs/reference.md` documents the channel.

## End-of-step evaluation

Confirm the executor made no domain decision about what each effort level *means* — only the channel exists. Confirm the effort directive reaches the entry role but is not globally injected into every child (parents translate effort into delegation instructions). Confirm the settings-file write is atomic (write-temp + rename) so a torn write cannot leave the file malformed for the next submission. Confirm `isEffortLevel` rejects floats, non-numbers, and out-of-range integers. Confirm the malformed-settings-read path returns a default rather than throwing (a torn read mid-write is expected and must not crash submission).

## Tracked technical debt

- **The effort→behavior mapping is undefined until step 25.** Until the seed Guild is written, sliding the effort changes the logged value and the injected directive but has no observable effect on run behavior (no prompt branches on the marker yet). This is expected and intentional — the mapping is Guild work. Remove this note when step 25 lands its effort-aware prompts.

## Estimated effort

Medium — a new persistence leaf with atomic write, threading through `RunOptions`/`RunMeta`/the entry-role context, two new endpoints, and their tests. No executor domain logic.

## Operator handoff

Run the service and exercise the API: `PUT /api/settings { effort: 4 }`, confirm `GET /api/settings` returns it; `POST /api/runs { task, effort: 2 }` and confirm the run's view shows effort 2; submit a run without `effort` and confirm it uses the project default. The run's *behavior* will not change with the slider until step 25 lands the Guild prompts — verify only that the value is accepted, persisted, logged, and surfaced.
