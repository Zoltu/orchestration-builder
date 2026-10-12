import { describe, expect, test } from 'bun:test'

import type { ContextPolicy, DeploymentConfig, ExecutorConfig, GuildConfig, LogEvent, ResolvedModelConfig, RoleDefinition, RunContinuation, RunMeta, ToolCall, ToolManifest } from './types.js'
import { isRunCheckpoint, type RunCheckpoint } from './checkpoint.ts'
import { resumeExecutor, runExecutor, type ExecutorDependencies } from './executor.ts'
import { createInterruptQueue } from './interrupts.ts'
import type { LlmCallResult, LlmCaller } from './llm.ts'
import type { LoadedGuild } from './loader.ts'
import type { AppendLog, DeleteCheckpoint, RunDirectory, WriteCheckpoint, WriteMeta } from './persistence.ts'
import { createFakeRoleSnapshotStore, stubHumanBackend, recordingHumanBackend, defined } from './test-fixtures.ts'

function success(toolCalls: ToolCall[], opts: { content?: string } = {}): LlmCallResult {
	return {
		kind: 'success',
		content: opts.content ?? '',
		reasoning: null,
		toolCalls,
		usage: { promptTokens: 10, completionTokens: 5 },
	}
}

class FakeLlm implements LlmCaller {
	responses: LlmCallResult[] = []
	calls = 0
	async call(): Promise<LlmCallResult> {
		this.calls++
		if (this.responses.length === 0) {
			throw new Error('FakeLlm ran out of responses')
		}
		const next = this.responses.shift()
		if (next === undefined) throw new Error('FakeLlm ran out of responses')
		return next
	}
}

interface FakePersistenceFns {
	appendLog: AppendLog
	createRunDirectory: RunDirectory
	writeMeta: WriteMeta
	writeCheckpoint: WriteCheckpoint
	deleteCheckpoint: DeleteCheckpoint
	state: {
		events: LogEvent[]
		meta: RunMeta | null
		metas: RunMeta[]
		checkpoints: RunCheckpoint[]
		deleteCheckpointCalls: number
		createRunDirectoryCalls: number
	}
}

function makeFakePersistence(): FakePersistenceFns {
	const events: LogEvent[] = []
	const metas: RunMeta[] = []
	const checkpoints: RunCheckpoint[] = []
	let meta: RunMeta | null = null
	let createRunDirectoryCalls = 0
	let deleteCheckpointCalls = 0
	return {
		appendLog: (event) => {
			events.push(event)
		},
		createRunDirectory: () => {
			createRunDirectoryCalls++
			return '/tmp/run'
		},
		writeMeta: (written) => {
			meta = written
			metas.push(written)
		},
		writeCheckpoint: (checkpoint) => {
			const copy: unknown = JSON.parse(JSON.stringify(checkpoint))
			if (!isRunCheckpoint(copy)) throw new Error('runExecutor wrote a checkpoint the guard rejects')
			checkpoints.push(copy)
		},
		deleteCheckpoint: () => {
			deleteCheckpointCalls++
		},
		state: {
			get events() {
				return events
			},
			get meta() {
				return meta
			},
			get metas() {
				return metas
			},
			get checkpoints() {
				return checkpoints
			},
			get deleteCheckpointCalls() {
				return deleteCheckpointCalls
			},
			get createRunDirectoryCalls() {
				return createRunDirectoryCalls
			},
		},
	}
}

const baseExecutor: ExecutorConfig = {
	maxAgentDepth: 8,
	defaultToolTimeoutSeconds: 30,
	maxCompactionAttempts: 5,
}

const baseModel: ResolvedModelConfig = {
	name: 'm',
	apiBase: 'http://x',
	contextWindow: 32768,
	generation: {},
}

const baseContextPolicy: ContextPolicy = { maxToolOutputChars: 4000 }

const finishManifest: ToolManifest = {
	name: 'finish',
	description: 'Finish the current role.',
	parameters: {
		type: 'object',
		required: ['status', 'summary'],
		properties: {
			status: { type: 'string' },
			summary: { type: 'string' },
		},
	},
}

function buildLoadedGuild(roles: Record<string, RoleDefinition>, entryRole: string): LoadedGuild {
	const config: GuildConfig = {
		entryRole,
		roles,
		tools: ['guild/tools/finish.json'],
	}
	const deployment: DeploymentConfig = {
		model: baseModel,
		executor: baseExecutor,
		contextPolicy: baseContextPolicy,
	}
	const prompts: Record<string, string> = {}
	for (const name of Object.keys(roles)) {
		prompts[name] = `prompt for ${name}`
	}
	const tools: Record<string, ToolManifest> = { finish: finishManifest }
	return { config, deployment, prompts, tools }
}

