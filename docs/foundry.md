# Foundry (Meta-Optimizer)

## Purpose

The Foundry is an offline optimization process that improves the Guild. It uses a large language model to propose changes to the Guild, runs the executor against a benchmark suite to test those changes, and merges the successful changes into a new baseline Guild.

The Foundry is the only part of the system that uses a large model. The executor itself never does.

## Overview of the optimization loop

1. **Observe** — read the current baseline Guild and recent run traces.
2. **Hypothesize** — prompt a large model to cluster failures and propose concrete improvement hypotheses.
3. **Branch** — create one or more candidate Guild configurations.
4. **Evaluate** — run each branch against the benchmark suite using the executor.
5. **Compare** — score each branch versus the baseline.
6. **Merge** — combine validated improvements and resolve conflicts.
7. **Report** — write a human-readable report to disk.
8. **Repeat**.

## Foundry execution modes

The Foundry can run in two modes:

- **Sequential.** Run one experiment at a time. Useful when the target model is local and only one context window fits in VRAM.
- **Parallel.** Run multiple experiments concurrently and generate/merge hypotheses in parallel. Useful when the target model is hosted or when multiple local endpoints are available.

```json
{
  "foundry": {
    "mode": "parallel",
    "maxConcurrentExecutorRuns": 1,
    "maxConcurrentBigRequests": 8,
    "bigModel": {
      "apiBase": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY",
      "model": "gpt-4o"
    }
  }
}
```

- `maxConcurrentExecutorRuns` controls how many benchmarks the executor can run at once. For a single local model this is `1`.
- `maxConcurrentBigRequests` controls how many meta-optimization LLM calls can happen at once.

In Foundry mode, `ask_human` is answered by the same large model that generates hypotheses, configured to simulate a human persona. This lets the optimization loop run unattended while still penalizing branches that ask too many questions.

## Human simulation and question penalty

When `ask_human` is included in the Guild, the Foundry supplies answers so optimization does not require a real human. The same large model used for hypothesis generation and merging acts as the human simulator.

The simulator is configured through a persona prompt:

```json
{
  "foundry": {
    "humanSimulator": {
      "persona": "a senior software engineer who wants the project done correctly"
    },
    "humanQuestionPenalty": 0.05
  }
}
```

The simulator receives:

- The question.
- The original task description.
- Any deterministic answers from the benchmark's `eval.json`.

It answers as the persona would. If the question is too complicated, vague, or unanswerable, it may say so instead of inventing an answer.

### Scoring penalty

Every `ask_human` call reduces the run's score by a flat `humanQuestionPenalty`:

```text
adjustedScore = (pass ? 1.0 : 0.0) - humanQuestionPenalty * askHumanCount
```

The penalty is a hyperparameter. A typical starting value is small enough that one clarifying question does not destroy an otherwise good run, but large enough that asking repeatedly is worse than solving the task directly.

## Hypotheses

A hypothesis is a concrete, testable change to the Guild. The Foundry represents it as metadata plus a branch configuration.

```json
{
  "hypothesis_id": "h-001",
  "motivation": "The coder role often ignores failing test output because it is too long to fit inline.",
  "mechanism": "Increase max_tool_output_chars for the tester role and instruct the coder to re-invoke run_shell instead of reading inline output.",
  "predicted_impact": "+10% pass rate on medium coding tasks",
  "changes": [
    { "path": "guild/prompts/coder.md", "edit": "..." },
    { "path": "guild/guild.json", "edit": "..." }
  ]
}
```

The large model is given:

- The current Guild.
- Recent `log.jsonl` files.
- Aggregated pass/fail and failure-mode summaries.
- Instructions to produce only actionable, testable hypotheses.

## Branches and experiments

Each hypothesis becomes a branch:

```
data/foundry/branches/<branch_id>/
├── guild.json
├── hypothesis.json
└── results/
    └── <benchmark_name>.json
```

For each branch, the Foundry:

1. Copies the baseline Guild.
2. Applies the changes.
3. Runs the executor against every benchmark in the suite (one run per benchmark, respecting `maxConcurrentExecutorRuns`).
4. Validates each final workspace using the benchmark’s own `eval.json`.
5. Records the result, token usage, context events, number of `ask_human` calls, and wall-clock time.

Branches are isolated. A bad branch cannot corrupt the baseline or other branches.

## Evaluation

The Foundry scores each branch on:

