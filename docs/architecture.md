# Architecture

The Adaptive Orchestrator enables a small, consumer-grade language model to solve complex tasks by working through a network of specialized roles and tools. The system has three layers: the executor (runtime), the Guild (configuration), and the Foundry (offline optimizer).

## Components

**Executor** — the runtime that runs the small model. It loads the Guild, starts the entry role, dispatches tool calls, enforces safety budgets, and persists results. It is small, sequential, and makes no domain decisions. See [`docs/reference.md`](reference.md) for the full runtime reference.

**Guild** — a JSON configuration plus referenced prompt, concept, and tool-manifest files. It describes the roles, tools, and entry role; the deployment settings (model endpoint, budgets, context policy) live in a separate deployment file so the Foundry's artifact stays purely behavioral. A role may declare `concepts`, shared standard files the loader appends to that role's system prompt at load time. The Guild is the artifact being optimized. See [`docs/reference.md`](reference.md) for the format specification.

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
2. The executor loads the Guild and starts the entry role with the task; when the entry role declares `projectDocs`, their contents are injected into its initial user message as untrusted project reference material (see [`docs/security.md`](security.md) "Attack surface").
3. The active role calls tools. Tool results are appended to the role's conversation. If the role calls `agent`, a child role runs to completion and returns a result card. If the role calls `ask_human`, the question surfaces in the web UI and the run pauses for an answer.
4. The run ends when the entry role calls `finish` or a hard safety budget is exhausted.
5. The executor writes `meta.json` and `log.jsonl` under `<workspace>/.orchestration/runs/<run_id>/`. The workspace itself holds the final filesystem state — the executor modified it in place.

## Data flow: an optimization cycle

The Foundry reads the current Guild and recent run logs, prompts a large model to propose hypotheses, creates branch Guilds, evaluates each branch against the benchmark suite via the executor service, scores and compares, merges accepted improvements, and writes a new baseline. See [`docs/foundry.md`](foundry.md) for the full design.

## Execution model

- **Single model on the executor.** The executor talks to exactly one OpenAI-compatible endpoint, using the streaming Responses API (`POST {apiBase}/responses`).
- **Sequential.** Only one LLM request is in flight at a time. A run is a depth-first traversal of the role tree.
- **One dispatched run plus a durable backlog.** The server runs one run at a time, dispatched from a durable task queue (`<workspace>/.orchestration/queue.json`): every task enters the queue, the scheduler dispatches the head waiting item whenever the run slot is free, and queued tasks survive restarts. See [`docs/queueing.md`](queueing.md).
- **In-place workspace.** The executor modifies the mounted project directly, exactly as a developer would. Run bookkeeping goes under `<workspace>/.orchestration/`.
- **No dependencies.** The executor uses only Bun built-ins and web-standard APIs. No npm packages.
- **Large model in the Foundry only.** The Foundry may use a commercial API or another local model.

## Review and version-control cadence

The orchestrator implements every plan step first, then runs one consolidated review pass — the architecture, style, and security reviewers, each scoped to the run's accumulated change set — before the final acceptance review of the whole workspace.
It may insert a single interim consolidated review at a milestone boundary, but only when foundation risk warrants it: a new subsystem, a risky integration, an unfamiliar domain, or a `needs replan:`/`needs refactor:` signal from a child.
There is no per-step review; one pass keeps review cost proportional to the run rather than to the number of steps, and the change set scopes what each reviewer reads.

The orchestrator commits after every meaningful unit of work, not only after review.
The executor records a base commit — HEAD at task start, the git empty tree when HEAD is unborn, and no base when the workspace is not a repository — and the run's reviewers diff against it.
Separately, it appends a one-line advisory notice to the entry role's initial message when a repository exists — a prompt to handle the dirty state when there are uncommitted changes (no HEAD sha), a note that there are no commits when HEAD is unborn, or the short HEAD when the tree is clean — and injects no notice when there is no repository.
The orchestrator may move the base with `git_set_base` — a hint, not a requirement, is to advance it after a review round completes — and the base rides the checkpoint so a resumed run keeps it.
`git_changes_since_base` reads the diff from that base to the working tree, so a consolidated review pass sees exactly what the run has changed so far, and the orchestrator may delegate a commit message to the `change_summarizer` when it wants the message derived from the diff.
Acceptance reviews the whole workspace and holds no git tool.
With no repository the change-set tools report there is nothing to show, and the git surface never depends on git being present.

