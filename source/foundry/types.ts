// Foundry data model. The Foundry is an offline meta-optimizer that uses a
// large model to improve the Guild (see docs/foundry.md). These types describe
// its configuration, the hypotheses it produces, and the per-branch / per-cycle
// results and scores it records. No behavior lives here; this is the contract
// the configuration guard (config.ts), the branch manager (branches.ts), and
// later steps (scoring, evaluation, hypothesis generation, merging, the loop)
// compose against.

export type FoundryMode = 'sequential' | 'parallel'

// The large model the Foundry uses for hypothesis generation, merging, and
// human simulation. It is described separately from the executor's small model
// (ModelConfig) because it carries an environment-variable key name rather than
// a literal key, and only needs the endpoint plus a model label.
export interface BigModelConfig {
	apiBase: string
	apiKeyEnv: string
	model: string
}

// The persona the large model adopts when answering `ask_human` calls during
// optimization. Only required when the Guild under test includes `ask_human`.
export interface HumanSimulatorConfig {
	persona: string
}

// Termination guardrails (docs/foundry.md "Guardrails and termination"). The
// cycle budget bounds the number of optimization cycles per run. The cost
// budget is expressed as a big-model token cap and/or a wall-clock cap; either
// may be omitted if the other is the operative limit. The plateau budget is
// the number of consecutive cycles with no improvement before the loop gives up.
export interface FoundryBudgets {
	maxCycles: number
	maxBigModelTokens?: number
	maxWallClockSeconds?: number
	plateauPatienceCycles: number
}

// Statistical evaluation knobs (docs/foundry.md "Statistical evaluation"). Each
// benchmark is run `repetitionsPerBenchmark` times per branch and a branch is
// considered better than the baseline only when its pass rate exceeds the
// baseline's by at least `improvementMargin`.
export interface FoundryEvaluationConfig {
	repetitionsPerBenchmark: number
	improvementMargin: number
}

export interface FoundryConfig {
	mode: FoundryMode
	maxConcurrentExecutorRuns: number
	maxConcurrentBigRequests: number
	bigModel: BigModelConfig
	humanSimulator?: HumanSimulatorConfig
	humanQuestionPenalty: number
	budgets: FoundryBudgets
	evaluation: FoundryEvaluationConfig
}

// A single file rewrite proposed by a hypothesis. `path` is relative to the
// Guild directory (e.g. "guild.json", "prompts/coder.md", "tools/agent.json"),
// matching the path convention used inside guild.json itself. `edit` is the
// complete new file content (a full replacement, not a diff), so no patch
// engine or third-party dependency is needed.
export interface HypothesisChange {
	path: string
	edit: string
}

// A concrete, testable change to the Guild. Produced by hypothesis generation
// (step 13) and applied by the branch manager (step 10) to produce a candidate
// branch Guild.
export interface Hypothesis {
	id: string
	motivation: string
	mechanism: string
	predictedImpact: string
	changes: HypothesisChange[]
}

export type BenchmarkOutcome = 'win' | 'loss' | 'partial'

// Raw per-benchmark outcome for a branch, recorded after the executor runs the
// branch Guild against that benchmark across the configured repetitions. This
// is the input to scoring (step 11).
export interface BenchmarkBranchResult {
	benchmark: string
	passRate: number
	adjustedScore: number
	averageTokensPerSuccessfulRun: number
	askHumanCount: number
	contextPressureEvents: number
	errorEvents: number
	wallTimeSeconds: number
	outcome: BenchmarkOutcome
}

// Per-benchmark scored entry with the win/loss/partial repetition counts the
// report surfaces so a human can see whether an improvement is consistent or
// the result of a lucky sample (docs/foundry.md "Statistical evaluation").
export interface BenchmarkScoreEntry {
	benchmark: string
	wins: number
	losses: number
	partials: number
	passRate: number
	adjustedScore: number
	averageTokensPerSuccessfulRun: number
	askHumanCount: number
	contextPressureEvents: number
	errorEvents: number
	wallTimeSeconds: number
	outcome: BenchmarkOutcome
}

// A branch's aggregate score, produced by `aggregateBranch` (step 11). The
// flags drive merge grouping: a regressing branch is rejected; a branch within
// the margin is not flagged as improved.
export interface BranchScore {
	branchId: string
	overallPassRate: number
	overallAdjustedScore: number
	perBenchmark: BenchmarkScoreEntry[]
	regression: boolean
	improvement: boolean
}

// Everything the Foundry records about one branch in a cycle: its hypothesis,
// its raw per-benchmark results, and its aggregate score. Steps 12–14 produce
// and consume this.
export interface BranchResult {
	branchId: string
	hypothesis: Hypothesis
	benchmarkResults: BenchmarkBranchResult[]
	score: BranchScore
}

export type FoundryTerminationReason = 'cycle_budget' | 'cost_budget' | 'plateau'

// The human-readable + machine-readable summary of one optimization cycle,
// written by the loop (step 15) and the reporting step (step 14).
export interface OptimizationCycleReport {
	cycleNumber: number
	startedAt: string
	baseline: {
		guildPath: string
		passRate: number
		adjustedScore: number
	}
	branches: BranchResult[]
	acceptedBranchIds: string[]
	rejectedBranchIds: string[]
	conflictingBranchIds: string[]
	merged: boolean
	newBaselinePath?: string
	terminated: boolean
	terminationReason?: FoundryTerminationReason
}
