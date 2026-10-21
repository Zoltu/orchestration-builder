import { describe, expect, test } from 'bun:test'

import type { RunCheckpoint } from './checkpoint.ts'
import type { ListRunIds, ReadRunCheckpointById, ReadRunMetaTextById, WriteMeta } from './persistence.ts'
import { reconcileRunsOnStartup, type StartupReconciliationDependencies } from './startup-reconciliation.ts'
import type { VersionStatus } from './orchestration-version.ts'
import type { RunMeta } from './types.ts'

function runningMeta(runId: string, startTime: string): RunMeta {
	return {
		runId,
		guildPath: 'guild',
		benchmarkPath: 'bench',
		task: `task for ${runId}`,
		effort: 'standard',
		involvement: 'early-engagement',
		status: 'running',
		startTime,
	}
}

function terminalMeta(runId: string): RunMeta {
	return {
		runId,
		guildPath: 'guild',
		benchmarkPath: 'bench',
		task: `task for ${runId}`,
		status: 'success',
		startTime: '2026-01-01T00:00:00.000Z',
		endTime: '2026-01-01T00:01:00.000Z',
	}
}

function checkpointFor(runId: string, startTime: string): RunCheckpoint {
	return {
		version: 2,
		runId,
		startTime,
		registryCounter: 1,
		frames: [
			{
				roleId: 'main-0-1',
				roleName: 'main',
				depth: 0,
				task: `task for ${runId}`,
				effort: 'standard',
				involvement: 'early-engagement',
				roleState: {
					protectedPrefixLength: 2,
					history: [
						{ role: 'system', content: 'prompt' },
						{ role: 'user', content: 'task' },
					],
					lastPromptTokens: 10,
					recentCompactionPromptTokens: [],
					recentToolCalls: [],
					toolCallCount: 0,
					generatedTokens: 5,
					contextExceededAttempts: 0,
					loopCheckToolCallWatermark: 0,
					loopCheckTokenWatermark: 0,
				},
			},
		],
	}
}

function parkedCheckpointFor(runId: string, startTime: string): RunCheckpoint {
	const checkpoint = checkpointFor(runId, startTime)
	const entry = checkpoint.frames[0]
	if (entry === undefined) throw new Error('checkpoint has no entry frame')
	return {
		...checkpoint,
		parkedAsk: { roleId: 'main-0-1', toolCallId: 'ask_1', callId: 'tool:ask_1', questionId: 'ask_1', question: 'which database?' },
		frames: [
			{
				...entry,
				roleState: {
					...entry.roleState,
					history: [
						{ role: 'system', content: 'prompt' },
						{ role: 'user', content: 'task' },
						{ role: 'assistant', content: '', tool_calls: [{ id: 'ask_1', type: 'function', function: { name: 'ask_human', arguments: '{"question":"which database?"}' } }] },
						{ role: 'tool', content: '{"question":"which database?","parked":true}', tool_call_id: 'ask_1' },
					],
				},
			},
		],
	}
}

interface Harness {
	dependencies: StartupReconciliationDependencies
	resumed: RunCheckpoint[]
	writtenMetas: Map<string, RunMeta[]>
	checkpointReads: string[]
}

// All leaves are in-memory fakes keyed by run id: metas and checkpoints are raw file text (or absent), and writeMetaFor records per run.
function makeHarness(runs: Record<string, { metaText?: string | undefined; checkpointText?: string | undefined; format?: VersionStatus }>): Harness {
	const resumed: RunCheckpoint[] = []
	const writtenMetas = new Map<string, RunMeta[]>()
	const checkpointReads: string[] = []
	const listRunIds: ListRunIds = () => Object.keys(runs)
	const readRunMetaTextById: ReadRunMetaTextById = (runId) => runs[runId]?.metaText ?? null
	const readCheckpointById: ReadRunCheckpointById = (runId) => {
		checkpointReads.push(runId)
		return runs[runId]?.checkpointText ?? null
	}
	const readRunFormat = (runId: string): VersionStatus => runs[runId]?.format ?? 'current'
	const writeMetaFor = (runId: string): WriteMeta => {
		return (meta) => {
			const list = writtenMetas.get(runId) ?? []
			list.push(meta)
			writtenMetas.set(runId, list)
		}
	}
	const dependencies: StartupReconciliationDependencies = {
		listRunIds,
		readRunMetaTextById,
		readCheckpointById,
		readRunFormat,
		writeMetaFor,
		resume: (checkpoint) => {
			resumed.push(checkpoint)
		},
	}
	return { dependencies, resumed, writtenMetas, checkpointReads }
}

