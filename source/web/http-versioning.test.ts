import { describe, expect, test } from 'bun:test'
import type { ListRunIds, ProjectSettings, ReadProjectSettings, ReadRunMetaById, ReadRunPlanById, ReadRunSnapshotStats, ReadRunSummaryById, ReadRunSummaryStats, RunCheckpointExists, WriteProjectSettings } from '../executor/persistence.ts'
import type { RunState } from '../executor/run-state.ts'
import type { ResumeErroredRun, RunSubmission } from '../executor/run-submission.ts'
import { createTaskQueue } from '../executor/queue/index.ts'
import type { DeploymentConfig, GuildConfig, RunMeta } from '../executor/types.ts'
import { applyFlowFrame, createFlowFeedResponder, emptyFlowFeedState, flowFeedRevision } from './static/ts/flow-feed/index.js'
import type { FlowFeedResponderOptions } from './static/ts/flow-feed/index.js'
import type { InteractionModel } from './static/ts/interaction-model.js'
import { applyRunListFrame, createRunListFeedResponder, emptyRunListFeedState, runListFeedRevision } from './static/ts/run-list-feed/index.js'
import type { RunSummary } from './static/ts/run-list-feed/index.js'
import { createRequestHandler, type RequestHandler } from './request-handler.ts'
import { createRunListCache } from './run-list-cache.ts'
import { parseLogEvents, parseRunMeta } from '../run-log/index.js'
import type { ReadRunSnapshot } from './snapshot-cache.ts'

function flowModelFromFrame(frame: unknown): InteractionModel {
	const result = applyFlowFrame(emptyFlowFeedState(), frame)
	if (result.model === null) throw new Error(`expected a flow frame with a model, received ${result.outcome}`)
	return result.model
}

function runSummariesFromFrame(frame: unknown): RunSummary[] {
	const result = applyRunListFrame(emptyRunListFeedState(), frame)
	if (result.summaries === null) throw new Error(`expected a run-list frame with summaries, received ${result.outcome}`)
	return result.summaries
}

// A local, mutable stand-in for the on-disk run store: each test owns its own map, so nothing here touches the filesystem or shared module state.
interface StoredRun {
	metaText: string | null
	logText: string
	plan: string | null
	checkpointExists: boolean
	summaryText: string | null
	metaMtimeMs: number
	logMtimeMs: number
	summaryMtimeMs: number
}

function storedRun(runId: string, status: RunMeta['status'] = 'success'): StoredRun {
	return {
		metaText: JSON.stringify({ runId, guildPath: 'guild', benchmarkPath: 'bench', task: `task for ${runId}`, status, startTime: '2026-01-01T00:00:00.000Z', endTime: '2026-01-01T00:01:00.000Z' }),
		logText: JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', type: 'llm_call', payload: { role: 'planner' } }),
		plan: null,
		checkpointExists: false,
		summaryText: null,
		metaMtimeMs: 1,
		logMtimeMs: 1,
		summaryMtimeMs: 1,
	}
}

// A log whose two role_start events produce two operations (op-1 and op-2) with text details, so the flow endpoint has a base model and two distinct operation details to address.
function flowLogText(): string {
	return [
		JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', type: 'role_start', payload: { role: 'planner', task: 'plan the work' } }),
		JSON.stringify({ timestamp: '2026-01-01T00:00:02.000Z', type: 'role_start', payload: { role: 'worker', task: 'do the work' } }),
	].join('\n')
}

const sampleGuildConfig: GuildConfig = {
	entryRole: 'orchestrator',
	roles: { orchestrator: { systemPrompt: 'prompts/orchestrator.md', tools: ['finish'] } },
	tools: ['tools/finish.json'],
}

const sampleDeployment: DeploymentConfig = {
	model: { name: 'qwen3.6:35b', apiBase: 'http://llama-server:8080/v1', contextWindow: 262144, generation: {} },
	executor: { maxAgentDepth: 8, defaultToolTimeoutSeconds: 30, maxCompactionAttempts: 5 },
	contextPolicy: { maxToolOutputChars: 8000 },
}

