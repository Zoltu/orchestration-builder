import { describe, expect, test } from 'bun:test'
import { createWebHumanBackend, type WebHumanBackend } from '../executor/human-backend.ts'
import { createInterruptChannel, createInterruptQueue, type InterruptChannel } from '../executor/interrupts.ts'
import { createRunState } from '../executor/run-state.ts'
import { createRunSubmission, type ResumeRun, type RunSubmission, type StartRun } from '../executor/run-submission.ts'
import type { RunCheckpoint } from '../executor/checkpoint.ts'
import type { ProjectSettings, ReadProjectSettings, WriteProjectSettings, RunSnapshotRaw, RunSnapshotStats, RunSummaryStats } from '../executor/persistence.ts'
import type { DeploymentConfig, EffortLevel, GuildConfig, LogLevel, RunContinuation, RunMeta } from '../executor/types.js'
import { parseRunSnapshot, type RunSnapshot } from './render.ts'
import type { BuildInfo } from './build-info.ts'
import { createRunListCache } from './run-list-cache.ts'
import { createRequestHandler, type RequestHandler } from './request-handler.ts'
import { createServeStatic, resolveStaticAsset, type ServeAssetFile } from './server.ts'

// The settlement hook the server tests never observe.
const settleNothing = async (): Promise<void> => {}

function snapshotFor(runId: string, status: RunMeta['status'] = 'success', overrides: Partial<RunMeta> = {}): RunSnapshotRaw {
	return {
		metaText: JSON.stringify({
			runId,
			guildPath: 'guild',
			benchmarkPath: 'bench',
			task: `task for ${runId}`,
			status,
			startTime: '2026-01-01T00:00:00.000Z',
			endTime: '2026-01-01T00:01:00.000Z',
			...overrides,
		}),
		logText: [
			JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', type: 'llm_call', payload: { role: 'planner', usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } } }),
			JSON.stringify({ timestamp: '2026-01-01T00:00:02.000Z', type: 'role_finished', payload: { role: 'planner', status: 'success' } }),
		].join('\n'),
	}
}

const snapshots = new Map<string, RunSnapshotRaw>([
	['run-1', snapshotFor('run-1')],
	['run-2', snapshotFor('run-2', 'error', {
		result: { status: 'error', summary: 'failed', artifacts: ['output.txt', 'logs/run.txt'] },
		error: { kind: 'llm_unavailable', message: 'connection refused' },
	})],
	['run-3', {
		metaText: JSON.stringify({
			runId: 'run-3',
			guildPath: 'guild',
			benchmarkPath: 'bench',
			task: 'task for run-3',
			status: 'needs_clarification',
			startTime: '2026-01-01T00:00:00.000Z',
			endTime: '2026-01-01T00:01:00.000Z',
		}),
		logText: [
			JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', type: 'llm_call', payload: { role: 'planner' } }),
			JSON.stringify({ timestamp: '2026-01-01T00:00:02.000Z', type: 'ask_human', payload: { id: 'q1', question: 'Which framework?', context: 'src/index.ts' } }),
			JSON.stringify({ timestamp: '2026-01-01T00:00:30.000Z', type: 'human_answer', payload: { id: 'q1', answer: 'react' } }),
			JSON.stringify({ timestamp: '2026-01-01T00:00:31.000Z', type: 'ask_human', payload: { id: 'q2', question: 'Still unsure?' } }),
		].join('\n'),
	}],
	// A run startup reconciliation could not resume: terminal 'interrupted' meta with the reconciliation's error record.
	['run-interrupted', {
		metaText: JSON.stringify({
			runId: 'run-interrupted',
			guildPath: 'guild',
			benchmarkPath: 'bench',
			task: 'task for run-interrupted',
			status: 'interrupted',
			startTime: '2026-01-01T00:00:00.000Z',
			endTime: '2026-01-01T00:02:00.000Z',
			error: { kind: 'interrupted', message: 'The service stopped while this run was in progress and it could not be resumed (no valid checkpoint).' },
		}),
		logText: [
			JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', type: 'role_start', payload: { role: 'planner', roleId: 'planner-0-1', depth: 0, task: 'task for run-interrupted' } }),
			JSON.stringify({ timestamp: '2026-01-01T00:00:02.000Z', type: 'llm_call', payload: { role: 'planner', usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 } } }),
		].join('\n'),
	}],
	// A run still marked running, so the continuation API can exercise the "prior run must be terminal" rejection.
	['run-active', snapshotFor('run-active', 'running')],
])

// A terminal prior run with a shape-valid run id and a result summary, so the continuation API's happy path can resolve a real briefing from its meta.
snapshots.set('run-20260101-000000', {
	metaText: JSON.stringify({
		runId: 'run-20260101-000000',
		guildPath: 'guild',
		benchmarkPath: 'bench',
		task: 'prior run task',
		status: 'success',
		startTime: '2026-01-01T00:00:00.000Z',
		endTime: '2026-01-01T00:01:00.000Z',
		result: { status: 'success', summary: 'prior run finished cleanly' },
	}),
	logText: '',
})

// 'run-19990101-000000' is run-id shaped but has no run directory, so the continuation validation's known-run check is exercisable (the default fabrication would otherwise invent a meta for any id).
const unknownRunIds = new Set(['never-started', 'run-19990101-000000'])

const sampleGuildConfig: GuildConfig = {
	entryRole: 'orchestrator',
	roles: {
		orchestrator: { systemPrompt: 'prompts/orchestrator.md', tools: ['agent', 'ask_human', 'finish'] },
		coder: { systemPrompt: 'prompts/coder.md', tools: ['read_file', 'write_file', 'finish'] },
	},
	tools: ['tools/agent.json', 'tools/finish.json'],
}

const sampleDeployment: DeploymentConfig = {
	model: {
		name: 'qwen3.6:35b',
		apiBase: 'http://llama-server:8080/v1',
		contextWindow: 262144,
		generation: { temperature: 0.2, maxTokens: 32768 },
	},
	executor: {
		maxAgentDepth: 8,
		defaultToolTimeoutSeconds: 30,
		maxCompactionAttempts: 5,
	},
	contextPolicy: { maxToolOutputChars: 8000 },
}

function rawSnapshotById(runId: string): RunSnapshotRaw {
	if (unknownRunIds.has(runId)) return { metaText: null, logText: '' }
	return snapshots.get(runId) ?? snapshotFor(runId)
}

function readRunSnapshot(runId: string): RunSnapshot {
	return parseRunSnapshot(rawSnapshotById(runId))
}

function readRunMetaById(runId: string): string | null {
	return rawSnapshotById(runId).metaText
}

// No fixture run carries a generated summary; a real read would miss the file and return null, so the harness reads null for every run.
function readRunSummaryById(_runId: string): string | null {
	return null
}

// In-memory plan documents keyed by run id: run-1 carries a plan so the run view's plan surfacing is exercised end to end, and every other run reads null (no plan document written).
const plans = new Map<string, string>([
	['run-1', '# Plan\n\n1. read the code\n2. fix the bug'],
])

function readRunPlanById(runId: string): string | null {
	return plans.get(runId) ?? null
}

function readRunSnapshotStats(runId: string): RunSnapshotStats {
	const raw = rawSnapshotById(runId)
	return {
		meta: raw.metaText === null ? null : { size: raw.metaText.length, mtimeMs: 1 },
		log: raw.logText === '' ? null : { size: raw.logText.length, mtimeMs: 1 },
	}
}

// No fixture run carries a generated summary; the run-list cache's freshness key sees a permanently absent summary.txt, which the summary reader below mirrors.
function readRunSummaryStats(runId: string): RunSummaryStats {
	const raw = rawSnapshotById(runId)
	return {
		meta: raw.metaText === null ? null : { size: raw.metaText.length, mtimeMs: 1 },
		summary: null,
	}
}

// Composed over the fixture readers the same way serve.ts composes it over the real ones.
const readRunListSummary = createRunListCache({ readRunSummaryStats, readRunMetaById, readRunSummaryById }, 64)

function listRunIds(): string[] {
	return Array.from(snapshots.keys())
}

interface InMemorySettings {
	read: ReadProjectSettings
	write: WriteProjectSettings
	snapshot: () => ProjectSettings
}

function createInMemorySettings(initial: ProjectSettings = {}): InMemorySettings {
	let current: ProjectSettings = initial
	return {
		read: () => current,
		write: (settings) => {
			current = settings
		},
		snapshot: () => current,
	}
}

// A run with more than MAX_LOG_LINES (200) events so pagination is exercisable end to end.
function longLogRun(id: string): RunSnapshotRaw {
	const lines: string[] = []
	for (let i = 0; i < 250; i++) {
		lines.push(JSON.stringify({ timestamp: `t${String(i).padStart(3, '0')}`, type: 'llm_call', payload: { role: 'planner' } }))
	}
	return {
		metaText: JSON.stringify({
			runId: id,
			guildPath: 'guild',
			benchmarkPath: 'bench',
			task: `task for ${id}`,
			status: 'success',
			startTime: '2026-01-01T00:00:00.000Z',
			endTime: '2026-01-01T00:01:00.000Z',
		}),
		logText: lines.join('\n'),
	}
}

