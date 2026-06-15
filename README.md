# Adaptive Orchestrator

This repository will contain an orchestrator that lets a small, consumer-grade language model solve complex tasks by working through a network of specialized roles and tools. The orchestrator itself is intentionally minimal; most behavior is described by a JSON configuration called the **Guild**. A separate meta-optimization process called the **Foundry** automatically improves the Guild by proposing, testing, and merging changes.

For a thorough description of the project, start with the design documents in the `docs/` folder.

## Design documents

1. [`docs/overview.md`](docs/overview.md) — purpose, goals, and use cases
2. [`docs/architecture.md`](docs/architecture.md) — high-level components and data flow
3. [`docs/security.md`](docs/security.md) — threat model and attack surface
4. [`docs/executor.md`](docs/executor.md) — executor runtime
5. [`docs/guild.md`](docs/guild.md) — Guild configuration format
6. [`docs/foundry.md`](docs/foundry.md) — meta-optimization loop
7. [`docs/benchmarks.md`](docs/benchmarks.md) — benchmark workspace format
