# Architecture

The Adaptive Orchestrator enables a small, consumer-grade language model to solve complex tasks by working through a network of specialized roles and tools. The system has three layers: the executor (runtime), the Guild (configuration), and the Foundry (offline optimizer).

## Components

**Executor** — the runtime that runs the small model. It loads the Guild, starts the entry role, dispatches tool calls, enforces safety budgets, and persists results. It is small, sequential, and makes no domain decisions. See [`docs/reference.md`](reference.md) for the full runtime reference.

**Guild** — a JSON configuration plus referenced prompt and tool-manifest files. It describes the roles, tools, and entry role; the deployment settings (model endpoint, budgets, context policy) live in a separate deployment file so the Foundry's artifact stays purely behavioral. The Guild is the artifact being optimized. See [`docs/reference.md`](reference.md) for the format specification.

**Foundry** — an offline optimization process that uses a large model to propose Guild changes, test them against a benchmark suite, and merge successful improvements. It is a separate program that talks to the executor over HTTP. See [`docs/foundry.md`](foundry.md).

```
Foundry (large model, offline optimizer)
    │
    │ writes/reads
    ▼
Guild (JSON config + prompt/tool files)
    │
    │ loads
    ▼
Executor (small model, sequential runtime)
    │
    │ operates on
    ▼
Workspace (the user's project, modified in place)
```

The executor provides the stage. The Guild is the script. The Foundry is the playwright rewriting the script.

## Data flow: a single run

1. The user mounts a project at `/workspace` and submits a task through the web UI (or HTTP API).
2. The executor loads the Guild and starts the entry role with the task.
3. The active role calls tools. Tool results are appended to the role's conversation. If the role calls `agent`, a child role runs to completion and returns a result card. If the role calls `ask_human`, the question surfaces in the web UI and the run pauses for an answer.
4. The run ends when the entry role calls `finish` or a hard safety budget is exhausted.
5. The executor writes `meta.json` and `log.jsonl` under `<workspace>/.orchestration/runs/<run_id>/`. The workspace itself holds the final filesystem state — the executor modified it in place.

## Data flow: an optimization cycle

The Foundry reads the current Guild and recent run logs, prompts a large model to propose hypotheses, creates branch Guilds, evaluates each branch against the benchmark suite via the executor service, scores and compares, merges accepted improvements, and writes a new baseline. See [`docs/foundry.md`](foundry.md) for the full design.

## Execution model

- **Single model on the executor.** The executor talks to exactly one OpenAI-compatible chat/completions endpoint.
- **Sequential.** Only one LLM request is in flight at a time. A run is a depth-first traversal of the role tree.
- **One task at a time.** The server runs one run at a time; there is no queue.
- **In-place workspace.** The executor modifies the mounted project directly, exactly as a developer would. Run bookkeeping goes under `<workspace>/.orchestration/`.
- **No dependencies.** The executor uses only Bun built-ins and web-standard APIs. No npm packages.
- **Large model in the Foundry only.** The Foundry may use a commercial API or another local model.

## Filesystem layout

```
workspace/                          # the user's project (mounted at /workspace)
├── .orchestration/                 # orchestrator bookkeeping (can be ignored)
│   └── runs/
│       └── <run_id>/
│           ├── meta.json           # run metadata, status, final result
│           ├── log.jsonl           # event stream: llm calls, tool calls, errors
│           ├── state.json          # checkpoint for restart resumption (deleted on completion)
│           └── summary.txt         # LLM-generated one-line run summary (UI label; best-effort)
├── (project files)
guild/                              # bundled into the image at /app/guild/
├── guild.json                      # current baseline Guild
├── prompts/                        # role system prompts
└── tools/                          # tool manifests
```

## Deployment

The executor ships as a Docker image that runs the long-running executor service as PID 1 via `ENTRYPOINT ["bun", "source/serve.ts"]`. The build runs `bun install`, typecheck, and tests as gates, then removes `node_modules`. Configuration is a bundled deployment file (model endpoint, budgets, context policy) with production defaults; environment variables select the file (`ORCHESTRATOR_DEPLOYMENT_FILE`) and layer per-field overrides on top of it. The deployment model is one container per project: the project is mounted at `/workspace` (read-write) and the executor modifies it in place. See [`Dockerfile`](../Dockerfile) and [`README.md`](../README.md).

### Run termination

The executor does not enforce a wall-clock run timeout or a per-role tool-call/token cap. A fixed wall-clock limit is hardware-dependent (it fires on healthy slow-hardware runs or never fires on fast hardware), and cumulative token/tool-call budgets fired on healthy long-horizon work long before the context window filled. The real context-window guardrail is the model endpoint's `context_budget_exceeded` path (see [`docs/reference.md`](reference.md) "Executor runtime"). Run termination is the deployment container's job: `docker stop` (or the orchestrator's own timeout) is the outer boundary that ends a stuck or runaway run. The in-band layer is the interrupt platform (see [`docs/reference.md`](reference.md) "Interrupt platform"): a loop-check cadence invokes a guild handler role (the seed Guild's `loop_detector`) that can redirect or abort a stuck role, and the operator/API interrupt lets the operator ask a question (answered by a fresh handler role — the seed Guild's `inquiry_responder` — while the run pauses at a safe point) or submit a plan modification that unwinds to the plan owner.

## Isolation

The executor operates on the mounted workspace in place. File tools canonicalize paths and reject any that resolve outside the workspace; `run_shell` runs commands with the workspace as their working directory, and its containment comes from the deployment container (see "Deployment"). Runs are sequential, so there is no concurrent-run isolation concern. Per-run environment isolation (scoped `PATH`/`HOME`, no global pollution) is future work in the Foundry that hardens benchmark evaluation; until then, the suite is constrained to no-install tasks. Operators who want to protect a project from in-place modification give the executor a throwaway copy. See [`docs/security.md`](security.md).

## Run visualization

The web client renders a run two ways — a flow-graph product surface and a sequence-diagram debug surface — both reading a single shared `InteractionModel`. The model is a timeline of operations over participants; one set of pure helpers answers every "what is happening right now" question so the two views cannot drift. The design (the model contract, the single invariant both views read, interrupts and their fates, label localization) is in [`docs/visualization.md`](visualization.md); the rendering security invariant is in [`docs/security.md`](security.md) "Web client rendering pipeline".
