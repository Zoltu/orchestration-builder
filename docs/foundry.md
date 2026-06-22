# Foundry

The Foundry is an offline meta-optimizer that improves the Guild by proposing, testing, and merging changes. It is a separate program from the executor — it never imports from the executor codebase and talks to the executor exclusively over its HTTP API. It uses a large language model (commercial API or large local model) for hypothesis generation and merging; the executor itself never does.

The Foundry is future work. Its design is documented here so executor and Guild decisions can account for it. Implementation is step 23 of the development plan.

## Architecture

The Foundry is a standalone program, not a subcommand of the executor service. It is an HTTP client + Docker orchestrator + big-model caller. It submits runs to the executor service via `POST /api/runs`, polls `GET /api/runs/:id` for completion, and reads the final workspace. It never imports `runExecutor` or runs inside the executor process.

Each Foundry benchmark run gets its own container (one container = one benchmark) so benchmarks that install packages or download tooling cannot pollute each other. The Foundry copies the benchmark source into a temp directory, mounts it into the container at `/workspace` (read-write), mounts the branch Guild read-only, starts the container, polls for completion, captures the result, then stops the container and deletes the temp. The copy is necessary so repeated runs start from a clean source.

The Foundry uses CLI args (not environment variables) because it is a batch tool with per-invocation parameters: `--suite`, `--cycles`, `--guild`, cost/plateau overrides, and the executor-service endpoint / container-image config. The project structure (in-repo subpackage vs separate repository) is decided when the step runs.

## Optimization loop

1. **Observe** — read the current baseline Guild and recent run logs.
2. **Hypothesize** — prompt the large model to cluster failures and propose concrete, testable hypotheses.
3. **Branch** — create candidate Guild configurations from the hypotheses.
4. **Evaluate** — run each branch against the benchmark suite via the executor service (one container per benchmark, `repetitionsPerBenchmark` repetitions).
5. **Score** — compare each branch against the baseline.
6. **Merge** — combine accepted improvements and resolve conflicts via the large model.
7. **Report** — write a human-readable report.
8. **Promote** — write the new baseline Guild.
9. **Repeat** until a guardrail fires.

A cycle that produces an accepted branch promotes it. A cycle with no improvement increments the plateau counter. A regression in the merged candidate prevents promotion.

## Configuration

```json
{
  "mode": "parallel",
  "maxConcurrentExecutorRuns": 1,
  "maxConcurrentBigRequests": 8,
  "bigModel": {
    "apiBase": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "model": "gpt-4o"
  },
  "humanSimulator": {
    "persona": "a senior software engineer who wants the project done correctly"
  },
  "humanQuestionPenalty": 0.05,
  "budgets": {
    "maxCycles": 20,
    "maxCostTokens": 5000000,
    "plateauLimit": 5
  },
  "evaluation": {
    "repetitionsPerBenchmark": 3,
    "improvementMargin": 0.1
  }
}
```

- `maxConcurrentExecutorRuns` — pipeline parallelism of the optimize loop (not parallel executor calls). For a single-container deployment this is effectively 1 (sequential). The per-benchmark container is the concurrency boundary.
- `humanSimulator` — optional. A run against a Guild without `ask_human` has no need for a simulator. `humanQuestionPenalty` is always required (part of the scoring formula).
- `evaluation.repetitionsPerBenchmark` — how many times each benchmark is run per branch (accounts for stochasticity).
- `evaluation.improvementMargin` — a branch must exceed the baseline pass rate by this margin to be considered an improvement.

## Hypotheses

A hypothesis is a concrete, testable change to the Guild:

```json
{
  "hypothesis_id": "h-001",
  "motivation": "The coder role ignores failing test output because it is too long.",
  "mechanism": "Increase max_tool_output_chars and instruct the coder to re-invoke run_shell.",
  "predicted_impact": "+10% pass rate on medium coding tasks",
  "changes": [
    { "path": "guild/prompts/coder.md", "edit": "..." },
    { "path": "guild/guild.json", "edit": "..." }
  ]
}
```

An `edit` is the **complete new file content** for the path (not a diff/patch). This needs no patch engine and keeps branch application auditable (write-then-validate).

