import { describe, expect, test } from 'bun:test'

import type { ContextPolicy, ExecutorConfig, GuildConfig, LogEvent, Message, ModelConfig, RoleDefinition, ToolCall, ToolManifest } from './types.js'
import { effortDirective } from './effort.ts'
import { runRole, type EngineDependencies } from './engine.ts'
import type { LlmCallResult, LlmCaller } from './llm.ts'
import type { LoadedGuild } from './loader.ts'
import type { AppendLog } from './persistence.ts'
import { stubHumanBackend, withTool } from './test-fixtures.ts'
import type { ToolHandler } from './tool-dispatch.ts'

function success(toolCalls: ToolCall[], opts: { content?: string; promptTokens?: number; completionTokens?: number; finishReason?: string } = {}): LlmCallResult {
	const result: LlmCallResult = {
		kind: 'success',
		content: opts.content ?? '',
		reasoning: null,
		toolCalls,
		usage: {
			promptTokens: opts.promptTokens ?? 10,
			completionTokens: opts.completionTokens ?? 5,
		},
	}
	if (opts.finishReason !== undefined) result.finishReason = opts.finishReason
	return result
}

function contextExceeded(promptTokens = 999, contextWindow = 100): LlmCallResult {
	return { kind: 'context_budget_exceeded', promptTokens, contextWindow }
}

function llmUnavailable(message = 'test'): LlmCallResult {
	return { kind: 'llm_unavailable', message }
}

class FakeLlm implements LlmCaller {
	responses: LlmCallResult[] = []
	calls: Array<{ messages: Message[]; tools?: ToolManifest[] }> = []

