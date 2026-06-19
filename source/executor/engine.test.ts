import { describe, expect, test } from 'bun:test'

import type { ContextPolicy, ExecutorConfig, GuildConfig, LogEvent, Message, ModelConfig, RoleDefinition, ToolCall, ToolManifest } from '../shared/types.js'
import { runRole, type EngineDependencies } from './engine.ts'
import type { LlmCallResult, LlmCaller } from './llm.ts'
import type { LoadedGuild } from './loader.ts'
import type { AppendLog } from './persistence.ts'
import { stubHumanBackend, withTool } from './test-fixtures.ts'
import type { ToolHandler } from './tool-dispatch.ts'

function success(toolCalls: ToolCall[], opts: { content?: string; promptTokens?: number; completionTokens?: number } = {}): LlmCallResult {
	return {
		kind: 'success',
		content: opts.content ?? '',
		reasoning: null,
		toolCalls,
		usage: {
			promptTokens: opts.promptTokens ?? 10,
			completionTokens: opts.completionTokens ?? 5,
		},
	}
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
			budget: { type: 'object' },
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
			startMs: Date.now(),
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
			startMs: Date.now(),
			roleName: 'parent',
			task: 'delegate',
		})

		expect(result).toEqual({ status: 'success', summary: 'parent done' })
		expect(llm.calls.length).toBe(3)
		expect(events.some((e) => e.type === 'role_finished' && (e.payload as { role: string }).role === 'child')).toBe(true)
		expect(events.some((e) => e.type === 'role_finished' && (e.payload as { role: string }).role === 'parent')).toBe(true)
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
			startMs: Date.now(),
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
			startMs: Date.now(),
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
			startMs: Date.now(),
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
			startMs: Date.now(),
			roleName: 'main',
			task: 'do it',
		})

		expect(result).toEqual({ status: 'success', summary: 'all done' })
		const implicitEvent = events.find((e) => e.type === 'implicit_finish')
		expect(implicitEvent).toBeDefined()
	})

	test('repeated identical tool calls trip loop_detected', async () => {
		const guild = withTool(
			buildGuild(
				{ main: { systemPrompt: 'p', tools: ['echo', 'finish'] } },
				'main',
			),
			{
				name: 'echo',
				description: 'echo',
				parameters: { type: 'object', properties: { x: { type: 'number' } } },
			},
		)
		const llm = new FakeLlm()
		const repeatCall: ToolCall = {
			id: 'e1',
			type: 'function',
			function: { name: 'echo', arguments: '{"x":1}' },
		}
		llm.responses = [
			success([repeatCall]),
			success([repeatCall]),
			success([repeatCall]),
			success([repeatCall]),
		]
		const { appendLog, events } = makeFakeAppendLog()
		const deps: EngineDependencies = {
			llmCaller: llm,
			appendLog,
			additionalToolHandlers: {
				echo: ((args: Record<string, unknown>) => ({ kind: 'success', data: args })) as ToolHandler,
			},
			humanBackend: stubHumanBackend,
		}

		const result = await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			startMs: Date.now(),
			roleName: 'main',
			task: 'do it',
		})

		expect(result.status).toBe('error')
		if (result.error) {
			expect(result.error.kind).toBe('loop_detected')
		}
		const loopEvent = events.find((e) => e.type === 'role_budget_exceeded')
		expect(loopEvent).toBeDefined()
	})

	test('per-role tool-call budget exceeded returns tool_budget_exceeded', async () => {
		const tight: ExecutorConfig = { ...baseExecutor, maxToolCallsPerRole: 2 }
		const guild = withTool(
			buildGuild(
				{ main: { systemPrompt: 'p', tools: ['echo', 'finish'] } },
				'main',
				{ executor: tight },
			),
			{
				name: 'echo',
				description: 'echo',
				parameters: { type: 'object', properties: { x: { type: 'number' } } },
			},
		)
		const llm = new FakeLlm()
		const call: ToolCall = {
			id: 'e1',
			type: 'function',
			function: { name: 'echo', arguments: '{"x":1}' },
		}
		llm.responses = [
			success([call]),
			success([call]),
			success([call]),
			success([call]),
		]
		const { appendLog, events } = makeFakeAppendLog()
		const deps: EngineDependencies = {
			llmCaller: llm,
			appendLog,
			additionalToolHandlers: {
				echo: ((args: Record<string, unknown>) => ({ kind: 'success', data: args })) as ToolHandler,
			},
			humanBackend: stubHumanBackend,
		}

		const result = await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			startMs: Date.now(),
			roleName: 'main',
			task: 'do it',
		})

		expect(result.status).toBe('error')
		if (result.error) {
			expect(result.error.kind).toBe('tool_budget_exceeded')
		}
		const budgetEvent = events.find((e) => e.type === 'role_budget_exceeded')
		expect(budgetEvent).toBeDefined()
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
			startMs: Date.now(),
			roleName: 'grandparent',
			task: 'delegate',
		})

		expect(result.status).toBe('success')
		expect(llm.calls.length).toBe(4)
		const depthEvent = events.find((e) => e.type === 'depth_exceeded')
		expect(depthEvent).toBeDefined()
		if (depthEvent) {
			const payload = depthEvent.payload as { depth: number }
			expect(payload.depth).toBeGreaterThan(tight.maxAgentDepth)
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
			startMs: Date.now(),
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
			startMs: Date.now(),
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
			startMs: Date.now(),
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
			startMs: Date.now(),
			roleName: 'parent',
			task: 'delegate',
		})

		expect(result).toEqual({ status: 'success', summary: 'parent done' })
		expect(llm.calls.length).toBe(3)
	})

	test('per-role token budget exceeded returns token_budget_exceeded', async () => {
		const tight: ExecutorConfig = { ...baseExecutor, maxTokensPerRole: 100 }
		const guild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
			{ executor: tight },
		)
		const llm = new FakeLlm()
		const finishArgs = { status: 'success' as const, summary: 'ok' }
		llm.responses = [
			success([finishCall(finishArgs)], { promptTokens: 80, completionTokens: 30 }),
			success([finishCall(finishArgs)], { promptTokens: 80, completionTokens: 30 }),
		]
		const { deps, events } = makeDeps(llm)

		const result = await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			startMs: Date.now(),
			roleName: 'main',
			task: 'do it',
		})

		expect(result.status).toBe('error')
		if (result.error) {
			expect(result.error.kind).toBe('token_budget_exceeded')
		}
		const budgetEvent = events.find((e) => e.type === 'role_budget_exceeded')
		expect(budgetEvent).toBeDefined()
	})

	test('wall-clock budget exceeded returns timeout', async () => {
		const tight: ExecutorConfig = { ...baseExecutor, maxRunTimeSeconds: 0 }
		const guild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
			{ executor: tight },
		)
		const llm = new FakeLlm()
		const finishArgs = { status: 'success' as const, summary: 'ok' }
		llm.responses = [
			success([finishCall(finishArgs)]),
		]
		const { deps, events } = makeDeps(llm)

		const past = Date.now() - 60_000
		const result = await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			startMs: past,
			roleName: 'main',
			task: 'do it',
		})

		expect(result.status).toBe('error')
		if (result.error) {
			expect(result.error.kind).toBe('timeout')
		}
		const globalEvent = events.find((e) => e.type === 'global_budget_exceeded')
		expect(globalEvent).toBeDefined()
	})

	test('token budget accumulates across iterations (regression for overwrite bug)', async () => {
		const tight: ExecutorConfig = { ...baseExecutor, maxTokensPerRole: 60 }
		const guild = withTool(
			buildGuild(
				{ main: { systemPrompt: 'p', tools: ['echo', 'finish'] } },
				'main',
				{ executor: tight },
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
		llm.responses = [
			success([echoCall], { promptTokens: 40, completionTokens: 10 }),
			success([echoCall], { promptTokens: 40, completionTokens: 10 }),
			success([finishCall({ status: 'success', summary: 'should not reach' })], { promptTokens: 5, completionTokens: 5 }),
		]
		const { deps, events } = makeDeps(llm)
		const depsWithEcho: EngineDependencies = {
			...deps,
			additionalToolHandlers: {
				echo: ((args: Record<string, unknown>) => ({ kind: 'success', data: args })) as ToolHandler,
			},
		}

		const result = await runRole(depsWithEcho, {
			loadedGuild: guild,
			depth: 0,
			startMs: Date.now(),
			roleName: 'main',
			task: 'do it',
		})

		expect(result.status).toBe('error')
		if (result.error) {
			expect(result.error.kind).toBe('token_budget_exceeded')
		}
		const budgetEvent = events.find((e) => e.type === 'role_budget_exceeded')
		expect(budgetEvent).toBeDefined()
		expect(llm.calls.length).toBe(2)
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
			startMs: Date.now(),
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
				echo: ((args: Record<string, unknown>) => ({ kind: 'success', data: args })) as ToolHandler,
			},
		}

		const result = await runRole(depsWithEcho, {
			loadedGuild: guild,
			depth: 0,
			startMs: Date.now(),
			roleName: 'main',
			task: 'do it',
		})

		expect(result.status).toBe('success')
		expect(llm.calls.length).toBe(2)
		const secondCallMessages = llm.calls[1]?.messages ?? []
		const assistantInSecond = secondCallMessages.find((m) => m.role === 'assistant')
		expect(assistantInSecond?.reasoning).toBe('I considered this carefully')
	})
})
