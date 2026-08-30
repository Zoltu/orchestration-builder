import { describe, expect, test } from 'bun:test'

import { runSuite, type BenchmarkRunOutcome, type BenchmarkRunRequest, type RunSuiteDependencies, type SuiteSummary } from './run-suite.ts'
import type { BenchmarkRunOutput, EvalConfig } from './validation.ts'

function evalConfig(taskType: string): EvalConfig {
	return {
		taskType,
		description: `task for ${taskType}`,
		validation: {
			command: 'true',
			expectedExitCode: 0,
			expectedFiles: ['output.txt'],
			expectedStdoutContains: 'ok',
		},
	}
}

function outcome(name: string, overrides: Partial<BenchmarkRunOutcome> = {}): BenchmarkRunOutcome {
	return {
		runId: `run-${name}`,
		workspacePath: `/tmp/workspaces/${name}`,
		status: 'success',
		tokens: { promptTokens: 100, completionTokens: 20 },
		wallTimeSeconds: 5,
		...overrides,
	}
}

function runOutput(overrides: Partial<BenchmarkRunOutput> = {}): BenchmarkRunOutput {
	return {
		exitCode: 0,
		stdout: 'ok',
		stderr: '',
		timedOut: false,
		expectedFilesPresent: { 'output.txt': true },
		...overrides,
	}
}

interface BenchmarkScript {
	evalConfig: EvalConfig
	outcome: BenchmarkRunOutcome
	runOutput?: BenchmarkRunOutput
}

interface FakeDepsState {
	listedSuitePath: string | null
	readDirs: string[]
	runRequests: BenchmarkRunRequest[]
	validatedWorkspaces: string[]
	written: { path: string; summary: SuiteSummary } | null
}

function makeFakeDeps(scriptsByDir: Record<string, BenchmarkScript>): { deps: RunSuiteDependencies; state: FakeDepsState } {
	const state: FakeDepsState = {
		listedSuitePath: null,
		readDirs: [],
		runRequests: [],
		validatedWorkspaces: [],
		written: null,
	}
	const deps: RunSuiteDependencies = {
		listBenchmarkDirectories: (suitePath) => {
			state.listedSuitePath = suitePath
			return Object.keys(scriptsByDir).map((dir) => `/suite/${dir}`)
		},
		readEvalConfig: (benchmarkDir) => {
			state.readDirs.push(benchmarkDir)
			const name = benchmarkDir.split('/').pop() ?? benchmarkDir
			const script = scriptsByDir[name]
			if (script === undefined) throw new Error(`no script for ${name}`)
			return script.evalConfig
		},
		runBenchmark: async (request) => {
			state.runRequests.push(request)
			const script = scriptsByDir[request.benchmarkDir.split('/').pop() ?? request.benchmarkDir]
			if (script === undefined) throw new Error(`no script for ${request.benchmarkDir}`)
			return script.outcome
		},
		runValidation: async (workspacePath) => {
			state.validatedWorkspaces.push(workspacePath)
			const name = workspacePath.split('/').pop() ?? workspacePath
			const script = scriptsByDir[name]
			if (script === undefined) throw new Error(`no script for ${name}`)
			return script.runOutput ?? runOutput()
		},
		writeSummary: (outputPath, summary) => {
			state.written = { path: outputPath, summary }
		},
	}
	return { deps, state }
}

const baseOptions = {
	suitePath: '/suite',
	guildPath: '/guild',
	outputSummaryPath: '/out/summary.json',
}