	async call(request: { messages: Message[]; tools?: ToolManifest[] }): Promise<LlmCallResult> {
		this.calls.push(request)
		if (this.responses.length === 0) {
			throw new Error('FakeLlm ran out of responses')
		}
		const next = this.responses.shift()
		if (next === undefined) {
			throw new Error('FakeLlm ran out of responses')
		}
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
			artifacts: { type: 'array' },
			error: { type: 'object' },
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

function buildGuild(roles: Record<string, RoleDefinition>, entryRole: string, extras: Partial<GuildConfig> = {}): LoadedGuild {
	const config: GuildConfig = {
		schemaVersion: 1,
		model: baseModel,
		executor: baseExecutor,
		contextPolicy: baseContextPolicy,
		entryRole,
		roles,
		tools: ['guild/tools/finish.json', 'guild/tools/agent.json'],
		...extras,
	}
	const prompts: Record<string, string> = {}
	for (const name of Object.keys(roles)) {
		prompts[name] = `prompt for ${name}`
	}
	const tools: Record<string, ToolManifest> = {
		finish: finishManifest,
		agent: agentManifest,
	}
	return { config, prompts, tools }
}

function finishCall(args: { status: 'success' | 'error' | 'needs_clarification'; summary: string; artifacts?: string[] }): ToolCall {
	return {
		id: 'finish_1',
		type: 'function',
		function: {
			name: 'finish',
			arguments: JSON.stringify(args),
		},
	}
}

function agentCall(role: string, task: string): ToolCall {
	return {
		id: 'agent_1',
		type: 'function',
		function: {
			name: 'agent',
			arguments: JSON.stringify({ role, task }),
		},
	}
}

function makeDeps(llm: FakeLlm): { deps: EngineDependencies; events: LogEvent[] } {
	const { appendLog, events } = makeFakeAppendLog()
	const deps: EngineDependencies = {
		llmCaller: llm,
		appendLog,
		additionalToolHandlers: {},
		humanBackend: stubHumanBackend,
	}
	return { deps, events }
}

const echoHandler: ToolHandler = (args) => ({ kind: 'success', data: args })

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function payloadField(event: LogEvent, field: string): unknown {
	const payload = event.payload
	return isRecord(payload) ? payload[field] : undefined
}

describe('runRole — acceptance criteria', () => {
	test('finish-only role returns a ResultCard after one LLM call', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [success([finishCall({ status: 'success', summary: 'Done' })])]
		const { deps, events } = makeDeps(llm)

		const result = await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result).toEqual({ status: 'success', summary: 'Done' })
		expect(llm.calls.length).toBe(1)
		expect(events.some((e) => e.type === 'role_finished')).toBe(true)
		expect(events.some((e) => e.type === 'llm_call')).toBe(true)
		expect(events.some((e) => e.type === 'tool_call')).toBe(true)
		expect(events.some((e) => e.type === 'tool_result')).toBe(true)
	})

	test('agent+finish role spawns a child role and returns its result card', async () => {
		const guild = buildGuild(
			{
				parent: { systemPrompt: 'p', tools: ['agent', 'finish'] },
				child: { systemPrompt: 'c', tools: ['finish'] },
			},
			'parent',
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([agentCall('child', 'subtask')]),
			success([finishCall({ status: 'success', summary: 'child done' })]),
			success([finishCall({ status: 'success', summary: 'parent done' })]),
		]
		const { deps, events } = makeDeps(llm)

		const result = await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'parent',
			task: 'delegate',
		})

		expect(result).toEqual({ status: 'success', summary: 'parent done' })
		expect(llm.calls.length).toBe(3)
		expect(events.some((e) => e.type === 'role_finished' && payloadField(e, 'role') === 'child')).toBe(true)
		expect(events.some((e) => e.type === 'role_finished' && payloadField(e, 'role') === 'parent')).toBe(true)
	})

	test('context_budget_exceeded surfaces a synthetic tool result and continues', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [
			contextExceeded(35000, 32768),
			success([finishCall({ status: 'success', summary: 'recovered' })]),
		]
		const { deps, events } = makeDeps(llm)

		const result = await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result).toEqual({ status: 'success', summary: 'recovered' })
		expect(llm.calls.length).toBe(2)
		const contextEvent = events.find((e) => e.type === 'context_budget_exceeded')
		expect(contextEvent).toBeDefined()
	})

	test('tool not in role allowed list returns invalid_tool_call and continues', async () => {
		const guild = withTool(
			buildGuild(
				{ main: { systemPrompt: 'p', tools: ['finish'] } },
				'main',
			),
			{
				name: 'read_file',
				description: 'Read a file.',
				parameters: { type: 'object', properties: { path: { type: 'string' } } },
			},
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([{ id: 'bad', type: 'function', function: { name: 'read_file', arguments: '{"path":"x"}' } }]),
			success([finishCall({ status: 'success', summary: 'done' })]),
		]
		const { deps, events } = makeDeps(llm)

		const result = await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result).toEqual({ status: 'success', summary: 'done' })
		expect(llm.calls.length).toBe(2)
		const invalid = events.find((e) => e.type === 'invalid_tool_call')
		expect(invalid).toBeDefined()
	})

	test('tool not declared in Guild manifest returns unknown_tool and continues', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([{ id: 'bad', type: 'function', function: { name: 'read_file', arguments: '{"path":"x"}' } }]),
			success([finishCall({ status: 'success', summary: 'done' })]),
		]
		const { deps, events } = makeDeps(llm)

		const result = await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result).toEqual({ status: 'success', summary: 'done' })
		expect(llm.calls.length).toBe(2)
		const unknown = events.find((e) => e.type === 'unknown_tool')
		expect(unknown).toBeDefined()
	})

	test('implicit finish on tool-less response returns success with content as summary', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [success([], { content: 'all done' })]
		const { deps, events } = makeDeps(llm)

		const result = await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result).toEqual({ status: 'success', summary: 'all done' })
		const implicitEvent = events.find((e) => e.type === 'implicit_finish')
		expect(implicitEvent).toBeDefined()
	})

	test('depth budget exceeded terminates agent child with tool_budget_exceeded', async () => {
		const tight: ExecutorConfig = { ...baseExecutor, maxAgentDepth: 1 }
		const guild = buildGuild(
			{
				grandparent: { systemPrompt: 'p', tools: ['agent', 'finish'] },
				parent: { systemPrompt: 'p', tools: ['agent', 'finish'] },
				child: { systemPrompt: 'p', tools: ['finish'] },
			},
			'grandparent',
			{ executor: tight },
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([agentCall('parent', 'delegate')]),
			success([agentCall('child', 'delegate')]),
			success([finishCall({ status: 'success', summary: 'parent done after child fail' })]),
			success([finishCall({ status: 'success', summary: 'grandparent done' })]),
		]
		const { deps, events } = makeDeps(llm)

		const result = await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'grandparent',
			task: 'delegate',
		})

		expect(result.status).toBe('success')
		expect(llm.calls.length).toBe(4)
		const depthEvent = events.find((e) => e.type === 'depth_exceeded')
		expect(depthEvent).toBeDefined()
	if (depthEvent) {
		const depth = payloadField(depthEvent, 'depth')
		expect(typeof depth === 'number' && depth > tight.maxAgentDepth).toBe(true)
	}
	})

	test('LLM unavailable returns ResultCard with llm_unavailable error', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [llmUnavailable('connection refused')]
		const { deps } = makeDeps(llm)

		const result = await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result.status).toBe('error')
		if (result.error) {
			expect(result.error.kind).toBe('llm_unavailable')
		}
	})

	test('unknown role returns an error ResultCard', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		const { deps } = makeDeps(llm)

		const result = await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'nonexistent',
			task: 'do it',
		})

		expect(result.status).toBe('error')
		expect(result.error?.kind).toBe('unknown_tool')
		expect(llm.calls.length).toBe(0)
	})

	test('log.jsonl records an LLM call and the matching tool_call and tool_result events', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [success([finishCall({ status: 'success', summary: 'done' })])]
		const { deps, events } = makeDeps(llm)

		await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		const eventTypes = events.map((e) => e.type)
		expect(eventTypes).toContain('llm_call')
		expect(eventTypes).toContain('tool_call')
		expect(eventTypes).toContain('tool_result')
		expect(eventTypes).toContain('role_finished')
	})

	test('agent tool call wraps child ResultCard as the parent tool result', async () => {
		const guild = buildGuild(
			{
				parent: { systemPrompt: 'p', tools: ['agent', 'finish'] },
				child: { systemPrompt: 'c', tools: ['finish'] },
			},
			'parent',
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([agentCall('child', 'sub')]),
			success([finishCall({ status: 'success', summary: 'child work done' })]),
			success([finishCall({ status: 'success', summary: 'parent done' })]),
		]
		const { deps } = makeDeps(llm)

		const result = await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'parent',
			task: 'delegate',
		})

		expect(result).toEqual({ status: 'success', summary: 'parent done' })
		expect(llm.calls.length).toBe(3)
	})

	test('agent with a nonexistent role name returns an error ResultCard to the parent', async () => {
		const guild = buildGuild(
			{
				parent: { systemPrompt: 'p', tools: ['agent', 'finish'] },
			},
			'parent',
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([agentCall('nonexistent', 'task')]),
			success([finishCall({ status: 'success', summary: 'parent handled child failure' })]),
		]
		const { deps, events } = makeDeps(llm)

		const result = await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'parent',
			task: 'delegate',
		})

		expect(result.status).toBe('success')
		expect(result.summary).toBe('parent handled child failure')
		expect(llm.calls.length).toBe(2)
		const notFoundEvent = events.find((e) => e.type === 'role_not_found')
		expect(notFoundEvent).toBeDefined()
	})

	test('includeReasoning: true keeps reasoning on assistant messages across a round-trip', async () => {
		const guild = withTool(
			buildGuild(
				{ main: { systemPrompt: 'p', tools: ['echo', 'finish'], includeReasoning: true } },
				'main',
			),
			{
				name: 'echo',
				description: 'echo',
				parameters: { type: 'object', properties: { x: { type: 'number' } } },
			},
		)
		const echoCall: ToolCall = {
			id: 'e1',
			type: 'function',
			function: { name: 'echo', arguments: '{"x":1}' },
		}
		const llm = new FakeLlm()
		llm.responses = [
			{ kind: 'success', content: 'first reply', reasoning: 'I considered this carefully', toolCalls: [echoCall], usage: { promptTokens: 10, completionTokens: 5 } },
			success([finishCall({ status: 'success', summary: 'done' })], { content: 'second reply' }),
		]
		const { deps } = makeDeps(llm)
		const depsWithEcho: EngineDependencies = {
			...deps,
			additionalToolHandlers: {
				echo: echoHandler,
			},
		}

		const result = await runRole(depsWithEcho, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result.status).toBe('success')
		expect(llm.calls.length).toBe(2)
		const secondCallMessages = llm.calls[1]?.messages ?? []
		const assistantInSecond = secondCallMessages.find((m) => m.role === 'assistant')
		expect(assistantInSecond?.reasoning).toBe('I considered this carefully')
	})

	test('tool output exceeding maxToolOutputChars is truncated without double-encoding', async () => {
		const guild = withTool(
			buildGuild(
				{ main: { systemPrompt: 'p', tools: ['big', 'finish'] } },
				'main',
				{ contextPolicy: { maxToolOutputChars: 20 } },
			),
			{
				name: 'big',
				description: 'returns a large payload',
				parameters: { type: 'object', properties: {} },
			},
		)
		const bigCall: ToolCall = {
			id: 'b1',
			type: 'function',
			function: { name: 'big', arguments: '{}' },
		}
		const bigHandler: ToolHandler = () => ({ kind: 'success', data: { text: 'x'.repeat(200) } })
		const llm = new FakeLlm()
		llm.responses = [
			success([bigCall]),
			success([finishCall({ status: 'success', summary: 'done' })]),
		]
		const { deps } = makeDeps(llm)
		const depsWithBig: EngineDependencies = {
			...deps,
			additionalToolHandlers: { big: bigHandler },
		}

		await runRole(depsWithBig, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		const secondCallMessages = llm.calls[1]?.messages ?? []
		const toolMessage = secondCallMessages.find((m) => m.role === 'tool')
		const content = toolMessage?.content ?? ''
		expect(content.includes('[truncated:')).toBe(true)
		expect(content.startsWith('{')).toBe(true)
		expect(content.startsWith('"')).toBe(false)
	})
})

