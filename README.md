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

## Running the executor

The CLI entry point (`source/main.ts`) invokes the executor end-to-end against a real model endpoint. It assembles the runtime from the Guild and the environment, so no secrets are stored in the Guild itself.

```bash
bun source/main.ts \
  --guild guild \
  --workspace benchmarks/hello_001 \
  --task "Write a file called output.txt containing the text hello world" \
  --run-id smoke-try
```

Or via the `start` script:

```bash
bun run start -- --guild guild --workspace benchmarks/hello_001 --task "..." 
```

Flags:

- `--guild <path>` (required) — path to the Guild directory (contains `guild.json`).
- `--workspace <path>` (required) — workspace copied into `data/runs/<run-id>/workspace/`.
- `--task <text>` (required) — task description handed to the entry role.
- `--run-id <id>` (optional) — run id; auto-generated as a UTC timestamp when omitted.
- `--human-backend <stub|foundry|web>` (optional, defaults to `stub`) — backend for `ask_human`. `stub` answers immediately with a canned reply; `web` parks the question for the operator to answer in the web UI (requires `--serve`); `foundry` requires the Foundry loop and is not supported by the CLI.
- `--serve <port>` (optional) — start the web UI on `<port>`; implies `--human-backend web`. Open `http://localhost:<port>` to watch the run and answer `ask_human` questions. The server stops when the run completes.
- `-h, --help` — print usage.

The model API key is read from the `ORCHESTRATOR_API_KEY` environment variable and injected into the model configuration at startup; it is never read into or stored in the Guild:

```bash
export ORCHESTRATOR_API_KEY=sk-...
bun source/main.ts --guild guild --workspace benchmarks/hello_001 --task "..."
```

Each run writes `meta.json`, `log.jsonl`, and the final `workspace/` under `data/runs/<run-id>/`. The process exits `0` on success, `2` on `needs_clarification` or a usage error, and `1` on any other failure.

### Web UI (human-in-the-loop)

To run a task with the web UI so the operator can answer `ask_human` questions in the browser, pass `--serve <port>` (which implies `--human-backend web`):

```bash
bun source/main.ts \
  --serve 8080 \
  --guild guild \
  --workspace benchmarks/hello_001 \
  --task "Write a file called output.txt containing the text hello world" \
  --run-id web-try
```

Open `http://localhost:8080` to watch the run status and tailed log. If a role calls `ask_human`, the question appears in the UI; submit an answer and the run resumes. The web server stops when the run finishes (or on `SIGINT`).

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
