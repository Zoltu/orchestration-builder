import { describe, expect, test } from 'bun:test'
import type { ContextPolicy, DeploymentConfig, ExecutorConfig, GuildConfig, LogEvent, Message, ResolvedModelConfig, RoleDefinition, ToolCall, ToolManifest } from './types.js'
import { runRole } from './engine.ts'
import type { EngineDependencies } from './engine-state.ts'
import { createContextPressureTracker } from './context-pressure.ts'
import type { HumanBackend } from './human-backend.ts'
import { createInterruptQueue } from './interrupts.ts'
import type { LlmCallResult, LlmCaller } from './llm.ts'
import type { LoadedGuild } from './loader.ts'
import type { AppendLog } from './persistence.ts'
import { createRoleRegistry } from './role-registry.ts'
import { createFakeCheckpointRecorder, recordingHumanBackend } from './test-fixtures.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseToolContent(content: string | undefined): Record<string, unknown> {
	const parsed: unknown = JSON.parse(content ?? '{}')
	if (!isRecord(parsed)) throw new Error('tool result content is not a JSON object')
	return parsed
}

function toolResultEvents(events: LogEvent[], tool: string): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = []
	for (const event of events) {
		if (event.type !== 'tool_result') continue
		if (!isRecord(event.payload)) continue
		if (event.payload['tool'] !== tool) continue
		out.push(event.payload)
	}
	return out
}

function success(toolCalls: ToolCall[], opts: { content?: string; promptTokens?: number } = {}): LlmCallResult {
	return {
		kind: 'success',
		content: opts.content ?? '',
		reasoning: null,
		toolCalls,
		usage: { promptTokens: opts.promptTokens ?? 100, completionTokens: 10 },
	}
}

class FakeLlm implements LlmCaller {
	responses: LlmCallResult[] = []
	calls: Array<{ messages: Message[] }> = []

	async call(request: { messages: Message[] }): Promise<LlmCallResult> {
		this.calls.push(request)
		const next = this.responses.shift()
		if (next === undefined) throw new Error('FakeLlm ran out of responses')
		return next
	}
}

function makeFakeAppendLog(): { appendLog: AppendLog; events: LogEvent[] } {
	const events: LogEvent[] = []
	return {
		appendLog: (event) => {
			events.push(event)
		},
		events,
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
	contextWindow: 32000,
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

const contextInfoManifest: ToolManifest = {
	name: 'context_info',
	description: 'Get current conversation metadata.',
	parameters: { type: 'object', properties: {} },
}

const editContextManifest: ToolManifest = {
	name: 'edit_context',
	description: 'Mutate the current role conversation.',
	parameters: {
		type: 'object',
		required: ['operations'],
		properties: {
			operations: {
				type: 'array',
				properties: {
					op: { type: 'string' },
					range: { type: 'array' },
					index: { type: 'number' },
					content: { type: 'string' },
				},
			},
		},
	},
}

const askHumanManifest: ToolManifest = {
	name: 'ask_human',
	description: 'Ask a human a question.',
	parameters: {
		type: 'object',
		required: ['question'],
		properties: {
			question: { type: 'string' },
			context: { type: 'string' },
		},
	},
}

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

function buildGuild(roles: Record<string, RoleDefinition>, entryRole: string): LoadedGuild {
	const config: GuildConfig = {
		entryRole,
		roles,
		tools: [
			'guild/tools/finish.json',
			'guild/tools/agent.json',
			'guild/tools/context_info.json',
			'guild/tools/edit_context.json',
			'guild/tools/ask_human.json',
		],
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
	const tools: Record<string, ToolManifest> = {
		finish: finishManifest,
		agent: agentManifest,
		context_info: contextInfoManifest,
		edit_context: editContextManifest,
		ask_human: askHumanManifest,
	}
	return { config, deployment, prompts, tools }
}

function makeCall(name: string, args: Record<string, unknown>): ToolCall {
	return {
		id: `call_${name}_1`,
		type: 'function',
		function: {
			name,
			arguments: JSON.stringify(args),
		},
	}
}

function makeDeps(llm: FakeLlm, humanBackend: HumanBackend): { deps: EngineDependencies; events: LogEvent[] } {
	const { appendLog, events } = makeFakeAppendLog()
	const roleRegistry = createRoleRegistry()
	const contextPressureTracker = createContextPressureTracker()
	const sink = createFakeCheckpointRecorder(roleRegistry, contextPressureTracker)
	const deps: EngineDependencies = {
		llmCaller: llm,
		appendLog,
		additionalToolHandlers: {},
		humanBackend,
		roleRegistry,
		interruptQueue: createInterruptQueue(),
		contextPressureTracker,
		checkpointRecorder: sink.recorder,
	}
	return { deps, events }
}

describe('context_info tool', () => {
	test('returns contextWindow, currentPromptTokens, and message snapshot', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'sys', tools: ['context_info', 'finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([makeCall('context_info', {})], { promptTokens: 500 }),
			success([{ id: 'f1', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ status: 'success', summary: 'done' }) } }], { promptTokens: 600 }),
		]
		const { deps } = makeDeps(llm, recordingHumanBackend())

		const result = await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result.status).toBe('success')
		expect(llm.calls.length).toBe(2)
		const toolResultMessages = llm.calls[1]?.messages.filter((m) => m.role === 'tool') ?? []
		expect(toolResultMessages.length).toBe(1)
		const serialized = toolResultMessages[0]?.content ?? ''
		const parsed = parseToolContent(serialized)
		expect(parsed['contextWindow']).toBe(32000)
		expect(typeof parsed['currentPromptTokens']).toBe('number')
		expect(parsed['lastReportedPromptTokens']).toBe(500)
		expect(parsed['budgetRemaining']).toBeGreaterThan(0)
		const messages = parsed['messages']
		expect(Array.isArray(messages) && messages.length > 0).toBe(true)
		if (Array.isArray(messages)) {
			const first = messages[0]
			const second = messages[1]
			expect(isRecord(first)).toBe(true)
			expect(isRecord(second)).toBe(true)
			if (isRecord(first) && isRecord(second)) {
				expect(first['role']).toBe('system')
				expect(first['index']).toBe(0)
				expect(second['role']).toBe('user')
				expect(second['index']).toBe(1)
			}
		}
	})
})