function makeDeps(llm: FakeLlm, persistence: FakePersistenceFns, loadedGuild: LoadedGuild): ExecutorDependencies {
	return {
		llmCaller: llm,
		appendLog: persistence.appendLog,
		createRunDirectory: persistence.createRunDirectory,
		writeMeta: persistence.writeMeta,
		writeCheckpoint: persistence.writeCheckpoint,
		deleteCheckpoint: persistence.deleteCheckpoint,
		additionalToolHandlers: {},
		humanBackend: stubHumanBackend,
		loadedGuild,
		interruptQueue: createInterruptQueue(),
		publishDelta: () => undefined,
		roleSnapshots: createFakeRoleSnapshotStore(),
		readProjectDoc: () => ({ kind: 'unavailable', reason: 'not used in these tests' }),
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

describe('runExecutor', () => {
	test('happy path: creates run dir, loads Guild, runs entry, writes meta', async () => {
		const guild = buildLoadedGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([{
				id: 'f1',
				type: 'function',
				function: {
					name: 'finish',
					arguments: JSON.stringify({ status: 'success', summary: 'all done' }),
				},
			}]),
		]
		const persistence = makeFakePersistence()
		const deps = makeDeps(llm, persistence, guild)

		const meta = await runExecutor(deps, {
			runId: 'r1',
			guildPath: '/guild',
			benchmarkPath: '/bench',
			task: 'do it',
			effort: 'standard',
		})

		expect(persistence.state.createRunDirectoryCalls).toBe(1)
		expect(persistence.state.meta).not.toBeNull()
		expect(meta.runId).toBe('r1')
		expect(meta.guildPath).toBe('/guild')
		expect(meta.benchmarkPath).toBe('/bench')
		expect(meta.task).toBe('do it')
		expect(meta.status).toBe('success')
		expect(meta.result).toEqual({ status: 'success', summary: 'all done' })
		expect(meta.startTime).toBeDefined()
		expect(meta.endTime).toBeDefined()
		// A running meta is written before the entry role runs and overwritten by the terminal meta on completion, so the UI can show task/start time while the run is in progress.
		expect(persistence.state.metas.length).toBe(2)
		const runningMeta = defined(persistence.state.metas[0], 'first written meta')
		expect(runningMeta.status).toBe('running')
		expect(runningMeta.runId).toBe('r1')
		expect(runningMeta.task).toBe('do it')
		expect(runningMeta.endTime).toBeUndefined()
	})

	test('error path: entry role returns error → meta.status is error', async () => {
		const guild = buildLoadedGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([{
				id: 'f1',
				type: 'function',
				function: {
					name: 'finish',
					arguments: JSON.stringify({
						status: 'error',
						summary: 'failed',
						error: { kind: 'tool_budget_exceeded', message: 'too many' },
					}),
				},
			}]),
		]
		const persistence = makeFakePersistence()
		const deps = makeDeps(llm, persistence, guild)

		const meta = await runExecutor(deps, {
			runId: 'r2',
			guildPath: '/guild',
			benchmarkPath: '/bench',
			task: 'do it',
			effort: 'standard',
		})

		expect(meta.status).toBe('error')
		if (meta.result) {
			expect(meta.result.status).toBe('error')
			if (meta.result.error) {
				expect(meta.result.error.kind).toBe('tool_budget_exceeded')
			}
		}
		expect(persistence.state.meta?.status).toBe('error')
	})

	test('the queue-tracking mark rides RunOptions into the park tracker: a marked run parks a pre-write ask, an unmarked one blocks', async () => {
		const askHumanManifest: ToolManifest = {
			name: 'ask_human',
			description: 'Ask a human a question.',
			parameters: { type: 'object', required: ['question'], properties: { question: { type: 'string' } } },
		}
		const guild: LoadedGuild = {
			config: { entryRole: 'main', roles: { main: { systemPrompt: 'p', tools: ['ask_human', 'finish'] } }, tools: [] },
			deployment: { model: baseModel, executor: baseExecutor, contextPolicy: baseContextPolicy },
			prompts: { main: 'prompt for main' },
			tools: { finish: finishManifest, ask_human: askHumanManifest },
		}
		const human = recordingHumanBackend()
		const askCall: ToolCall = { id: 'ask_1', type: 'function', function: { name: 'ask_human', arguments: JSON.stringify({ question: 'Which database?' }) } }
		const finishCall: ToolCall = { id: 'f1', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ status: 'success', summary: 'done' }) } }

		const parkedLlm = new FakeLlm()
		parkedLlm.responses = [success([askCall])]
		const parkedPersistence = makeFakePersistence()
		const parkedMeta = await runExecutor(makeDeps(parkedLlm, parkedPersistence, guild), {
			runId: 'r1',
			guildPath: '/guild',
			task: 'do it',
			effort: 'standard',
			queueTracked: true,
		})
		expect(parkedMeta.status).toBe('needs_clarification')
		expect(parkedMeta.result?.summary).toBe('waiting for an answer to: Which database?')
		expect(human.questions).toEqual([])

		const blockingLlm = new FakeLlm()
		blockingLlm.responses = [success([askCall]), success([finishCall])]
		const blockingPersistence = makeFakePersistence()
		const blockingDeps = makeDeps(blockingLlm, blockingPersistence, guild)
		blockingDeps.humanBackend = human
		const blockingMeta = await runExecutor(blockingDeps, {
			runId: 'r2',
			guildPath: '/guild',
			task: 'do it',
			effort: 'standard',
		})
		expect(blockingMeta.status).toBe('success')
		expect(human.questions).toEqual([{ question: 'Which database?', context: undefined }])
	})

	test('meta.json contains run id, guild path, status, and final result', async () => {
		const guild = buildLoadedGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([], { content: 'finished' }),
		]
		const persistence = makeFakePersistence()
		const deps = makeDeps(llm, persistence, guild)

		const meta = await runExecutor(deps, {
			runId: 'r3',
			guildPath: '/guild',
			benchmarkPath: '/bench',
			task: 'implicit',
			effort: 'standard',
		})

		expect(persistence.state.meta).not.toBeNull()
		const written = persistence.state.meta
		expect(written).not.toBeNull()
		if (written === null) throw new Error('expected the terminal meta write')
		expect(written.runId).toBe('r3')
		expect(written.guildPath).toBe('/guild')
		expect(written.status).toBe('success')
		expect(written.result).toBeDefined()
		expect(meta.result).toEqual(written.result)
	})

	test('persists every LLM call and tool call via appendLog', async () => {
		const guild = buildLoadedGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([{
				id: 'f1',
				type: 'function',
				function: {
					name: 'finish',
					arguments: JSON.stringify({ status: 'success', summary: 'ok' }),
				},
			}]),
		]
		const persistence = makeFakePersistence()
		const deps = makeDeps(llm, persistence, guild)

		await runExecutor(deps, {
			runId: 'r4',
			guildPath: '/guild',
			benchmarkPath: '/bench',
			task: 'do it',
			effort: 'standard',
		})

		const eventTypes = persistence.state.events.map((e) => e.type)
		expect(eventTypes).toContain('role_start')
		expect(eventTypes).toContain('llm_call')
		expect(eventTypes).toContain('tool_call')
		expect(eventTypes).toContain('tool_result')
		expect(eventTypes).toContain('role_finished')
		const finished = persistence.state.events.find((e) => e.type === 'role_finished')
		expect(finished).toBeDefined()
		const finishedPayload = defined(finished, 'role_finished event').payload
		expect(isRecord(finishedPayload)).toBe(true)
		if (isRecord(finishedPayload)) {
			expect(finishedPayload['role']).toBe('main')
			expect(finishedPayload['depth']).toBe(0)
			expect(finishedPayload['status']).toBe('success')
			expect('parent' in finishedPayload).toBe(false)
		}
	})

	test('logs an effort_set event once at run start and carries effort into the meta', async () => {
		const guild = buildLoadedGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [success([{
			id: 'f1',
			type: 'function',
			function: { name: 'finish', arguments: JSON.stringify({ status: 'success', summary: 'ok' }) },
		}])]
		const persistence = makeFakePersistence()
		const deps = makeDeps(llm, persistence, guild)

		const meta = await runExecutor(deps, {
			runId: 'r-effort',
			guildPath: '/guild',
			benchmarkPath: '/bench',
			task: 'do it',
			effort: 'thorough',
		})

		const effortSetEvents = persistence.state.events.filter((e) => e.type === 'effort_set')
		expect(effortSetEvents.length).toBe(1)
		const effortEvent = defined(effortSetEvents[0], 'effort_set event')
		const effortPayload = effortEvent.payload
		expect(isRecord(effortPayload)).toBe(true)
		if (isRecord(effortPayload)) expect(effortPayload['effort']).toBe('thorough')
		// effort_set is the first event, ahead of the entry role's role_start.
		expect(defined(persistence.state.events[0], 'first logged event').type).toBe('effort_set')
		expect(meta.effort).toBe('thorough')
		expect(persistence.state.meta?.effort).toBe('thorough')
	})

	test('a continuation run writes continuesFrom into both metas and briefs the entry role once', async () => {
		const guild = buildLoadedGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [success([{
			id: 'f1',
			type: 'function',
			function: { name: 'finish', arguments: JSON.stringify({ status: 'success', summary: 'ok' }) },
		}])]
		const persistence = makeFakePersistence()
		const deps = makeDeps(llm, persistence, guild)
		const continuation = { runId: 'run-20260101-000000', task: 'prior task', summary: 'prior summary' }

		const meta = await runExecutor(deps, {
			runId: 'r-cont',
			guildPath: '/guild',
			benchmarkPath: '/bench',
			task: 'do it again',
			effort: 'standard',
			continuation,
		})

		expect(meta.continuesFrom).toBe('run-20260101-000000')
		expect(persistence.state.meta?.continuesFrom).toBe('run-20260101-000000')
		expect(persistence.state.metas.length).toBe(2)
		expect(persistence.state.metas[0]?.continuesFrom).toBe('run-20260101-000000')
		// The briefing is baked into the entry role's initial user message: the task stays the first line and the block follows after a blank line.
		const llmCall = defined(persistence.state.events.find((e) => e.type === 'llm_call'), 'llm_call event')
		const llmPayload = llmCall.payload
		expect(isRecord(llmPayload)).toBe(true)
		if (isRecord(llmPayload)) {
			const sent = llmPayload['sent']
			expect(Array.isArray(sent)).toBe(true)
			if (Array.isArray(sent)) {
				const userMessage = sent[1]
				expect(isRecord(userMessage)).toBe(true)
				if (isRecord(userMessage)) {
					expect(userMessage['role']).toBe('user')
					expect(userMessage['content']).toBe('do it again\n\n[This run continues run run-20260101-000000.] Prior task: prior task\nPrior outcome: prior summary\nThe prior run\'s plan document is available with the read_plan tool (runId: "run-20260101-000000").')
				}
			}
		}
	})

	test('a run without a continuation writes no continuesFrom field', async () => {
		const guild = buildLoadedGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [success([{
			id: 'f1',
			type: 'function',
			function: { name: 'finish', arguments: JSON.stringify({ status: 'success', summary: 'done' }) },
		}])]
		const persistence = makeFakePersistence()
		const deps = makeDeps(llm, persistence, guild)

		const meta = await runExecutor(deps, {
			runId: 'r-plain',
			guildPath: '/guild',
			benchmarkPath: '/bench',
			task: 'do it',
			effort: 'standard',
		})

		expect('continuesFrom' in meta).toBe(false)
		expect(persistence.state.meta).not.toBeNull()
		if (persistence.state.meta !== null) expect('continuesFrom' in persistence.state.meta).toBe(false)
	})

	test('a run with a logging level carries it into both metas and the checkpoint entry frame', async () => {
		const guild = buildLoadedGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [success([{
			id: 'f1',
			type: 'function',
			function: { name: 'finish', arguments: JSON.stringify({ status: 'success', summary: 'ok' }) },
		}])]
		const persistence = makeFakePersistence()
		const deps = makeDeps(llm, persistence, guild)

		const meta = await runExecutor(deps, {
			runId: 'r-log-level',
			guildPath: '/guild',
			benchmarkPath: '/bench',
			task: 'do it',
			effort: 'standard',
			logLevel: 'standard',
		})

		expect(meta.logLevel).toBe('standard')
		expect(persistence.state.meta?.logLevel).toBe('standard')
		expect(persistence.state.metas.length).toBe(2)
		expect(persistence.state.metas[0]?.logLevel).toBe('standard')
		for (const checkpoint of persistence.state.checkpoints) {
			expect(checkpoint.frames[0]?.logLevel).toBe('standard')
		}
	})

	test('a run without a logging level writes no logLevel field and stamps none on checkpoints', async () => {
		const guild = buildLoadedGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [success([{
			id: 'f1',
			type: 'function',
			function: { name: 'finish', arguments: JSON.stringify({ status: 'success', summary: 'ok' }) },
		}])]
		const persistence = makeFakePersistence()
		const deps = makeDeps(llm, persistence, guild)

		const meta = await runExecutor(deps, {
			runId: 'r-no-log-level',
			guildPath: '/guild',
			benchmarkPath: '/bench',
			task: 'do it',
			effort: 'standard',
		})

		expect('logLevel' in meta).toBe(false)
		expect(persistence.state.meta).not.toBeNull()
		if (persistence.state.meta !== null) expect('logLevel' in persistence.state.meta).toBe(false)
		for (const checkpoint of persistence.state.checkpoints) {
			expect(checkpoint.frames[0]?.logLevel).toBeUndefined()
		}
	})
})

