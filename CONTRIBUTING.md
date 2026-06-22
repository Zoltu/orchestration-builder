# Contributing

Development setup and conventions for the Adaptive Orchestrator. For running the executor, see [`README.md`](README.md). For the full agent guidelines that govern every change, read [`AGENTS.md`](AGENTS.md).

## Development setup

```bash
bun install        # install dev dependencies (frozen lockfile)
bun run typecheck  # bun --bun tsc --noEmit
bun test           # unit tests under source/**/*.test.ts (in-memory, no network)
```

There are no runtime dependencies — the executor and all tooling use only Bun built-ins and web-standard APIs. The dev dependencies are `@types/bun` and `typescript` only.

## Smoke benchmark

`benchmarks/hello_001/` is the smoke benchmark. It is a Foundry validation harness, not a unit test, so it is intentionally excluded from `bun test`. Exercise it manually against a hand-created output:

```bash
cd benchmarks/hello_001
printf 'hello world\n' > output.txt
bun test tests/
rm output.txt
```

## Design documents

1. [`docs/architecture.md`](docs/architecture.md) — high-level components, data flow, execution model
2. [`docs/reference.md`](docs/reference.md) — executor runtime, Guild format, HTTP API, benchmarks
3. [`docs/foundry.md`](docs/foundry.md) — meta-optimization loop (future work)
4. [`docs/security.md`](docs/security.md) — threat model and mitigations

## Development plan

The work is broken into bite-sized, session-sized steps in [`plan/README.md`](plan/README.md). The foundation (original Phases 1–4) is complete; forward work begins at step `01`. Every step must leave the repository in a clean, healthy state — see the "Step hygiene" section of the plan and [`AGENTS.md`](AGENTS.md).
