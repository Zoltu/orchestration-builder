// Orchestration: runs every benchmark in a suite directory through the executor
// and the validation harness, then writes a machine-readable summary. This is
// testable orchestration: it receives its leaf dependencies explicitly and
// touches no environment variables, command-line arguments, or external systems
// directly. The CLI wrapper (a future step) assembles the real leaves and calls
// runSuite; in-memory tests inject fakes.

import * as path from 'node:path'
import { evaluateValidation } from './validation.js'
import type { BenchmarkRunOutput, EvalConfig, ValidationSpec } from './validation.js'

export type BenchmarkRunStatus = 'success' | 'error' | 'needs_clarification'

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

export type BenchmarkEntryStatus = 'pass' | 'fail' | 'error'

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
	totals: { pass: number; fail: number; error: number; total: number }
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
	for (const entry of results) {
		if (entry.status === 'pass') pass++
		else if (entry.status === 'fail') fail++
		else error++
	}
	return { pass, fail, error, total: results.length }
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

		const entry = outcome.status === 'success'
			? await entryForSuccessfulRun(name, outcome, evalConfig, deps.runValidation)
			: entryForFailedRun(name, outcome)
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