describe('runRole — role-tree log events', () => {
	test('an entry-role run logs exactly one role_start with parent omitted', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [success([finishCall({ status: 'success', summary: 'done' })])]
		const { deps, events } = makeDeps(llm)

		await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		const starts = events.filter((e) => e.type === 'role_start')
		expect(starts.length).toBe(1)
		expect(payloadField(starts[0]!, 'role')).toBe('main')
		expect(payloadField(starts[0]!, 'depth')).toBe(0)
		expect(payloadField(starts[0]!, 'task')).toBe('do it')
		expect(payloadField(starts[0]!, 'parent')).toBeUndefined()

		const finishes = events.filter((e) => e.type === 'role_finished')
		expect(finishes.length).toBe(1)
		expect(payloadField(finishes[0]!, 'role')).toBe('main')
		expect(payloadField(finishes[0]!, 'depth')).toBe(0)
		expect(payloadField(finishes[0]!, 'status')).toBe('success')
		expect(payloadField(finishes[0]!, 'parent')).toBeUndefined()
	})

	test('a parent→child run logs role_start and agent_call linking parent, child, and depth', async () => {
		const guild = buildGuild(
			{
				parent: { systemPrompt: 'p', tools: ['agent', 'finish'] },
				child: { systemPrompt: 'c', tools: ['finish'] },
			},
			'parent',
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([agentCall('child', 'subtask')]),
			success([finishCall({ status: 'success', summary: 'child done' })]),
			success([finishCall({ status: 'success', summary: 'parent done' })]),
		]
		const { deps, events } = makeDeps(llm)

		await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'parent',
			task: 'delegate',
		})

		const starts = events.filter((e) => e.type === 'role_start')
		// Exactly two role_start events: one for the entry parent, one for the child.
		expect(starts.length).toBe(2)
		const childStart = starts.find((e) => payloadField(e, 'role') === 'child')
		expect(childStart).toBeDefined()
		expect(payloadField(childStart!, 'parent')).toBe('parent')
		expect(payloadField(childStart!, 'depth')).toBe(1)
		expect(payloadField(childStart!, 'task')).toBe('subtask')

		const agentCalls = events.filter((e) => e.type === 'agent_call')
		expect(agentCalls.length).toBe(1)
		expect(payloadField(agentCalls[0]!, 'parent')).toBe('parent')
		expect(payloadField(agentCalls[0]!, 'child')).toBe('child')
		expect(payloadField(agentCalls[0]!, 'depth')).toBe(1)

		const finishes = events.filter((e) => e.type === 'role_finished')
		expect(finishes.length).toBe(2)
		const childFinish = finishes.find((e) => payloadField(e, 'role') === 'child')
		expect(payloadField(childFinish!, 'parent')).toBe('parent')
		expect(payloadField(childFinish!, 'depth')).toBe(1)
	})

	test('a refused agent call (depth exceeded) emits no role_start for the never-run child', async () => {
		const tight: ExecutorConfig = { ...baseExecutor, maxAgentDepth: 0 }
		const guild = buildGuild(
			{
				parent: { systemPrompt: 'p', tools: ['agent', 'finish'] },
				child: { systemPrompt: 'c', tools: ['finish'] },
			},
			'parent',
			{ executor: tight },
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([agentCall('child', 'subtask')]),
			success([finishCall({ status: 'success', summary: 'parent done' })]),
		]
		const { deps, events } = makeDeps(llm)

		await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'parent',
			task: 'delegate',
		})

		const starts = events.filter((e) => e.type === 'role_start')
		// Only the parent's role_start; the refused child never runs.
		expect(starts.length).toBe(1)
		expect(payloadField(starts[0]!, 'role')).toBe('parent')
		expect(events.some((e) => e.type === 'depth_exceeded')).toBe(true)
		expect(events.some((e) => e.type === 'agent_call')).toBe(false)
	})
})

