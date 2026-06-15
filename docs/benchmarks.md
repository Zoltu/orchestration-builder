# Benchmark Workspaces

## What a benchmark is

A benchmark is a self-contained folder that defines an initial state and a validation rule. The executor treats the folder as a workspace. The Foundry uses a separate `eval.json` file in the same folder to validate the final workspace state.

## Folder layout

```
benchmarks/
└── <benchmark_name>/
    ├── eval.json          # validation specification; not seen by the executor
    ├── README.md          # task description; copied into run workspace
    ├── src/
    └── tests/
```

Everything in the benchmark folder except `eval.json` is copied into `data/runs/<run_id>/workspace/` at the start of a run. This means the agent can read any file in the workspace, but it cannot read the validation rules.

## `eval.json` schema

```json
{
  "taskType": "coding",
  "description": "Implement a function that calculates the factorial of a non-negative integer.",
  "validation": {
    "command": "python -m pytest tests/",
    "expectedExitCode": 0,
    "expectedFiles": ["src/factorial.py"],
    "timeoutSeconds": 60
  }
}
```

Fields:

- `taskType` (string): a label used by the Foundry for grouping and regression analysis. It may match a Guild workflow the Foundry optimizes.
- `description` (string): a human-readable description of the benchmark. Also useful as the default task text passed to the entry role.
- `validation` (object): how to determine whether the run succeeded.
  - `command` (string, required): a shell command to run inside the final workspace.
  - `expectedExitCode` (number, optional): the command must exit with this code. Default `0`.
  - `expectedFiles` (array, optional): files that must exist after the run.
  - `expectedStdoutContains` (string or array, optional): text that must appear in the command’s stdout.
  - `timeoutSeconds` (number, optional): how long the validation command may run.
- `humanResponses` (object, optional): deterministic answers to expected `ask_human` questions. Keys are question strings, values are answers. The Foundry simulator returns these when the small model asks an exact or near-exact match.

## Validation rules

The Foundry validates a completed run by:

1. Checking that all `expectedFiles` exist.
2. Running `command` in the final workspace.
3. Checking the exit code.
4. Checking for `expectedStdoutContains` if present.

Validation is deterministic and objective. A benchmark fails if any step fails.

## Task text

The executor receives the benchmark task as a user message to the entry role. By default the task text is taken from `eval.json.description`, but the user may override it when starting a run.

## Benchmark suite

A suite is simply a directory of benchmarks. The Foundry runs every benchmark in the suite against the current Guild and aggregates scores. Suites should include:

- **Easy tasks** to verify the Guild can function at all.
- **Medium tasks** that require a small number of roles and tools.
- **Hard tasks** that require multiple decomposition steps, verification, or retries.
- A mix of task types if the Guild is intended to generalize.

## Why keep `eval.json` out of the workspace

The executor only needs the initial workspace. The validation rules are used after the run is complete by the Foundry. Keeping `eval.json` out of the workspace prevents the active model from optimizing for the test rather than the task. It also lets the validation change without changing the task the agent sees.

## Human answer bank

For benchmarks optimized with `ask_human` enabled, `eval.json` may include deterministic answers to expected questions:

```json
{
  "taskType": "coding",
  "description": "Implement factorial in src/factorial.py.",
  "humanResponses": {
    "What language should I use?": "TypeScript.",
    "Should I handle negative inputs?": "Yes, raise ValueError."
  },
  "validation": {
    "command": "python -m pytest tests/",
    "expectedExitCode": 0,
    "timeoutSeconds": 60
  }
}
```

The Foundry simulator returns the canned answer for exact or near-exact matches. If no match exists, the simulator answers from the configured persona. This keeps optimization runs reproducible.

## Non-coding validation

The validation command can be any shell command, not just a test runner. For example, a writing benchmark could use:

```json
{
  "taskType": "writing",
  "description": "Write a one-paragraph summary of README.md and save it to summary.txt.",
  "validation": {
    "command": "diff -q expected_summary.txt summary.txt",
    "expectedExitCode": 0,
    "expectedFiles": ["summary.txt"],
    "timeoutSeconds": 30
  }
}
```

This keeps the validation mechanism general while remaining deterministic and scriptable.

## Example benchmark

```
benchmarks/factorial_001/
├── eval.json
├── README.md
├── src/
│   └── __init__.py
└── tests/
    └── test_factorial.py
```

`README.md`:

```markdown
# Factorial

Implement `factorial(n)` in `src/factorial.py`.
The function should handle `n = 0` and raise ValueError for negative inputs.
```

`eval.json`:

```json
{
  "taskType": "coding",
  "description": "Implement factorial in src/factorial.py. Handle n=0 and reject negatives.",
  "validation": {
    "command": "python -m pytest tests/",
    "expectedExitCode": 0,
    "expectedFiles": ["src/factorial.py"],
    "timeoutSeconds": 60
  }
}
```

## Storing benchmark results

The Foundry records per-benchmark results inside each branch:

```
data/foundry/branches/<branch_id>/
└── results/
    └── <benchmark_name>.json
```

Each result file contains:

- `status`: `pass`, `fail`, or `error`.
- `validation`: detailed validation output.
- `tokens`: prompt and completion token counts.
- `errors`: any error events encountered during the run.
- `run_id`: link to the full trace.