- **Pass rate.** Percentage of benchmarks that pass validation.
- **Partial rate.** Percentage that partially pass, if the validation supports it.
- **Average tokens per successful run.**
- **Context pressure.** Frequency and severity of `context_budget_exceeded` events.
- **Error rate.** How often runs hit safety budgets, loops, or tool timeouts.
- **Regression.** Pass-rate change on benchmarks that the baseline already solves.
- **Ask frequency.** Average number of `ask_human` calls per run.
- **Adjusted score.** Pass score minus the per-question `humanQuestionPenalty`.

A branch must pass a confidence check before being considered for merge. Because small models are stochastic, each benchmark should be run multiple times (configurable, default 3–5) and the pass rate is computed across repetitions.

## Merging and conflict resolution

After scoring, the Foundry divides branches into three groups:

1. **Rejected** — no improvement or statistically worse.
2. **Accepted** — clear improvement, no conflict with other accepted branches.
3. **Conflicting** — improves things but edits the same files as another accepted branch.

Accepted branches apply automatically.

Conflicting branches are merged by the large model. All merging is done by the LLM, not by hand-written tooling. To help the LLM merge correctly, the Foundry provides:

- The common ancestor of each file.
- Clearly labeled diffs: baseline → branch A, and baseline → branch B.
- The experimental results for each branch.

The large model produces a merged version of each conflicting file. The merged configuration is treated as a new candidate branch and re-evaluated for regression. If the merge introduces malformed JSON, schema violations, or regressions, the candidate is rejected.

## Regression testing

The final merged candidate is promoted to the new baseline only after it is evaluated against **all** benchmarks in the suite, not just the ones the individual branches targeted.

## Promotion and rollback

The Foundry writes the new baseline to `guild/guild.json` and copies the previous baseline to `data/foundry/history/<timestamp>/guild.json`. A simple rollback command restores a historical baseline to `guild/guild.json`.

Only one Foundry process may promote to the baseline at a time. Branch experiments are independent and can run concurrently, but baseline writes are serialized to avoid corrupting the active Guild.

## Guardrails and termination

The Foundry loop has explicit limits to prevent unbounded spending:

- **Cycle budget.** A maximum number of optimization cycles per run.
- **Cost budget.** A maximum number of big-model tokens or a maximum wall-clock time.
- **Plateau detection.** If no branch improves the baseline for a configured number of cycles, the loop terminates.
- **No-op detection.** Hypotheses that only shuffle wording without changing scores are discarded.

When a limit is reached, the Foundry writes a final report and exits cleanly.

## Statistical evaluation

Because the small model is stochastic, each benchmark is run multiple times per branch. A branch is considered better than baseline only if its pass rate exceeds the baseline by a pre-configured margin across those repetitions. The margin accounts for variance and prevents the Foundry from chasing noise.

Reports include per-benchmark win/loss/partial counts so a human can see whether an improvement is consistent or the result of a lucky sample.

## Reporting

After each optimization cycle, the Foundry writes a report to:

```
data/foundry/reports/<timestamp>/
├── index.html        # human-readable summary
├── summary.json      # machine-readable summary
└── branches/
    └── <branch_id>/
        ├── diff.txt
        └── results.json
```

The report includes:

- A summary of all hypotheses.
- A table of branches and their scores.
- Which branches were accepted, rejected, or merged.
- The new baseline diff.
- Run IDs and links to full traces.

Reports are plain files so a human can review them without starting any service.

## Foundry data layout

```
data/foundry/
├── baseline/
│   └── guild.json             # latest accepted baseline copy
├── branches/
│   └── <branch_id>/
│       ├── guild.json
│       ├── hypothesis.json
│       └── results.json
├── history/
│   └── <timestamp>/
│       └── guild.json
└── reports/
    └── <timestamp>/
        ├── index.html
        ├── summary.json
        └── branches/
```

## Separation from the executor

The Foundry never runs inside the executor process and never runs on the small model except by invoking the executor. It is a higher-level control loop. This separation means:

- The executor stays simple and single-model.
- The Foundry can parallelize large-model calls freely.
- Experiments can be distributed across machines later without changing the executor.

## Initial seed guild

The Foundry needs an initial Guild to optimize. The initial Guild is hand-written and contains:

- Basic roles such as `orchestrator`, `planner`, `coder`, `critic`.
- The built-in tools.
- A small number of native tools.
- Conservative budgets.

From this seed, the Foundry explores improvements. The seed does not need to be good; it only needs to be runnable.