describe('runRole — rich LLM and tool payloads', () => {
	test('llm_call carries the sent message list, received response, finishReason, and per-call usage', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		const finish = finishCall({ status: 'success', summary: 'done' })
		llm.responses = [success([finish], { content: 'the answer', finishReason: 'tool_calls', promptTokens: 42, completionTokens: 7 })]
		const { deps, events } = makeDeps(llm)

		await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		const llmCall = events.find((e) => e.type === 'llm_call')
		expect(llmCall).toBeDefined()
		const payload = llmCall!.payload
		expect(isRecord(payload)).toBe(true)
		if (!isRecord(payload)) throw new Error('llm_call payload is not a record')
		expect(payload['messageCount']).toBe(2)
		// The sent message list carries role and content for each message, with tool_calls on assistant messages included.
		const sent = payload['sent']
		expect(Array.isArray(sent)).toBe(true)
		expect((sent as unknown[]).length).toBe(2)
		expect((sent as { role: string }[])[0]!.role).toBe('system')
		expect((sent as { role: string }[])[1]!.role).toBe('user')
		// The received response carries the assistant content and the parsed tool calls with name and arguments.
		const received = payload['received'] as { content?: string; toolCalls: Array<{ id: string; function: { name: string; arguments: string } }> }
		expect(received.content).toBe('the answer')
		expect(received.toolCalls.length).toBe(1)
		expect(received.toolCalls[0]!.function.name).toBe('finish')
		expect(received.toolCalls[0]!.function.arguments).toBe(finish.function.arguments)
		expect(payload['finishReason']).toBe('tool_calls')
		const usage = payload['usage'] as { promptTokens: number; completionTokens: number; totalTokens: number }
		expect(usage.promptTokens).toBe(42)
		expect(usage.completionTokens).toBe(7)
		expect(usage.totalTokens).toBe(49)
	})

	test('llm_call is not emitted on the llm_unavailable path', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [llmUnavailable('connection refused')]
		const { deps, events } = makeDeps(llm)

		await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(events.some((e) => e.type === 'llm_unavailable')).toBe(true)
		expect(events.some((e) => e.type === 'llm_call')).toBe(false)
	})

	test('llm_call is not emitted on the context_budget_exceeded path', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [
			contextExceeded(35000, 32768),
			success([finishCall({ status: 'success', summary: 'recovered' })]),
		]
		const { deps, events } = makeDeps(llm)

		await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		// Exactly one llm_call: the recovered success turn, not the over-budget rejection.
		const llmCalls = events.filter((e) => e.type === 'llm_call')
		expect(llmCalls.length).toBe(1)
		expect(events.some((e) => e.type === 'context_budget_exceeded')).toBe(true)
	})

	test('tool_call carries the model raw arguments and tool_result carries the full un-truncated result', async () => {
		const guild = withTool(
			buildGuild(
				{ main: { systemPrompt: 'p', tools: ['big', 'finish'] } },
				'main',
				{ contextPolicy: { maxToolOutputChars: 20 } },
			),
			{
				name: 'big',
				description: 'returns a large payload',
				parameters: { type: 'object', properties: {} },
			},
		)
		const bigCall: ToolCall = {
			id: 'b1',
			type: 'function',
			function: { name: 'big', arguments: '{"path":"x.txt"}' },
		}
		const bigHandler: ToolHandler = () => ({ kind: 'success', data: { text: 'x'.repeat(200) } })
		const llm = new FakeLlm()
		llm.responses = [
			success([bigCall]),
			success([finishCall({ status: 'success', summary: 'done' })]),
		]
		const { deps, events } = makeDeps(llm)
		const depsWithBig: EngineDependencies = {
			...deps,
			additionalToolHandlers: { big: bigHandler },
		}

		await runRole(depsWithBig, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		const toolCall = events.find((e) => e.type === 'tool_call' && payloadField(e, 'tool') === 'big')
		expect(toolCall).toBeDefined()
		expect(payloadField(toolCall!, 'arguments')).toBe('{"path":"x.txt"}')

		const toolResult = events.find((e) => e.type === 'tool_result' && payloadField(e, 'tool') === 'big')
		expect(toolResult).toBeDefined()
		expect(payloadField(toolResult!, 'kind')).toBe('success')
		// The logged result is the full un-truncated ToolResult, so its data retains the full 200-char string even though truncation applies to what is appended to the conversation.
		const result = payloadField(toolResult!, 'result') as { kind: string; data: { text: string } }
		expect(result.kind).toBe('success')
		expect(result.data.text.length).toBe(200)
	})
})