snapshots.set('run-long', longLogRun('run-long'))

// A run whose llm_call events carry cached prompt tokens, so the budgets token breakdown exercises the cached-vs-uncached prompt split end to end.
snapshots.set('run-cached', {
	metaText: JSON.stringify({
		runId: 'run-cached',
		guildPath: 'guild',
		benchmarkPath: 'bench',
		task: 'task for run-cached',
		status: 'success',
		startTime: '2026-01-01T00:00:00.000Z',
		endTime: '2026-01-01T00:01:00.000Z',
	}),
	logText: [
		JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', type: 'llm_call', payload: { role: 'planner', usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedPromptTokens: 60 } } }),
		JSON.stringify({ timestamp: '2026-01-01T00:00:02.000Z', type: 'tool_call', payload: { role: 'planner', tool: 'read_file' } }),
		JSON.stringify({ timestamp: '2026-01-01T00:00:03.000Z', type: 'llm_call', payload: { role: 'coder', usage: { promptTokens: 200, completionTokens: 50, totalTokens: 250 } } }),
		JSON.stringify({ timestamp: '2026-01-01T00:00:04.000Z', type: 'role_finished', payload: { role: 'coder', status: 'success' } }),
	].join('\n'),
})

// A run whose log carries the role-tree events and the rich llm_call/tool_call/tool_result payloads, so the /api/runs/:id view exercises the tree shape and the paired raw-payload detail end to end.
snapshots.set('run-tree', {
	metaText: JSON.stringify({
		runId: 'run-tree',
		guildPath: 'guild',
		benchmarkPath: 'bench',
		task: 'task for run-tree',
		status: 'success',
		startTime: '2026-01-01T00:00:00.000Z',
		endTime: '2026-01-01T00:01:00.000Z',
	}),
	logText: [
		JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', type: 'role_start', payload: { role: 'orchestrator', depth: 0, task: 'task for run-tree' } }),
		JSON.stringify({ timestamp: '2026-01-01T00:00:02.000Z', type: 'llm_call', payload: { role: 'orchestrator', messageCount: 2, sent: [{ role: 'system', content: 'p' }, { role: 'user', content: 'task for run-tree' }], received: { content: 'delegating', toolCalls: [{ id: 'c1', function: { name: 'agent', arguments: '{"role":"coder","task":"code"}' } }] }, finishReason: 'tool_calls', usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 } } }),
		JSON.stringify({ timestamp: '2026-01-01T00:00:03.000Z', type: 'tool_call', payload: { role: 'orchestrator', tool: 'agent', arguments: '{"role":"coder","task":"code"}' } }),
		JSON.stringify({ timestamp: '2026-01-01T00:00:04.000Z', type: 'agent_call', payload: { parent: 'orchestrator', child: 'coder', depth: 1 } }),
		JSON.stringify({ timestamp: '2026-01-01T00:00:05.000Z', type: 'role_start', payload: { role: 'coder', depth: 1, parent: 'orchestrator', task: 'code' } }),
		JSON.stringify({ timestamp: '2026-01-01T00:00:06.000Z', type: 'tool_result', payload: { role: 'orchestrator', tool: 'agent', kind: 'success', result: { kind: 'success', data: { status: 'success', summary: 'coded' } } } }),
		JSON.stringify({ timestamp: '2026-01-01T00:00:07.000Z', type: 'role_finished', payload: { role: 'coder', depth: 1, status: 'success', parent: 'orchestrator' } }),
		JSON.stringify({ timestamp: '2026-01-01T00:00:08.000Z', type: 'role_finished', payload: { role: 'orchestrator', depth: 0, status: 'success' } }),
	].join('\n'),
})