## Tool surface

The deployment container is the security boundary; tools do not filter or allowlist commands. The targeted tools are high-signal semantic wrappers — a uniform discipline (workspace-rooted execution, clamped timeouts, structured, capped results) around what the model chooses — and `run_shell` is the general escape hatch for everything they do not cover. The toolchain a workspace needs is determined by the model at run time, by surveying the workspace, not configured in the executor or the Guild. See [`docs/security.md`](security.md) "Mitigations".

## Filesystem layout

```
workspace/                          # the user's project (mounted at /workspace)
├── .orchestration/                 # orchestrator bookkeeping (can be ignored)
│   ├── settings.json               # project-wide settings (the default effort and logging level)
│   ├── queue.json                  # the durable task queue (queued tasks and their outcomes)
│   └── runs/
│       └── <run_id>/
│           ├── meta.json           # run metadata, status, final result
│           ├── log.jsonl           # event stream: llm calls, tool calls, errors
│           ├── state.json          # checkpoint for restart resumption (deleted on completion)
│           ├── summary.txt         # LLM-generated one-line run summary (UI label; best-effort)
│           ├── plan.md             # the run's plan document (write_plan/read_plan)
│           ├── style-guide.md      # the run's style guide document (write_style_guide/read_style_guide)
│           └── roles/              # finished child snapshots, one <roleId>.json each, written at role finish (makes continue_agent survive a restart)
├── (project files)
guild/                              # bundled into the image at /app/guild/
├── guild.json                      # current baseline Guild
├── prompts/                        # role system prompts
├── concepts/                       # shared concept files appended to role prompts (Markdown)
└── tools/                          # tool manifests
```

## Deployment

The executor ships as a Docker image that runs the long-running executor service as PID 1 via `ENTRYPOINT ["bun", "/app/source/serve.ts"]`. The build runs `bun install`, typecheck, and tests as gates, then removes `node_modules`. Configuration is a bundled deployment file (model endpoint, budgets, context policy) with production defaults; environment variables select the file (`ORCHESTRATOR_DEPLOYMENT_FILE`) and layer per-field overrides on top of it. The deployment model is one container per project: the project is mounted at `/workspace` (read-write) and the executor modifies it in place. See [`Dockerfile`](../Dockerfile) and [`README.md`](../README.md).

### Run termination

