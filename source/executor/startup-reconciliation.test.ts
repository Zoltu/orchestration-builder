import { describe, expect, test } from 'bun:test'

import type { RunCheckpoint } from './checkpoint.ts'
import type { ListRunIds, ReadRunCheckpointById, ReadRunMetaById, WriteMeta } from './persistence.ts'
import { reconcileRunsOnStartup, type StartupReconciliationDependencies } from './startup-reconciliation.ts'
import type { RunMeta } from './types.ts'

function runningMeta(runId: string, startTime: string): RunMeta {
	return {
		runId,
		guildPath: 'guild',
		benchmarkPath: 'bench',
		task: `task for ${runId}`,
		effort: 3,
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
		version: 1,
		runId,
		startTime,
		registryCounter: 1,
		frames: [
			{
				roleId: 'main-0-1',
				roleName: 'main',
				depth: 0,
				task: `task for ${runId}`,
				effort: 3,
				roleState: {
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

interface Harness {
	dependencies: StartupReconciliationDependencies
	resumed: RunCheckpoint[]
	writtenMetas: Map<string, RunMeta[]>
}

// All leaves are in-memory fakes keyed by run id: metas and checkpoints are raw file text (or absent), and writeMetaFor records per run.
function makeHarness(runs: Record<string, { metaText?: string | undefined; checkpointText?: string | undefined }>): Harness {
	const resumed: RunCheckpoint[] = []
	const writtenMetas = new Map<string, RunMeta[]>()
	const listRunIds: ListRunIds = () => Object.keys(runs)
	const readRunMetaById: ReadRunMetaById = (runId) => runs[runId]?.metaText ?? null
	const readCheckpointById: ReadRunCheckpointById = (runId) => runs[runId]?.checkpointText ?? null
	const writeMetaFor = (runId: string): WriteMeta => {
		return (meta) => {
			const list = writtenMetas.get(runId) ?? []
			list.push(meta)
			writtenMetas.set(runId, list)
		}
	}
	const dependencies: StartupReconciliationDependencies = {
		listRunIds,
		readRunMetaById,
		readCheckpointById,
		writeMetaFor,
		resume: (checkpoint) => {
			resumed.push(checkpoint)
		},
	}
	return { dependencies, resumed, writtenMetas }
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
		expect(meta?.effort).toBe(3)
		expect(meta?.guildPath).toBe('guild')
		expect(meta?.startTime).toBe('2026-01-01T00:00:00.000Z')
		expect(meta?.endTime).toBeDefined()
		expect(meta?.error?.kind).toBe('interrupted')
	})

	test('a run with no meta and no checkpoint is marked interrupted with placeholder fields', () => {
		const harness = makeHarness({ 'run-1': {} })

		const report = reconcileRunsOnStartup(harness.dependencies)

		expect(report.interruptedRunIds).toEqual(['run-1'])
		const meta = harness.writtenMetas.get('run-1')?.[0]
		expect(meta?.status).toBe('interrupted')
		expect(meta?.task).toContain('unknown')
		expect(meta?.error?.kind).toBe('interrupted')
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
})