describe('resumeExecutor', () => {
	const agentManifest: ToolManifest = {
		name: 'agent',
		description: 'Invoke another role.',
		parameters: {
			type: 'object',
			required: ['role', 'task'],
			properties: {
				role: { type: 'string' },
				task: { type: 'string' },
			},
		},
	}

	function buildDelegationGuild(): LoadedGuild {
		const guild = buildLoadedGuild(
			{
				orchestrator: { systemPrompt: 'p', tools: ['agent', 'finish'] },
				coder: { systemPrompt: 'c', tools: ['finish'] },
			},
			'orchestrator',
		)
		const config: GuildConfig = { ...guild.config, tools: ['guild/tools/finish.json', 'guild/tools/agent.json'] }
		return { config, deployment: guild.deployment, prompts: guild.prompts, tools: { ...guild.tools, agent: agentManifest } }
	}

	function finishToolCall(id: string, summary: string): ToolCall {
		return {
			id,
			type: 'function',
			function: { name: 'finish', arguments: JSON.stringify({ status: 'success', summary }) },
		}
	}

	function agentToolCall(id: string, role: string, task: string): ToolCall {
		return {
			id,
			type: 'function',
			function: { name: 'agent', arguments: JSON.stringify({ role, task }) },
		}
	}

	// Whether a sent llm_call message carries the continuation briefing: the sent list is unknown-shaped, so the content narrows through a local string check.
	function sentCarriesBriefing(message: unknown): boolean {
		if (!isRecord(message)) return false
		const content = message['content']
		return typeof content === 'string' && content.includes('[This run continues run run-20260101-000000.]')
	}

	const resumeOptions = { guildPath: '/guild', benchmarkPath: '/bench' }

	// Drives a full orchestrator→coder run and returns the captured checkpoints; the resumed-run tests then re-enter from the checkpoint taken while the coder was active. Pass a continuation to drive a continuation run (the entry frame then carries the lineage and its history the briefing).
	async function driveUninterruptedRun(continuation?: RunContinuation): Promise<{ meta: RunMeta; checkpoints: RunCheckpoint[] }> {
		const guild = buildDelegationGuild()
		const llm = new FakeLlm()
		llm.responses = [
			success([agentToolCall('a1', 'coder', 'subtask')]),
			success([finishToolCall('f1', 'child done')]),
			success([finishToolCall('f2', 'parent done')]),
		]
		const persistence = makeFakePersistence()
		const deps = makeDeps(llm, persistence, guild)

		const meta = await runExecutor(deps, { runId: 'r-resume', ...resumeOptions, task: 'do it', effort: 'quick', ...(continuation !== undefined ? { continuation } : {}) })
		return { meta, checkpoints: persistence.state.checkpoints }
	}

	test('a resumed run completes with the uninterrupted result, preserving run identity and start time', async () => {
		const uninterrupted = await driveUninterruptedRun()
		// Writes: [orchestrator], [orchestrator+coder], [orchestrator with child card], [orchestrator]. Index 1 is the checkpoint taken while the coder was active.
		const checkpoint = uninterrupted.checkpoints[1]
		if (checkpoint === undefined) throw new Error('expected the mid-descent checkpoint')

		const guild = buildDelegationGuild()
		const llm = new FakeLlm()
		llm.responses = [
			success([finishToolCall('f1', 'child done')]),
			success([finishToolCall('f2', 'parent done')]),
		]
		const persistence = makeFakePersistence()
		const deps = makeDeps(llm, persistence, guild)

		const meta = await resumeExecutor(deps, checkpoint, resumeOptions)

		expect(meta.status).toBe(uninterrupted.meta.status)
		expect(meta.result).toEqual(uninterrupted.meta.result)
		expect(meta.runId).toBe('r-resume')
		expect(meta.task).toBe('do it')
		expect(meta.effort).toBe('quick')
		expect(meta.startTime).toBe(uninterrupted.meta.startTime)
		expect(meta.endTime).toBeDefined()
		expect(llm.calls).toBe(2)
		// The running meta is re-asserted with the original start time before the terminal meta lands, and the checkpoint is deleted once the run is terminal.
		expect(persistence.state.metas.length).toBe(2)
		expect(persistence.state.metas[0]?.status).toBe('running')
		expect(persistence.state.metas[0]?.startTime).toBe(uninterrupted.meta.startTime)
		expect(persistence.state.deleteCheckpointCalls).toBe(1)
		// run_resumed marks the restart boundary ahead of every resumed-role event.
		expect(persistence.state.events[0]?.type).toBe('run_resumed')
		expect(persistence.state.events.some((e) => e.type === 'role_start')).toBe(false)
		expect(persistence.state.events.some((e) => e.type === 'role_finished')).toBe(true)
	})

	test('a resumed continuation run keeps continuesFrom in its metas without re-briefing the history', async () => {
		const continuation = { runId: 'run-20260101-000000', task: 'prior task', summary: 'prior summary' }
		const uninterrupted = await driveUninterruptedRun(continuation)
		const checkpoint = uninterrupted.checkpoints[1]
		if (checkpoint === undefined) throw new Error('expected the mid-descent checkpoint')
		// The pre-restart recorder wrote the lineage onto the entry frame from the entry context.
		expect(checkpoint.frames[0]?.continuesFrom).toBe('run-20260101-000000')

		const guild = buildDelegationGuild()
		const llm = new FakeLlm()
		llm.responses = [
			success([finishToolCall('f1', 'child done')]),
			success([finishToolCall('f2', 'parent done')]),
		]
		const persistence = makeFakePersistence()
		const deps = makeDeps(llm, persistence, guild)

		const meta = await resumeExecutor(deps, checkpoint, resumeOptions)

		expect(meta.continuesFrom).toBe('run-20260101-000000')
		expect(persistence.state.metas.length).toBe(2)
		expect(persistence.state.metas[0]?.continuesFrom).toBe('run-20260101-000000')
		expect(persistence.state.meta?.continuesFrom).toBe('run-20260101-000000')
		// The briefing lives only in the checkpointed history. The resumed turns log their sent lists as deltas against the role's previous request, so the briefing no longer rides along in every event; what must hold is that no sent list ever shows it twice, and the entry role's preserved history — captured in the resumed run's own checkpoints — still carries it exactly once (a resume that re-derived the briefing would double it there).
		const briefingCounts = persistence.state.events
			.filter((e) => e.type === 'llm_call')
			.map((e) => (isRecord(e.payload) && Array.isArray(e.payload['sent']) ? e.payload['sent'] : []))
			.map((sent) => sent.filter(sentCarriesBriefing).length)
		expect(briefingCounts.length).toBeGreaterThan(0)
		expect(briefingCounts.every((count) => count <= 1)).toBe(true)
		const resumedCheckpoint = persistence.state.checkpoints[0]
		if (resumedCheckpoint === undefined) throw new Error('expected a post-resume checkpoint')
		expect(resumedCheckpoint.frames[0]?.roleState.history.filter(sentCarriesBriefing).length).toBe(1)
	})

	test('lineage survives a second restart: post-resume checkpoints keep continuesFrom on the entry frame', async () => {
		const continuation = { runId: 'run-20260101-000000', task: 'prior task', summary: 'prior summary' }
		const firstRun = await driveUninterruptedRun(continuation)
		const firstCheckpoint = firstRun.checkpoints[1]
		if (firstCheckpoint === undefined) throw new Error('expected the mid-descent checkpoint')

		// First restart: the resumed run's own checkpoints must re-stamp the lineage — their contexts carry no live continuation anymore.
		const firstResumeLlm = new FakeLlm()
		firstResumeLlm.responses = [
			success([finishToolCall('f1', 'child done')]),
			success([finishToolCall('f2', 'parent done')]),
		]
		const firstResumePersistence = makeFakePersistence()
		await resumeExecutor(makeDeps(firstResumeLlm, firstResumePersistence, buildDelegationGuild()), firstCheckpoint, resumeOptions)
		// The first write of the resumed run is the re-entered coder's first safe point: the same mid-descent shape, now produced by the resume path.
		const postResumeCheckpoint = firstResumePersistence.state.checkpoints[0]
		if (postResumeCheckpoint === undefined) throw new Error('expected a post-resume checkpoint')
		expect(postResumeCheckpoint.frames[0]?.continuesFrom).toBe('run-20260101-000000')

		// Second restart: resuming the post-resume checkpoint still writes continuesFrom into the metas.
		const secondResumeLlm = new FakeLlm()
		secondResumeLlm.responses = [
			success([finishToolCall('f1', 'child done')]),
			success([finishToolCall('f2', 'parent done')]),
		]
		const secondResumePersistence = makeFakePersistence()
		const meta = await resumeExecutor(makeDeps(secondResumeLlm, secondResumePersistence, buildDelegationGuild()), postResumeCheckpoint, resumeOptions)

		expect(meta.continuesFrom).toBe('run-20260101-000000')
		expect(secondResumePersistence.state.metas.length).toBe(2)
		expect(secondResumePersistence.state.metas[0]?.continuesFrom).toBe('run-20260101-000000')
		expect(secondResumePersistence.state.meta?.continuesFrom).toBe('run-20260101-000000')
	})

	test('the resumed registry is seeded past pre-restart ids so post-resume spawns cannot collide', async () => {
		const uninterrupted = await driveUninterruptedRun()
		const checkpoint = uninterrupted.checkpoints[1]
		if (checkpoint === undefined) throw new Error('expected the mid-descent checkpoint')

		const guild = buildDelegationGuild()
		const llm = new FakeLlm()
		llm.responses = [
			success([finishToolCall('f1', 'child done')]),
			success([agentToolCall('a2', 'coder', 'again')]),
			success([finishToolCall('f3', 'second child done')]),
			success([finishToolCall('f4', 'parent done')]),
		]
		const persistence = makeFakePersistence()
		const deps = makeDeps(llm, persistence, guild)

		const meta = await resumeExecutor(deps, checkpoint, resumeOptions)

		expect(meta.status).toBe('success')
		// The pre-restart run minted two instances, so the coder spawned after the resume mints counter value 3.
		const starts = persistence.state.events.filter((e) => e.type === 'role_start').map((e) => (isRecord(e.payload) ? e.payload['roleId'] : undefined))
		expect(starts).toEqual(['coder-1-3'])
	})

	test('a completed run deletes its checkpoint so a restart never resumes it', async () => {
		const guild = buildLoadedGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [success([finishToolCall('f1', 'done')])]
		const persistence = makeFakePersistence()
		const deps = makeDeps(llm, persistence, guild)

		await runExecutor(deps, { runId: 'r-clean', ...resumeOptions, task: 'do it', effort: 'standard' })

		expect(persistence.state.deleteCheckpointCalls).toBe(1)
	})

	test('a run that ends in error keeps its checkpoint so the operator can explicitly resume it', async () => {
		const guild = buildLoadedGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [success([{
			id: 'f1',
			type: 'function',
			function: { name: 'finish', arguments: JSON.stringify({ status: 'error', summary: 'the endpoint is down', error: { kind: 'llm_unavailable', message: 'connection refused' } }) },
		}])]
		const persistence = makeFakePersistence()
		const deps = makeDeps(llm, persistence, guild)

		const meta = await runExecutor(deps, { runId: 'r-error', ...resumeOptions, task: 'do it', effort: 'standard' })

		expect(meta.status).toBe('error')
		expect(persistence.state.checkpoints.length).toBeGreaterThan(0)
		expect(persistence.state.deleteCheckpointCalls).toBe(0)
	})

	test('a run that parks pre-write deletes its checkpoint — the answer flow continues it as a new run', async () => {
		const askHumanManifest: ToolManifest = {
			name: 'ask_human',
			description: 'Ask a human a question.',
			parameters: { type: 'object', required: ['question'], properties: { question: { type: 'string' } } },
		}
		const guild: LoadedGuild = {
			config: { entryRole: 'main', roles: { main: { systemPrompt: 'p', tools: ['ask_human', 'finish'] } }, tools: [] },
			deployment: { model: baseModel, executor: baseExecutor, contextPolicy: baseContextPolicy },
			prompts: { main: 'prompt for main' },
			tools: { finish: finishManifest, ask_human: askHumanManifest },
		}
		const llm = new FakeLlm()
		llm.responses = [success([{ id: 'ask_1', type: 'function', function: { name: 'ask_human', arguments: JSON.stringify({ question: 'Which database?' }) } }])]
		const persistence = makeFakePersistence()
		const deps = makeDeps(llm, persistence, guild)

		const meta = await runExecutor(deps, {
			runId: 'r-park',
			guildPath: '/guild',
			task: 'do it',
			effort: 'standard',
			queueTracked: true,
		})

		expect(meta.status).toBe('needs_clarification')
		expect(persistence.state.deleteCheckpointCalls).toBe(1)
	})

	test('a resumed run that ends in error also keeps its checkpoint, so it stays resumable', async () => {
		const uninterrupted = await driveUninterruptedRun()
		const checkpoint = uninterrupted.checkpoints[1]
		if (checkpoint === undefined) throw new Error('expected the mid-descent checkpoint')

		const guild = buildDelegationGuild()
		const llm = new FakeLlm()
		// The resumed coder re-enters first (its frame's own turn), then the orchestrator continues and finishes with the error — the terminal error keeps the checkpoint.
		llm.responses = [
			success([finishToolCall('f1', 'child done')]),
			success([{
				id: 'f2',
				type: 'function',
				function: { name: 'finish', arguments: JSON.stringify({ status: 'error', summary: 'still broken', error: { kind: 'llm_unavailable', message: 'connection refused' } }) },
			}]),
		]
		const persistence = makeFakePersistence()
		const deps = makeDeps(llm, persistence, guild)

		const meta = await resumeExecutor(deps, checkpoint, resumeOptions)

		expect(meta.status).toBe('error')
		expect(persistence.state.deleteCheckpointCalls).toBe(0)
	})

	test('a resumed run keeps the logging level recorded on its checkpoint entry frame', async () => {
		const uninterrupted = await driveUninterruptedRun()
		const checkpoint = uninterrupted.checkpoints[1]
		if (checkpoint === undefined) throw new Error('expected the mid-descent checkpoint')
		const entryFrame = checkpoint.frames[0]
		if (entryFrame === undefined) throw new Error('expected an entry frame')
		entryFrame.logLevel = 'standard'

		const guild = buildDelegationGuild()
		const llm = new FakeLlm()
		llm.responses = [
			success([finishToolCall('f1', 'child done')]),
			success([finishToolCall('f2', 'parent done')]),
		]
		const persistence = makeFakePersistence()
		const deps = makeDeps(llm, persistence, guild)

		const meta = await resumeExecutor(deps, checkpoint, resumeOptions)

		expect(meta.logLevel).toBe('standard')
		expect(persistence.state.metas.length).toBe(2)
		expect(persistence.state.metas[0]?.logLevel).toBe('standard')
		expect(persistence.state.meta?.logLevel).toBe('standard')
	})

	test('a checkpoint without a recorded logging level resumes at full detail', async () => {
		const uninterrupted = await driveUninterruptedRun()
		const checkpoint = uninterrupted.checkpoints[1]
		if (checkpoint === undefined) throw new Error('expected the mid-descent checkpoint')
		const entryFrame = checkpoint.frames[0]
		if (entryFrame === undefined) throw new Error('expected an entry frame')
		expect(entryFrame.logLevel).toBeUndefined()

		const guild = buildDelegationGuild()
		const llm = new FakeLlm()
		llm.responses = [
			success([finishToolCall('f1', 'child done')]),
			success([finishToolCall('f2', 'parent done')]),
		]
		const persistence = makeFakePersistence()
		const deps = makeDeps(llm, persistence, guild)

		const meta = await resumeExecutor(deps, checkpoint, resumeOptions)

		expect(meta.logLevel).toBe('full')
		expect(persistence.state.meta?.logLevel).toBe('full')
	})

	test('an explicit resume stamps the operator note on run_resumed and into the resumed leaf history before its first LLM call', async () => {
		const uninterrupted = await driveUninterruptedRun()
		const checkpoint = uninterrupted.checkpoints[1]
		if (checkpoint === undefined) throw new Error('expected the mid-descent checkpoint')

		const guild = buildDelegationGuild()
		const llm = new FakeLlm()
		llm.responses = [
			success([finishToolCall('f1', 'child done')]),
			success([finishToolCall('f2', 'parent done')]),
		]
		const persistence = makeFakePersistence()
		const deps = makeDeps(llm, persistence, guild)

		await resumeExecutor(deps, checkpoint, { ...resumeOptions, operatorNote: 'The operator resumed this run after a failure. Message from the operator: carry on' })

		const resumedEvent = persistence.state.events.find((e) => e.type === 'run_resumed')
		expect(resumedEvent).toBeDefined()
		const resumedPayload = defined(resumedEvent, 'run_resumed event').payload
		expect(isRecord(resumedPayload)).toBe(true)
		if (isRecord(resumedPayload)) expect(resumedPayload['operatorNote']).toBe('The operator resumed this run after a failure. Message from the operator: carry on')
		// The note is the last message of the first post-resume request (the re-entered coder's turn).
		const firstCall = defined(persistence.state.events.find((e) => e.type === 'llm_call'), 'first llm_call event')
		const callPayload = firstCall.payload
		expect(isRecord(callPayload)).toBe(true)
		if (isRecord(callPayload)) {
			const sent = callPayload['sent']
			expect(Array.isArray(sent)).toBe(true)
			if (Array.isArray(sent)) {
				const noteMessage = sent[sent.length - 1]
				expect(isRecord(noteMessage)).toBe(true)
				if (isRecord(noteMessage)) {
					expect(noteMessage['role']).toBe('user')
					expect(noteMessage['content']).toBe('The operator resumed this run after a failure. Message from the operator: carry on')
				}
			}
		}
		// The note rides the same persisted history every message uses: the resumed run's own checkpoints carry it (on the leaf frame it was injected into).
		const postResumeCheckpoint = persistence.state.checkpoints[0]
		if (postResumeCheckpoint === undefined) throw new Error('expected a post-resume checkpoint')
		const noteInHistory = postResumeCheckpoint.frames.some((frame) => frame.roleState.history.some((message) => message.role === 'user' && message.content === 'The operator resumed this run after a failure. Message from the operator: carry on'))
		expect(noteInHistory).toBe(true)
	})

	test('the operator note lands after a suspended turn\'s recorded tool result, never between the agent call and its result', async () => {
		// The error-run checkpoint shape: the child already returned, so the root's suspension carries its recorded card and the resume re-enters the root alone.
		const uninterrupted = await driveUninterruptedRun()
		const checkpoint = uninterrupted.checkpoints[2]
		if (checkpoint === undefined) throw new Error('expected the post-child checkpoint')
		expect(checkpoint.frames.length).toBe(1)
		expect(checkpoint.frames[0]?.pending?.childCard).toBeDefined()

		const guild = buildDelegationGuild()
		const llm = new FakeLlm()
		llm.responses = [success([finishToolCall('f2', 'parent done')])]
		const persistence = makeFakePersistence()
		const deps = makeDeps(llm, persistence, guild)

		await resumeExecutor(deps, checkpoint, { ...resumeOptions, operatorNote: 'The operator resumed this run after a failure. Message from the operator: the child already finished; summarize' })

		const firstCall = defined(persistence.state.events.find((e) => e.type === 'llm_call'), 'first llm_call event')
		const callPayload = firstCall.payload
		expect(isRecord(callPayload)).toBe(true)
		if (isRecord(callPayload)) {
			const sent = callPayload['sent']
			expect(Array.isArray(sent)).toBe(true)
			if (Array.isArray(sent)) {
				// The sent slice must read agent tool_calls → tool result → note: a user message between the assistant call and its result would be a malformed request on strict endpoints.
				const assistantCall = sent[0]
				const toolResult = sent[1]
				const noteMessage = sent[2]
				expect(isRecord(assistantCall) && Array.isArray(assistantCall['tool_calls'])).toBe(true)
				expect(isRecord(toolResult) && toolResult['role'] === 'tool').toBe(true)
				expect(isRecord(noteMessage) && noteMessage['role'] === 'user').toBe(true)
			}
		}
	})

	test('the first post-resume request picks the note up through the delta protocol: a sliced sent list still carries it', async () => {
		// A run that errors on the root's SECOND llm call, so the checkpointed role carries a delta baseline from the first: the resumed request must slice from that baseline and still contain the note.
		const guild = buildDelegationGuild()
		const llm = new FakeLlm()
		llm.responses = [
			success([agentToolCall('a1', 'coder', 'subtask')]),
			success([finishToolCall('f1', 'child done')]),
			{ kind: 'llm_unavailable', message: 'connection refused' },
		]
		const originalPersistence = makeFakePersistence()
		await runExecutor(makeDeps(llm, originalPersistence, guild), { runId: 'r-delta', ...resumeOptions, task: 'do it', effort: 'quick' })
		const checkpoint = originalPersistence.state.checkpoints[originalPersistence.state.checkpoints.length - 1]
		if (checkpoint === undefined) throw new Error('expected the final checkpoint')
		expect(checkpoint.frames[0]?.pending).toBeUndefined()

		const resumedGuild = buildDelegationGuild()
		const resumedLlm = new FakeLlm()
		resumedLlm.responses = [success([finishToolCall('f2', 'parent done')])]
		const persistence = makeFakePersistence()
		const deps = makeDeps(resumedLlm, persistence, resumedGuild)

		await resumeExecutor(deps, checkpoint, { ...resumeOptions, operatorNote: 'The operator resumed this run after a failure. Message from the operator: carry on' })

		const firstCall = defined(persistence.state.events.find((e) => e.type === 'llm_call'), 'first llm_call event')
		const callPayload = firstCall.payload
		expect(isRecord(callPayload)).toBe(true)
		if (isRecord(callPayload)) {
			// sentFrom 2 is the pre-error baseline: the event is a delta slice, not a full snapshot, and the note rides the slice as its last message.
			expect(callPayload['sentFrom']).toBe(2)
			expect(callPayload['messageCount']).toBe(5)
			const sent = callPayload['sent']
			expect(Array.isArray(sent)).toBe(true)
			if (Array.isArray(sent)) {
				expect(sent.length).toBe(3)
				const noteMessage = sent[2]
				expect(isRecord(noteMessage)).toBe(true)
				if (isRecord(noteMessage)) {
					expect(noteMessage['role']).toBe('user')
					expect(noteMessage['content']).toBe('The operator resumed this run after a failure. Message from the operator: carry on')
				}
			}
		}
	})

	test('the note is delivered even when the resumed turn terminates without an LLM request (a finish among the remaining calls)', async () => {
		// The error-run checkpoint shape where the root's interrupted turn was batched [agent, finish]: the child's card is recorded, and the turn's remaining call is the finish — the resumed role terminates without a further LLM request, so the loop-entry injection alone would silently drop the note.
		const finishCall: ToolCall = { id: 'f1', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ status: 'success', summary: 'wrapped up' }) } }
		const checkpoint: RunCheckpoint = {
			version: 1,
			runId: 'r-batched',
			startTime: '2026-01-01T00:00:00.000Z',
			registryCounter: 1,
			frames: [
				{
					roleId: 'orchestrator-0-1',
					roleName: 'orchestrator',
					depth: 0,
					task: 'do it',
					roleState: {
						history: [
							{ role: 'system', content: 'prompt' },
							{ role: 'user', content: 'do it' },
							{ role: 'assistant', content: '', tool_calls: [agentToolCall('a1', 'coder', 'subtask'), finishCall] },
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
					pending: {
						toolCalls: [agentToolCall('a1', 'coder', 'subtask'), finishCall],
						childIndex: 0,
						childCard: { status: 'success', summary: 'child done' },
					},
				},
			],
		}

		const guild = buildDelegationGuild()
		const llm = new FakeLlm()
		const persistence = makeFakePersistence()
		const deps = makeDeps(llm, persistence, guild)

		const meta = await resumeExecutor(deps, checkpoint, { ...resumeOptions, operatorNote: 'The operator resumed this run after a failure. Message from the operator: the child already finished; wrap up' })

		// The turn completed from the recorded card and the remaining finish — no LLM request was needed, and the note still reached the conversation.
		expect(llm.calls).toBe(0)
		expect(meta.status).toBe('success')
		expect(meta.result).toEqual({ status: 'success', summary: 'wrapped up' })
		// The checkpoint fixture's roleState is the live object the resumed engine mutated: the history must read agent tool_calls → tool result → note → finish result, well-formed throughout.
		const frame = defined(checkpoint.frames[0], 'resumed frame')
		const history = frame.roleState.history
		expect(history.length).toBe(6)
		const assistantMessage = history[2]
		const agentResult = history[3]
		const noteMessage = history[4]
		const finishResult = history[5]
		expect(assistantMessage?.tool_calls?.length).toBe(2)
		expect(agentResult?.role).toBe('tool')
		expect(noteMessage?.role).toBe('user')
		expect(noteMessage?.content).toBe('The operator resumed this run after a failure. Message from the operator: the child already finished; wrap up')
		expect(finishResult?.role).toBe('tool')
	})

	test('a twice-errored run stays resumable throughout and only its final success deletes the checkpoint', async () => {
		const guild = buildLoadedGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const errorFinish: ToolCall = { id: 'f1', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ status: 'error', summary: 'the endpoint is down', error: { kind: 'llm_unavailable', message: 'connection refused' } }) } }
		const originalLlm = new FakeLlm()
		originalLlm.responses = [success([errorFinish])]
		const originalPersistence = makeFakePersistence()
		const originalMeta = await runExecutor(makeDeps(originalLlm, originalPersistence, guild), { runId: 'r-twice', ...resumeOptions, task: 'do it', effort: 'standard' })
		expect(originalMeta.status).toBe('error')
		expect(originalPersistence.state.deleteCheckpointCalls).toBe(0)

		// First resume: errors again — the checkpoint is kept and the note is stamped on the resume boundary.
		const firstCheckpoint = originalPersistence.state.checkpoints[originalPersistence.state.checkpoints.length - 1]
		if (firstCheckpoint === undefined) throw new Error('expected the original run checkpoint')
		const firstResumeLlm = new FakeLlm()
		firstResumeLlm.responses = [success([errorFinish])]
		const firstResumePersistence = makeFakePersistence()
		const firstResumeMeta = await resumeExecutor(makeDeps(firstResumeLlm, firstResumePersistence, guild), firstCheckpoint, { ...resumeOptions, operatorNote: 'The operator resumed this run after a failure. Message from the operator: try again' })
		expect(firstResumeMeta.status).toBe('error')
		expect(firstResumeMeta.runId).toBe('r-twice')
		expect(firstResumeMeta.startTime).toBe(originalMeta.startTime)
		expect(firstResumePersistence.state.deleteCheckpointCalls).toBe(0)
		const resumedEvent = firstResumePersistence.state.events.find((e) => e.type === 'run_resumed')
		const resumedPayload = defined(resumedEvent, 'run_resumed event').payload
		if (isRecord(resumedPayload)) expect(resumedPayload['operatorNote']).toBe('The operator resumed this run after a failure. Message from the operator: try again')

		// Second resume — from the resumed run's own last checkpoint — succeeds, and only then is the checkpoint deleted.
		const secondCheckpoint = firstResumePersistence.state.checkpoints[firstResumePersistence.state.checkpoints.length - 1]
		if (secondCheckpoint === undefined) throw new Error('expected the first resume checkpoint')
		const secondResumeLlm = new FakeLlm()
		secondResumeLlm.responses = [success([finishToolCall('f2', 'finally done')])]
		const secondResumePersistence = makeFakePersistence()
		const secondResumeMeta = await resumeExecutor(makeDeps(secondResumeLlm, secondResumePersistence, guild), secondCheckpoint, resumeOptions)
		expect(secondResumeMeta.status).toBe('success')
		expect(secondResumeMeta.runId).toBe('r-twice')
		expect(secondResumeMeta.startTime).toBe(originalMeta.startTime)
		expect(secondResumePersistence.state.deleteCheckpointCalls).toBe(1)
	})
})