describe('edit_context tool', () => {
	test('drop operation removes history messages in the range', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'sys', tools: ['edit_context', 'finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([makeCall('edit_context', { operations: [{ op: 'drop', range: [2, 4] }] })]),
			success([{ id: 'f1', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ status: 'success', summary: 'done' }) } }]),
		]
		const { deps } = makeDeps(llm, recordingHumanBackend())

		const result = await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result.status).toBe('success')
		const toolResultMessages = llm.calls[1]?.messages.filter((m) => m.role === 'tool') ?? []
		const parsed = parseToolContent(toolResultMessages[0]?.content)
		expect(parsed['messageCount']).toBe(2)
	})

	test('replace operation updates content at the given index', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'sys', tools: ['edit_context', 'finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([makeCall('edit_context', { operations: [{ op: 'replace', index: 2, content: 'new assistant text' }] })]),
			success([{ id: 'f1', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ status: 'success', summary: 'done' }) } }]),
		]
		const { deps } = makeDeps(llm, recordingHumanBackend())

		const result = await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'original task',
		})

		expect(result.status).toBe('success')
		const secondCallMessages = llm.calls[1]?.messages ?? []
		const replaced = secondCallMessages.find((m) => m.role === 'assistant' && m.content === 'new assistant text')
		expect(replaced).toBeDefined()
	})

	test('strip_reasoning operation clears reasoning on a range', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'sys', tools: ['edit_context', 'finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [
			{ kind: 'success', content: 'first reply', reasoning: 'thinking hard', toolCalls: [makeCall('edit_context', { operations: [{ op: 'strip_reasoning', range: [2, 3] }] })], usage: { promptTokens: 100, completionTokens: 10 } },
			success([{ id: 'f1', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ status: 'success', summary: 'done' }) } }], { promptTokens: 100 }),
		]
		const { deps } = makeDeps(llm, recordingHumanBackend())

		const result = await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result.status).toBe('success')
	})

	test('rejects an unknown operation with invalid_arguments', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'sys', tools: ['edit_context', 'finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([makeCall('edit_context', { operations: [{ op: 'magic' }] })]),
			success([{ id: 'f1', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ status: 'success', summary: 'done' }) } }]),
		]
		const { deps } = makeDeps(llm, recordingHumanBackend())

		const result = await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result.status).toBe('success')
		const toolResultMessages = llm.calls[1]?.messages.filter((m) => m.role === 'tool') ?? []
		expect(toolResultMessages.length).toBe(1)
		const parsed = parseToolContent(toolResultMessages[0]?.content)
		expect(parsed['kind']).toBe('invalid_arguments')
	})

	test('rejects a drop.range that is not an array', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'sys', tools: ['edit_context', 'finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([makeCall('edit_context', { operations: [{ op: 'drop', range: 'oops' }] })]),
			success([{ id: 'f1', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ status: 'success', summary: 'done' }) } }]),
		]
		const { deps } = makeDeps(llm, recordingHumanBackend())

		await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		const toolResultMessages = llm.calls[1]?.messages.filter((m) => m.role === 'tool') ?? []
		const parsed = parseToolContent(toolResultMessages[0]?.content)
		expect(parsed['kind']).toBe('invalid_arguments')
	})

	test('tracks recentCompactionPromptTokens after each edit', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'sys', tools: ['edit_context', 'finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([makeCall('edit_context', { operations: [{ op: 'drop', range: [2, 3] }] })]),
			success([{ id: 'f1', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ status: 'success', summary: 'done' }) } }]),
		]
		const { deps } = makeDeps(llm, recordingHumanBackend())

		await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		const toolResultMessages = llm.calls[1]?.messages.filter((m) => m.role === 'tool') ?? []
		const parsed = parseToolContent(toolResultMessages[0]?.content)
		const tokens = parsed['recentCompactionPromptTokens']
		expect(Array.isArray(tokens) && tokens.length === 1).toBe(true)
		expect(parsed['messageCount']).toBeLessThanOrEqual(2)
	})
})