// A run whose llm_call events carry the delta protocol (docs/reference.md "Log events"): turn 1 is a full snapshot, turn 2 a delta slice, and a third event is the same conversation logged as a full snapshot — so the detail endpoint's server-side fold can be compared against it byte for byte.
snapshots.set('run-delta', {
	metaText: JSON.stringify({
		runId: 'run-delta',
		guildPath: 'guild',
		benchmarkPath: 'bench',
		task: 'task for run-delta',
		status: 'success',
		startTime: '2026-01-01T00:00:00.000Z',
		endTime: '2026-01-01T00:01:00.000Z',
	}),
	logText: [
		JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', type: 'role_start', payload: { role: 'coder', depth: 0, task: 'task for run-delta' } }),
		JSON.stringify({ timestamp: '2026-01-01T00:00:02.000Z', type: 'llm_call', payload: { role: 'coder', messageCount: 2, sentFrom: 0, sent: [{ role: 'system', content: 'p' }, { role: 'user', content: 'task for run-delta' }], received: { content: 'working', toolCalls: [] }, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } } }),
		JSON.stringify({ timestamp: '2026-01-01T00:00:03.000Z', type: 'llm_call', payload: { role: 'coder', messageCount: 4, sentFrom: 2, sent: [{ role: 'assistant', content: 'working', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"x"}' } }] }, { role: 'tool', content: 'ok' }], received: { content: 'done', toolCalls: [] }, finishReason: 'stop', usage: { promptTokens: 30, completionTokens: 5, totalTokens: 35 } } }),
		JSON.stringify({ timestamp: '2026-01-01T00:00:04.000Z', type: 'llm_call', payload: { role: 'coder', messageCount: 4, sentFrom: 0, sent: [{ role: 'system', content: 'p' }, { role: 'user', content: 'task for run-delta' }, { role: 'assistant', content: 'working', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"x"}' } }] }, { role: 'tool', content: 'ok' }], received: { content: 'done', toolCalls: [] }, finishReason: 'stop', usage: { promptTokens: 30, completionTokens: 5, totalTokens: 35 } } }),
		JSON.stringify({ timestamp: '2026-01-01T00:00:05.000Z', type: 'role_finished', payload: { role: 'coder', depth: 0, status: 'success' } }),
	].join('\n'),
})

// A run with a real (non-control) tool call and result carrying raw arguments and a full result, plus role task and summary text — the detail material the flow endpoint's ?operation= variant resolves on demand.
snapshots.set('run-flow-details', {
	metaText: JSON.stringify({
		runId: 'run-flow-details',
		guildPath: 'guild',
		benchmarkPath: 'bench',
		task: 'task for run-flow-details',
		status: 'success',
		startTime: '2026-01-01T00:00:00.000Z',
		endTime: '2026-01-01T00:01:00.000Z',
	}),
	logText: [
		JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', type: 'role_start', payload: { role: 'coder', depth: 0, task: 'do the work' } }),
		JSON.stringify({ timestamp: '2026-01-01T00:00:02.000Z', type: 'tool_call', payload: { role: 'coder', tool: 'read_file', arguments: '{"path":"README.md"}' } }),
		JSON.stringify({ timestamp: '2026-01-01T00:00:03.000Z', type: 'tool_result', payload: { role: 'coder', tool: 'read_file', kind: 'success', result: { kind: 'success', data: { content: '# Project' } } } }),
		JSON.stringify({ timestamp: '2026-01-01T00:00:04.000Z', type: 'role_finished', payload: { role: 'coder', depth: 0, status: 'success', summary: 'done' } }),
	].join('\n'),
})

// A run whose orchestrator delegates to coder twice (first errors, second succeeds) — mirrors a retry — so the per-invocation tree, the per-invocation status, and the inline error surfacing are all exercised end to end.
snapshots.set('run-retry', {
	metaText: JSON.stringify({
		runId: 'run-retry',
		guildPath: 'guild',
		benchmarkPath: 'bench',
		task: 'task for run-retry',
		status: 'success',
		startTime: '2026-01-01T00:00:00.000Z',
		endTime: '2026-01-01T00:02:00.000Z',
	}),
	logText: [
		JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', type: 'role_start', payload: { role: 'orchestrator', depth: 0, task: 'task for run-retry' } }),
		JSON.stringify({ timestamp: '2026-01-01T00:00:02.000Z', type: 'role_start', payload: { role: 'coder', depth: 1, parent: 'orchestrator', task: 'first attempt' } }),
		JSON.stringify({ timestamp: '2026-01-01T00:00:03.000Z', type: 'role_finished', payload: { role: 'coder', depth: 1, status: 'error', summary: 'file not found', error: { kind: 'invalid_arguments', message: 'no such file' }, parent: 'orchestrator' } }),
		JSON.stringify({ timestamp: '2026-01-01T00:00:04.000Z', type: 'role_start', payload: { role: 'coder', depth: 1, parent: 'orchestrator', task: 'second attempt' } }),
		JSON.stringify({ timestamp: '2026-01-01T00:00:05.000Z', type: 'role_finished', payload: { role: 'coder', depth: 1, status: 'success', summary: 'wrote the file', parent: 'orchestrator' } }),
		JSON.stringify({ timestamp: '2026-01-01T00:00:06.000Z', type: 'role_finished', payload: { role: 'orchestrator', depth: 0, status: 'success', summary: 'done after retry' } }),
	].join('\n'),
})

// A run whose meta carries an effort level, so the /api/runs/:id effort-surfacing and the list summary are exercised end to end.
snapshots.set('run-effort', {
	metaText: JSON.stringify({
		runId: 'run-effort',
		guildPath: 'guild',
		benchmarkPath: 'bench',
		task: 'task for run-effort',
		effort: 'thorough',
		status: 'success',
		startTime: '2026-01-01T00:00:00.000Z',
		endTime: '2026-01-01T00:01:00.000Z',
	}),
	logText: [
		JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', type: 'effort_set', payload: { effort: 'thorough' } }),
		JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', type: 'role_finished', payload: { role: 'planner', status: 'success' } }),
	].join('\n'),
})

interface HandlerHarness {
	handler: RequestHandler
	submission: RunSubmission
	settings: InMemorySettings
	interruptChannel: InterruptChannel
	humanBackend: WebHumanBackend
	staticCalls: string[]
	lastEffort: () => EffortLevel | undefined
	lastLogLevel: () => LogLevel | undefined
	lastContinuation: () => RunContinuation | undefined
	resolveActive: () => (meta: RunMeta) => void
	resolveResumed: () => (meta: RunMeta) => void
	resumedCheckpoints: () => RunCheckpoint[]
}

// Builds a fresh handler whose startRun and resumeRun park on caller-controlled resolvers, so each test drives its own run lifecycle without touching shared state. The static leaf is a recording fake; every dependency is in-memory. runIdCollides makes runDirectoryExists report an existing directory for the generated id, exercising the submit-level run_id_collision refusal. build seeds the image build identifier GET /api/config surfaces (null, as from a source checkout, unless a test passes one).
function createHandlerHarness(options: { runIdCollides?: boolean, build?: BuildInfo | null } = {}): HandlerHarness {
	let resolveActive: (meta: RunMeta) => void = () => {}
	let resolveResumed: (meta: RunMeta) => void = () => {}
	let capturedEffort: EffortLevel | undefined
	let capturedLogLevel: LogLevel | undefined
	let capturedContinuation: RunContinuation | undefined
	const resumed: RunCheckpoint[] = []
	const startRun: StartRun = (_runId, _task, effort, logLevel, continuation) => {
		capturedEffort = effort
		capturedLogLevel = logLevel
		capturedContinuation = continuation
		return new Promise<RunMeta>((resolve) => {
			resolveActive = resolve
		})
	}
	const resumeRun: ResumeRun = (checkpoint) => {
		resumed.push(checkpoint)
		return new Promise<RunMeta>((resolve) => {
			resolveResumed = resolve
		})
	}
	let nextId = 0
	const settings = createInMemorySettings()
	const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun, generateRunId: () => `test-run-${nextId++}`, runDirectoryExists: () => options.runIdCollides ?? false, readProjectSettings: settings.read })
	const interruptChannel = createInterruptChannel()
	const humanBackend = createWebHumanBackend()
	const staticCalls: string[] = []
	const handler = createRequestHandler(
		{
			guildConfig: sampleGuildConfig,
			deployment: sampleDeployment,
			tools: {},
			runState: createRunState({ humanBackend, interruptChannel }),
			runSubmission: submission,
			readRunSnapshot,
			readRunMetaById,
			readRunListSummary,
			readRunSummaryStats,
			readRunPlanById,
			readRunSnapshotStats,
			listRunIds,
			readProjectSettings: settings.read,
			writeProjectSettings: settings.write,
			build: options.build ?? null,
		},
		async (requestPath) => {
			staticCalls.push(requestPath)
			return new Response('static body', { headers: { 'content-type': 'text/javascript; charset=utf-8' } })
		},
	)
	return {
		handler,
		submission,
		settings,
		interruptChannel,
		humanBackend,
		staticCalls,
		lastEffort: () => capturedEffort,
		lastLogLevel: () => capturedLogLevel,
		lastContinuation: () => capturedContinuation,
		resolveActive: () => resolveActive,
		resolveResumed: () => resolveResumed,
		resumedCheckpoints: () => resumed,
	}
}

function terminalMeta(runId: string, task: string): RunMeta {
	return {
		runId,
		guildPath: 'guild',
		benchmarkPath: 'bench',
		task,
		status: 'success',
		startTime: '2026-01-01T00:00:00.000Z',
		endTime: '2026-01-01T00:01:00.000Z',
	}
}

// A minimal valid checkpoint for the resume tests: a single depth-0 frame (an active entry role).
function resumeCheckpoint(runId: string): RunCheckpoint {
	return {
		version: 1,
		runId,
		startTime: '2026-01-01T00:00:00.000Z',
		registryCounter: 1,
		frames: [
			{
				roleId: 'orchestrator-0-1',
				roleName: 'orchestrator',
				depth: 0,
				task: `task for ${runId}`,
				roleState: {
					history: [
						{ role: 'system', content: 'prompt' },
						{ role: 'user', content: 'task' },
					],
					lastPromptTokens: 10,
					recentCompactionPromptTokens: [],
					recentToolCalls: [],
					toolCallCount: 1,
					generatedTokens: 5,
					contextExceededAttempts: 0,
					loopCheckToolCallWatermark: 0,
					loopCheckTokenWatermark: 0,
				},
			},
		],
	}
}

function get(path: string): Request {
	return new Request(`http://handler.test${path}`)
}

function post(path: string, body: string): Request {
	return new Request(`http://handler.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
}

function put(path: string, body: string): Request {
	return new Request(`http://handler.test${path}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body })
}

describe('static asset resolution', () => {
	test('maps / to index.html', () => {
		expect(resolveStaticAsset('/static', '/')).toEqual({ resolvedPath: '/static/index.html', contentType: 'text/html; charset=utf-8' })
	})

	test('resolves a nested asset with its content type', () => {
		expect(resolveStaticAsset('/static', '/vendor/hyperapp.js')).toEqual({ resolvedPath: '/static/vendor/hyperapp.js', contentType: 'text/javascript; charset=utf-8' })
	})

	test('rejects a path that escapes the static directory via ..', () => {
		expect(resolveStaticAsset('/static', '/../source/web/server.ts')).toBeNull()
	})

	test('falls back to a binary content type for unknown extensions', () => {
		expect(resolveStaticAsset('/static', '/data.bin')).toEqual({ resolvedPath: '/static/data.bin', contentType: 'application/octet-stream' })
	})
})

describe('static serving title substitution', () => {
	const INDEX_HTML = '<!DOCTYPE html><html><head><title>Adaptive Orchestrator</title></head><body><div id="app"></div></body></html>'

	// A fake asset reader standing in for the filesystem leaf: index.html serves the fixture document, missing.js is absent, everything else a JS body. The static dir is never touched.
	function createTitleHarness(pageTitle: string, indexHtml: string = INDEX_HTML) {
		const servedPaths: string[] = []
		const serveAssetFile: ServeAssetFile = (asset) => {
			servedPaths.push(asset.resolvedPath)
			if (asset.resolvedPath === '/static/missing.js') return null
			if (asset.resolvedPath === '/static/index.html') return new Response(indexHtml, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
			return new Response('app.js bytes', { headers: { 'content-type': 'text/javascript; charset=utf-8' } })
		}
		return { serveStatic: createServeStatic({ staticDir: '/static', pageTitle, serveAssetFile }), servedPaths: () => servedPaths }
	}

	test('substitutes the configured title into the index page served at /', async () => {
		const { serveStatic } = createTitleHarness('Mission Control')
		const response = await serveStatic('/')
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
		expect(response.headers.get('cache-control')).toBe('no-store')
		expect(await response.text()).toBe(INDEX_HTML.replace('<title>Adaptive Orchestrator</title>', '<title>Mission Control</title>'))
	})

	test('substitutes the title when the index page is requested by name', async () => {
		const { serveStatic } = createTitleHarness('Mission Control')
		const response = await serveStatic('/index.html')
		expect(await response.text()).toContain('<title>Mission Control</title>')
	})

	test('escapes an HTML-shaped title so the served page cannot be injected', async () => {
		const { serveStatic } = createTitleHarness('</title><script>alert(1)</script>')
		const body = await (await serveStatic('/')).text()
		expect(body).toContain('<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>')
		expect(body).not.toContain('<script>alert(1)</script>')
	})

	test('other assets pass through without a title read', async () => {
		const { serveStatic } = createTitleHarness('Mission Control')
		const response = await serveStatic('/app.js')
		expect(await response.text()).toBe('app.js bytes')
	})

	test('an index body with no title element is served unchanged', async () => {
		const titleLess = '<!DOCTYPE html><html><body><h1>no title here</h1></body></html>'
		const { serveStatic } = createTitleHarness('Mission Control', titleLess)
		const response = await serveStatic('/')
		expect(await response.text()).toBe(titleLess)
	})

	test('an absent asset is a JSON 404', async () => {
		const { serveStatic } = createTitleHarness('Mission Control')
		const response = await serveStatic('/missing.js')
		expect(response.status).toBe(404)
		expect(await response.json()).toEqual({ ok: false, error: 'not_found' })
	})
})

describe('request handler static fallback', () => {
	test('GET /favicon.ico returns 204 without consulting the static leaf', async () => {
		const { handler, staticCalls } = createHandlerHarness()
		const response = await handler(get('/favicon.ico'))
		expect(response.status).toBe(204)
		expect(staticCalls).toEqual([])
	})

	test('an unmatched GET path is delegated to the static leaf with the raw path', async () => {
		const { handler, staticCalls } = createHandlerHarness()
		const response = await handler(get('/app.js'))
		expect(response.status).toBe(200)
		expect(await response.text()).toBe('static body')
		expect(staticCalls).toEqual(['/app.js'])
	})

	test('an unmatched method and path returns the JSON 404 without consulting the static leaf', async () => {
		const { handler, staticCalls } = createHandlerHarness()
		const response = await handler(post('/nope', '{}'))
		expect(response.status).toBe(404)
		expect(await response.json()).toEqual({ ok: false, error: 'not_found' })
		expect(staticCalls).toEqual([])
	})
})

describe('GET /api/config', () => {
	test('returns the safe config subset derived from the loaded Guild', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/config'))
		expect(response.status).toBe(200)
		const config = await response.json()
		expect(config.model).toEqual({ name: 'qwen3.6:35b', contextWindow: 262144 })
		expect(config.executor).toEqual({
			maxAgentDepth: 8,
			defaultToolTimeoutSeconds: 30,
			maxCompactionAttempts: 5,
		})
		expect(config.entryRole).toBe('orchestrator')
		expect(config.roles).toEqual({
			orchestrator: { tools: ['agent', 'ask_human', 'finish'] },
			coder: { tools: ['read_file', 'write_file', 'finish'] },
		})
		expect(config.build).toBeNull()
	})

	test('carries the baked image build identifier through to the response', async () => {
		const { handler } = createHandlerHarness({ build: { sha: '9f3a2b7c4d1e5a6b', builtAt: '2026-09-25T12:00:00Z' } })
		const response = await handler(get('/api/config'))
		const config = await response.json()
		expect(config.build).toEqual({ sha: '9f3a2b7c4d1e5a6b', builtAt: '2026-09-25T12:00:00Z' })
	})

	test('structurally omits apiKey and apiBase from the response', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/config'))
		const config = await response.json()
		expect(config.model).not.toHaveProperty('apiKey')
		expect(config.model).not.toHaveProperty('apiBase')
		const serialized = JSON.stringify(config)
		expect(serialized).not.toContain('secret-key')
		expect(serialized).not.toContain('llama-server')
	})

	test('includes the entry role and every role declared in the Guild', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/config'))
		const config = await response.json()
		expect(config.entryRole).toBe('orchestrator')
		expect(Object.keys(config.roles).sort()).toEqual(['coder', 'orchestrator'])
		expect(config.roles.orchestrator.tools).toEqual(['agent', 'ask_human', 'finish'])
		expect(config.roles.coder.tools).toEqual(['read_file', 'write_file', 'finish'])
	})
})

describe('GET /api/run alias', () => {
	test('returns the active (most recent) run view', async () => {
		const { handler, submission, resolveActive } = createHandlerHarness()
		submission.submit('bootstrap task')
		const response = await handler(get('/api/run'))
		expect(response.status).toBe(200)
		const view = await response.json()
		expect(view.runId).toBe('test-run-0')
		expect(view.task).toBe('task for test-run-0')

		resolveActive()(terminalMeta('test-run-0', 'bootstrap task'))
		await submission.awaitActive()
	})

	test('returns 404 no_run when no run has ever been started', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/run'))
		expect(response.status).toBe(404)
		expect(await response.json()).toEqual({ ok: false, error: 'no_run' })
	})

	test('keeps surfacing the most recent run after it completes', async () => {
		const { handler, submission, resolveActive } = createHandlerHarness()
		submission.submit('bootstrap task')
		resolveActive()(terminalMeta('test-run-0', 'bootstrap task'))
		await submission.awaitActive()

		const response = await handler(get('/api/run'))
		expect(response.status).toBe(200)
		const view = await response.json()
		expect(view.runId).toBe('test-run-0')
	})
})

describe('GET /api/runs (list)', () => {
	test('returns the known runs as summaries, newest first by id', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs'))
		expect(response.status).toBe(200)
		const list = await response.json()
		expect(Array.isArray(list)).toBe(true)
		expect(list.length).toBe(13)
		expect(list[0].runId).toBe('run-tree')
		expect(list[1].runId).toBe('run-retry')
		expect(list[2].runId).toBe('run-long')
		expect(list[3].runId).toBe('run-interrupted')
		expect(list[4].runId).toBe('run-flow-details')
		expect(list[5].runId).toBe('run-effort')
		expect(list[6].runId).toBe('run-delta')
		expect(list[7].runId).toBe('run-cached')
		expect(list[8].runId).toBe('run-active')
		expect(list[9].runId).toBe('run-3')
		expect(list[10].runId).toBe('run-20260101-000000')
		expect(list[11].runId).toBe('run-2')
		expect(list[12].runId).toBe('run-1')
		expect(list[3]).toEqual({
			runId: 'run-interrupted',
			status: 'interrupted',
			task: 'task for run-interrupted',
			effort: null,
			startTime: '2026-01-01T00:00:00.000Z',
			endTime: '2026-01-01T00:02:00.000Z',
			result: null,
			error: { kind: 'interrupted', message: 'The service stopped while this run was in progress and it could not be resumed (no valid checkpoint).' },
			summary: null,
		})
		expect(list[5]).toEqual({
			runId: 'run-effort',
			status: 'success',
			task: 'task for run-effort',
			effort: 'thorough',
			startTime: '2026-01-01T00:00:00.000Z',
			endTime: '2026-01-01T00:01:00.000Z',
			result: null,
			error: null,
			summary: null,
		})
		expect(list[11]).toEqual({
			runId: 'run-2',
			status: 'error',
			task: 'task for run-2',
			effort: null,
			startTime: '2026-01-01T00:00:00.000Z',
			endTime: '2026-01-01T00:01:00.000Z',
			result: { status: 'error', summary: 'failed', artifacts: ['output.txt', 'logs/run.txt'] },
			error: { kind: 'llm_unavailable', message: 'connection refused' },
			summary: null,
		})
	})
})

describe('GET /api/runs/:id', () => {
	test('returns the full run view for a known run id', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/run-1'))
		expect(response.status).toBe(200)
		const view = await response.json()
		expect(view.runId).toBe('run-1')
		expect(view.status).toBe('success')
		expect(view.roles.length).toBe(1)
		expect(view.roles[0].role).toBe('planner')
		expect(view.recentLog.length).toBe(2)
		expect(view.recentLog[0].text).toBe('planner · llm call')
		expect(view.recentLog[0].index).toBe(0)
		expect(view.error).toBeNull()
		expect(view.currentActivity.role).toBe('planner')
		expect(view.currentActivity.summary).toBe('planner · finished (success)')
	})

	test('recentLog entries carry no payload or detail sections — heavy bodies live on the window endpoint', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/run-tree'))
		expect(response.status).toBe(200)
		const view = await response.json()
		expect(view.recentLog.length).toBeGreaterThan(0)
		for (const entry of view.recentLog) {
			expect(entry).toEqual({ index: entry.index, timestamp: entry.timestamp, type: entry.type, text: entry.text })
		}
		// The raw llm_call sent/received bodies must not appear anywhere in the polled run view.
		const serialized = JSON.stringify(view)
		expect(serialized).not.toContain('"sent"')
		expect(serialized).not.toContain('"received"')
	})

	test('returns the run plan markdown when the run has a plan document', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/run-1'))
		expect(response.status).toBe(200)
		const view = await response.json()
		expect(view.plan).toBe('# Plan\n\n1. read the code\n2. fix the bug')
	})

	test('returns plan null when the run has no plan document', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/run-2'))
		expect(response.status).toBe(200)
		const view = await response.json()
		expect(view.plan).toBeNull()
	})

	test('returns budgets derived from the log and meta', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/run-1'))
		expect(response.status).toBe(200)
		const view = await response.json()
		expect(view.budgets).toEqual({
			elapsedSeconds: 60,
			toolCalls: 0,
			tokensUsed: 120,
			tokenBreakdown: { promptTokens: 100, cachedPromptTokens: 0, completionTokens: 20, totalTokens: 120 },
		})
	})

	test('returns budgets that split cached from uncached prompt tokens', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/run-cached'))
		expect(response.status).toBe(200)
		const view = await response.json()
		expect(view.budgets.toolCalls).toBe(1)
		expect(view.budgets.tokensUsed).toBe(370)
		expect(view.budgets.tokenBreakdown).toEqual({
			promptTokens: 300,
			cachedPromptTokens: 60,
			completionTokens: 70,
			totalTokens: 370,
		})
	})

	test('surfaces error, artifacts, currentActivity, and readable recentLog for a failed run', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/run-2'))
		expect(response.status).toBe(200)
		const view = await response.json()
		expect(view.error).toEqual({ kind: 'llm_unavailable', message: 'connection refused' })
		expect(view.result.artifacts).toEqual(['output.txt', 'logs/run.txt'])
		expect(view.currentActivity.summary).toBe('planner · finished (success)')
		expect(view.recentLog[0].text).toBe('planner · llm call')
		expect(view.recentLog[1].text).toBe('planner · finished (success)')
	})

	test('an interrupted run renders as a terminal state with the reconciliation error, not as in progress', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/run-interrupted'))
		expect(response.status).toBe(200)
		const view = await response.json()
		expect(view.status).toBe('interrupted')
		expect(view.error).toEqual({ kind: 'interrupted', message: 'The service stopped while this run was in progress and it could not be resumed (no valid checkpoint).' })
		expect(view.endTime).toBe('2026-01-01T00:02:00.000Z')
	})

	test('returns 404 for an unknown run id', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/never-started'))
		expect(response.status).toBe(404)
		expect(await response.json()).toEqual({ ok: false, error: 'not_found' })
	})

	test('a malformed percent-encoding in the run id path is a 404, not a crash', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/%'))
		expect(response.status).toBe(404)
		expect(await response.json()).toEqual({ ok: false, error: 'not_found' })
	})

	test('returns questionHistory pairing ask_human with human_answer events', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/run-3'))
		expect(response.status).toBe(200)
		const view = await response.json()
		expect(view.questionHistory.length).toBe(2)
		expect(view.questionHistory[0]).toEqual({
			id: 'q1',
			question: 'Which framework?',
			context: 'src/index.ts',
			askedAt: '2026-01-01T00:00:02.000Z',
			answer: 'react',
			answeredAt: '2026-01-01T00:00:30.000Z',
		})
		expect(view.questionHistory[1]).toEqual({
			id: 'q2',
			question: 'Still unsure?',
			askedAt: '2026-01-01T00:00:31.000Z',
		})
	})

	test('exposes the role tree for a tree-bearing run', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/run-tree'))
		expect(response.status).toBe(200)
		const view = await response.json()
		expect(view.roleTree).not.toBeNull()
		expect(view.roleTree.length).toBe(1)
		expect(view.roleTree[0].role).toBe('orchestrator')
		expect(view.roleTree[0].children.length).toBe(1)
		expect(view.roleTree[0].children[0].role).toBe('coder')
		expect(view.roleTree[0].children[0].parent).toBe('orchestrator')
	})

	test('a retry run shows two distinct coder invocations with their own statuses and surfaces the error summary inline', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/run-retry'))
		expect(response.status).toBe(200)
		const view = await response.json()
		// The tree has two coder invocations under one orchestrator, each with its own status — not one merged node.
		expect(view.roleTree.length).toBe(1)
		const root = view.roleTree[0]
		expect(root.role).toBe('orchestrator')
		expect(root.children.length).toBe(2)
		expect(root.children[0].role).toBe('coder')
		expect(root.children[0].status).toBe('error')
		expect(root.children[0].summary).toBe('file not found')
		expect(root.children[1].role).toBe('coder')
		expect(root.children[1].status).toBe('success')
		expect(root.children[1].summary).toBe('wrote the file')
		// The completed run has no active invocation.
		expect(root.active).toBe(false)
		expect(root.children[0].active).toBe(false)
		expect(root.children[1].active).toBe(false)

		// The erroring coder's role_finished shows status only in the one-line text (the model's full prose is kept out of the row); its summary is reachable through the window endpoint's detail variant.
		const errorFinish = view.recentLog.find((entry: { type: string; text: string }) => entry.type === 'role_finished' && entry.text === 'coder · finished (error)')
		expect(errorFinish).toBeDefined()
	})

	test('includes the run effort from meta.effort, or null when the run\'s meta carries no effort', async () => {
		const { handler } = createHandlerHarness()
		const withEffort = await handler(get('/api/runs/run-effort'))
		expect(withEffort.status).toBe(200)
		expect((await withEffort.json()).effort).toBe('thorough')

		const withoutEffort = await handler(get('/api/runs/run-1'))
		expect(withoutEffort.status).toBe(200)
		expect((await withoutEffort.json()).effort).toBeNull()
	})
})

