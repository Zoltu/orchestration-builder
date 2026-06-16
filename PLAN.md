# Adaptive Orchestrator — Long-Term Development Plan

This document is the high-level roadmap for building the Adaptive Orchestrator. Each phase has a dedicated plan file under `plan/` that details goals, deliverables, module boundaries, and acceptance criteria.

> **Note:** This plan is a living document. As we implement, we adapt. When reality diverges from the plan, we update the plan to match the well-factored code, not the other way around. See `AGENTS.md` ("Adapting the Plan") for the guiding principle.

## Project goals

1. Build a minimal executor that runs a small language model against a JSON-driven Guild configuration.
2. Seed a Guild capable of long-horizon coding tasks and project maintenance for non-developer users.
3. Validate the system with a real benchmark suite covering minutes-long bug fixes and days-long application builds.
4. Add a meta-optimizer (Foundry) that automatically improves the Guild offline.
5. Deliver a simple web UI and containerized deployment for end users.

## Target demographic

The primary user is a **non-developer** who wants software built or maintained without knowing git, project structures, frameworks, or testing workflows. The Guild must ask clear, minimal clarifying questions and explain failures in plain language.

## Core architecture

The codebase follows the three-tier pattern from `AGENTS.md`:

- **Leaf factories** wrap external systems (network, filesystem, subprocess, environment).
- **Orchestration functions** accept a `dependencies` object containing only the leaf factories they directly use.
- **Pure helpers** contain parsing, validation, formatting, transformation, and decision logic.

See `AGENTS.md` for the full rules on type safety, error handling, testing, and control flow.

## Phase overview

| Phase | Focus | Output | Plan file |
|---|---|---|---|
| 1 | Foundation | Shared types, validation, persistence primitives, first smoke benchmark | [`plan/01-foundation-PLAN.md`](plan/01-foundation-PLAN.md) |
| 2 | Executor runtime | LLM client, role engine, budget enforcement, run lifecycle | [`plan/02-executor-runtime-PLAN.md`](plan/02-executor-runtime-PLAN.md) |
| 3 | Tool layer | Native file/search tools, built-in agent/finish/context tools, `ask_human` stub | [`plan/03-tool-layer-PLAN.md`](plan/03-tool-layer-PLAN.md) |
| 4 | Seed Guild | Role prompts, tool manifests, non-developer orchestrator workflow | [`plan/04-seed-guild-PLAN.md`](plan/04-seed-guild-PLAN.md) |
| 5 | Integration & smoke testing | CLI wiring, end-to-end runs on `hello_001`, bug fixes | [`plan/05-integration-testing-PLAN.md`](plan/05-integration-testing-PLAN.md) |
| 6 | Real benchmark suite | Diverse coding benchmarks from bug fixes to multi-hour app builds | [`plan/06-real-benchmark-suite-PLAN.md`](plan/06-real-benchmark-suite-PLAN.md) |
| 7 | Foundry meta-optimizer | Hypothesis generation, branch evaluation, merging, reporting | [`plan/07-foundry-optimizer-PLAN.md`](plan/07-foundry-optimizer-PLAN.md) |
| 8 | Web UI & deployment | `ask_human` web backend, progress viewer, Dockerfile | [`plan/08-web-ui-deployment-PLAN.md`](plan/08-web-ui-deployment-PLAN.md) |

## Implementation order

Phases 1–5 are the **initial executor + seed guild** milestone. Phase 6 constitutes the first realistic training/optimization target. Phases 7 and 8 are future work and depend on a stable executor and benchmark suite.

## Phase 1 closeout

Phase 1's plan (`plan/01-foundation-PLAN.md`) called for shared contracts, validation, persistence primitives, and a smoke benchmark. The following were added during phase 1 closeout to give phase 2 a solid foundation without making phase 2 itself bigger:

- **Guild loader** (`source/executor/loader.ts`): leaf factory that reads `guild.json`, prompt files, and tool manifests from a Guild folder and validates them.
- **Tool dispatch interface** (`source/executor/tool-dispatch.ts`): pure orchestration factory that dispatches tool calls to a handler map; phase 2's engine composes handlers for built-in and native tools.
- **Validation tests** (`source/shared/validation.test.ts`): in-memory Bun tests for the type guards and `validate*` functions.
- **Tool-dispatch tests** (`source/executor/tool-dispatch.test.ts`): in-memory Bun tests for the dispatch mechanism.
- **Testing policy** (`AGENTS.md`): tests must run in-memory only; no network or real LLM endpoints.
- **`package.json` `test` script** scopes `bun test` to `source/` so the smoke benchmark (which expects an agent-produced `output.txt`) is not run as a unit test. A separate `bench:smoke` script runs it manually.
- **`.gitignore`** covers `data/` (runtime artifacts under `data/runs/`).
- **Root `README.md`** quickstart section.

## Technology choices

- **Runtime:** Bun (TypeScript, no transpile step, no npm dependencies, built-in file/spawn/fetch/web server).
- **Executor model:** Any OpenAI-compatible chat/completions endpoint (local or hosted).
- **Persistence:** Plain JSON/JSONL files on disk via `data/runs/<run_id>/`.
- **Validation:** Runtime type guards only; no typecasts (`as Type`) allowed.

## Cross-cutting concerns

- **Security:** All native tools operate only inside `data/runs/<run_id>/workspace/`. Paths are canonicalized. `fetch_url` is the only network-facing v1 tool and runs under a timeout. Shell execution is intentionally excluded from v1; when added later it must also run under a timeout. Strong isolation comes from the deployment environment.
- **Long-horizon safety:** Budgets must be configurable up to multi-day run lengths. Recovery logic lives in the Guild, not the executor.
- **Non-developer UX:** Clarifying questions are few and only when a reasonable guess cannot be made. Error results must be actionable in plain language.

## When to proceed

Review each phase plan under `plan/`. Once the plan is accepted, implementation begins with Phase 1.
