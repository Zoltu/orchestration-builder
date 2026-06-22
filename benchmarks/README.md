# Benchmarks

A benchmark is a self-contained folder that defines an initial workspace and a validation rule. The executor treats the folder as a workspace; the Foundry (and the suite harness) use the `eval.json` file in the same folder to validate the final workspace state.

The full `eval.json` schema, validation rules, and design rationale live in [`../docs/reference.md`](../docs/reference.md#benchmarks). This document covers authoring and running.

## Folder layout

```
benchmarks/
└── <benchmark_name>/
    ├── eval.json          # validation specification; NOT copied into the run workspace
    ├── README.md          # task description; copied into the run workspace
    ├── src/
    └── tests/
```

Everything in the benchmark folder **except `eval.json`** is copied into `data/runs/<run_id>/workspace/` at the start of a run, so the agent can read any workspace file but cannot read the validation rules.

## Authoring a benchmark

1. Create `benchmarks/<name>/` with a short, descriptive name (e.g. `factorial_001`).
2. Add a `README.md` describing the task in plain language. This is the text the agent sees.
3. Add the initial workspace files (`src/`, `tests/`, etc.).
4. Add an `eval.json`. The required fields are `taskType`, `description`, and `validation.command`. Everything else is optional.

### `eval.json` schema (summary)

```json
{
  "taskType": "coding",
  "description": "Implement factorial in src/factorial.py.",
  "validation": {
    "command": "python -m pytest tests/",
    "expectedExitCode": 0,
    "expectedFiles": ["src/factorial.py"],
    "expectedStdoutContains": "2 pass",
    "timeoutSeconds": 60
  },
  "humanResponses": {
    "Which language should I use?": "TypeScript."
  }
}
```

- `taskType` (string, required): label used for grouping/regression analysis.
- `description` (string, required): human-readable description; used as the default task text for the entry role.
- `validation` (object, required):
  - `command` (string, required): shell command run inside the final workspace.
  - `expectedExitCode` (number, optional): required exit code. Defaults to `0`.
  - `expectedFiles` (string[], optional): files that must exist after the run.
  - `expectedStdoutContains` (string | string[], optional): text that must appear in `command` stdout.
  - `timeoutSeconds` (number, optional): how long the validation command may run. Defaults to the suite runner's configured default.
- `humanResponses` (object, optional): deterministic answers to expected `ask_human` questions. Keys are question strings, values are answers.

A benchmark passes only when every declared expectation holds. `eval.json` is kept out of the workspace on purpose: it prevents the model from optimizing for the test and lets validation change without changing the task the agent sees.

### Validating an `eval.json` in isolation

`parseEvalConfig` (in `source/benchmarks/validation.ts`) validates an `eval.json` object with type guards and rejects malformed input with a path-based `ValidationError`. The in-memory test `source/benchmarks/validation.test.ts` locks in the accepted/rejected shapes.

## Validation model

Validation is split into three layers (see `AGENTS.md` for the three-tier pattern):

- `source/benchmarks/validation.ts` — **pure** decision logic: `parseEvalConfig` and `evaluateValidation`. Tested.
- `source/benchmarks/run-validation.ts` — **leaf** that spawns the validation command under a timeout and reports raw outputs (`exitCode`, `stdout`, `expectedFilesPresent`, `timedOut`). Not unit-tested; exercised against real benchmarks by the operator.
- `source/benchmarks/run-suite.ts` — **orchestration** that, for each benchmark in a suite, reads `eval.json`, runs the executor, runs validation, and writes `summary.json`. Tested with fakes.

`evaluateValidation` returns `{ status: 'pass' | 'fail', reasons: string[] }`. A timeout short-circuits to `fail` with a single reason; otherwise every declared expectation (files, exit code, stdout substrings) is checked and each miss is recorded as a reason.

## Running benchmarks

### Single benchmark

Run the executor image against one benchmark workspace by mounting the benchmark at `/workspace` and submitting a task through the API. The executor modifies the workspace in place, so mount a throwaway copy to protect the canonical benchmark:

```bash
cp -r hello_001 /tmp/hello-try
docker run --rm -p 8080:80 \
  -v "/tmp/hello-try:/workspace" \
  -e ORCHESTRATOR_API_KEY=sk-... \
  adaptive-orchestrator
```

Then submit the task:

```bash
curl -X POST http://localhost:8080/api/runs \
  -H 'content-type: application/json' \
  -d '{"task":"Write '"'"'hello world'"'"' to output.txt"}'
# → { "runId": "run-20260621-..." }
```

The executor writes `output.txt` into `/tmp/hello-try` in place, and run artifacts land under `/tmp/hello-try/.orchestration/runs/<run-id>/`. Validate the result with the benchmark's own command — either from the host or from inside a throwaway container mounting the same directory:

```bash
docker run --rm -v "/tmp/hello-try:/workspace" --entrypoint sh adaptive-orchestrator \
  -c 'cd /workspace && bun test tests/'
```

### The smoke benchmark

`benchmarks/hello_001/` is the smoke benchmark. It is intentionally excluded from `bun test` (it expects an agent-produced `output.txt`). Run it manually against a hand-created output:

```bash
cd benchmarks/hello_001
printf 'hello world\n' > output.txt
bun test tests/
rm output.txt
```

### The whole suite

The suite harness lives in `source/benchmarks/run-suite.ts`. `runSuite(deps, options)` iterates every benchmark directory in a suite, runs the executor, validates each final workspace, and writes a `summary.json` with per-benchmark `pass`/`fail`/`error` status and aggregate totals:

```json
{
  "suitePath": "benchmarks",
  "guildPath": "guild",
  "startedAt": "2026-01-01T00:00:00.000Z",
  "totals": { "pass": 1, "fail": 0, "error": 0, "total": 1 },
  "results": [
    {
      "benchmark": "hello_001",
      "status": "pass",
      "runId": "suite-hello_001-1735689600000-0",
      "tokens": { "promptTokens": 0, "completionTokens": 0 },
      "wallTimeSeconds": 12,
      "reasons": []
    }
  ]
}
```

`runSuite` receives its leaf dependencies (`listBenchmarkDirectories`, `readEvalConfig`, `runBenchmark`, `runValidation`, `writeSummary`) explicitly and reads no environment variables or command-line arguments itself; a thin CLI wrapper assembles the real leaves and calls it. End-to-end suite execution against a real LLM is wired by the CLI entry point (step 02) and exercised by the benchmark steps (06–08), whose operator handoffs cover real-LLM runs.

### Suite status semantics

- `pass` — the run completed successfully and validation passed.
- `fail` — the run completed successfully but validation failed (missing file, wrong exit code, missing stdout text, or timeout). `reasons` lists every miss.
- `error` — the run itself did not complete successfully (executor error or `needs_clarification`). Validation is skipped; `reasons` records the run status.
