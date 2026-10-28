

import * as path from 'node:path'
import { evaluateValidation } from './validation.js'
import type { BenchmarkRunOutput, EvalConfig, ValidationSpec } from './validation.js'

export type BenchmarkRunStatus = 'success' | 'error' | 'needs_clarification' | 'suspended' | 'interrupted'

export interface BenchmarkRunRequest {
	benchmarkDir: string
	runId: string
	guildPath: string
	task: string
	humanResponses?: Record<string, string>
}

export interface BenchmarkRunOutcome {
	runId: string
	workspacePath: string
	status: BenchmarkRunStatus
	tokens: { promptTokens: number; completionTokens: number }
	wallTimeSeconds: number
}

export type BenchmarkEntryStatus = 'pass' | 'fail' | 'error' | 'invalid'

export interface SuiteSummaryEntry {
	benchmark: string
	status: BenchmarkEntryStatus
	runId: string
	tokens: { promptTokens: number; completionTokens: number }
	wallTimeSeconds: number
	reasons: string[]
}

export interface SuiteSummary {
	suitePath: string
	guildPath: string
	startedAt: string
	totals: { pass: number; fail: number; error: number; invalid: number; total: number }
	results: SuiteSummaryEntry[]
}

export interface RunSuiteDependencies {
	listBenchmarkDirectories: (suitePath: string) => string[]
	readEvalConfig: (benchmarkDir: string) => EvalConfig
	runBenchmark: (request: BenchmarkRunRequest) => Promise<BenchmarkRunOutcome>
	runValidation: (workspacePath: string, spec: ValidationSpec) => Promise<BenchmarkRunOutput>
	writeSummary: (outputPath: string, summary: SuiteSummary) => void
}

export interface RunSuiteOptions {
	suitePath: string
	guildPath: string
	outputSummaryPath: string
	runIdPrefix?: string
	taskOverride?: string
}

function computeTotals(results: SuiteSummaryEntry[]): SuiteSummary['totals'] {
	let pass = 0
	let fail = 0
	let error = 0
	let invalid = 0
	for (const entry of results) {
		if (entry.status === 'pass') pass++
		else if (entry.status === 'fail') fail++
		else if (entry.status === 'invalid') invalid++
		else error++
	}
	return { pass, fail, error, invalid, total: results.length }
}

// A suspended run never reached a verdict: the provider outage stopped it before it could be judged. Its spend still counts toward cost, but it is excluded from the pass/fail/error totals so an outage can neither improve nor degrade the suite's score.
function entryForInvalidRun(name: string, outcome: BenchmarkRunOutcome): SuiteSummaryEntry {
	return {
		benchmark: name,
		status: 'invalid',
		runId: outcome.runId,
		tokens: outcome.tokens,
		wallTimeSeconds: outcome.wallTimeSeconds,
		reasons: ['run suspended by provider outage'],
	}
}

function entryForFailedRun(name: string, outcome: BenchmarkRunOutcome): SuiteSummaryEntry {
	return {
		benchmark: name,
		status: 'error',
		runId: outcome.runId,
		tokens: outcome.tokens,
		wallTimeSeconds: outcome.wallTimeSeconds,
		reasons: [`run ended with status: ${outcome.status}`],
	}
}

async function entryForSuccessfulRun(
	name: string,
	outcome: BenchmarkRunOutcome,
	evalConfig: EvalConfig,
	runValidation: RunSuiteDependencies['runValidation'],
): Promise<SuiteSummaryEntry> {
	const runOutput = await runValidation(outcome.workspacePath, evalConfig.validation)
	const result = evaluateValidation(evalConfig.validation, runOutput)
	return {
		benchmark: name,
		status: result.status,
		runId: outcome.runId,
		tokens: outcome.tokens,
		wallTimeSeconds: outcome.wallTimeSeconds,
		reasons: result.reasons,
	}
}

async function entryForOutcome(
	name: string,
	outcome: BenchmarkRunOutcome,
	evalConfig: EvalConfig,
	runValidation: RunSuiteDependencies['runValidation'],
): Promise<SuiteSummaryEntry> {
	if (outcome.status === 'success') return entryForSuccessfulRun(name, outcome, evalConfig, runValidation)
	if (outcome.status === 'suspended') return entryForInvalidRun(name, outcome)
	return entryForFailedRun(name, outcome)
}

export async function runSuite(deps: RunSuiteDependencies, options: RunSuiteOptions): Promise<SuiteSummary> {
	const startedAt = new Date().toISOString()
	const startedAtMs = Date.now()
	const prefix = options.runIdPrefix ?? 'suite'
	const taskOverride = options.taskOverride

	const benchmarkDirs = deps.listBenchmarkDirectories(options.suitePath)
	const results: SuiteSummaryEntry[] = []

	let index = 0
	for (const benchmarkDir of benchmarkDirs) {
		const name = path.basename(benchmarkDir)
		const evalConfig = deps.readEvalConfig(benchmarkDir)
		const task = taskOverride ?? evalConfig.description
		const runId = `${prefix}-${name}-${startedAtMs}-${index}`
		index++

		const outcome = await deps.runBenchmark({
			benchmarkDir,
			runId,
			guildPath: options.guildPath,
			task,
			humanResponses: evalConfig.humanResponses,
		})

		const entry = await entryForOutcome(name, outcome, evalConfig, deps.runValidation)
		results.push(entry)
	}

	const summary: SuiteSummary = {
		suitePath: options.suitePath,
		guildPath: options.guildPath,
		startedAt,
		totals: computeTotals(results),
		results,
	}
	deps.writeSummary(options.outputSummaryPath, summary)
	return summary
}