describe('GET /api/runs/:id/log', () => {
	test('returns the default first page with total, offset, and limit', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/run-long/log'))
		expect(response.status).toBe(200)
		const body = await response.json()
		expect(body.runId).toBe('run-long')
		expect(body.total).toBe(250)
		expect(body.offset).toBe(0)
		expect(body.limit).toBe(50)
		expect(body.events.length).toBe(50)
		// Each event is a raw window row: its log-wide index plus the identity fields and payload.
		expect(body.events[0]).toEqual({ index: 0, timestamp: 't000', type: 'llm_call', payload: { role: 'planner' } })
		expect(body.events[49].index).toBe(49)
		expect(body.events[49].timestamp).toBe('t049')
	})

	test('returns a later page with explicit offset and limit, indices log-wide', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/run-long/log?offset=240&limit=20'))
		expect(response.status).toBe(200)
		const body = await response.json()
		expect(body.total).toBe(250)
		expect(body.offset).toBe(240)
		expect(body.limit).toBe(20)
		expect(body.events.length).toBe(10)
		expect(body.events[0]).toEqual({ index: 240, timestamp: 't240', type: 'llm_call', payload: { role: 'planner' } })
		expect(body.events[9].timestamp).toBe('t249')
	})

	test('caps the limit at the window maximum', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/run-long/log?limit=100000'))
		expect(response.status).toBe(200)
		const body = await response.json()
		expect(body.limit).toBe(500)
		expect(body.events.length).toBe(250)
	})

	test('returns an empty page with the correct total when offset is past the end', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/run-long/log?offset=300&limit=10'))
		expect(response.status).toBe(200)
		const body = await response.json()
		expect(body.total).toBe(250)
		expect(body.offset).toBe(300)
		expect(body.events).toEqual([])
	})

	test('treats invalid query params as defaults', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/run-long/log?offset=abc&limit=-5'))
		expect(response.status).toBe(200)
		const body = await response.json()
		expect(body.offset).toBe(0)
		expect(body.limit).toBe(50)
		expect(body.events.length).toBe(50)
	})

	test('detail=<index> serves one event\'s paired detail sections', async () => {
		const { handler } = createHandlerHarness()
		// run-tree's event 1 is an llm_call carrying paired sent/received detail bodies.
		const response = await handler(get('/api/runs/run-tree/log?detail=1'))
		expect(response.status).toBe(200)
		const body = await response.json()
		expect(body.index).toBe(1)
		expect(body.detailSections.map((s: { label: string }) => s.label)).toEqual(['sent', 'received', 'finish reason', 'usage'])
		expect(body.detailSections[2].content).toBe('tool_calls')
	})

	test('detail=<index> folds an llm_call delta into the full conversation, identical to a full-snapshot twin', async () => {
		const { handler } = createHandlerHarness()
		// run-delta's event 2 is the delta turn; event 3 is the same conversation logged as a full snapshot.
		const deltaResponse = await handler(get('/api/runs/run-delta/log?detail=2'))
		expect(deltaResponse.status).toBe(200)
		const delta = await deltaResponse.json()
		expect(delta.index).toBe(2)
		expect(delta.detailSections.map((s: { label: string }) => s.label)).toEqual(['sent', 'received', 'finish reason', 'usage'])
		const twinResponse = await handler(get('/api/runs/run-delta/log?detail=3'))
		const twin = await twinResponse.json()
		expect(delta.detailSections).toEqual(twin.detailSections)
		// The folded sent section carries the whole 4-message conversation, not just the delta slice.
		const sentSection = delta.detailSections.find((s: { label: string }) => s.label === 'sent')
		expect(sentSection.content).toHaveLength(4)
		expect(sentSection.content[1]).toEqual({ role: 'user', content: 'task for run-delta' })
	})

	test('detail=<index> on the full-snapshot turn serves it unchanged', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/run-delta/log?detail=1'))
		const body = await response.json()
		const sentSection = body.detailSections.find((s: { label: string }) => s.label === 'sent')
		expect(sentSection.content).toEqual([{ role: 'system', content: 'p' }, { role: 'user', content: 'task for run-delta' }])
	})

	test('detail=<index> serves the raw tool arguments and the full un-truncated result', async () => {
		const { handler } = createHandlerHarness()
		const toolCallResponse = await handler(get('/api/runs/run-tree/log?detail=2'))
		const toolCall = await toolCallResponse.json()
		expect(toolCall.detailSections.map((s: { label: string }) => s.label)).toEqual(['arguments'])
		expect(toolCall.detailSections[0].content).toBe('{"role":"coder","task":"code"}')

		const toolResultResponse = await handler(get('/api/runs/run-tree/log?detail=5'))
		const toolResult = await toolResultResponse.json()
		expect(toolResult.detailSections.map((s: { label: string }) => s.label)).toEqual(['result'])
		expect(toolResult.detailSections[0].content).toEqual({ kind: 'success', data: { status: 'success', summary: 'coded' } })
	})

	test('detail=<index> returns detailSections null for an event without sections', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/run-tree/log?detail=0'))
		expect(response.status).toBe(200)
		const body = await response.json()
		expect(body.index).toBe(0)
		expect(body.detailSections).toBeNull()
	})

	test('detail=<index> returns 404 for an out-of-range or malformed index', async () => {
		const { handler } = createHandlerHarness()
		const outOfRange = await handler(get('/api/runs/run-tree/log?detail=999'))
		expect(outOfRange.status).toBe(404)
		expect(await outOfRange.json()).toEqual({ ok: false, error: 'not_found' })
		const malformed = await handler(get('/api/runs/run-tree/log?detail=abc'))
		expect(malformed.status).toBe(404)
		const negative = await handler(get('/api/runs/run-tree/log?detail=-1'))
		expect(negative.status).toBe(404)
		// An empty value must not collapse to event 0 (Number('') is 0): it is malformed, not an identity.
		const empty = await handler(get('/api/runs/run-tree/log?detail='))
		expect(empty.status).toBe(404)
		expect(await empty.json()).toEqual({ ok: false, error: 'not_found' })
	})

	test('returns 404 for an unknown run id', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/never-started/log'))
		expect(response.status).toBe(404)
		expect(await response.json()).toEqual({ ok: false, error: 'not_found' })
	})

	test('a malformed percent-encoding in the path is a 404, not a crash', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/%/log'))
		expect(response.status).toBe(404)
		expect(await response.json()).toEqual({ ok: false, error: 'not_found' })
	})

	test('format=text returns the page as a downloadable plain-text log', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/run-1/log?format=text'))
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toContain('text/plain')
		expect(response.headers.get('content-disposition')).toBe('attachment; filename="run-1.log"')
		const text = await response.text()
		const lines = text.split('\n')
		expect(lines.length).toBe(2)
		expect(lines[0]).toBe('2026-01-01T00:00:01.000Z\tllm_call\tplanner · llm call')
		expect(lines[1]).toBe('2026-01-01T00:00:02.000Z\trole_finished\tplanner · finished (success)')
	})

	test('format=text honors offset and limit', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/run-long/log?format=text&offset=0&limit=3'))
		expect(response.status).toBe(200)
		const lines = (await response.text()).split('\n')
		expect(lines.length).toBe(3)
		expect(lines[0]).toContain('t000')
		expect(lines[2]).toContain('t002')
	})

	test('format=text returns 404 for an unknown run id', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/never-started/log?format=text'))
		expect(response.status).toBe(404)
		expect(await response.json()).toEqual({ ok: false, error: 'not_found' })
	})
})