interface VersioningHarness {
	handler: RequestHandler
	runs: Map<string, StoredRun>
	setActiveRunId: (runId: string | undefined) => void
	setInterruptPending: (pending: boolean) => void
}

function createVersioningHarness(initialRuns: Array<[string, StoredRun]>, flowFeedOptions: FlowFeedResponderOptions = { epoch: 'versioning-epoch', historyLimit: 64, maxRuns: 8 }): VersioningHarness {
	const runs = new Map(initialRuns)
	let activeRunId: string | undefined
	let interruptPending = false

	const readRunSnapshotStats: ReadRunSnapshotStats = (runId) => {
		const run = runs.get(runId)
		if (run === undefined) return { meta: null, log: null }
		return {
			meta: run.metaText === null ? null : { size: run.metaText.length, mtimeMs: run.metaMtimeMs },
			log: run.logText === '' ? null : { size: run.logText.length, mtimeMs: run.logMtimeMs },
		}
	}
	const readRunMetaById: ReadRunMetaById = (runId) => runs.get(runId)?.metaText ?? null
	const readRunSummaryById: ReadRunSummaryById = (runId) => runs.get(runId)?.summaryText ?? null
	const readRunSnapshot: ReadRunSnapshot = (runId) => ({ meta: parseRunMeta(readRunMetaById(runId)), logEvents: parseLogEvents(runs.get(runId)?.logText ?? '') })
	const readRunPlanById: ReadRunPlanById = (runId) => runs.get(runId)?.plan ?? null
	const runCheckpointExists: RunCheckpointExists = (runId) => runs.get(runId)?.checkpointExists ?? false
	const listRunIds: ListRunIds = () => Array.from(runs.keys())
	const readRunSummaryStats: ReadRunSummaryStats = (runId) => {
		const run = runs.get(runId)
		if (run === undefined) return { meta: null, summary: null }
		return {
			meta: run.metaText === null ? null : { size: run.metaText.length, mtimeMs: run.metaMtimeMs },
			summary: run.summaryText === null ? null : { size: run.summaryText.length, mtimeMs: run.summaryMtimeMs },
		}
	}
	const readRunListSummary = createRunListCache({ readRunSummaryStats, readRunMetaById, readRunSummaryById }, 64)

	const runState: RunState = {
		pendingQuestions: () => [],
		submitAnswer: () => ({ kind: 'not_found' }),
		submitInterrupt: () => 'no_active_run',
		interruptPending: () => interruptPending,
	}
	const runSubmission: RunSubmission = {
		submit: () => ({ ok: false, error: 'run_in_progress' }),
		resume: () => {},
		activeRunId: () => activeRunId,
		lastRunId: () => undefined,
		awaitActive: async () => undefined,
		awaitFatalError: () => new Promise<Error>(() => {}),
	}

	let settings: ProjectSettings = {}
	const readProjectSettings: ReadProjectSettings = () => settings
	const writeProjectSettings: WriteProjectSettings = (next) => {
		settings = next
	}
	const taskQueue = createTaskQueue({
		queueStore: { read: () => null, write: () => {} },
		readRunMetaById: readRunMetaById,
		listRunIds,
		readRunListSummary,
		submitRun: () => ({ ok: false, error: 'run_in_progress' }),
		hasActiveRun: () => activeRunId !== undefined,
		sleep: async () => {},
		now: () => '2026-01-01T00:00:00.000Z',
	})
	const resumeErroredRun: ResumeErroredRun = () => ({ ok: false, error: 'run_not_found' })
	const flowFeedResponder = createFlowFeedResponder(flowFeedOptions)
	const runListFeedResponder = createRunListFeedResponder({ epoch: 'versioning-epoch', historyLimit: 64 })

	const handler = createRequestHandler(
		{
			guildConfig: sampleGuildConfig,
			deployment: sampleDeployment,
			tools: {},
			runState,
			runSubmission,
			readRunSnapshot,
			readRunMetaById,
			readRunListSummary,
			readRunPlanById,
			readRunSnapshotStats,
			listRunIds,
			readProjectSettings,
			writeProjectSettings,
			taskQueue,
			resumeErroredRun,
			runCheckpointExists,
			build: null,
			flowFeedResponder,
			runListFeedResponder,
		},
		async () => new Response('static body'),
	)

	return {
		handler,
		runs,
		setActiveRunId: (runId) => {
			activeRunId = runId
		},
		setInterruptPending: (pending) => {
			interruptPending = pending
		},
	}
}

