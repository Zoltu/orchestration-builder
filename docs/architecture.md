# Architecture

## High-level components

The system consists of three layers:

```
Foundry (large model, parallel, offline)
   │
   │ writes/reads
   ▼
Guild (JSON config + prompt/tool files)
   │
   │ loads
   ▼
Executor (small model, sequential, runtime)
   │
   │ operates on
   ▼
Benchmark workspace
```

### Executor

The executor is the runtime. It is small, sequential, and makes no decisions about what a given task should look like. It only knows how to:

- Load a Guild.
- Start the configured entry role.
- Build a prompt for the active role.
- Call the single configured LLM endpoint.
- Parse the response (content, reasoning, tool calls).
- Dispatch tool calls, including the built-in `agent` tool that spawns another role.
- Enforce hard safety budgets and surface errors as tool results.
- Persist the run state to disk.

The executor has no understanding of "planner," "coder," "router," or "compaction agent." Those are all roles defined in the Guild.

### Guild

The Guild is the entire behavior of the orchestrator described as data. It contains:

- Model endpoint configuration.
- Runtime budgets and context policy.
- Role definitions (system prompt path, allowed tools, per-role budgets).
- Tool manifests for built-in and native tools.
- The name of the entry role.

No workflow graph is defined in the Guild. Workflows emerge from roles calling the `agent` tool to invoke other roles.

### Foundry

The Foundry is an optimization process, not a runtime service. It uses a large language model to:

- Analyze recent run traces and propose hypotheses for Guild improvements.
- Create branch configurations from those hypotheses.
- Run the executor against each branch on the benchmark suite.
- Score branches versus the current baseline.
- Merge validated improvements and write a new baseline Guild.
- Produce human-readable reports.

The Foundry may run many of its own LLM calls in parallel, and it may run multiple executor instances in parallel if the user’s hardware supports it. The executor itself remains sequential.

## Data flow: a single run

1. The user invokes the executor with a task and a benchmark workspace.
2. The executor copies the workspace into `data/runs/<run_id>/workspace/`, omitting `eval.json`.
3. The executor loads `guild.json` and starts the configured entry role with the user goal.
4. The active role calls tools. Tool results are appended to the role’s conversation. If the role calls `ask_human`, the answer comes from either the Foundry simulator (during optimization) or the web UI (in the final product).
5. If the role calls the built-in `agent` tool, the executor spawns a child role and runs it to completion.
6. The child returns via the built-in `finish` tool. The result card becomes the tool result for the parent.
7. The run ends when the entry role calls `finish` or when a hard safety budget is exhausted.
8. The executor writes `data/runs/<run_id>/meta.json`, `log.jsonl`, and the final workspace.

## Data flow: an optimization cycle

1. The Foundry reads the current `guild.json` and the most recent run logs in `data/runs/`.
2. It prompts a large model to cluster failures and propose concrete hypotheses.
3. Each hypothesis becomes a branch: `data/foundry/branches/<branch_id>/guild.json`.
4. For each branch, the Foundry runs the benchmark suite through the executor (one run per benchmark).
5. The Foundry validates each final workspace using the original `eval.json` files.
6. Scores are compared to the baseline pass rate, token cost, error rate, and context pressure.
7. Validated improvements are merged into the next baseline `guild.json`.
8. A report is written to `data/foundry/reports/<timestamp>/`.

## Filesystem layout

```
workspace/
├── README.md                  # project-level readme (not part of the design docs)
├── docs/                      # design documents
├── data/
│   ├── runs/
│   │   └── <run_id>/
│   │       ├── meta.json
│   │       ├── log.jsonl
│   │       └── workspace/
│   └── foundry/
│       ├── branches/<branch_id>/guild.json
│       └── reports/<timestamp>/
├── guild/
│   ├── guild.json             # current baseline Guild
│   ├── prompts/
│   └── tools/
└── benchmarks/
    └── <benchmark_name>/
        ├── eval.json
        └── workspace/
```

## Execution model

- **Single model on the executor.** The executor talks to exactly one chat/completions endpoint. That model is usually the same small local model the user wants to optimize for.
- **Sequential in the executor.** Only one LLM request is in flight at a time. This lets the user devote all available VRAM to one large context window.
- **No libraries in the executor code.** The executor is implemented in TypeScript running on Bun, using only Bun built-ins and web-standard APIs. There are no npm dependencies.
- **Large model in the Foundry only.** The Foundry may use a commercial API or another local large model for hypothesis generation and merging.
- **Web UI for human interaction.** The final product ships with a simple web UI surfaced by `--serve`. It displays progress and handles `ask_human` questions.
- **Single Dockerfile for the final product.** The Dockerfile uses the Bun base image, copies the project, and runs the executor. Because there are no dependencies to install, the image is small.

## Boundary between executor and guild

| Concern | Executor | Guild |
|---|---|---|
| HTTP transport to model | yes | no |
| JSON parsing / serialization | yes | no |
| File system / shell tool execution | yes | no |
| Which roles exist | no | yes |
| What each role is instructed to do | no | yes |
| Which tools each role may use | no | yes |
| When to delegate / plan / review | no | yes |
| How to compact context | no | yes |
| Model endpoint, context window | partly (config values) | yes |
| Hard safety budgets | yes | values only |

The executor provides the stage. The Guild is the script being performed. The Foundry is the playwright rewriting the script.
