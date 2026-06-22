# HTTP API

The web UI is the primary interface for giving the orchestrator tasks, monitoring progress, and responding to questions. The HTTP API exists for programmatic access (e.g. the Foundry uses it to submit benchmark runs as an HTTP client). Most users never need it.

All endpoints return JSON. The server runs one task at a time; there is no queue.

## Endpoints

### `POST /api/runs`

Starts a run against the mounted project.

**Request body:** `{ "task": "..." }`

**Response (201):** `{ "runId": "run-20260621-..." }`

**Response (409):** `{ "ok": false, "error": "run_in_progress" }` — a run is already active; the server does not queue tasks.

### `GET /api/runs`

Lists known runs (read from `<workspace>/.orchestration/runs/`), newest first.

### `GET /api/runs/:id`

Full run view for a specific run: status, role activity, and the recent event log.

### `GET /api/run`

Convenience alias for the most recent run (active or last completed).

### `GET /api/questions`

Returns pending `ask_human` questions from the active run.

### `POST /api/answer`

Submits an answer to a pending `ask_human` question.

**Request body:** `{ "id": "...", "answer": "..." }`

## Lifecycle

The server outlives every run: a completed run's view stays reachable, and a new task can be submitted once the previous one finishes. `SIGINT` and `SIGTERM` (the latter is what `docker stop` sends) trigger graceful shutdown: the active run is allowed to finish, the server stops, and the process exits (`130` if a run was interrupted mid-flight, `0` if idle).