The executor does not enforce a wall-clock run timeout or a per-role tool-call/token cap. A fixed wall-clock limit is hardware-dependent (it fires on healthy slow-hardware runs or never fires on fast hardware), and cumulative token/tool-call budgets fire on healthy long-horizon work long before the context window fills. The real context-window guardrail is the model endpoint's `context_budget_exceeded` path (see [`docs/reference.md`](reference.md) "Executor runtime"). Run termination is the deployment container's job: `docker stop` (or the orchestrator's own timeout) is the outer boundary that ends a stuck or runaway run. The in-band layer is the interrupt platform (see [`docs/reference.md`](reference.md) "Interrupt platform"): a loop-check cadence invokes a guild handler role (the seed Guild's `loop_detector`) that can redirect or abort a stuck role, and the operator/API interrupt lets the operator ask a question (answered by a fresh handler role — the seed Guild's `inquiry_responder` — while the run pauses at a safe point) or submit a plan modification that unwinds to the plan owner.

## Isolation

The executor operates on the mounted workspace in place. File tools canonicalize paths and reject any that resolve outside the workspace; `run_shell` runs commands with the workspace as their working directory, and its containment comes from the deployment container (see "Deployment"). Runs are sequential, so there is no concurrent-run isolation concern. Per-run environment isolation (scoped `PATH`/`HOME`, no global pollution) is future work in the Foundry that hardens benchmark evaluation; until then, the suite is constrained to no-install tasks. Operators who want to protect a project from in-place modification give the executor a throwaway copy. See [`docs/security.md`](security.md).

## Run visualization

The web client renders a run two ways — a flow-graph product surface and a sequence-diagram debug surface — both reading a single shared `InteractionModel`. The model is a timeline of operations over participants; one set of pure helpers answers every "what is happening right now" question so the two views cannot drift. The design (the model contract, the single invariant both views read, interrupts and their fates, label localization) is in [`docs/visualization.md`](visualization.md); the rendering security invariant is in [`docs/security.md`](security.md) "Web client rendering pipeline". The dev harness that renders recorded fixture frames runs under a fixed contract — it exercises the production view modules as a fixture transport and inherits shell behavior by import; see [`docs/visualization.md`](visualization.md) "The demo page is a fixture transport, not a sandbox".

**Live token stream.** One WebSocket endpoint (`/ws/stream`, see [`docs/reference.md`](reference.md) "Live token stream") layers an isolated enhancement channel over this polling architecture: a browser client may additionally subscribe to the active run's in-flight partials, which render only inside the inspector modal's in-flight row and feed no other state. The channel degrades by design — polling remains the sole authority for run state and turn history, and the UI keeps fully working when the socket is absent, rejected, or dies mid-stream (only live partial text is lost).

## Web client

The browser client's sources are TypeScript under `source/web/static/ts/` and are transpiled on request by the static server (`Bun.Transpiler`, a Bun built-in — no build step, no emitted output on disk). The browser-facing URL space is unchanged: pages still load `app.js`/`demo.js` and modules still import `./sibling.js` — the server maps a `.js` request (outside `vendor/`) to `ts/<same path>.ts` when that source exists and falls back to the real file otherwise, and a raw `.ts`/`.d.ts` request 404s, so the authoring sources are never shipped to the browser. Every first-party browser module is covered by `bun run typecheck`; no plain-JS module or forwarding shim remains. Should a future change convert a module while plain-JS importers of it remain, a one-line forwarding module stays at the converted module's old path for the duration of the conversion, because Bun resolves plain-JS importers' specifiers literally and `bun test` imports those modules.

Two consequences every change to `source/web/static/` must respect:

- **Runtime guards are still required at every external ingress.** Types don't validate: every external value the browser modules read (fetch bodies, websocket messages, DOM events, `window.showdown`/`hljs` presence) goes through shape checks, and a type annotation never rejects a malformed payload — keep that discipline even where the module is TypeScript.
- **Never share vnode objects across renders or tree positions.** hyperapp's differ mutates a vnode's `node` property in place, so a vnode object reused at two positions (e.g. a memo cache handing the same object out for repeated text) corrupts the mounted tree the next time positions shift — it throws `DOMException` mid-patch and every following render crashes. The markdown pipeline (`markdown-render.ts`) caches its sanitized neutral tree and rebuilds vnodes per call for exactly this reason; keep that shape for any future memoization.

## Shared state sync: `entity-diff`

The polled UI state that grows with a run or the number of runs — the run list and the visualization's `InteractionModel` — is derived server-side and consumed by the browser. Instead of re-sending the whole derived state whenever it changes, the app ships entity-level diffs through a shared module, `source/web/static/ts/entity-diff/`. (The run view is a single bounded document and remains on plain conditional requests.)

The module is generic over id-keyed entities and owns the sync machinery: a version per state (an epoch-scoped revision, with a content hash on snapshots for verification), keyed `added`/`changed`/`removed` deltas, a bounded server-side delta history, and a total snapshot fallback so a client that is too far behind (or carries an unknown version) always recovers. The app declares its collections and owns the entity bodies; the module never names an app type.

It is a **dependency**, not part of the app's layers: it lives under `source/web/static/ts/` so the browser loads it (transpiled on request) and the server imports it through the same `./static/ts/entity-diff/index.js` specifier; it imports nothing outside its own folder; and it is browser-pure — web-standard globals only, with a pure-JS SHA-256 rather than a Bun- or secure-context-only hash. Its tests live under `source/web/entity-diff/` and import it by the same specifier. This section is the normative home for the entity-diff specifics; [`AGENTS.md`](../AGENTS.md) states only the general shared-module principle.

The app must honor two integration contracts: entities and returned state are treated as immutable (replace objects, never mutate in place — the identity-keyed version cache depends on it), and collections are unordered (the version is order-independent, so the app sorts by its own domain key when display order matters). Snapshots are content-verified; deltas are protected only by the base-revision precondition, so a forged delta with a matching base is trusted — the accepted tradeoff of the revision scheme.