describe('GET /api/runs/:id/flow', () => {
	test('returns the InteractionModel for a known run with the root human and entry role', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/run-tree/flow'))
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toContain('application/json')
		const model = await response.json()
		expect(model.status).toBe('success')
		expect(model.participants.map((p: { role: string }) => p.role)).toEqual(['human', 'orchestrator', 'coder'])
		expect(model.participants[0]).toEqual({ id: 'human:root', role: 'human', kind: 'human' })
		// run-tree delegates orchestrator → coder then unwinds: two calls and two returns.
		expect(model.operations.map((o: { kind: string }) => o.kind)).toEqual(['call', 'call', 'return', 'return'])
		expect(model.operations[0].source).toBe('human:root')
		expect(model.operations[1].destination).toBe(model.participants[2].id)
		// A terminal run has nothing in flight.
		expect(model.operations.every((o: { lifecycle: string }) => o.lifecycle === 'settled')).toBe(true)
	})

	test('returns 404 for an unknown run id', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/never-started/flow'))
		expect(response.status).toBe(404)
		expect(await response.json()).toEqual({ ok: false, error: 'not_found' })
	})

	test('an interrupted run carries the terminal interrupted status into the flow model', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/run-interrupted/flow'))
		expect(response.status).toBe(200)
		const model = await response.json()
		expect(model.status).toBe('interrupted')
	})

	test('operations carry no details — the polled model ships identities only', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/run-flow-details/flow'))
		expect(response.status).toBe(200)
		const model = await response.json()
		expect(model.operations.length).toBeGreaterThan(0)
		for (const operation of model.operations) {
			expect(operation).not.toHaveProperty('details')
		}
		// The heavy task/arguments/result bodies must not appear anywhere in the polled flow model.
		const serialized = JSON.stringify(model)
		expect(serialized).not.toContain('do the work')
		expect(serialized).not.toContain('README.md')
		expect(serialized).not.toContain('details')
	})

	test('?operation=<id> serves that single operation\'s details', async () => {
		const { handler } = createHandlerHarness()
		// run-flow-details: op-1 is the role call (task text), op-2 the tool call (arguments), op-3 the tool return (result), op-4 the finish return (summary).
		const callResponse = await handler(get('/api/runs/run-flow-details/flow?operation=op-1'))
		expect(callResponse.status).toBe(200)
		expect(await callResponse.json()).toEqual({ operationId: 'op-1', details: 'do the work' })
		const finishResponse = await handler(get('/api/runs/run-flow-details/flow?operation=op-4'))
		expect(await finishResponse.json()).toEqual({ operationId: 'op-4', details: 'done' })
	})

	test('?operation=<id> for an operation with no detail material resolves to details null, not a 404', async () => {
		const { handler } = createHandlerHarness()
		// run-tree's op-3 is the coder's return: a real operation whose role_finished carried no summary, so there is no detail material to format.
		const response = await handler(get('/api/runs/run-tree/flow?operation=op-3'))
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ operationId: 'op-3', details: null })
	})

	test('?operation=<id> pretty-prints a tool call\'s raw arguments and serves the full result', async () => {
		const { handler } = createHandlerHarness()
		const argumentsResponse = await handler(get('/api/runs/run-flow-details/flow?operation=op-2'))
		const argumentsBody = await argumentsResponse.json()
		expect(argumentsBody.operationId).toBe('op-2')
		expect(JSON.parse(argumentsBody.details.replace(/^```json\n|\n```$/g, ''))).toEqual({ path: 'README.md' })

		const resultResponse = await handler(get('/api/runs/run-flow-details/flow?operation=op-3'))
		const resultBody = await resultResponse.json()
		expect(JSON.parse(resultBody.details.replace(/^```json\n|\n```$/g, ''))).toEqual({ kind: 'success', data: { content: '# Project' } })
	})

	test('?operation=<unknown id> returns 404', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/run-flow-details/flow?operation=op-999'))
		expect(response.status).toBe(404)
		expect(await response.json()).toEqual({ ok: false, error: 'not_found' })
	})

	test('?operation=<id> returns 404 for an unknown run id', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/never-started/flow?operation=op-1'))
		expect(response.status).toBe(404)
		expect(await response.json()).toEqual({ ok: false, error: 'not_found' })
	})
})