describe('runRole effort directive injection', () => {
	test('the entry role receives the effort directive merged into its single system message', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [success([finishCall({ status: 'success', summary: 'Done' })])]
		const { deps } = makeDeps(llm)

		await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
			effort: 2,
		})

		expect(llm.calls.length).toBe(1)
		const messages = llm.calls[0]!.messages
		// The directive is merged into the single system message, not emitted as a second one — many chat templates reject a system message that is not the first message.
		expect(messages).toHaveLength(2)
		expect(messages[0]).toEqual({ role: 'system', content: `prompt for main\n\n${effortDirective(2)}` })
		expect(messages[0]!.content).toContain('Quality level: 2 of 5')
		expect(messages[1]).toEqual({ role: 'user', content: 'do it' })
	})

	test('the entry role receives no directive when effort is absent on the context', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [success([finishCall({ status: 'success', summary: 'Done' })])]
		const { deps } = makeDeps(llm)

		await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		const messages = llm.calls[0]!.messages
		expect(messages.length).toBe(2)
		expect(messages[0]).toEqual({ role: 'system', content: 'prompt for main' })
		expect(messages[1]).toEqual({ role: 'user', content: 'do it' })
	})

	test('a child role does not receive the effort directive even though the context is spread from the parent', async () => {
		const guild = buildGuild(
			{
				parent: { systemPrompt: 'p', tools: ['agent', 'finish'] },
				child: { systemPrompt: 'c', tools: ['finish'] },
			},
			'parent',
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([agentCall('child', 'subtask')]),
			success([finishCall({ status: 'success', summary: 'child done' })]),
			success([finishCall({ status: 'success', summary: 'parent done' })]),
		]
		const { deps } = makeDeps(llm)

		await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'parent',
			task: 'delegate',
			effort: 5,
		})

		// calls[0] = parent (entry, has directive); calls[1] = child (depth 1, no directive); calls[2] = parent follow-up.
		const childMessages = llm.calls[1]!.messages
		expect(childMessages[0]).toEqual({ role: 'system', content: 'prompt for child' })
		expect(childMessages[1]).toEqual({ role: 'user', content: 'subtask' })
		expect(childMessages.length).toBe(2)
		expect(childMessages.some((m) => m.content.includes('Quality level'))).toBe(false)
	})
})
