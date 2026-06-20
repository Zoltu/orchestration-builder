# Add a greeting endpoint

The small server in `src/server.ts` answers one route today: `GET /health`, which returns `{ "ok": true }`. A test for that route already passes.

The server needs a new route: `GET /greeting`.

The new route should:

- Read the `name` from the query string (for example `?name=Ada`).
- Return JSON shaped like `{ "greeting": "Hello, <name>" }`, using the name that was given.
- When no name is given, or the name is empty, greet the world by default: `{ "greeting": "Hello, world" }`.

Put the route handler in a new file `src/routes/greeting.ts`, and call it from the router in `src/server.ts` so the server dispatches `/greeting` to it.

The tests in `tests/greeting.test.ts` describe the exact behavior expected; they currently fail because the route does not exist yet. Make them pass. The existing tests in `tests/health.test.ts` must keep passing.