describe('GET /api/run/flow alias', () => {
	test('matches /api/runs/:id/flow for the active run', async () => {
		const { handler, submission, resolveActive } = createHandlerHarness()
		submission.submit('bootstrap task')
		const activeId = submission.activeRunId()
		expect(activeId).toBe('test-run-0')

		const aliasResponse = await handler(get('/api/run/flow'))
		expect(aliasResponse.status).toBe(200)
		const byIdResponse = await handler(get(`/api/runs/${activeId}/flow`))
		expect(byIdResponse.status).toBe(200)
		expect(await aliasResponse.json()).toEqual(await byIdResponse.json())

		resolveActive()(terminalMeta('test-run-0', 'bootstrap task'))
		await submission.awaitActive()
	})

	test('returns 404 no_run when no run has ever been started', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/run/flow'))
		expect(response.status).toBe(404)
		expect(await response.json()).toEqual({ ok: false, error: 'no_run' })
	})
})

describe('GET /api/demo/scenarios', () => {
	test('lists every demo fixture with id, label, frame count, and participants', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/demo/scenarios'))
		expect(response.status).toBe(200)
		const list = await response.json()
		expect(Array.isArray(list)).toBe(true)
		expect(list.length).toBeGreaterThan(0)
		const sample = list[0]
		expect(typeof sample.id).toBe('string')
		expect(typeof sample.label).toBe('string')
		expect(typeof sample.frameCount).toBe('number')
		expect(Array.isArray(sample.participants)).toBe(true)
		expect(sample.participants[0]).toEqual({ id: 'human:root', role: 'human', kind: 'human' })
		expect(list.some((entry: { id: string }) => entry.id === 'delegation-chain')).toBe(true)
	})
})

