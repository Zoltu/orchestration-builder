import { describe, expect, test } from 'bun:test'
import { createWebHumanBackend, type WebHumanBackend } from '../executor/human-backend.ts'
import { createInterruptChannel, createInterruptQueue, type InterruptChannel } from '../executor/interrupts.ts'
import { createRunState } from '../executor/run-state.ts'
import { createRunSubmission, type ResumeRun, type RunSubmission, type StartRun } from '../executor/run-submission.ts'
import type { RunCheckpoint } from '../executor/checkpoint.ts'
import type { ProjectSettings, ReadProjectSettings, WriteProjectSettings, RunSnapshotRaw, RunSnapshotStats } from '../executor/persistence.ts'
import type { GuildConfig, RunMeta } from '../executor/types.js'
import { parseRunSnapshot, type RunSnapshot } from './render.ts'
import { createRequestHandler, type RequestHandler } from './request-handler.ts'
import { resolveStaticAsset } from './server.ts'

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
])

const unknownRunIds = new Set(['never-started'])

const sampleGuildConfig: GuildConfig = {
	schemaVersion: 1,
	model: {
		name: 'qwen3.6:35b',
		apiBase: 'http://llama-server:8080/v1',
		apiKey: 'secret-key',
		contextWindow: 262144,
		reasoningField: 'reasoning',
		generation: { temperature: 0.2, maxTokens: 32768 },
	},
	executor: {
		maxAgentDepth: 8,
		defaultToolTimeoutSeconds: 30,
		maxCompactionAttempts: 5,
	},
	contextPolicy: { maxToolOutputChars: 8000 },
	entryRole: 'orchestrator',
	roles: {
		orchestrator: { systemPrompt: 'prompts/orchestrator.md', tools: ['agent', 'ask_human', 'finish'] },
		coder: { systemPrompt: 'prompts/coder.md', tools: ['read_file', 'write_file', 'finish'] },
	},
	tools: ['tools/agent.json', 'tools/finish.json'],
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

function readRunSnapshotStats(runId: string): RunSnapshotStats {
	const raw = rawSnapshotById(runId)
	return {
		meta: raw.metaText === null ? null : { size: raw.metaText.length, mtimeMs: 1 },
		log: raw.logText === '' ? null : { size: raw.logText.length, mtimeMs: 1 },
	}
}

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

// A run whose orchestrator delegates to coder twice (first errors, second succeeds) — mirrors a retry — so the per-invocation tree, the per-invocation status, and the inline error surfacing are all exercised end to end. Pre-fix this would have shown one merged coder pulsing while reading "error" despite the run succeeding.
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
		effort: 4,
		status: 'success',
		startTime: '2026-01-01T00:00:00.000Z',
		endTime: '2026-01-01T00:01:00.000Z',
	}),
	logText: [
		JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', type: 'effort_set', payload: { effort: 4 } }),
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
	lastEffort: () => number | undefined
	resolveActive: () => (meta: RunMeta) => void
	resolveResumed: () => (meta: RunMeta) => void
	resumedCheckpoints: () => RunCheckpoint[]
}