function get(path: string, ifNoneMatch?: string): Request {
	return new Request(`http://handler.test${path}`, ifNoneMatch === undefined ? {} : { headers: { 'if-none-match': ifNoneMatch } })
}

function requireEtag(response: Response): string {
	const etag = response.headers.get('etag')
	if (etag === null) throw new Error('response carried no ETag')
	return etag
}

function storedRunOrThrow(runs: Map<string, StoredRun>, runId: string): StoredRun {
	const run = runs.get(runId)
	if (run === undefined) throw new Error(`missing fixture run ${runId}`)
	return run
}

describe('run-view conditional requests', () => {
	test('an unconditional poll returns 200 with an ETag and no-store', async () => {
		const { handler } = createVersioningHarness([['run-1', storedRun('run-1')]])
		const response = await handler(get('/api/runs/run-1'))
		expect(response.status).toBe(200)
		expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/)
		expect(response.headers.get('cache-control')).toBe('no-store')
		expect((await response.json()).runId).toBe('run-1')
	})

	test('a poll echoing the current ETag returns 304 with no body', async () => {
		const { handler } = createVersioningHarness([['run-1', storedRun('run-1')]])
		const etag = requireEtag(await handler(get('/api/runs/run-1')))
		const response = await handler(get('/api/runs/run-1', etag))
		expect(response.status).toBe(304)
		expect(await response.text()).toBe('')
		expect(response.headers.get('etag')).toBe(etag)
	})

	test('tolerates the weak prefix and unquoted forms of the echoed validator', async () => {
		const { handler } = createVersioningHarness([['run-1', storedRun('run-1')]])
		const etag = requireEtag(await handler(get('/api/runs/run-1')))
		expect((await handler(get('/api/runs/run-1', `W/${etag}`))).status).toBe(304)
		expect((await handler(get('/api/runs/run-1', etag.slice(1, -1)))).status).toBe(304)
	})

	test('an unknown run is a plain 404 with no ETag', async () => {
		const { handler } = createVersioningHarness([])
		const response = await handler(get('/api/runs/missing'))
		expect(response.status).toBe(404)
		expect(response.headers.get('etag')).toBeNull()
		expect(await response.json()).toEqual({ ok: false, error: 'not_found' })
	})
})