describe('GET /api/demo/flow/:scenario/:frame', () => {
	test('returns the adapter-derived InteractionModel for a frame (root human + the entry role)', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/demo/flow/single-role-completion/0'))
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toContain('application/json')
		const model = await response.json()
		expect(model.status).toBe('running')
		expect(model.participants.map((p: { role: string }) => p.role)).toEqual(['human', 'coder'])
		expect(model.participants[0]).toEqual({ id: 'human:root', role: 'human', kind: 'human' })
		const call = model.operations[0]
		expect(call.kind).toBe('call')
		expect(call.source).toBe('human:root')
		expect(call.lifecycle).toBe('in_flight')
	})

	test('a later frame reflects adapter lifecycle (the lingering tool return at the tool_result frame)', async () => {
		// tool_result is the 8th event (index 7) of the delegation-chain fixture.
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/demo/flow/delegation-chain/7'))
		const model = await response.json()
		const inFlightReturns = model.operations.filter((o: { kind: string; lifecycle: string }) => o.kind === 'return' && o.lifecycle === 'in_flight')
		expect(inFlightReturns.length).toBe(1)
	})

	test('returns 404 for an unknown scenario', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/demo/flow/no-such-scenario/0'))
		expect(response.status).toBe(404)
		expect(await response.json()).toEqual({ ok: false, error: 'not_found' })
	})

	test('returns 404 for an out-of-range frame', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/demo/flow/single-role-completion/999'))
		expect(response.status).toBe(404)
		expect(await response.json()).toEqual({ ok: false, error: 'not_found' })
	})

	test('a malformed frame index is a 404, not a crash', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/demo/flow/single-role-completion/abc'))
		expect(response.status).toBe(404)
	})

	test('a malformed percent-encoding in the path is a 404, not a crash', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/demo/flow/%/0'))
		expect(response.status).toBe(404)
		expect(await response.json()).toEqual({ ok: false, error: 'not_found' })
	})

	test('?operation=<id> resolves one frame operation\'s details (the delegation task text)', async () => {
		const { handler } = createHandlerHarness()
		// delegation-chain frame 2: the planner role_start just landed, so op-2 is its call.
		const response = await handler(get('/api/demo/flow/delegation-chain/2?operation=op-2'))
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ operationId: 'op-2', details: 'Plan the approach.' })
	})

	test('?operation=<id> returns 404 for an unknown operation or scenario', async () => {
		const { handler } = createHandlerHarness()
		const unknownOperation = await handler(get('/api/demo/flow/single-role-completion/0?operation=op-9'))
		expect(unknownOperation.status).toBe(404)
		const unknownScenario = await handler(get('/api/demo/flow/no-such-scenario/0?operation=op-1'))
		expect(unknownScenario.status).toBe(404)
		const outOfRangeFrame = await handler(get('/api/demo/flow/single-role-completion/999?operation=op-1'))
		expect(outOfRangeFrame.status).toBe(404)
	})
})

describe('POST /api/runs', () => {
	test('accepts a task when no run is active and returns 201 with the run id', async () => {
		const { handler, submission, resolveActive } = createHandlerHarness()
		const response = await handler(post('/api/runs', JSON.stringify({ task: 'a new task' })))
		expect(response.status).toBe(201)
		const body = await response.json()
		expect(body.runId).toBe('test-run-0')
		expect(submission.activeRunId()).toBe('test-run-0')

		resolveActive()(terminalMeta('test-run-0', 'a new task'))
		await submission.awaitActive()
	})

	test('rejects a second submit while a run is active with 409 run_in_progress', async () => {
		const { handler, submission, resolveActive } = createHandlerHarness()
		submission.submit('first')
		const response = await handler(post('/api/runs', JSON.stringify({ task: 'second' })))
		expect(response.status).toBe(409)
		expect(await response.json()).toEqual({ ok: false, error: 'run_in_progress' })

		resolveActive()(terminalMeta('test-run-0', 'first'))
		await submission.awaitActive()
	})

	test('rejects a submit whose generated id collides with an existing run directory with 409 run_id_collision', async () => {
		const { handler, submission } = createHandlerHarness({ runIdCollides: true })
		const response = await handler(post('/api/runs', JSON.stringify({ task: 'a colliding task' })))
		expect(response.status).toBe(409)
		expect(await response.json()).toEqual({ ok: false, error: 'run_id_collision' })
		// The collision refuses the submission outright: no run was started or tracked.
		expect(submission.activeRunId()).toBeUndefined()
	})

	test('rejects a submit while a resumed run is still active, then accepts after it settles', async () => {
		const { handler, submission, resolveResumed } = createHandlerHarness()
		submission.resume(resumeCheckpoint('run-restored'))

		const response = await handler(post('/api/runs', JSON.stringify({ task: 'second' })))
		expect(response.status).toBe(409)
		expect(await response.json()).toEqual({ ok: false, error: 'run_in_progress' })

		resolveResumed()(terminalMeta('run-restored', 'restored task'))
		await submission.awaitActive()
		const accepted = await handler(post('/api/runs', JSON.stringify({ task: 'second' })))
		expect(accepted.status).toBe(201)
	})

	test('rejects a body missing the task field with 400 invalid_body', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(post('/api/runs', JSON.stringify({ notTask: 'x' })))
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({ ok: false, error: 'invalid_body' })
	})

	test('rejects malformed json with 400 invalid_body', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(post('/api/runs', '{ not json'))
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({ ok: false, error: 'invalid_body' })
	})

	test('threads a valid effort override into the started run', async () => {
		const { handler, submission, lastEffort, resolveActive } = createHandlerHarness()
		const response = await handler(post('/api/runs', JSON.stringify({ task: 'careful task', effort: 'thorough' })))
		expect(response.status).toBe(201)
		expect(lastEffort()).toBe('thorough')

		resolveActive()(terminalMeta('test-run-0', 'careful task'))
		await submission.awaitActive()
	})

	test('applies the project default when effort is omitted', async () => {
		const { handler, submission, settings, lastEffort, resolveActive } = createHandlerHarness()
		settings.write({ effort: 'quick' })
		const response = await handler(post('/api/runs', JSON.stringify({ task: 'defaulted task' })))
		expect(response.status).toBe(201)
		expect(lastEffort()).toBe('quick')

		resolveActive()(terminalMeta('test-run-0', 'defaulted task'))
		await submission.awaitActive()
	})

	test('rejects an unknown effort tier with 400 invalid_body', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(post('/api/runs', JSON.stringify({ task: 'x', effort: 'copious' })))
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({ ok: false, error: 'invalid_body' })
	})

	test('rejects a numeric effort with 400 invalid_body', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(post('/api/runs', JSON.stringify({ task: 'x', effort: 2 })))
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({ ok: false, error: 'invalid_body' })
	})

	test('threads a valid logLevel override into the started run', async () => {
		const { handler, submission, lastLogLevel, resolveActive } = createHandlerHarness()
		const response = await handler(post('/api/runs', JSON.stringify({ task: 'quiet task', logLevel: 'standard' })))
		expect(response.status).toBe(201)
		expect(lastLogLevel()).toBe('standard')

		resolveActive()(terminalMeta('test-run-0', 'quiet task'))
		await submission.awaitActive()
	})

	test('applies the project log-level default when logLevel is omitted', async () => {
		const { handler, submission, settings, lastLogLevel, resolveActive } = createHandlerHarness()
		settings.write({ effort: 'quick', logLevel: 'standard' })
		const response = await handler(post('/api/runs', JSON.stringify({ task: 'defaulted task' })))
		expect(response.status).toBe(201)
		expect(lastLogLevel()).toBe('standard')

		resolveActive()(terminalMeta('test-run-0', 'defaulted task'))
		await submission.awaitActive()
	})

	test('rejects an unknown logLevel with 400 invalid_body', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(post('/api/runs', JSON.stringify({ task: 'x', logLevel: 'quiet' })))
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({ ok: false, error: 'invalid_body' })
	})

	test('rejects a numeric logLevel with 400 invalid_body', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(post('/api/runs', JSON.stringify({ task: 'x', logLevel: 1 })))
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({ ok: false, error: 'invalid_body' })
	})

	test('accepts a valid continuesFrom and threads the resolved continuation into the started run', async () => {
		const { handler, submission, lastContinuation, resolveActive } = createHandlerHarness()
		const response = await handler(post('/api/runs', JSON.stringify({ task: 'pick up where that left off', continuesFrom: 'run-20260101-000000' })))
		expect(response.status).toBe(201)
		expect(lastContinuation()).toEqual({ runId: 'run-20260101-000000', task: 'prior run task', summary: 'prior run finished cleanly' })

		resolveActive()(terminalMeta('test-run-0', 'pick up where that left off'))
		await submission.awaitActive()
	})

	test('threads no continuation when continuesFrom is absent', async () => {
		const { handler, submission, lastContinuation, resolveActive } = createHandlerHarness()
		const response = await handler(post('/api/runs', JSON.stringify({ task: 'a fresh task' })))
		expect(response.status).toBe(201)
		expect(lastContinuation()).toBeUndefined()

		resolveActive()(terminalMeta('test-run-0', 'a fresh task'))
		await submission.awaitActive()
	})

	test('rejects an unknown continuesFrom run id with 400 invalid_body', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(post('/api/runs', JSON.stringify({ task: 'x', continuesFrom: 'run-19990101-000000' })))
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({ ok: false, error: 'invalid_body' })
	})

	test('rejects continuing a run whose meta still says running with 400 invalid_body', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(post('/api/runs', JSON.stringify({ task: 'x', continuesFrom: 'run-active' })))
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({ ok: false, error: 'invalid_body' })
	})

	test('rejects a malformed continuesFrom with 400 invalid_body', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(post('/api/runs', JSON.stringify({ task: 'x', continuesFrom: 'not-a-run-id' })))
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({ ok: false, error: 'invalid_body' })
	})
})

