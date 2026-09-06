# Adaptive Orchestrator

An orchestration engine that lets a small, consumer-grade language model solve complex tasks by working through a network of specialized roles and tools. The orchestration engine itself is intentionally minimal; most behavior is described by a JSON configuration called the **Guild**. A separate meta-optimization process called the **Foundry** automatically improves the Guild by proposing, testing, and merging changes.

For contributors and development setup, see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Running the executor

The executor ships as a Docker image that serves a webpage. The deployment model is **one container = one project**: the project (e.g., a git repository, a research project, etc.) is mounted into the container and the executor works on it, exactly as a developer would. Orchestration bookkeeping is written under `<root>/.orchestration/` and can generally be ignored.

### Run

```bash
docker container run --rm -p 12345:80 -v "$PWD:/workspace" -e ORCHESTRATOR_API_KEY=... adaptive-orchestrator
```

Open `http://localhost:12345` to give the orchestrator tasks, monitor progress, and respond to questions from the orchestrator.

```bash
curl -X POST http://localhost:12345/api/runs -H 'content-type: application/json' -d '{"task":"Write a file called output.txt containing the text hello world"}'
# → { "runId": "run-20260621-..." }
```

### Configuration

Configuration is a bundled deployment file (model endpoint, budgets, context policy) with environment variables layered on top, passed via `docker run -e`. Precedence is deployment file first, environment variables second: an override variable replaces only its own field, and unset variables keep the file's value.

| Variable | Default | Purpose |
|---|---|---|
| `ORCHESTRATOR_API_KEY` | _(none)_ | Model API key, injected into the model configuration at startup and never stored in the Guild. May also be provided as a Docker secret at `/run/secrets/orchestrator_api_key`. Omit for a local endpoint that needs no key. |
| `ORCHESTRATOR_DEPLOYMENT_FILE` | Bundled `deployment/deployment.json` | Path to the deployment configuration file. Point it at a docker config, docker secret, or bind mount to change the deployment without rebuilding the image. |
| `KAGI_API_KEY` | _(none)_ | Kagi API key enabling the `web_search` tool and `fetch_url`'s Kagi Extract backend. May also be provided as a Docker secret at `/run/secrets/kagi_api_key`. Without it those tools report themselves unavailable and `fetch_url` falls back to markdown.new and direct fetching. |
| `PORT` | `80` | Port the HTTP service listens on inside the container. |
| `WORKSPACE_ROOT` | `/workspace` | The path inside the container that the project the executor operates on. Run artifacts are written to `<WORKSPACE_ROOT>/.orchestration/runs/`. |

Deployment field overrides — each variable defaults to the deployment file's value for that field, and setting it replaces just that field:

| Variable | Deployment field | Constraint |
|---|---|---|
| `ORCHESTRATOR_MODEL` | `model.name` | non-empty string |
| `ORCHESTRATOR_API_BASE` | `model.apiBase` | non-empty string |
| `ORCHESTRATOR_MODEL_CONTEXT_WINDOW` | `model.contextWindow` | positive integer |
| `ORCHESTRATOR_REASONING_FIELD` | `model.reasoningField` | non-empty string |
| `ORCHESTRATOR_TEMPERATURE` | `model.generation.temperature` | finite number |
| `ORCHESTRATOR_MAX_TOKENS` | `model.generation.maxTokens` | positive integer |
| `ORCHESTRATOR_MAX_AGENT_DEPTH` | `executor.maxAgentDepth` | positive integer |
| `ORCHESTRATOR_TOOL_TIMEOUT_SECONDS` | `executor.defaultToolTimeoutSeconds` | positive integer |
| `ORCHESTRATOR_MAX_COMPACTION_ATTEMPTS` | `executor.maxCompactionAttempts` | positive integer |
| `ORCHESTRATOR_CONTEXT_PRESSURE_THRESHOLD` | `executor.contextPressureThreshold` | number in (0, 1) |
| `ORCHESTRATOR_CONTEXT_HANDLER_ROLE` | `executor.contextHandlerRole` | non-empty string |
| `ORCHESTRATOR_INQUIRY_HANDLER_ROLE` | `executor.inquiryHandlerRole` | non-empty string |
| `ORCHESTRATOR_INTERRUPT_HANDLER_ROLE` | `executor.interruptTriggers.handlerRole` | non-empty string |
| `ORCHESTRATOR_INTERRUPT_EVERY_TOOL_CALLS` | `executor.interruptTriggers.everyToolCalls` | positive integer |
| `ORCHESTRATOR_INTERRUPT_EVERY_TOKENS` | `executor.interruptTriggers.everyTokens` | positive integer |
| `ORCHESTRATOR_INTERRUPT_PLAN_OWNER_ROLE` | `executor.interruptTriggers.planOwnerRole` | non-empty string |
| `ORCHESTRATOR_MAX_TOOL_OUTPUT_CHARS` | `contextPolicy.maxToolOutputChars` | positive integer |

If the service cannot start because of invalid configuration — an invalid or missing deployment file or Guild, or an invalid `ORCHESTRATOR_*` variable — it binds the port anyway and serves an error page describing the problem instead of exiting, so opening the UI in a browser shows what to fix; the process still exits non-zero once stopped.

The Guild is bundled into the image at `/app/guild/`, with its deployment configuration (model endpoint, budgets, context policy) at `/app/deployment/deployment.json`. To override either without rebuilding, mount a different guild read-only at `/app/guild`, or point `ORCHESTRATOR_DEPLOYMENT_FILE` at a different deployment file (a docker config, docker secret, or bind mount).

For programmatic access, there is an [HTTP API](docs/reference.md) for submitting tasks and reading run state.
