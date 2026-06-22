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

## Architecture

The codebase follows a three-tier architecture that maximizes testability. Read [`AGENTS.md`](AGENTS.md) for the full rules; the short version:

- **Leaf functions** touch external systems (network, filesystem, subprocess, environment) and are exported as factories. They are thin and not unit-tested.
- **Orchestration functions** sequence calls and make decisions. They are unit-tested and receive pre-configured leaves via a `dependencies` object with no defaults.
- **Pure helpers** contain parsing, validation, and transformation logic. They are imported directly and unit-tested.

The server entry point (`source/serve.ts`) is the only integration shell: it reads `Bun.env`, assembles real leaves, and hands them to the tested orchestration. It holds no business logic and is not unit-tested.

## Design documents

1. [`docs/overview.md`](docs/overview.md) — purpose, goals, and use cases
2. [`docs/architecture.md`](docs/architecture.md) — high-level components and data flow
3. [`docs/security.md`](docs/security.md) — threat model and attack surface
4. [`docs/executor.md`](docs/executor.md) — executor runtime
5. [`docs/guild.md`](docs/guild.md) — Guild configuration format
6. [`docs/foundry.md`](docs/foundry.md) — meta-optimization loop
7. [`docs/benchmarks.md`](docs/benchmarks.md) — benchmark workspace format
8. [`docs/api.md`](docs/api.md) — HTTP API reference

## Development plan

The work is broken into bite-sized, session-sized steps in [`plan/README.md`](plan/README.md). The foundation (original Phases 1–4) is complete; forward work begins at step `01`. Every step must leave the repository in a clean, healthy state — see the "Step hygiene" section of the plan and [`AGENTS.md`](AGENTS.md).