describe('/api/questions and /api/answer', () => {
	test('GET /api/questions returns the pending list and POST /api/answer resolves the ask', async () => {
		const { handler, humanBackend } = createHandlerHarness()
		const askPromise = humanBackend.ask('Which framework?', 'src/index.ts')

		const response = await handler(get('/api/questions'))
		expect(response.status).toBe(200)
		const questions = await response.json()
		expect(questions.length).toBe(1)
		expect(questions[0].question).toBe('Which framework?')
		expect(questions[0].context).toBe('src/index.ts')
		expect(typeof questions[0].id).toBe('string')

		const id = questions[0].id
		const answerResponse = await handler(post('/api/answer', JSON.stringify({ id, answer: 'react' })))
		expect(answerResponse.status).toBe(200)
		expect(await answerResponse.json()).toEqual({ ok: true })

		expect(await askPromise).toBe('react')

		const afterResponse = await handler(get('/api/questions'))
		const afterQuestions = await afterResponse.json()
		expect(afterQuestions).toEqual([])
	})

	test('POST /api/answer for an unknown id returns 404 not_found', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(post('/api/answer', JSON.stringify({ id: 'does-not-exist', answer: 'whatever' })))
		expect(response.status).toBe(404)
		expect(await response.json()).toEqual({ ok: false, error: 'not_found' })
	})

	test('POST /api/answer with malformed json returns 400 invalid_body', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(post('/api/answer', '{ not json'))
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({ ok: false, error: 'invalid_body' })
	})

	test('POST /api/answer with a missing id returns 400 invalid_body', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(post('/api/answer', JSON.stringify({ answer: 'no id' })))
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({ ok: false, error: 'invalid_body' })
	})
})

describe('startup resume', () => {
	test('a resumed run takes the active slot under its original run id and is served by the alias', async () => {
		const { handler, submission, resolveResumed, resumedCheckpoints } = createHandlerHarness()
		const checkpoint = resumeCheckpoint('run-restored')
		submission.resume(checkpoint)

		expect(submission.activeRunId()).toBe('run-restored')
		expect(resumedCheckpoints()).toEqual([checkpoint])
		const response = await handler(get('/api/run'))
		expect(response.status).toBe(200)
		const view = await response.json()
		expect(view.runId).toBe('run-restored')

		resolveResumed()(terminalMeta('run-restored', 'restored task'))
		await submission.awaitActive()
		expect(submission.activeRunId()).toBeUndefined()
	})
})

describe('POST /api/runs/:id/interrupt', () => {
	test('an inquiry for the active run is accepted with 202 and queued for the engine', async () => {
		const { handler, submission, interruptChannel } = createHandlerHarness()
		const queue = createInterruptQueue()
		interruptChannel.bindQueue(queue)
		const submitted = submission.submit('a task')
		if (!submitted.ok) throw new Error('submit failed')

		const response = await handler(post(`/api/runs/${submitted.runId}/interrupt`, JSON.stringify({ kind: 'inquiry', message: 'how is it going?' })))
		expect(response.status).toBe(202)
		expect(await response.json()).toEqual({ ok: true })
		expect(queue.drain()).toEqual({ kind: 'inquiry', message: 'how is it going?' })
	})

	test('an interrupt for a non-active or unknown run is rejected with 409', async () => {
		const { handler, submission, interruptChannel } = createHandlerHarness()
		interruptChannel.bindQueue(createInterruptQueue())
		const submitted = submission.submit('a task')
		if (!submitted.ok) throw new Error('submit failed')

		const stale = await handler(post('/api/runs/some-other-run/interrupt', JSON.stringify({ kind: 'inquiry', message: 'hello?' })))
		expect(stale.status).toBe(409)
		expect(await stale.json()).toEqual({ ok: false, error: 'run_not_active' })
	})

	test('an interrupt with no active run at all is rejected with 409', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(post('/api/runs/anything/interrupt', JSON.stringify({ kind: 'plan_modification', message: 'change course' })))
		expect(response.status).toBe(409)
		expect(await response.json()).toEqual({ ok: false, error: 'run_not_active' })
	})

	test('an interrupt with a bad kind or empty message is rejected with 400', async () => {
		const { handler, submission, interruptChannel } = createHandlerHarness()
		interruptChannel.bindQueue(createInterruptQueue())
		const submitted = submission.submit('a task')
		if (!submitted.ok) throw new Error('submit failed')

		const badKind = await handler(post(`/api/runs/${submitted.runId}/interrupt`, JSON.stringify({ kind: 'explode', message: 'boom' })))
		expect(badKind.status).toBe(400)
		const emptyMessage = await handler(post(`/api/runs/${submitted.runId}/interrupt`, JSON.stringify({ kind: 'inquiry', message: '' })))
		expect(emptyMessage.status).toBe(400)
	})

	test('GET /api/runs/:id exposes whether an interrupt is pending for the active run only', async () => {
		const { handler, submission, interruptChannel, resolveActive } = createHandlerHarness()
		interruptChannel.bindQueue(createInterruptQueue())
		const submitted = submission.submit('a task')
		if (!submitted.ok) throw new Error('submit failed')

		const before = await handler(get(`/api/runs/${submitted.runId}`))
		expect(before.status).toBe(200)
		expect((await before.json()).interruptPending).toBe(false)

		interruptChannel.submit({ kind: 'inquiry', message: 'ping' })
		const after = await handler(get(`/api/runs/${submitted.runId}`))
		expect(after.status).toBe(200)
		expect((await after.json()).interruptPending).toBe(true)

		// The pending interrupt belongs to the active run: a terminal run viewed while it is still queued must report false, not inherit the channel's state.
		const terminal = await handler(get('/api/runs/run-1'))
		expect(terminal.status).toBe(200)
		expect((await terminal.json()).interruptPending).toBe(false)

		resolveActive()(terminalMeta('test-run-0', 'a task'))
		await submission.awaitActive()
	})

	test('a malformed percent-encoding in the path is a 404, not a crash', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(post('/api/runs/%/interrupt', JSON.stringify({ kind: 'inquiry', message: 'hello?' })))
		expect(response.status).toBe(404)
		expect(await response.json()).toEqual({ ok: false, error: 'not_found' })
	})
})

describe('/api/settings', () => {
	test('GET /api/settings returns null defaults when nothing is set', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/settings'))
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ effort: null, logLevel: null })
	})

	test('GET /api/settings returns the stored defaults after a write', async () => {
		const { handler, settings } = createHandlerHarness()
		settings.write({ effort: 'thorough', logLevel: 'standard' })
		const response = await handler(get('/api/settings'))
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ effort: 'thorough', logLevel: 'standard' })
	})

	test('PUT /api/settings persists the effort and echoes it back', async () => {
		const { handler, settings } = createHandlerHarness()
		const response = await handler(put('/api/settings', JSON.stringify({ effort: 'standard' })))
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ effort: 'standard', logLevel: null })
		expect(settings.snapshot()).toEqual({ effort: 'standard' })

		const getResponse = await handler(get('/api/settings'))
		expect(await getResponse.json()).toEqual({ effort: 'standard', logLevel: null })
	})

	test('PUT /api/settings persists an optional logLevel and echoes it back', async () => {
		const { handler, settings } = createHandlerHarness()
		const response = await handler(put('/api/settings', JSON.stringify({ effort: 'standard', logLevel: 'standard' })))
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ effort: 'standard', logLevel: 'standard' })
		expect(settings.snapshot()).toEqual({ effort: 'standard', logLevel: 'standard' })

		const getResponse = await handler(get('/api/settings'))
		expect(await getResponse.json()).toEqual({ effort: 'standard', logLevel: 'standard' })
	})

	test('PUT /api/settings without logLevel clears a previously persisted one', async () => {
		const { handler, settings } = createHandlerHarness()
		settings.write({ effort: 'quick', logLevel: 'standard' })

		const response = await handler(put('/api/settings', JSON.stringify({ effort: 'quick' })))
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ effort: 'quick', logLevel: null })
		expect(settings.snapshot()).toEqual({ effort: 'quick' })
	})

	test('PUT /api/settings rejects a missing effort with 400 invalid_body', async () => {
		const { handler, settings } = createHandlerHarness()
		const response = await handler(put('/api/settings', JSON.stringify({ notEffort: 1 })))
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({ ok: false, error: 'invalid_body' })
		expect(settings.snapshot()).toEqual({})
	})

	test('PUT /api/settings rejects a numeric effort with 400 invalid_body', async () => {
		const { handler, settings } = createHandlerHarness()
		const response = await handler(put('/api/settings', JSON.stringify({ effort: 3 })))
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({ ok: false, error: 'invalid_body' })
		expect(settings.snapshot()).toEqual({})
	})

	test('PUT /api/settings rejects an invalid logLevel with 400 invalid_body', async () => {
		const { handler, settings } = createHandlerHarness()
		const response = await handler(put('/api/settings', JSON.stringify({ effort: 'quick', logLevel: 'tiny' })))
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({ ok: false, error: 'invalid_body' })
		expect(settings.snapshot()).toEqual({})
	})

	test('PUT /api/settings rejects malformed json with 400 invalid_body', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(put('/api/settings', '{ not json'))
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({ ok: false, error: 'invalid_body' })
	})
})
