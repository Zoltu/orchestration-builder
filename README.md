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

All configuration is environment variables passed via `docker run -e`:

| Variable | Default | Purpose |
|---|---|---|
| `ORCHESTRATOR_API_KEY` | _(none)_ | Model API key, injected into the model configuration at startup and never stored in the Guild. Omit for a local endpoint that needs no key. |
| `PORT` | `80` | Port the HTTP service listens on inside the container. |
| `WORKSPACE_ROOT` | `/workspace` | The path inside the container that the project the executor operates on. Run artifacts are written to `<WORKSPACE_ROOT>/.orchestration/runs/`. |

The Guild is bundled into the image at `/app/guild/`. To override it without rebuilding, mount a different guild read-only at `/app/guild`.

For programmatic access, there is an [HTTP API](docs/reference.md) for submitting tasks and reading run state.
