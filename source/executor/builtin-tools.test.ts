import { describe, expect, test } from 'bun:test'
import type { ContextPolicy, ExecutorConfig, GuildConfig, LogEvent, Message, ModelConfig, RoleDefinition, ToolCall, ToolManifest } from '../shared/types.js'
import { runRole, type EngineDependencies } from './engine.ts'
import type { HumanBackend } from './human-backend.ts'
import type { LlmCallResult, LlmCaller } from './llm.ts'
import type { LoadedGuild } from './loader.ts'
import type { AppendLog } from './persistence.ts'
import { recordingHumanBackend, withTool } from './test-fixtures.ts'

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
			budget: { type: 'object' },
		},
	},
}

function buildGuild(roles: Record<string, RoleDefinition>, entryRole: string): LoadedGuild {
	const config: GuildConfig = {
		schemaVersion: 1,
		model: baseModel,
		executor: baseExecutor,
		contextPolicy: baseContextPolicy,
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
	return { config, prompts, tools }
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
	const deps: EngineDependencies = {
		llmCaller: llm,
		appendLog,
		additionalToolHandlers: {},
		humanBackend,
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
			startMs: Date.now(),
			roleName: 'main',
			task: 'do it',
		})

		expect(result.status).toBe('success')
		expect(llm.calls.length).toBe(2)
		const toolResultMessages = llm.calls[1]?.messages.filter((m) => m.role === 'tool') ?? []
		expect(toolResultMessages.length).toBe(1)
		const serialized = toolResultMessages[0]?.content ?? ''
		const parsed = JSON.parse(serialized) as {
			contextWindow: number
			currentPromptTokens: number
			lastReportedPromptTokens: number
			budgetRemaining: number
			messages: Array<{ index: number; role: string }>
		}
		expect(parsed.contextWindow).toBe(32000)
		expect(typeof parsed.currentPromptTokens).toBe('number')
		expect(parsed.lastReportedPromptTokens).toBe(500)
		expect(parsed.budgetRemaining).toBeGreaterThan(0)
		expect(parsed.messages.length).toBeGreaterThan(0)
		expect(parsed.messages[0]?.role).toBe('system')
		expect(parsed.messages[0]?.index).toBe(0)
		expect(parsed.messages[1]?.role).toBe('user')
		expect(parsed.messages[1]?.index).toBe(1)
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
			startMs: Date.now(),
			roleName: 'main',
			task: 'do it',
		})

		expect(result.status).toBe('success')
		const toolResultMessages = llm.calls[1]?.messages.filter((m) => m.role === 'tool') ?? []
		const parsed = JSON.parse(toolResultMessages[0]?.content ?? '{}') as { messageCount: number }
		expect(parsed.messageCount).toBe(2)
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
			startMs: Date.now(),
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
			{ main: { systemPrompt: 'sys', tools: ['edit_context', 'finish'], includeReasoning: true } },
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
			startMs: Date.now(),
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
			startMs: Date.now(),
			roleName: 'main',
			task: 'do it',
		})

		expect(result.status).toBe('success')
		const toolResultMessages = llm.calls[1]?.messages.filter((m) => m.role === 'tool') ?? []
		expect(toolResultMessages.length).toBe(1)
		const parsed = JSON.parse(toolResultMessages[0]?.content ?? '{}') as { kind: string }
		expect(parsed.kind).toBe('invalid_arguments')
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
			startMs: Date.now(),
			roleName: 'main',
			task: 'do it',
		})

		const toolResultMessages = llm.calls[1]?.messages.filter((m) => m.role === 'tool') ?? []
		const parsed = JSON.parse(toolResultMessages[0]?.content ?? '{}') as { kind: string }
		expect(parsed.kind).toBe('invalid_arguments')
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
			startMs: Date.now(),
			roleName: 'main',
			task: 'do it',
		})

		const toolResultMessages = llm.calls[1]?.messages.filter((m) => m.role === 'tool') ?? []
		const parsed = JSON.parse(toolResultMessages[0]?.content ?? '{}') as {
			recentCompactionPromptTokens: number[]
			messageCount: number
		}
		expect(parsed.recentCompactionPromptTokens.length).toBe(1)
		expect(parsed.messageCount).toBeLessThanOrEqual(2)
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
			startMs: Date.now(),
			roleName: 'main',
			task: 'do it',
		})

		expect(result.status).toBe('success')
		expect(human.questions).toEqual([{ question: 'What language?', context: undefined }])
		const toolResultMessages = llm.calls[1]?.messages.filter((m) => m.role === 'tool') ?? []
		const parsed = JSON.parse(toolResultMessages[0]?.content ?? '{}') as { answer: string }
		expect(parsed.answer).toBe('use your best judgement')
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
			startMs: Date.now(),
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
			startMs: Date.now(),
			roleName: 'main',
			task: 'do it',
		})

		const toolResultMessages = llm.calls[1]?.messages.filter((m) => m.role === 'tool') ?? []
		const parsed = JSON.parse(toolResultMessages[0]?.content ?? '{}') as { kind: string }
		expect(parsed.kind).toBe('invalid_arguments')
	})
})