// Builds a fresh handler whose startRun and resumeRun park on caller-controlled resolvers, so each test drives its own run lifecycle without touching shared state. The static leaf is a recording fake; every dependency is in-memory.
function createHandlerHarness(): HandlerHarness {
	let resolveActive: (meta: RunMeta) => void = () => {}
	let resolveResumed: (meta: RunMeta) => void = () => {}
	let capturedEffort: number | undefined
	const resumed: RunCheckpoint[] = []
	const startRun: StartRun = (_runId, _task, effort) => {
		capturedEffort = effort
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
	const submission = createRunSubmission({ startRun, resumeRun, generateRunId: () => `test-run-${nextId++}`, readProjectSettings: settings.read })
	const interruptChannel = createInterruptChannel()
	const humanBackend = createWebHumanBackend()
	const staticCalls: string[] = []
	const handler = createRequestHandler(
		{
			guildConfig: sampleGuildConfig,
			tools: {},
			runState: createRunState({ humanBackend, interruptChannel }),
			runSubmission: submission,
			readRunSnapshot,
			readRunMetaById,
			readRunSummaryById,
			readRunSnapshotStats,
			listRunIds,
			readProjectSettings: settings.read,
			writeProjectSettings: settings.write,
		},
		(requestPath) => {
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
		expect(list.length).toBe(9)
		expect(list[0].runId).toBe('run-tree')
		expect(list[1].runId).toBe('run-retry')
		expect(list[2].runId).toBe('run-long')
		expect(list[3].runId).toBe('run-interrupted')
		expect(list[4].runId).toBe('run-effort')
		expect(list[5].runId).toBe('run-cached')
		expect(list[6].runId).toBe('run-3')
		expect(list[7].runId).toBe('run-2')
		expect(list[8].runId).toBe('run-1')
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
		expect(list[4]).toEqual({
			runId: 'run-effort',
			status: 'success',
			task: 'task for run-effort',
			effort: 4,
			startTime: '2026-01-01T00:00:00.000Z',
			endTime: '2026-01-01T00:01:00.000Z',
			result: null,
			error: null,
			summary: null,
		})
		expect(list[7]).toEqual({
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
		expect(view.recentLog[0].summary).toBe('planner · llm call')
		expect(view.recentLog[0].payload).toEqual({ role: 'planner', usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } })
		expect(view.error).toBeNull()
		expect(view.currentActivity.role).toBe('planner')
		expect(view.currentActivity.summary).toBe('planner · finished (success)')
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
		expect(view.recentLog[0].summary).toBe('planner · llm call')
		expect(view.recentLog[1].summary).toBe('planner · finished (success)')
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

	test('exposes the role tree and paired raw-payload detail sections for a tree-bearing run', async () => {
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

		// The llm_call entry carries paired detail sections: sent messages, received response, finish reason, and usage.
		const llmEntry = view.recentLog.find((entry: { type: string }) => entry.type === 'llm_call')
		expect(llmEntry.detailSections).not.toBeNull()
		expect(llmEntry.detailSections.map((s: { label: string }) => s.label)).toEqual(['sent', 'received', 'finish reason', 'usage'])
		expect(llmEntry.detailSections[2].content).toBe('tool_calls')

		// The tool_call entry carries the raw arguments; the tool_result entry carries the full un-truncated result.
		const toolCallEntry = view.recentLog.find((entry: { type: string }) => entry.type === 'tool_call')
		expect(toolCallEntry.detailSections.map((s: { label: string }) => s.label)).toEqual(['arguments'])
		expect(toolCallEntry.detailSections[0].content).toBe('{"role":"coder","task":"code"}')
		const toolResultEntry = view.recentLog.find((entry: { type: string }) => entry.type === 'tool_result')
		expect(toolResultEntry.detailSections.map((s: { label: string }) => s.label)).toEqual(['result'])
		expect(toolResultEntry.detailSections[0].content).toEqual({ kind: 'success', data: { status: 'success', summary: 'coded' } })
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

		// The erroring coder's role_finished shows status only in the one-line summary (the model's full prose is kept out of the row), with the summary text and structured error reachable as paired detail sections.
		const errorFinish = view.recentLog.find((entry: { type: string; summary: string }) => entry.type === 'role_finished' && entry.summary === 'coder · finished (error)')
		expect(errorFinish).toBeDefined()
		expect(errorFinish.detailSections.map((s: { label: string }) => s.label)).toEqual(['summary', 'error'])
		expect(errorFinish.detailSections[0].content).toBe('file not found')
		expect(errorFinish.detailSections[1].content).toEqual({ kind: 'invalid_arguments', message: 'no such file' })
	})

	test('includes the run effort from meta.effort, or null when the run predates the channel', async () => {
		const { handler } = createHandlerHarness()
		const withEffort = await handler(get('/api/runs/run-effort'))
		expect(withEffort.status).toBe(200)
		expect((await withEffort.json()).effort).toBe(4)

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
		expect(body.limit).toBe(200)
		expect(body.events.length).toBe(200)
		expect(body.events[0].timestamp).toBe('t000')
		expect(body.events[199].timestamp).toBe('t199')
		expect(body.events[0].summary).toBe('planner · llm call')
		expect(body.events[0].payload).toEqual({ role: 'planner' })
	})

	test('returns a later page with explicit offset and limit', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/run-long/log?offset=240&limit=20'))
		expect(response.status).toBe(200)
		const body = await response.json()
		expect(body.total).toBe(250)
		expect(body.offset).toBe(240)
		expect(body.limit).toBe(20)
		expect(body.events.length).toBe(10)
		expect(body.events[0].timestamp).toBe('t240')
		expect(body.events[9].timestamp).toBe('t249')
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
		expect(body.limit).toBe(200)
		expect(body.events.length).toBe(200)
	})

	test('returns 404 for an unknown run id', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/runs/never-started/log'))
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
		const response = await handler(post('/api/runs', JSON.stringify({ task: 'careful task', effort: 5 })))
		expect(response.status).toBe(201)
		expect(lastEffort()).toBe(5)

		resolveActive()(terminalMeta('test-run-0', 'careful task'))
		await submission.awaitActive()
	})

	test('applies the project default when effort is omitted', async () => {
		const { handler, submission, settings, lastEffort, resolveActive } = createHandlerHarness()
		settings.write({ effort: 2 })
		const response = await handler(post('/api/runs', JSON.stringify({ task: 'defaulted task' })))
		expect(response.status).toBe(201)
		expect(lastEffort()).toBe(2)

		resolveActive()(terminalMeta('test-run-0', 'defaulted task'))
		await submission.awaitActive()
	})

	test('rejects an out-of-range effort with 400 invalid_body', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(post('/api/runs', JSON.stringify({ task: 'x', effort: 6 })))
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({ ok: false, error: 'invalid_body' })
	})

	test('rejects a non-integer effort with 400 invalid_body', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(post('/api/runs', JSON.stringify({ task: 'x', effort: 2.5 })))
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

	test('GET /api/runs/:id exposes whether an interrupt is pending', async () => {
		const { handler, interruptChannel } = createHandlerHarness()
		const knownRunId = 'run-a'
		interruptChannel.bindQueue(createInterruptQueue())

		const before = await handler(get(`/api/runs/${knownRunId}`))
		expect(before.status).toBe(200)
		expect((await before.json()).interruptPending).toBe(false)

		interruptChannel.submit({ kind: 'inquiry', message: 'ping' })
		const after = await handler(get(`/api/runs/${knownRunId}`))
		expect(after.status).toBe(200)
		expect((await after.json()).interruptPending).toBe(true)
	})
})

describe('/api/settings', () => {
	test('GET /api/settings returns effort null when no default is set', async () => {
		const { handler } = createHandlerHarness()
		const response = await handler(get('/api/settings'))
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ effort: null })
	})

	test('GET /api/settings returns the stored default after a write', async () => {
		const { handler, settings } = createHandlerHarness()
		settings.write({ effort: 4 })
		const response = await handler(get('/api/settings'))
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ effort: 4 })
	})

	test('PUT /api/settings persists the effort and echoes it back', async () => {
		const { handler, settings } = createHandlerHarness()
		const response = await handler(put('/api/settings', JSON.stringify({ effort: 3 })))
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ effort: 3 })
		expect(settings.snapshot()).toEqual({ effort: 3 })

		const getResponse = await handler(get('/api/settings'))
		expect(await getResponse.json()).toEqual({ effort: 3 })
	})

	test('PUT /api/settings rejects a missing effort with 400 invalid_body', async () => {
		const { handler, settings } = createHandlerHarness()
		const response = await handler(put('/api/settings', JSON.stringify({ notEffort: 1 })))
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({ ok: false, error: 'invalid_body' })
		expect(settings.snapshot()).toEqual({})
	})

	test('PUT /api/settings rejects an out-of-range effort with 400 invalid_body', async () => {
		const { handler, settings } = createHandlerHarness()
		const response = await handler(put('/api/settings', JSON.stringify({ effort: 7 })))
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