describe('run-view version changes', () => {
	test('appending to the log changes the ETag and returns a fresh 200', async () => {
		const { handler, runs } = createVersioningHarness([['run-1', storedRun('run-1')]])
		const etag = requireEtag(await handler(get('/api/runs/run-1')))
		storedRunOrThrow(runs, 'run-1').logText += `\n${JSON.stringify({ timestamp: '2026-01-01T00:00:02.000Z', type: 'role_finished', payload: { role: 'planner', status: 'success' } })}`
		const response = await handler(get('/api/runs/run-1', etag))
		expect(response.status).toBe(200)
		expect(response.headers.get('etag')).not.toBe(etag)
	})

	test('changing the plan changes the ETag', async () => {
		const { handler, runs } = createVersioningHarness([['run-1', storedRun('run-1')]])
		const etag = requireEtag(await handler(get('/api/runs/run-1')))
		storedRunOrThrow(runs, 'run-1').plan = '# Plan\n\n1. do the work'
		const response = await handler(get('/api/runs/run-1', etag))
		expect(response.status).toBe(200)
		expect(response.headers.get('etag')).not.toBe(etag)
		expect((await response.json()).plan).toBe('# Plan\n\n1. do the work')
	})

	test('flipping interruptPending on the active run changes the ETag and the payload', async () => {
		const { handler, setActiveRunId, setInterruptPending } = createVersioningHarness([['run-1', storedRun('run-1')]])
		setActiveRunId('run-1')
		const first = await handler(get('/api/runs/run-1'))
		const etag = requireEtag(first)
		expect((await first.json()).interruptPending).toBe(false)
		setInterruptPending(true)
		const second = await handler(get('/api/runs/run-1', etag))
		expect(second.status).toBe(200)
		expect(second.headers.get('etag')).not.toBe(etag)
		expect((await second.json()).interruptPending).toBe(true)
	})

	test('a non-active run reports interruptPending false even when an interrupt is pending', async () => {
		const { handler, setActiveRunId, setInterruptPending } = createVersioningHarness([['run-1', storedRun('run-1')]])
		setActiveRunId('some-other-run')
		setInterruptPending(true)
		expect((await (await handler(get('/api/runs/run-1'))).json()).interruptPending).toBe(false)
	})

	test('two runs never share a version token', async () => {
		const { handler } = createVersioningHarness([['run-1', storedRun('run-1')], ['run-2', storedRun('run-2')]])
		const firstEtag = requireEtag(await handler(get('/api/runs/run-1')))
		const secondEtag = requireEtag(await handler(get('/api/runs/run-2')))
		expect(firstEtag).not.toBe(secondEtag)
		expect((await handler(get('/api/runs/run-2', firstEtag))).status).toBe(200)
	})

	test('a meta-only status change yields a new ETag and a fresh 200', async () => {
		const { handler, runs } = createVersioningHarness([['run-1', storedRun('run-1', 'success')]])
		const etag = requireEtag(await handler(get('/api/runs/run-1')))
		const run = storedRunOrThrow(runs, 'run-1')
		run.metaText = JSON.stringify({ runId: 'run-1', guildPath: 'guild', benchmarkPath: 'bench', task: 'task for run-1', status: 'error', startTime: '2026-01-01T00:00:00.000Z', endTime: '2026-01-01T00:01:00.000Z' })
		run.metaMtimeMs = 2
		const response = await handler(get('/api/runs/run-1', etag))
		expect(response.status).toBe(200)
		expect(response.headers.get('etag')).not.toBe(etag)
		expect((await response.json()).status).toBe('error')
	})

	test('toggling checkpointExists yields a new ETag and a fresh 200', async () => {
		const { handler, runs } = createVersioningHarness([['run-1', storedRun('run-1', 'error')]])
		const etag = requireEtag(await handler(get('/api/runs/run-1')))
		storedRunOrThrow(runs, 'run-1').checkpointExists = true
		const response = await handler(get('/api/runs/run-1', etag))
		expect(response.status).toBe(200)
		expect(response.headers.get('etag')).not.toBe(etag)
		expect((await response.json()).resumable).toBe(true)
	})
})