describe('ask_human tool', () => {
	test('returns the human backend answer wrapped as a tool result', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'sys', tools: ['ask_human', 'finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([makeCall('ask_human', { question: 'What language?' })]),
			success([{ id: 'f1', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ status: 'success', summary: 'done' }) } }]),
		]
		const human = recordingHumanBackend()
		const { deps } = makeDeps(llm, human)

		const result = await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result.status).toBe('success')
		expect(human.questions).toEqual([{ question: 'What language?', context: undefined }])
		const toolResultMessages = llm.calls[1]?.messages.filter((m) => m.role === 'tool') ?? []
		const parsed = parseToolContent(toolResultMessages[0]?.content)
		expect(parsed['answer']).toBe('use your best judgement')
	})

	test('passes context to the human backend when provided', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'sys', tools: ['ask_human', 'finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([makeCall('ask_human', { question: 'q', context: 'c' })]),
			success([{ id: 'f1', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ status: 'success', summary: 'done' }) } }]),
		]
		const human = recordingHumanBackend()
		const { deps } = makeDeps(llm, human)

		await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(human.questions).toEqual([{ question: 'q', context: 'c' }])
	})

	test('rejects a missing question with invalid_arguments', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'sys', tools: ['ask_human', 'finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([makeCall('ask_human', {})]),
			success([{ id: 'f1', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ status: 'success', summary: 'done' }) } }]),
		]
		const { deps } = makeDeps(llm, recordingHumanBackend())

		await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		const toolResultMessages = llm.calls[1]?.messages.filter((m) => m.role === 'tool') ?? []
		const parsed = parseToolContent(toolResultMessages[0]?.content)
		expect(parsed['kind']).toBe('invalid_arguments')
	})
})

describe('finish tool', () => {
	test('rejects an empty summary with invalid_arguments naming summary', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'sys', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([makeCall('finish', { status: 'success', summary: '' })]),
			success([{ id: 'f1', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ status: 'success', summary: 'done' }) } }]),
		]
		const { deps, events } = makeDeps(llm, recordingHumanBackend())

		const result = await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result.status).toBe('success')
		const results = toolResultEvents(events, 'finish')
		const rejected = results[0]
		expect(rejected?.['kind']).toBe('invalid_arguments')
		const rejectedPayload = rejected?.['result']
		if (!isRecord(rejectedPayload)) throw new Error('tool result payload is not an object')
		expect(rejectedPayload['message']).toBe('summary must be a non-empty string')
	})

	test('rejects a whitespace-only summary with invalid_arguments naming summary', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'sys', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([makeCall('finish', { status: 'success', summary: '   ' })]),
			success([{ id: 'f1', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ status: 'success', summary: 'done' }) } }]),
		]
		const { deps, events } = makeDeps(llm, recordingHumanBackend())

		const result = await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result.status).toBe('success')
		const results = toolResultEvents(events, 'finish')
		const rejected = results[0]
		expect(rejected?.['kind']).toBe('invalid_arguments')
		const rejectedPayload = rejected?.['result']
		if (!isRecord(rejectedPayload)) throw new Error('tool result payload is not an object')
		expect(rejectedPayload['message']).toBe('summary must be a non-empty string')
	})

	test('a valid summary still finalizes the role with its card', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'sys', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([{ id: 'f1', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ status: 'success', summary: 'all done' }) } }]),
		]
		const { deps } = makeDeps(llm, recordingHumanBackend())

		const result = await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result.status).toBe('success')
		expect(result.summary).toBe('all done')
	})
})
