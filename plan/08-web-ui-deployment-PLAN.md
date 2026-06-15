# Phase 8 — Web UI & Deployment

## Goal

Provide a human-friendly interface for monitoring runs and answering `ask_human` questions, and package the system for end users.

## Deliverables

1. Web UI server:
   - `src/web/server.ts` — leaf factory `createWebServer(port)` using `Bun.serve`.
   - Serve a plain HTML/JS interface with no external dependencies.
   - Display:
     - Current run status and active role.
     - Message tree / role tree.
     - Tailed `log.jsonl` view.
     - Pending `ask_human` questions with answer input.

2. `src/executor/human-backend.ts` expansion:
   - Add `mode: 'web'` backend that writes pending questions to the run state and resumes the executor when an answer is provided.
   - The tool interface remains identical to the stub backend.

3. Web UI client assets:
   - `src/web/static/index.html`
   - `src/web/static/app.js`
   - `src/web/static/styles.css`
   - Minimal polling or SSE for live updates.

4. Dockerfile:
   - Use the official Bun base image.
   - Copy the project.
   - No `npm install` step because there are no dependencies.
   - Default command surfaces the web UI on a configurable port.

5. `docs/deployment.md` — deployment guidance:
   - Recommended container flags: no network egress for executor, non-root user, read-only filesystem except workspace volume.
   - How to pass API keys via environment variables.
   - How to mount a Guild and benchmark workspace.

## Module boundaries

- The web UI is an optional backend for `ask_human`; it does not change the executor tool interface.
- `src/web/server.ts` is a leaf factory; it can be started from `main.ts` when `--serve <port>` is passed.
- Static assets are plain files, not generated.

## Acceptance criteria

- [ ] `bun src/main.ts --serve 8080 --human-backend web` starts the executor and a web server.
- [ ] A pending `ask_human` question appears in the web UI.
- [ ] Submitting an answer in the UI resumes the run.
- [ ] The Dockerfile builds and runs.
- [ ] The container can run the smoke benchmark successfully.

## Estimated effort

Medium — the UI is intentionally simple; most work is in plumbing the human-backend state machine.

## Out of scope for this phase

- Authentication or multi-user support.
- Persistent web-server state across restarts.
- Real-time streaming of LLM tokens.