describe('agent tool budget override', () => {
	test('agent tool call with budget parameter overrides the child role budget', async () => {
		const guild = buildGuild(
			{
				parent: { systemPrompt: 'p', tools: ['agent', 'finish'] },
				child: { systemPrompt: 'c', tools: ['finish'], budget: { maxToolCalls: 100 } },
			},
			'parent',
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([{ id: 'a1', type: 'function', function: { name: 'agent', arguments: JSON.stringify({ role: 'child', task: 'do', budget: { maxToolCalls: 5 } }) } }]),
			success([{ id: 'f1', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ status: 'success', summary: 'child done' }) } }]),
			success([{ id: 'f2', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ status: 'success', summary: 'parent done' }) } }]),
		]
		const { deps } = makeDeps(llm, recordingHumanBackend())

		const result = await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			startMs: Date.now(),
			roleName: 'parent',
			task: 'delegate',
		})

		expect(result.status).toBe('success')
		expect(result.summary).toBe('parent done')
	})

	test('agent tool budget override tightens child tool-call budget and returns tool_budget_exceeded', async () => {
		const guild = withTool(
			buildGuild(
				{
					parent: { systemPrompt: 'p', tools: ['agent', 'finish'] },
					child: { systemPrompt: 'c', tools: ['echo', 'finish'], budget: { maxToolCalls: 100 } },
				},
				'parent',
			),
			{
				name: 'echo',
				description: 'echo',
				parameters: { type: 'object', properties: { x: { type: 'number' } } },
			},
		)
		const llm = new FakeLlm()
		const echoCall: ToolCall = {
			id: 'e1',
			type: 'function',
			function: { name: 'echo', arguments: '{"x":1}' },
		}
		const finishCallForParent: ToolCall = {
			id: 'f1',
			type: 'function',
			function: { name: 'finish', arguments: JSON.stringify({ status: 'success', summary: 'parent handled child failure' }) },
		}
		llm.responses = [
			success([{ id: 'a1', type: 'function', function: { name: 'agent', arguments: JSON.stringify({ role: 'child', task: 'do', budget: { maxToolCalls: 1 } }) } }]),
			success([echoCall]),
			success([echoCall]),
			success([finishCallForParent]),
		]
		const { deps, events } = makeDeps(llm, recordingHumanBackend())

		const result = await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			startMs: Date.now(),
			roleName: 'parent',
			task: 'delegate',
		})

		expect(result.status).toBe('success')
		expect(result.summary).toBe('parent handled child failure')
		expect(llm.calls.length).toBe(4)
		const roleBudgetEvents = events.filter((e) => e.type === 'role_budget_exceeded')
		expect(roleBudgetEvents.length).toBeGreaterThanOrEqual(1)
		const childBudgetEvent = roleBudgetEvents.find((e) => {
			const payload = e.payload as { role?: string }
			return payload.role === 'child'
		})
		expect(childBudgetEvent).toBeDefined()
		const budgetErrorPayload = childBudgetEvent?.payload as { error?: { kind?: string } }
		expect(budgetErrorPayload.error?.kind).toBe('tool_budget_exceeded')
	})
})