describe('runSuite', () => {
	test('aggregates passing benchmarks and writes a summary', async () => {
		const { deps, state } = makeFakeDeps({
			alpha: { evalConfig: evalConfig('coding'), outcome: outcome('alpha') },
			beta: { evalConfig: evalConfig('coding'), outcome: outcome('beta') },
		})

		const summary = await runSuite(deps, baseOptions)

		expect(state.listedSuitePath).toBe('/suite')
		expect(state.readDirs).toEqual(['/suite/alpha', '/suite/beta'])
		expect(state.runRequests).toHaveLength(2)
		expect(state.validatedWorkspaces).toEqual(['/tmp/workspaces/alpha', '/tmp/workspaces/beta'])
		expect(summary.totals).toEqual({ pass: 2, fail: 0, error: 0, total: 2 })
		expect(summary.results.map((r) => r.status)).toEqual(['pass', 'pass'])
		expect(state.written).not.toBeNull()
		const written = state.written
		if (written === null) throw new Error('expected the suite summary to be written')
		expect(written.path).toBe('/out/summary.json')
		expect(written.summary).toBe(summary)
	})

	test('marks a validation failure as fail with reasons, without affecting other benchmarks', async () => {
		const { deps, state } = makeFakeDeps({
			alpha: {
				evalConfig: evalConfig('coding'),
				outcome: outcome('alpha'),
				runOutput: runOutput({ exitCode: 1, stdout: 'wrong' }),
			},
			beta: { evalConfig: evalConfig('coding'), outcome: outcome('beta') },
		})

		const summary = await runSuite(deps, baseOptions)

		expect(summary.totals).toEqual({ pass: 1, fail: 1, error: 0, total: 2 })
		const alpha = summary.results.find((r) => r.benchmark === 'alpha')
		expect(alpha?.status).toBe('fail')
		expect(alpha?.reasons.length).toBeGreaterThan(0)
		expect(state.validatedWorkspaces).toEqual(['/tmp/workspaces/alpha', '/tmp/workspaces/beta'])
	})

	test('marks a non-success run outcome as error and skips validation', async () => {
		const { deps, state } = makeFakeDeps({
			alpha: { evalConfig: evalConfig('coding'), outcome: outcome('alpha', { status: 'error' }) },
			beta: { evalConfig: evalConfig('coding'), outcome: outcome('beta', { status: 'needs_clarification' }) },
		})

		const summary = await runSuite(deps, baseOptions)

		expect(summary.totals).toEqual({ pass: 0, fail: 0, error: 2, total: 2 })
		expect(summary.results.every((r) => r.status === 'error')).toBe(true)
		expect(state.validatedWorkspaces).toEqual([])
		const alpha = summary.results.find((r) => r.benchmark === 'alpha')
		expect(alpha?.reasons).toContain('run ended with status: error')
	})

	test('passes through tokens and wall time from the runner', async () => {
		const { deps } = makeFakeDeps({
			alpha: {
				evalConfig: evalConfig('coding'),
				outcome: outcome('alpha', { tokens: { promptTokens: 4321, completionTokens: 123 }, wallTimeSeconds: 42 }),
			},
		})

		const summary = await runSuite(deps, baseOptions)

		const alpha = summary.results[0]
		expect(alpha?.tokens).toEqual({ promptTokens: 4321, completionTokens: 123 })
		expect(alpha?.wallTimeSeconds).toBe(42)
	})

	test('uses the eval description as the task and forwards humanResponses', async () => {
		const { deps, state } = makeFakeDeps({
			alpha: {
				evalConfig: {
					taskType: 'coding',
					description: 'custom task text',
					validation: { command: 'true' },
					humanResponses: { 'Which language?': 'TypeScript' },
				},
				outcome: outcome('alpha'),
			},
		})

		await runSuite(deps, baseOptions)

		expect(state.runRequests[0]?.task).toBe('custom task text')
		expect(state.runRequests[0]?.humanResponses).toEqual({ 'Which language?': 'TypeScript' })
	})

	test('honors a task override and run id prefix', async () => {
		const { deps, state } = makeFakeDeps({
			alpha: { evalConfig: evalConfig('coding'), outcome: outcome('alpha') },
		})

		await runSuite(deps, { ...baseOptions, taskOverride: 'override task', runIdPrefix: 'runX' })

		expect(state.runRequests[0]?.task).toBe('override task')
		expect(state.runRequests[0]?.runId).toMatch(/^runX-alpha-\d+-0$/)
	})

	test('produces an empty summary for an empty suite', async () => {
		const { deps, state } = makeFakeDeps({})
		const summary = await runSuite(deps, baseOptions)
		expect(summary.totals).toEqual({ pass: 0, fail: 0, error: 0, total: 0 })
		expect(summary.results).toEqual([])
		expect(state.written?.summary).toBe(summary)
	})
})