The large model is given the current Guild, recent run logs, aggregated failure summaries, and instructions to produce only actionable hypotheses. Hypotheses whose edits produce an invalid Guild are dropped (not crashed on), with the reason recorded. No-op hypotheses (wording-only changes that don't move scores) are discarded as a loop rule, not a termination reason.

## Branch management

Each hypothesis becomes a branch under `data/foundry/branches/<branch_id>/`. Branch management is filesystem-only (no executor imports, no HTTP). It exposes four operations: copy baseline into branch, apply hypothesis edits, archive baseline into history, restore historical baseline. It reuses the Guild loader/validator to validate branch Guilds end-to-end. A branch whose edits produce an invalid Guild is rejected with `ValidationError`. Branch paths are confined to their directory (path-escape is prevented).

## Scoring

Each run produces a `RunScore` (pass/fail, adjusted score, tokens, ask count, context-pressure count, error count). Runs are aggregated per-branch into a `BranchScore` (per-benchmark win/loss/partial counts, overall pass rate, adjusted score, regression flag, improvement flag).

The adjusted score formula:

```text
adjustedScore = (pass ? 1.0 : 0.0) - humanQuestionPenalty * askHumanCount
```

A branch is flagged as improved only if its adjusted pass rate exceeds the baseline by `evaluation.improvementMargin` across repetitions. A branch is flagged as regressing if any baseline-passing benchmark regresses. The margin prevents the Foundry from chasing noise.

Validation reuses `source/benchmarks/validation.ts` — the same helpers the benchmark harness uses. The Foundry does not duplicate validation logic.

## Evaluation

`evaluateBranch` runs each benchmark in the suite `repetitionsPerBenchmark` times against the branch Guild via the executor service. After each run, it validates the final workspace and collects a `RunRecord` (status, tokens, ask count, context events, errors, wall time, run id, final workspace path). Results are written to `data/foundry/branches/<branch_id>/results/<benchmark>.json` (per-benchmark) and a branch-level `results.json`.

The run-submission lifecycle handles container/temp teardown on both success and error (teardown order matters: stop the container before deleting the temp). A run that does not terminate hits a configurable timeout and is still torn down.

## Merge and conflict resolution

Branches are classified: **rejected** (no improvement or worse), **accepted** (clear improvement, no conflict), **conflicting** (improves but edits the same files as another accepted branch).

Conflicting branches are merged by the large model. The Foundry provides the common ancestor, labeled diffs (baseline → A, baseline → B), and experimental results. The model produces merged file contents. The merged candidate is re-evaluated for regression by the loop (not by the merge module). If the merge introduces malformed JSON, schema violations, or regressions, the candidate is rejected.

## Guardrails

The loop terminates on:

- **Cycle budget** — maximum optimization cycles per run.
- **Cost budget** — maximum big-model tokens or wall-clock time.
- **Plateau** — no branch improves the baseline for a configured number of cycles.

No-op detection (wording-only changes) is a discard rule, not a termination reason. Termination logic is expressed as a pure `shouldTerminate(state, config)` helper.

## Promotion and rollback

`promote.ts` is the sole writer of `guild/guild.json`. It writes the new baseline, copies the previous baseline to `data/foundry/history/<timestamp>/`, and provides rollback. Baseline writes are serialized (v1 assumes a single Foundry process). Promotion never overwrites history. The final merged candidate is promoted only after being evaluated against all benchmarks in the suite, not just the ones individual branches targeted.

## Human simulation

When `ask_human` is in the Guild, the Foundry answers questions via the large model configured with a persona. The simulator returns deterministic `humanResponses` from the benchmark's `eval.json` on near-exact matches before falling back to the big-model persona. This keeps optimization runs reproducible. The Foundry answers as an HTTP client posting to the executor's `/api/answer` endpoint — the tool schema is identical to what the small model sees in production.

Every `ask_human` call reduces the run's score by `humanQuestionPenalty`. This penalizes branches that ask too many questions while allowing occasional clarifying questions.

## Reporting

Reports are written to `data/foundry/reports/<timestamp>/`:

```
├── index.html        # human-readable summary (plain HTML, no deps)
├── summary.json      # machine-readable summary
└── branches/
    └── <branch_id>/
        ├── diff.txt
        └── results.json
```

Reports include hypothesis summaries, a branch score table, accepted/rejected/merged status, the new-baseline diff, and run-id links. All untrusted content (diffs, summaries, file paths) is HTML-escaped.

## Data layout

```
data/foundry/
├── baseline/
│   └── guild.json             # latest accepted baseline copy
├── branches/
│   └── <branch_id>/
│       ├── guild.json
│       ├── hypothesis.json
│       ├── results.json
│       └── results/
│           └── <benchmark>.json
├── history/
│   └── <timestamp>/
│       └── guild.json
└── reports/
    └── <timestamp>/
        ├── index.html
        ├── summary.json
        └── branches/
```

## Seed Guild

The Foundry needs an initial Guild to optimize. The seed Guild is hand-written with basic roles (`orchestrator`, `planner`, `coder`, `critic`, `context_manager`, `recovery`), built-in tools, a small number of native tools, and conservative budgets. It does not need to be good — it only needs to be runnable.