describe('flow-model envelope and run-list conditional requests', () => {
	test('the base flow route returns a snapshot, then unchanged, then a delta whose application reconstructs the model', async () => {
		const { handler, runs } = createVersioningHarness([['run-1', storedRun('run-1')]])
		storedRunOrThrow(runs, 'run-1').logText = flowLogText()
		const first = await handler(get('/api/runs/run-1/flow'))
		expect(first.status).toBe(200)
		expect(first.headers.get('etag')).toBeNull()
		const snapshot = await first.json()
		expect(snapshot.kind).toBe('snapshot')
		expect(typeof snapshot.version).toBe('string')
		expect(typeof snapshot.contentHash).toBe('string')
		const snapshotResult = applyFlowFrame(emptyFlowFeedState(), snapshot)
		expect(snapshotResult.outcome).toBe('snapshot')
		if (snapshotResult.model === null) throw new Error('expected the snapshot to produce a model')
		expect(snapshotResult.model.operations.length).toBe(2)
		const revision = flowFeedRevision(snapshotResult.state)
		if (revision === null) throw new Error('expected the snapshot to produce a revision')

		const unchanged = await handler(get(`/api/runs/run-1/flow?have=${encodeURIComponent(revision)}`))
		expect(await unchanged.json()).toEqual({ kind: 'unchanged', version: revision })

		storedRunOrThrow(runs, 'run-1').logText += `\n${JSON.stringify({ timestamp: '2026-01-01T00:00:03.000Z', type: 'role_finished', payload: { role: 'worker', status: 'success' } })}`
		const changed = await handler(get(`/api/runs/run-1/flow?have=${encodeURIComponent(revision)}`))
		const delta = await changed.json()
		expect(delta.kind).toBe('delta')
		expect(delta.base).toBe(revision)
		expect(delta.next).not.toBe(revision)

		const applied = applyFlowFrame(snapshotResult.state, delta)
		expect(applied.outcome).toBe('applied')
		if (applied.model === null) throw new Error('expected the delta to produce a model')
		const reconstructed = applied.model

		const fresh = await (await handler(get('/api/runs/run-1/flow'))).json()
		expect(fresh.kind).toBe('snapshot')
		expect(flowModelFromFrame(fresh)).toEqual(reconstructed)
	})

	test('an unknown or evicted have returns a snapshot', async () => {
		const { handler } = createVersioningHarness([['run-1', storedRun('run-1')], ['run-2', storedRun('run-2')]], { epoch: 'evict-epoch', historyLimit: 64, maxRuns: 1 })
		const first = await (await handler(get('/api/runs/run-1/flow'))).json()
		expect(first.kind).toBe('snapshot')
		// Requesting run-2 evicts run-1's replica; re-requesting run-1 with the pre-eviction revision falls back to a snapshot.
		expect((await (await handler(get('/api/runs/run-2/flow'))).json()).kind).toBe('snapshot')
		const reRequested = await (await handler(get(`/api/runs/run-1/flow?have=${encodeURIComponent(first.version)}`))).json()
		expect(reRequested.kind).toBe('snapshot')

		const unknown = await (await handler(get('/api/runs/run-1/flow?have=not-a-revision'))).json()
		expect(unknown.kind).toBe('snapshot')
	})

	test("a run switch never cross-contaminates: run-2 does not accept run-1's revision", async () => {
		const { handler } = createVersioningHarness([['run-1', storedRun('run-1')], ['run-2', storedRun('run-2')]])
		const first = await (await handler(get('/api/runs/run-1/flow'))).json()
		const other = await (await handler(get(`/api/runs/run-2/flow?have=${encodeURIComponent(first.version)}`))).json()
		expect(other.kind).toBe('snapshot')
	})

	test('?operation= keeps its own ETag validator, distinct per operation', async () => {
		const { handler, runs } = createVersioningHarness([['run-1', storedRun('run-1')]])
		storedRunOrThrow(runs, 'run-1').logText = flowLogText()
		const first = await handler(get('/api/runs/run-1/flow?operation=op-1'))
		expect(first.status).toBe(200)
		const detailEtag = requireEtag(first)
		expect((await first.json()).operationId).toBe('op-1')
		expect((await handler(get('/api/runs/run-1/flow?operation=op-1', detailEtag))).status).toBe(304)
		// The base route is unconditional now, so replaying the detail validator there is a fresh 200 envelope, not a 304.
		const base = await handler(get('/api/runs/run-1/flow', detailEtag))
		expect(base.status).toBe(200)
		expect((await base.json()).kind).toBe('snapshot')
		const secondEtag = requireEtag(await handler(get('/api/runs/run-1/flow?operation=op-2')))
		expect(secondEtag).not.toBe(detailEtag)
	})

	test('?operation= still returns 404 for a nonexistent operation', async () => {
		const { handler, runs } = createVersioningHarness([['run-1', storedRun('run-1')]])
		storedRunOrThrow(runs, 'run-1').logText = flowLogText()
		const response = await handler(get('/api/runs/run-1/flow?operation=ghost'))
		expect(response.status).toBe(404)
	})

	test('the run list returns a snapshot, then unchanged, then a delta whose application reconstructs the list', async () => {
		const { handler, runs } = createVersioningHarness([['run-1', storedRun('run-1')]])
		const first = await handler(get('/api/runs'))
		expect(first.status).toBe(200)
		expect(first.headers.get('etag')).toBeNull()
		expect(first.headers.get('cache-control')).toBe('no-store')
		const snapshot = await first.json()
		expect(snapshot.kind).toBe('snapshot')
		expect(typeof snapshot.version).toBe('string')
		expect(typeof snapshot.contentHash).toBe('string')
		const snapshotResult = applyRunListFrame(emptyRunListFeedState(), snapshot)
		expect(snapshotResult.outcome).toBe('snapshot')
		if (snapshotResult.summaries === null) throw new Error('expected the snapshot to produce summaries')
		expect(snapshotResult.summaries.map((summary) => summary.runId)).toEqual(['run-1'])
		const revision = runListFeedRevision(snapshotResult.state)
		if (revision === null) throw new Error('expected the snapshot to produce a revision')

		const unchanged = await handler(get(`/api/runs?have=${encodeURIComponent(revision)}`))
		expect(await unchanged.json()).toEqual({ kind: 'unchanged', version: revision })

		const run = storedRunOrThrow(runs, 'run-1')
		run.summaryText = 'a generated summary'
		run.summaryMtimeMs = 2
		const changed = await handler(get(`/api/runs?have=${encodeURIComponent(revision)}`))
		const delta = await changed.json()
		expect(delta.kind).toBe('delta')
		expect(delta.base).toBe(revision)
		expect(delta.next).not.toBe(revision)

		const applied = applyRunListFrame(snapshotResult.state, delta)
		expect(applied.outcome).toBe('applied')
		if (applied.summaries === null) throw new Error('expected the delta to produce summaries')
		const reconstructed = applied.summaries
		expect(reconstructed[0]?.summary).toBe('a generated summary')

		const fresh = await (await handler(get('/api/runs'))).json()
		expect(fresh.kind).toBe('snapshot')
		expect(runSummariesFromFrame(fresh)).toEqual(reconstructed)
	})

	test('adding a run yields a delta that carries the new run newest-first', async () => {
		const { handler, runs } = createVersioningHarness([['run-1', storedRun('run-1')]])
		const snapshot = await (await handler(get('/api/runs'))).json()
		const snapshotResult = applyRunListFrame(emptyRunListFeedState(), snapshot)
		const revision = runListFeedRevision(snapshotResult.state)
		if (revision === null) throw new Error('expected the snapshot to produce a revision')
		runs.set('run-2', storedRun('run-2'))
		const delta = await (await handler(get(`/api/runs?have=${encodeURIComponent(revision)}`))).json()
		expect(delta.kind).toBe('delta')
		const applied = applyRunListFrame(snapshotResult.state, delta)
		expect(applied.outcome).toBe('applied')
		if (applied.summaries === null) throw new Error('expected the delta to produce summaries')
		expect(applied.summaries.map((summary) => summary.runId)).toEqual(['run-2', 'run-1'])
	})

	test('an unknown have returns a snapshot', async () => {
		const { handler } = createVersioningHarness([['run-1', storedRun('run-1')]])
		const unknown = await (await handler(get('/api/runs?have=not-a-revision'))).json()
		expect(unknown.kind).toBe('snapshot')
	})
})