describe('reconcileRunsOnStartup', () => {
	test('a run with a terminal meta is left alone', () => {
		const harness = makeHarness({ 'run-1': { metaText: JSON.stringify(terminalMeta('run-1')) } })

		const report = reconcileRunsOnStartup(harness.dependencies)

		expect(report.resumedRunId).toBeUndefined()
		expect(report.interruptedRunIds).toEqual([])
		expect(harness.resumed).toEqual([])
		expect(harness.writtenMetas.size).toBe(0)
	})

	test('a run with a running meta and a valid checkpoint resumes from it', () => {
		const checkpoint = checkpointFor('run-1', '2026-01-01T00:00:00.000Z')
		const harness = makeHarness({
			'run-1': {
				metaText: JSON.stringify(runningMeta('run-1', '2026-01-01T00:00:00.000Z')),
				checkpointText: JSON.stringify(checkpoint),
			},
		})

		const report = reconcileRunsOnStartup(harness.dependencies)

		expect(report.resumedRunId).toBe('run-1')
		expect(report.interruptedRunIds).toEqual([])
		expect(harness.resumed).toEqual([checkpoint])
		expect(harness.writtenMetas.size).toBe(0)
	})

	test('a run with a running meta and no checkpoint is marked interrupted, preserving its meta fields', () => {
		const harness = makeHarness({
			'run-1': { metaText: JSON.stringify(runningMeta('run-1', '2026-01-01T00:00:00.000Z')) },
		})

		const report = reconcileRunsOnStartup(harness.dependencies)

		expect(report.resumedRunId).toBeUndefined()
		expect(report.interruptedRunIds).toEqual(['run-1'])
		const written = harness.writtenMetas.get('run-1')
		expect(written?.length).toBe(1)
		const meta = written?.[0]
		expect(meta?.status).toBe('interrupted')
		expect(meta?.task).toBe('task for run-1')
		expect(meta?.effort).toBe('standard')
		expect(meta?.involvement).toBe('early-engagement')
		expect(meta?.guildPath).toBe('guild')
		expect(meta?.startTime).toBe('2026-01-01T00:00:00.000Z')
		expect(meta?.endTime).toBeDefined()
		expect(meta?.error?.kind).toBe('interrupted')
	})

	test('a run with no meta and no checkpoint is marked interrupted, omitting the absent optional fields', () => {
		const harness = makeHarness({ 'run-1': {} })

		const report = reconcileRunsOnStartup(harness.dependencies)

		expect(report.interruptedRunIds).toEqual(['run-1'])
		const meta = harness.writtenMetas.get('run-1')?.[0]
		expect(meta?.status).toBe('interrupted')
		expect(meta?.task).toContain('unknown')
		expect(meta?.error?.kind).toBe('interrupted')
		expect('guildPath' in (meta ?? {})).toBe(false)
		expect('benchmarkPath' in (meta ?? {})).toBe(false)
	})

	test('a corrupt checkpoint reconciles to interrupted rather than resuming', () => {
		const harness = makeHarness({
			'run-1': {
				metaText: JSON.stringify(runningMeta('run-1', '2026-01-01T00:00:00.000Z')),
				checkpointText: '{"version":1,"runId":"run-1","frames":',
			},
		})

		const report = reconcileRunsOnStartup(harness.dependencies)

		expect(report.resumedRunId).toBeUndefined()
		expect(report.interruptedRunIds).toEqual(['run-1'])
		expect(harness.resumed).toEqual([])
	})

	test('a checkpoint naming a different run id is treated as corrupt', () => {
		const harness = makeHarness({
			'run-1': {
				metaText: JSON.stringify(runningMeta('run-1', '2026-01-01T00:00:00.000Z')),
				checkpointText: JSON.stringify(checkpointFor('run-other', '2026-01-01T00:00:00.000Z')),
			},
		})

		const report = reconcileRunsOnStartup(harness.dependencies)

		expect(report.resumedRunId).toBeUndefined()
		expect(report.interruptedRunIds).toEqual(['run-1'])
	})

	test('with several resumable runs, the most recent resumes and the rest are marked interrupted', () => {
		const older = checkpointFor('run-older', '2026-01-01T00:00:00.000Z')
		const newer = checkpointFor('run-newer', '2026-01-02T00:00:00.000Z')
		const harness = makeHarness({
			'run-older': {
				metaText: JSON.stringify(runningMeta('run-older', '2026-01-01T00:00:00.000Z')),
				checkpointText: JSON.stringify(older),
			},
			'run-newer': {
				metaText: JSON.stringify(runningMeta('run-newer', '2026-01-02T00:00:00.000Z')),
				checkpointText: JSON.stringify(newer),
			},
		})

		const report = reconcileRunsOnStartup(harness.dependencies)

		expect(report.resumedRunId).toBe('run-newer')
		expect(harness.resumed).toEqual([newer])
		expect(report.interruptedRunIds).toEqual(['run-older'])
		expect(harness.writtenMetas.get('run-older')?.[0]?.status).toBe('interrupted')
	})

	test('a parked checkpoint is not resumed: it is terminalized as needs_clarification with the park summary and left on disk', () => {
		const checkpoint = parkedCheckpointFor('run-1', '2026-01-01T00:00:00.000Z')
		const harness = makeHarness({
			'run-1': {
				metaText: JSON.stringify(runningMeta('run-1', '2026-01-01T00:00:00.000Z')),
				checkpointText: JSON.stringify(checkpoint),
			},
		})

		const report = reconcileRunsOnStartup(harness.dependencies)

		expect(report.resumedRunId).toBeUndefined()
		expect(report.parkedRunIds).toEqual(['run-1'])
		expect(report.interruptedRunIds).toEqual([])
		expect(harness.resumed).toEqual([])
		// The reconciliation has no delete dependency: the checkpoint is left exactly as it was for the queue answer.
		expect(harness.dependencies.readCheckpointById('run-1')).toBe(JSON.stringify(checkpoint))
		const written = harness.writtenMetas.get('run-1')?.[0]
		expect(written?.status).toBe('needs_clarification')
		expect(written?.result).toEqual({ status: 'needs_clarification', summary: 'waiting for an answer to: which database?' })
		expect(written?.task).toBe('task for run-1')
		expect(written?.effort).toBe('standard')
		expect(written?.involvement).toBe('early-engagement')
		expect(written?.guildPath).toBe('guild')
		expect(written?.startTime).toBe('2026-01-01T00:00:00.000Z')
		expect(written?.endTime).toBeDefined()
	})

	test('a parked checkpoint whose meta never landed takes its identity from the entry frame', () => {
		const checkpoint = parkedCheckpointFor('run-1', '2026-01-01T00:00:00.000Z')
		const harness = makeHarness({ 'run-1': { checkpointText: JSON.stringify(checkpoint) } })

		const report = reconcileRunsOnStartup(harness.dependencies)

		expect(report.parkedRunIds).toEqual(['run-1'])
		const written = harness.writtenMetas.get('run-1')?.[0]
		expect(written?.task).toBe('task for run-1')
		expect(written?.effort).toBe('standard')
		expect(written?.involvement).toBe('early-engagement')
		expect(written?.startTime).toBe('2026-01-01T00:00:00.000Z')
		expect('guildPath' in (written ?? {})).toBe(false)
	})

	test('a parked run does not block a resumable run: the resumable run still resumes', () => {
		const resumable = checkpointFor('run-resumable', '2026-01-01T00:00:00.000Z')
		const parked = parkedCheckpointFor('run-parked', '2026-01-02T00:00:00.000Z')
		const harness = makeHarness({
			'run-resumable': {
				metaText: JSON.stringify(runningMeta('run-resumable', '2026-01-01T00:00:00.000Z')),
				checkpointText: JSON.stringify(resumable),
			},
			'run-parked': {
				metaText: JSON.stringify(runningMeta('run-parked', '2026-01-02T00:00:00.000Z')),
				checkpointText: JSON.stringify(parked),
			},
		})

		const report = reconcileRunsOnStartup(harness.dependencies)

		expect(report.resumedRunId).toBe('run-resumable')
		expect(harness.resumed).toEqual([resumable])
		expect(report.parkedRunIds).toEqual(['run-parked'])
		expect(report.interruptedRunIds).toEqual([])
	})

	test('an unsupported run manifest marks a non-terminal run interrupted without parsing its checkpoint', () => {
		const cases: Array<{ format: VersionStatus; message: string }> = [
			{ format: 'missing', message: 'run manifest is missing' },
			{ format: 'old', message: 'run manifest is older than this build supports' },
			{ format: 'newer', message: 'run manifest is newer than this build supports' },
			{ format: 'malformed', message: 'run manifest is malformed' },
		]
		for (const testCase of cases) {
			const harness = makeHarness({
				'run-1': {
					metaText: JSON.stringify(runningMeta('run-1', '2026-01-01T00:00:00.000Z')),
					checkpointText: '{"version":2,"runId":"run-1","frames":',
					format: testCase.format,
				},
			})

			const report = reconcileRunsOnStartup(harness.dependencies)

			expect(report.interruptedRunIds).toEqual(['run-1'])
			expect(report.resumedRunId).toBeUndefined()
			expect(harness.resumed).toEqual([])
			expect(harness.checkpointReads).toEqual([])
			const meta = harness.writtenMetas.get('run-1')?.[0]
			expect(meta?.status).toBe('interrupted')
			expect(meta?.error?.message).toContain(testCase.message)
		}
	})

	test('an unsupported manifest preserves every existing meta field when terminalizing and never parses the checkpoint', () => {
		const existingMeta = {
			...runningMeta('run-1', '2026-01-01T00:00:00.000Z'),
			logLevel: 'standard' as const,
			continuesFrom: 'run-20251231-000000',
		}
		const harness = makeHarness({
			'run-1': {
				metaText: JSON.stringify(existingMeta),
				// Corrupt on purpose: an unsupported run must be classified before the checkpoint is parsed.
				checkpointText: '{"version":2,"runId":"run-1","frames":',
				format: 'old',
			},
		})

		const report = reconcileRunsOnStartup(harness.dependencies)

		expect(report.interruptedRunIds).toEqual(['run-1'])
		expect(report.resumedRunId).toBeUndefined()
		expect(harness.resumed).toEqual([])
		const written = harness.writtenMetas.get('run-1')?.[0]
		expect(written).toMatchObject({
			runId: 'run-1',
			guildPath: existingMeta.guildPath,
			benchmarkPath: existingMeta.benchmarkPath,
			task: existingMeta.task,
			effort: existingMeta.effort,
			involvement: existingMeta.involvement,
			logLevel: existingMeta.logLevel,
			continuesFrom: existingMeta.continuesFrom,
			status: 'interrupted',
			startTime: existingMeta.startTime,
		})
		expect(written?.error?.kind).toBe('interrupted')
	})

	test('a current manifest still resumes a run with a valid checkpoint', () => {
		const checkpoint = checkpointFor('run-1', '2026-01-01T00:00:00.000Z')
		const harness = makeHarness({
			'run-1': {
				metaText: JSON.stringify(runningMeta('run-1', '2026-01-01T00:00:00.000Z')),
				checkpointText: JSON.stringify(checkpoint),
				format: 'current',
			},
		})

		const report = reconcileRunsOnStartup(harness.dependencies)

		expect(report.resumedRunId).toBe('run-1')
		expect(harness.resumed).toEqual([checkpoint])
		expect(harness.checkpointReads).toEqual(['run-1'])
	})
})
