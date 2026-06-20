# Step 14 — Foundry merge + reporting

## Goal

Add conflict detection and LLM-driven merging of accepted branches, plus human- and machine-readable reports. After this step all Foundry pieces except the top-level loop/CLI exist.

## Context

Read `docs/foundry.md` ("Merging and conflict resolution", "Regression testing", "Promotion and rollback", "Reporting"). Accepted branches apply automatically. Conflicting branches (editing the same files as another accepted branch) are merged by the large model using common-ancestor + labeled diffs + results. The merged candidate is re-evaluated against the full suite before promotion. Only one Foundry process may promote to baseline.

## Deliverables

1. `source/foundry/merge.ts` — pure helpers + orchestration:
   - `classifyBranches(scoredBranches): { rejected, accepted, conflicting }` — pure decision logic.
   - `detectConflicts(acceptedBranches): ConflictSet` — pure: which branches edit overlapping files.
   - `mergeConflicting(dependencies, { ancestor, branchA, branchB, resultsA, resultsB })` — orchestration that builds the labeled-diff prompt, calls the big model (injected caller), parses the merged file contents with a type guard, and returns a merged candidate. Re-evaluation of the merged candidate happens in the loop (step 15), not here.
2. `source/foundry/merge.test.ts` — in-memory tests: classification; conflict detection on overlapping vs disjoint file sets; merge with a fake big-model caller returns parsed merged content; malformed merge output is rejected.
3. `source/foundry/report.ts` — pure helpers that render a `summary.json` and an `index.html` (plain HTML, no deps) from a cycle's results. HTML includes hypothesis summaries, branch score table, accepted/rejected/merged status, the new-baseline diff, and run-id links.
4. `source/foundry/report.test.ts` — in-memory tests: `summary.json` shape; `index.html` contains required sections and escapes file content safely (no raw injection of untrusted diffs into HTML — escape `<`, `>`, `&`).
5. `source/foundry/promote.ts` — leaf/orchestration that writes the new baseline to `guild/guild.json`, copies the previous baseline to `data/foundry/history/<timestamp>/`, and provides a rollback. Baseline writes are serialized (a simple lock-file or single-process assumption documented; v1 assumes a single Foundry process).

## Module boundaries

- `merge.ts` classification/detection are pure; the LLM merge call goes through the injected big-model caller (step 13's `llm.ts`).
- `report.ts` is pure rendering — no I/O; the loop writes the files.
- `promote.ts` is the only writer of `guild/guild.json`.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] Classification and conflict detection are correct (pure-logic tests).
- [ ] Merge with a fake caller parses merged content and rejects malformed output.
- [ ] Reports render required sections; HTML escaping prevents injection.
- [ ] Promotion writes baseline + history and supports rollback (tested in a temp tree).

## End-of-step evaluation

Confirm the HTML report escapes all untrusted content (diffs, summaries, file paths). Ensure `promote.ts` never overwrites history. Re-read `docs/foundry.md` reporting section and confirm every documented report field is present.

## Estimated effort

Medium to large — merge orchestration and report rendering.

## Operator handoff

None — fully in-memory. Real merging/reporting is exercised in step 15.
