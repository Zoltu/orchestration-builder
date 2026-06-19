import { describe, expect, test } from 'bun:test'

import type { ContextPolicy, ExecutorConfig, GuildConfig, LogEvent, ModelConfig, RoleDefinition, RunMeta, ToolCall, ToolManifest } from '../shared/types.js'
import { ValidationError } from '../shared/errors.js'
import { runExecutor, type ExecutorDependencies } from './executor.ts'
import type { LlmCallResult, LlmCaller } from './llm.ts'
import type { LoadGuild, LoadedGuild } from './loader.ts'
import type { AppendLog, CopyWorkspace, RunDirectory, SnapshotWorkspace, WriteMeta } from './persistence.ts'
import { stubHumanBackend } from './test-fixtures.ts'

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
	copyWorkspace: CopyWorkspace
	snapshotWorkspace: SnapshotWorkspace
	writeMeta: WriteMeta
	state: {
		events: LogEvent[]
		meta: RunMeta | null
		createRunDirectoryCalls: number
		copyWorkspaceCalls: string[]
		snapshotWorkspaceCalls: number
	}
}

function makeFakePersistence(): FakePersistenceFns {
	const state = {
		events: [] as LogEvent[],
		meta: null as RunMeta | null,
		createRunDirectoryCalls: 0,
		copyWorkspaceCalls: [] as string[],
		snapshotWorkspaceCalls: 0,
	}
	return {
		appendLog: (event) => {
			state.events.push(event)
		},
		createRunDirectory: () => {
			state.createRunDirectoryCalls++
			return '/tmp/run'
		},
		copyWorkspace: (sourcePath) => {
			state.copyWorkspaceCalls.push(sourcePath)
		},
		snapshotWorkspace: () => {
			state.snapshotWorkspaceCalls++
		},
		writeMeta: (meta) => {
			state.meta = meta
		},
		state,
	}
}

const baseExecutor: ExecutorConfig = {
	maxAgentDepth: 8,
	maxToolCallsPerRole: 50,
	maxTokensPerRole: 60000,
	maxRunTimeSeconds: 300,
	defaultToolTimeoutSeconds: 30,
	maxRepeatedToolCalls: 3,
	maxCompactionAttempts: 5,
}

const baseModel: ModelConfig = {
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
		schemaVersion: 1,
		model: baseModel,
		executor: baseExecutor,
		contextPolicy: baseContextPolicy,
		entryRole,
		roles,
		tools: ['guild/tools/finish.json'],
	}
	const prompts: Record<string, string> = {}
	for (const name of Object.keys(roles)) {
		prompts[name] = `prompt for ${name}`
	}
	const tools: Record<string, ToolManifest> = { finish: finishManifest }
	return { config, prompts, tools }
}

function makeLoader(guild: LoadedGuild): LoadGuild {
	return (_guildDir: string) => guild
}

function makeDeps(llm: FakeLlm, persistence: FakePersistenceFns, loadGuild: LoadGuild): ExecutorDependencies {
	return {
		llmCaller: llm,
		appendLog: persistence.appendLog,
		createRunDirectory: persistence.createRunDirectory,
		copyWorkspace: persistence.copyWorkspace,
		snapshotWorkspace: persistence.snapshotWorkspace,
		writeMeta: persistence.writeMeta,
		additionalToolHandlers: {},
		humanBackend: stubHumanBackend,
		loadGuild,
	}
}

describe('runExecutor', () => {
	test('Guild-load failure propagates as a thrown ValidationError before runRole runs', async () => {
		const llm = new FakeLlm()
		const persistence = makeFakePersistence()
		const failingLoadGuild: LoadGuild = () => {
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
			})
		} catch (error) {
			caught = error
		}

		expect(caught).toBeInstanceOf(ValidationError)
		expect(llm.calls).toBe(0)
		expect(persistence.state.createRunDirectoryCalls).toBe(1)
		expect(persistence.state.copyWorkspaceCalls).toEqual(['/bench'])
		expect(persistence.state.meta).toBeNull()
	})

	test('happy path: creates run dir, copies workspace, loads Guild, runs entry, writes meta', async () => {
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
		})

		expect(persistence.state.createRunDirectoryCalls).toBe(1)
		expect(persistence.state.copyWorkspaceCalls).toEqual(['/bench'])
		expect(persistence.state.meta).not.toBeNull()
		expect(meta.runId).toBe('r1')
		expect(meta.guildPath).toBe('/guild')
		expect(meta.benchmarkPath).toBe('/bench')
		expect(meta.task).toBe('do it')
		expect(meta.status).toBe('success')
		expect(meta.result).toEqual({ status: 'success', summary: 'all done' })
		expect(meta.startTime).toBeDefined()
		expect(meta.endTime).toBeDefined()
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
		})

		expect(persistence.state.meta).not.toBeNull()
		const written = persistence.state.meta
		expect(written).not.toBeNull()
		expect(written!.runId).toBe('r3')
		expect(written!.guildPath).toBe('/guild')
		expect(written!.status).toBe('success')
		expect(written!.result).toBeDefined()
		expect(meta.result).toEqual(written!.result)
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
		})

		const eventTypes = persistence.state.events.map((e) => e.type)
		expect(eventTypes).toContain('llm_call')
		expect(eventTypes).toContain('tool_call')
		expect(eventTypes).toContain('tool_result')
		expect(eventTypes).toContain('role_finished')
	})
})
