import { describe, expect, test } from 'bun:test'

import type { ContextPolicy, DeploymentConfig, ExecutorConfig, GuildConfig, LogEvent, ResolvedModelConfig, RoleDefinition, RunContinuation, RunMeta, ToolCall, ToolManifest } from './types.js'
import { ValidationError } from './errors.js'
import { isRunCheckpoint, type RunCheckpoint } from './checkpoint.ts'
import { resumeExecutor, runExecutor, type ExecutorDependencies } from './executor.ts'
import { createInterruptQueue } from './interrupts.ts'
import type { LlmCallResult, LlmCaller } from './llm.ts'
import type { LoadedGuild } from './loader.ts'
import type { AppendLog, DeleteCheckpoint, RunDirectory, WriteCheckpoint, WriteMeta } from './persistence.ts'
import { stubHumanBackend, defined } from './test-fixtures.ts'

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

function makeLoader(guild: LoadedGuild): () => LoadedGuild {
	return () => guild
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function makeDeps(llm: FakeLlm, persistence: FakePersistenceFns, loadGuild: () => LoadedGuild): ExecutorDependencies {
	return {
		llmCaller: llm,
		appendLog: persistence.appendLog,
		createRunDirectory: persistence.createRunDirectory,
		writeMeta: persistence.writeMeta,
		writeCheckpoint: persistence.writeCheckpoint,
		deleteCheckpoint: persistence.deleteCheckpoint,
		additionalToolHandlers: {},
		humanBackend: stubHumanBackend,
		loadGuild,
		interruptQueue: createInterruptQueue(),
	}
}

describe('runExecutor', () => {
	test('Guild-load failure propagates as a thrown ValidationError before runRole runs', async () => {
		const llm = new FakeLlm()
		const persistence = makeFakePersistence()
		const failingLoadGuild: () => LoadedGuild = () => {
			throw new ValidationError('', 'guild.json is not a valid GuildConfig')
		}
		const deps = makeDeps(llm, persistence, failingLoadGuild)

		let caught: unknown
		try {
			await runExecutor(deps, {
			runId: 'r-fail',
			guildPath: '/guild',
			benchmarkPath: '/bench',
			task: 'do it',
			effort: 'standard',
		})
		} catch (error) {
			caught = error
		}

		expect(caught).toBeInstanceOf(ValidationError)
		expect(llm.calls).toBe(0)
		expect(persistence.state.createRunDirectoryCalls).toBe(1)
		expect(persistence.state.meta).toBeNull()
	})

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
		const deps = makeDeps(llm, persistence, makeLoader(guild))

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
		const deps = makeDeps(llm, persistence, makeLoader(guild))

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
		const deps = makeDeps(llm, persistence, makeLoader(guild))

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
		const deps = makeDeps(llm, persistence, makeLoader(guild))

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
		const deps = makeDeps(llm, persistence, makeLoader(guild))

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
		const deps = makeDeps(llm, persistence, makeLoader(guild))
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
		const deps = makeDeps(llm, persistence, makeLoader(guild))

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
		const deps = makeDeps(llm, persistence, makeLoader(guild))

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
		const deps = makeDeps(llm, persistence, makeLoader(guild))

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
		const deps = makeDeps(llm, persistence, makeLoader(guild))

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
		const deps = makeDeps(llm, persistence, makeLoader(guild))

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
		const deps = makeDeps(llm, persistence, makeLoader(guild))

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
		await resumeExecutor(makeDeps(firstResumeLlm, firstResumePersistence, makeLoader(buildDelegationGuild())), firstCheckpoint, resumeOptions)
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
		const meta = await resumeExecutor(makeDeps(secondResumeLlm, secondResumePersistence, makeLoader(buildDelegationGuild())), postResumeCheckpoint, resumeOptions)

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
		const deps = makeDeps(llm, persistence, makeLoader(guild))

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
		const deps = makeDeps(llm, persistence, makeLoader(guild))

		await runExecutor(deps, { runId: 'r-clean', ...resumeOptions, task: 'do it', effort: 'standard' })

		expect(persistence.state.deleteCheckpointCalls).toBe(1)
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
		const deps = makeDeps(llm, persistence, makeLoader(guild))

		const meta = await resumeExecutor(deps, checkpoint, resumeOptions)

		expect(meta.logLevel).toBe('standard')
		expect(persistence.state.metas.length).toBe(2)
		expect(persistence.state.metas[0]?.logLevel).toBe('standard')
		expect(persistence.state.meta?.logLevel).toBe('standard')
	})

	test('a checkpoint from before the logging channel existed resumes at full detail', async () => {
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
		const deps = makeDeps(llm, persistence, makeLoader(guild))

		const meta = await resumeExecutor(deps, checkpoint, resumeOptions)

		expect(meta.logLevel).toBe('full')
		expect(persistence.state.meta?.logLevel).toBe('full')
	})
})
