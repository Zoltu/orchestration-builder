# Adaptive Orchestrator

This repository will contain an orchestrator that lets a small, consumer-grade language model solve complex tasks by working through a network of specialized roles and tools. The orchestrator itself is intentionally minimal; most behavior is described by a JSON configuration called the **Guild**. A separate meta-optimization process called the **Foundry** automatically improves the Guild by proposing, testing, and merging changes.

For a thorough description of the project, start with the design documents in the `docs/` folder. For the current build roadmap and step-by-step plan, see [`plan/README.md`](plan/README.md); contributors should also read [`AGENTS.md`](AGENTS.md).

## Getting started

```bash
bun install        # install dev dependencies (frozen lockfile)
bun run typecheck  # bun --bun tsc --noEmit
bun test           # unit tests under source/**/*.test.ts (in-memory, no network)
```

To exercise the smoke benchmark manually against a hand-created output:

```bash
cd benchmarks/hello_001
printf 'hello world\n' > output.txt
bun test tests/
rm output.txt
```

The smoke benchmark is a Foundry validation harness, not a unit test; it is intentionally excluded from `bun test`.

## Design documents

1. [`docs/overview.md`](docs/overview.md) — purpose, goals, and use cases
2. [`docs/architecture.md`](docs/architecture.md) — high-level components and data flow
3. [`docs/security.md`](docs/security.md) — threat model and attack surface
4. [`docs/executor.md`](docs/executor.md) — executor runtime
5. [`docs/guild.md`](docs/guild.md) — Guild configuration format
6. [`docs/foundry.md`](docs/foundry.md) — meta-optimization loop
7. [`docs/benchmarks.md`](docs/benchmarks.md) — benchmark workspace format

## Development plan

The work is broken into bite-sized, session-sized steps in [`plan/README.md`](plan/README.md). The foundation (original Phases 1–4) is complete; forward work begins at step `01`. Every step must leave the repository in a clean, healthy state — see the "Step hygiene" section of the plan and [`AGENTS.md`](AGENTS.md).
