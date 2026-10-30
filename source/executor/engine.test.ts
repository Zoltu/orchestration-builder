import { describe, expect, test } from 'bun:test'

import type { ContextPolicy, DeploymentConfig, ExecutorConfig, GuildConfig, LogEvent, Message, ResolvedModelConfig, ResultCard, RoleDefinition, ToolCall, ToolManifest, ToolResult } from './types.js'
import { effortDirective } from './effort.ts'
import { involvementDirective } from './involvement.ts'
import { createContextPressureTracker } from './context/index.js'
import { runRole } from './engine.ts'
import type { EngineDependencies } from './engine-state.ts'
import { resumeRoleStack } from './resume.ts'
import { createInterruptQueue } from './interrupts.ts'
import { createOperatorPauseQueue } from './operator-pause.ts'
import type { LlmCallResult, LlmCaller, LlmFetch, LlmFetchRequest, LlmRequest, LlmStreamDelta, LlmStreamResponse } from './llm.ts'
import { createLlmCaller } from './llm.ts'
import type { LoadedGuild } from './loader.ts'
import type { AppendLog } from './persistence.ts'
import { createRoleRegistry } from './role-registry.ts'
import { isRunCheckpoint, type RunCheckpoint } from './checkpoint.ts'
import { createInvocationJournal } from './invocation.ts'
import { createEmptyRoleState, createFakeCheckpointRecorder, createFakeRoleSnapshotStore, createFixtureToolPlatform, createProviderFailure as providerFailure, recordingHumanBackend, stubHumanBackend, withTool, defined } from './test-fixtures.ts'
import { createRunBaseTracker } from './base-state.ts'
import { createRunParkTracker, type RunParkTracker } from './park-state.ts'
import type { RoleSnapshotStore } from './role-snapshot.ts'
import type { RoleDelta } from './stream-channel.ts'
import type { ToolPlatform } from './tool-platform-port.ts'
import { createToolError } from './errors.ts'
import { isObject, safeJsonParse } from './validation.ts'

async function runRoleCard(...args: Parameters<typeof runRole>): Promise<ResultCard> {
	const outcome = await runRole(...args)
	if (outcome.kind === 'suspended' || outcome.kind === 'operator_paused') throw new Error('unexpected pause outside a pause test')
	return outcome.card
}

async function resumeRoleStackCard(...args: Parameters<typeof resumeRoleStack>): Promise<ResultCard> {
	const outcome = await resumeRoleStack(...args)
	if (outcome.kind === 'suspended' || outcome.kind === 'operator_paused') throw new Error('unexpected pause outside a pause test')
	return outcome.card
}

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

function llmUnavailable(message = 'empty response (no content, no tool calls)'): LlmCallResult {
	return { kind: 'llm_unavailable', message }
}

class FakeLlm implements LlmCaller {
	responses: LlmCallResult[] = []
	calls: Array<{ messages: Message[]; tools?: ToolManifest[] }> = []
	// Per-call scripted streaming deltas, emitted through the request's onDelta before the scripted response is returned. Absent for a call emits nothing.
	deltasPerCall: LlmStreamDelta[][] = []

	async call(request: LlmRequest): Promise<LlmCallResult> {
		this.calls.push(request)
		const deltas = this.deltasPerCall.shift()
		if (deltas !== undefined) {
			for (const delta of deltas) request.onDelta?.(delta)
		}
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

// A fake wire leaf for tests that assert on the actual Responses API payload the engine produces: SSE streams are scripted per request and every request body is recorded whole.
class FakeWire {
	responses: LlmStreamResponse[] = []
	requests: LlmFetchRequest[] = []

	llmFetch: LlmFetch = (request) => {
		this.requests.push(request)
		const next = this.responses.shift()
		if (next === undefined) return Promise.resolve({ kind: 'http_error', status: 500, errorBody: 'unscripted response', headers: {} })
		return Promise.resolve(next)
	}
}

function sseChunks(output: unknown[]): Uint8Array[] {
	const terminal = { type: 'response.completed', response: { status: 'completed', output, usage: { input_tokens: 10, output_tokens: 5 } } }
	return [new TextEncoder().encode(`data: ${JSON.stringify(terminal)}\n\n`)]
}

function streamOf(chunks: Uint8Array[]): LlmStreamResponse {
	return { kind: 'stream', status: 200, stream: new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close() } }) }
}

function wireInput(request: LlmFetchRequest | undefined): unknown[] {
	if (request === undefined) throw new Error('expected a captured wire request')
	const parsed: unknown = JSON.parse(request.body)
	if (!isRecord(parsed) || !Array.isArray(parsed['input'])) throw new Error('captured request body carries no input array')
	return parsed['input']
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

const continueAgentManifest: ToolManifest = {
	name: 'continue_agent',
	description: 'Continue a finished child role as a new seeded instance.',
	parameters: {
		type: 'object',
		required: ['role'],
		properties: {
			role: { type: 'string' },
			roleId: { type: 'string' },
			comment: { type: 'string' },
		},
	},
}

function buildGuild(roles: Record<string, RoleDefinition>, entryRole: string, extras: Partial<DeploymentConfig> = {}): LoadedGuild {
	const config: GuildConfig = {
		entryRole,
		roles,
		tools: ['guild/tools/finish.json', 'guild/tools/agent.json'],
	}
	const deployment: DeploymentConfig = {
		model: baseModel,
		executor: baseExecutor,
		contextPolicy: baseContextPolicy,
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
	return { config, deployment, prompts, tools }
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

function continueAgentCall(role: string, comment?: string, roleId?: string): ToolCall {
	const args: Record<string, unknown> = { role }
	if (comment !== undefined) args['comment'] = comment
	if (roleId !== undefined) args['roleId'] = roleId
	return {
		id: 'continue_1',
		type: 'function',
		function: {
			name: 'continue_agent',
			arguments: JSON.stringify(args),
		},
	}
}

function continueAgentGuild(): LoadedGuild {
	const guild = buildGuild(
		{
			parent: { systemPrompt: 'p', tools: ['agent', 'continue_agent', 'finish'] },
			child: { systemPrompt: 'c', tools: ['finish'] },
		},
		'parent',
	)
	return withTool(guild, continueAgentManifest)
}

interface ContinueAgentCardShape {
	status: string
	error?: { kind: string }
}

// Narrows the ResultCard the parent received back from a continue_agent tool result, so the error-path assertions read the card's status and error kind without a typecast.
function continueAgentCard(events: LogEvent[]): ContinueAgentCardShape {
	const toolResult = events.find((e) => e.type === 'tool_result' && payloadField(e, 'tool') === 'continue_agent')
	const event = defined(toolResult, 'continue_agent tool_result event')
	const loggedResult = payloadField(event, 'result')
	if (!isRecord(loggedResult)) throw new Error('expected a logged continue_agent result')
	const data = loggedResult['data']
	if (!isRecord(data)) throw new Error('expected the continue_agent card data')
	const status = data['status']
	if (typeof status !== 'string') throw new Error('expected the continue_agent card status')
	const errorRaw = data['error']
	if (isRecord(errorRaw) && typeof errorRaw['kind'] === 'string') return { status, error: { kind: errorRaw['kind'] } }
	return { status }
}

// Wraps the real platform so a test can add a scripted tool while preserving the platform's gating and its rule that built-ins and native handlers are never shadowed. This keeps engine tests focused on orchestration without reopening the production platform to arbitrary handler maps.
type FixtureToolHandler = (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>

function withExtraHandlers(platform: ToolPlatform, extra: Record<string, FixtureToolHandler>): ToolPlatform {
	return {
		handlerNames(runScope) {
			return [...new Set([...Object.keys(extra), ...platform.handlerNames(runScope)])]
		},
		validateCall(roleDefinition, runScope, call) {
			if (platform.handlerNames(runScope).includes(call.function.name)) return platform.validateCall(roleDefinition, runScope, call)
			if (!runScope.manifestNames.has(call.function.name)) return createToolError('unknown_tool', `Tool ${call.function.name} is not registered in the Guild`)
			if (!roleDefinition.tools.includes(call.function.name)) return createToolError('invalid_tool_call', `Tool ${call.function.name} not allowed for this role`)
			return null
		},
		async dispatch(roleDefinition, runScope, call, invocation) {
			const baseOwnsTool = platform.handlerNames(runScope).includes(call.function.name)
			if (baseOwnsTool) return platform.dispatch(roleDefinition, runScope, call, invocation)
			const handler = extra[call.function.name]
			if (handler === undefined) return platform.dispatch(roleDefinition, runScope, call, invocation)
			if (!runScope.manifestNames.has(call.function.name)) return { kind: 'result', result: createToolError('unknown_tool', `Tool ${call.function.name} is not registered in the Guild`) }
			if (!roleDefinition.tools.includes(call.function.name)) return { kind: 'result', result: createToolError('invalid_tool_call', `Tool ${call.function.name} not allowed for this role`) }
			const parsed = safeJsonParse(call.function.arguments)
			if (!parsed.ok) return { kind: 'result', result: createToolError('invalid_arguments', 'arguments must be valid JSON') }
			if (!isObject(parsed.value)) return { kind: 'result', result: createToolError('invalid_arguments', 'arguments must be a JSON object') }
			return { kind: 'result', result: await handler(parsed.value) }
		},
		suspendsChild(toolName) {
			return platform.suspendsChild(toolName)
		},
		observesRole(toolName) {
			return platform.observesRole(toolName)
		},
	}
}

function makeDeps(llm: LlmCaller, registryCounter = 0): { deps: EngineDependencies; events: LogEvent[]; checkpoints: RunCheckpoint[]; parkTracker: RunParkTracker; roleSnapshots: RoleSnapshotStore } {
	const { appendLog, events } = makeFakeAppendLog()
	const roleRegistry = createRoleRegistry(registryCounter)
	const contextPressureTracker = createContextPressureTracker()
	const parkTracker = createRunParkTracker()
	const baseTracker = createRunBaseTracker()
	const roleSnapshots = createFakeRoleSnapshotStore()
	const sink = createFakeCheckpointRecorder(roleRegistry, contextPressureTracker, parkTracker, baseTracker)
	const deps: EngineDependencies = {
		llmCaller: llm,
		appendLog,
		runId: 'test-run',
		readRunLogEvents: () => events,
		invocationJournal: createInvocationJournal(appendLog),
		toolPlatform: createFixtureToolPlatform(),
		humanBackend: stubHumanBackend,
		roleRegistry,
		interruptQueue: createInterruptQueue(),
		operatorPauseQueue: createOperatorPauseQueue(),
		contextPressureTracker,
		checkpointRecorder: sink.recorder,
		parkTracker,
		baseTracker,
		publishDelta: noOpPublishDelta,
		roleSnapshots,
		readProjectDoc: () => ({ kind: 'unavailable', reason: 'not used in these tests' }),
	}
	return { deps, events, checkpoints: sink.checkpoints, parkTracker, roleSnapshots }
}

function noOpPublishDelta(): void {}

const echoHandler: FixtureToolHandler = (args) => ({ kind: 'success', data: args })

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function payloadField(event: LogEvent, field: string): unknown {
	const payload = event.payload
	return isRecord(payload) ? payload[field] : undefined
}

function isRoleList(value: unknown): value is Array<{ role: string }> {
	return Array.isArray(value) && value.every((entry) => isRecord(entry) && typeof entry['role'] === 'string')
}

interface ReceivedLlmResponse {
	content?: string
	toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>
}

function isReceivedLlmResponse(value: unknown): value is ReceivedLlmResponse {
	if (!isRecord(value) || !Array.isArray(value['toolCalls'])) return false
	return value['toolCalls'].every((call) => {
		if (!isRecord(call)) return false
		const fn = call['function']
		return typeof call['id'] === 'string' && isRecord(fn) && typeof fn['name'] === 'string' && typeof fn['arguments'] === 'string'
	})
}

function isUsageTotals(value: unknown): value is { promptTokens: number; completionTokens: number; totalTokens: number; cachedPromptTokens?: number } {
	return isRecord(value) && typeof value['promptTokens'] === 'number' && typeof value['completionTokens'] === 'number' && typeof value['totalTokens'] === 'number'
}

function isLoggedToolResult(value: unknown): value is { kind: string; data: { text: string } } {
	if (!isRecord(value) || typeof value['kind'] !== 'string') return false
	const data = value['data']
	return isRecord(data) && typeof data['text'] === 'string'
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

		const result = await runRoleCard(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result).toEqual({ status: 'success', summary: 'Done' })
		expect(llm.calls.length).toBe(1)
		expect(events.some((e) => e.type === 'role_finished')).toBe(true)
		expect(events.some((e) => e.type === 'llm_call')).toBe(true)
		const toolCallEvent = defined(events.find((e) => e.type === 'tool_call'), 'tool_call event')
		const toolResultEvent = defined(events.find((e) => e.type === 'tool_result'), 'tool_result event')
		expect(payloadField(toolCallEvent, 'callId')).toBe('tool:finish_1')
		expect(payloadField(toolCallEvent, 'parentCallId')).toBe('role:main-0-1')
		expect(payloadField(toolResultEvent, 'callId')).toBe('tool:finish_1')
		const roleFinished = defined(events.find((e) => e.type === 'role_finished'), 'role_finished event')
		expect(payloadField(roleFinished, 'callId')).toBe('role:main-0-1')
	})

	test('records the protected prefix explicitly for fresh, continuation, and seeded histories', async () => {
		const guild = buildGuild({ main: { systemPrompt: 'p', tools: ['finish'] } }, 'main')
		const continuation = { runId: 'run-20260101-000000', task: 'prior task', summary: 'prior summary' }

		const freshLlm = new FakeLlm()
		freshLlm.responses = [success([finishCall({ status: 'success', summary: 'fresh' })])]
		const fresh = makeDeps(freshLlm)
		await runRoleCard(fresh.deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })
		expect(fresh.checkpoints[fresh.checkpoints.length - 1]?.frames[0]?.roleState.protectedPrefixLength).toBe(2)

		const continuationLlm = new FakeLlm()
		continuationLlm.responses = [success([finishCall({ status: 'success', summary: 'continued' })])]
		const continued = makeDeps(continuationLlm)
		await runRoleCard(continued.deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it again', continuation })
		expect(continued.checkpoints[continued.checkpoints.length - 1]?.frames[0]?.roleState.protectedPrefixLength).toBe(4)

		const seededLlm = new FakeLlm()
		seededLlm.responses = [success([finishCall({ status: 'success', summary: 'seeded' })])]
		const seeded = makeDeps(seededLlm)
		await runRoleCard(seeded.deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'comment' }, undefined, {
			history: [
				{ role: 'system', content: 'sys' },
				{ role: 'user', content: 'prior task' },
				{ role: 'assistant', content: 'prior result' },
				{ role: 'user', content: 'comment' },
			],
			continuedFrom: 'main-0-1',
		})
		expect(seeded.checkpoints[seeded.checkpoints.length - 1]?.frames[0]?.roleState.protectedPrefixLength).toBe(2)

		const resumedContinuationLlm = new FakeLlm()
		resumedContinuationLlm.responses = [success([finishCall({ status: 'success', summary: 'restored' })])]
		const resumedContinuation = makeDeps(resumedContinuationLlm)
		await runRoleCard(resumedContinuation.deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it again' }, {
			roleId: 'main-0-1',
			roleState: createEmptyRoleState({
				history: [
					{ role: 'system', content: 'sys' },
					{ role: 'user', content: 'prior task' },
					{ role: 'assistant', content: 'prior result' },
					{ role: 'user', content: 'do it again' },
				],
				protectedPrefixLength: 4,
			}),
		})
		expect(resumedContinuation.checkpoints[resumedContinuation.checkpoints.length - 1]?.frames[0]?.roleState.protectedPrefixLength).toBe(4)
	})

	test('an invalid finish summary is rejected as a tool result and the role continues to a valid finish', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([namedCall('bad_finish', 'finish', { status: 'success', summary: '   ' })]),
			success([finishCall({ status: 'success', summary: 'done' })]),
		]
		const { deps, events } = makeDeps(llm)

		const result = await runRoleCard(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result).toEqual({ status: 'success', summary: 'done' })
		expect(llm.calls.length).toBe(2)
		const finishResults = events.filter((e) => e.type === 'tool_result' && payloadField(e, 'tool') === 'finish')
		expect(finishResults.length).toBe(2)
		const rejected = payloadField(defined(finishResults[0], 'rejected finish result'), 'result')
		if (!isRecord(rejected)) throw new Error('expected the rejected finish tool result payload')
		expect(rejected['kind']).toBe('invalid_arguments')
		expect(rejected['message']).toBe('summary must be a non-empty string')
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

		const result = await runRoleCard(deps, {
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

	test('context_budget_exceeded continues with a platform notice as a user message', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [
			contextExceeded(0, 32768),
			success([finishCall({ status: 'success', summary: 'recovered' })]),
		]
		const { deps, events } = makeDeps(llm)

		const result = await runRoleCard(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result).toEqual({ status: 'success', summary: 'recovered' })
		expect(llm.calls.length).toBe(2)
		const contextEvent = events.find((e) => e.type === 'context_budget_exceeded')
		expect(contextEvent).toBeDefined()
		const recoveryMessages = llm.calls[1]?.messages ?? []
		const notice = recoveryMessages[recoveryMessages.length - 1]
		expect(notice?.role).toBe('user')
		expect(notice?.content.includes('[Platform notice — context window exceeded]')).toBe(true)
		// A tool message answering no assistant tool_call is a malformed request on OpenAI-compatible endpoints, so the notice must never be one.
		expect(recoveryMessages.some((m) => m.tool_call_id === 'context_budget_exceeded')).toBe(false)
	})

	test('context_budget_exceeded compacts the history so the recovery request fits', async () => {
		const guild = withTool(
			buildGuild(
				{ main: { systemPrompt: 'p', tools: ['big', 'finish'] } },
				'main',
			),
			{
				name: 'big',
				description: 'returns a large payload',
				parameters: { type: 'object', properties: {} },
			},
		)
		const bigCall = (id: string): ToolCall => ({ id, type: 'function', function: { name: 'big', arguments: '{}' } })
		const bigHandler: FixtureToolHandler = () => ({ kind: 'success', data: { text: 'x'.repeat(2000) } })
		const llm = new FakeLlm()
		llm.responses = [
			success([bigCall('b1')]),
			success([bigCall('b2')]),
			success([bigCall('b3')]),
			contextExceeded(0, 1000),
			success([finishCall({ status: 'success', summary: 'recovered' })]),
		]
		const { deps, events } = makeDeps(llm)
		const depsWithBig: EngineDependencies = { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { big: bigHandler }) }

		const result = await runRoleCard(depsWithBig, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result).toEqual({ status: 'success', summary: 'recovered' })
		expect(llm.calls.length).toBe(5)
		const rejectedMessages = llm.calls[3]?.messages ?? []
		const recoveryMessages = llm.calls[4]?.messages ?? []
		expect(rejectedMessages.length).toBe(8)
		expect(recoveryMessages.length).toBeLessThan(rejectedMessages.length)
		// The two oldest turns were dropped; system, task, and the most recent turn survive.
		expect(recoveryMessages[0]?.role).toBe('system')
		expect(recoveryMessages[1]?.role).toBe('user')
		expect(recoveryMessages[2]?.tool_calls?.[0]?.id).toBe('b3')
		expect(recoveryMessages[3]?.tool_call_id).toBe('b3')
		const compactedEvent = events.find((e) => e.type === 'context_compacted')
		if (compactedEvent === undefined) throw new Error('expected a context_compacted event')
		expect(payloadField(compactedEvent, 'droppedMessages')).toBe(4)
		expect(payloadField(compactedEvent, 'strippedReasoningMessages')).toBe(0)
	})

	test('repeated context_budget_exceeded rejections finish the role with an error instead of looping', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [
			contextExceeded(0, 32768),
			contextExceeded(0, 32768),
			contextExceeded(0, 32768),
			contextExceeded(0, 32768),
		]
		const { deps, events } = makeDeps(llm)

		const result = await runRoleCard(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result.status).toBe('error')
		expect(result.error?.kind).toBe('context_budget_exceeded')
		expect(llm.calls.length).toBe(4)
		expect(events.filter((e) => e.type === 'context_budget_exceeded').length).toBe(4)
	})

	test('a context rejection that cannot be compacted away finishes immediately', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		// The endpoint reports a million prompt tokens for a tiny conversation: nothing can be dropped or truncated to make it fit.
		llm.responses = [contextExceeded(1_000_000, 100)]
		const { deps } = makeDeps(llm)

		const result = await runRoleCard(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result.status).toBe('error')
		expect(result.error?.kind).toBe('context_budget_exceeded')
		expect(llm.calls.length).toBe(1)
	})

	test('a successful call resets the context recovery attempt counter', async () => {
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
		const echoCall: ToolCall = {
			id: 'e1',
			type: 'function',
			function: { name: 'echo', arguments: '{"x":1}' },
		}
		const llm = new FakeLlm()
		// Three rejections, a successful turn, then three more rejections: without a reset the seventh rejection would finish the role.
		llm.responses = [
			contextExceeded(0, 32768),
			contextExceeded(0, 32768),
			contextExceeded(0, 32768),
			success([echoCall]),
			contextExceeded(0, 32768),
			contextExceeded(0, 32768),
			contextExceeded(0, 32768),
			success([finishCall({ status: 'success', summary: 'recovered' })]),
		]
		const { deps } = makeDeps(llm)
		const depsWithEcho: EngineDependencies = { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { echo: echoHandler }) }

		const result = await runRoleCard(depsWithEcho, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result).toEqual({ status: 'success', summary: 'recovered' })
		expect(llm.calls.length).toBe(8)
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

		const result = await runRoleCard(deps, {
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

		const result = await runRoleCard(deps, {
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

		const result = await runRoleCard(deps, {
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

		const result = await runRoleCard(deps, {
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

	test('a model-output failure returns a ResultCard with llm_unavailable error', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [llmUnavailable()]
		const { deps } = makeDeps(llm)

		const result = await runRoleCard(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result.status).toBe('error')
		if (result.error) {
			expect(result.error.kind).toBe('llm_unavailable')
		}
		// A failure without a response body carries no detail.
		expect(result.detail).toBeUndefined()
	})

	test('a provider failure detail stays in the log and out of the suspension record', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [{ ...providerFailure('billing'), detail: '{"error":"Insufficient credit. Please top up."}' }]
		const { deps, events } = makeDeps(llm)

		const outcome = await runRole(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(outcome.kind).toBe('suspended')
		if (outcome.kind !== 'suspended') throw new Error('expected a suspension')
		expect('detail' in outcome.suspension).toBe(false)
		const failureEvent = defined(events.find((event) => event.type === 'provider_failure'), 'provider_failure event')
		expect(payloadField(failureEvent, 'detail')).toBe('{"error":"Insufficient credit. Please top up."}')
	})

	test('unknown role returns an error ResultCard', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		const { deps } = makeDeps(llm)

		const result = await runRoleCard(deps, {
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

		await runRoleCard(deps, {
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

		const result = await runRoleCard(deps, {
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

		const result = await runRoleCard(deps, {
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

	test('reasoning persists on assistant messages across a round-trip', async () => {
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
			toolPlatform: withExtraHandlers(deps.toolPlatform, { echo: echoHandler }),
		}

		const result = await runRoleCard(depsWithEcho, {
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

	test('replayed reasoning reaches the wire before each assistant turn\'s items, and a null-reasoning turn emits no reasoning item', async () => {
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
		const wire = new FakeWire()
		wire.responses = [
			streamOf(sseChunks([
				{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'round one thought' }] },
				{ type: 'message', content: [{ type: 'output_text', text: 'Let me check.' }] },
				{ type: 'function_call', call_id: 'call_1', name: 'echo', arguments: '{"x":1}' },
			])),
			streamOf(sseChunks([
				{ type: 'message', content: [{ type: 'output_text', text: 'done' }] },
			])),
		]
		const caller = createLlmCaller(baseModel, undefined, { llmFetch: wire.llmFetch, sleep: () => Promise.resolve(), scheduleTimeout: () => () => undefined, random: () => 1, now: () => 0 })
		const { deps } = makeDeps(caller)
		const depsWithEcho: EngineDependencies = { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { echo: echoHandler }) }

		const result = await runRoleCard(depsWithEcho, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		expect(result.status).toBe('success')
		expect(wire.requests.length).toBe(2)
		// Round 1: the first request carries only the task — the reasoning item appears when the turn is replayed.
		expect(wireInput(wire.requests[0])).toEqual([
			{ role: 'user', content: [{ type: 'input_text', text: 'do it' }] },
		])
		// Round 2: the tool-call turn's reasoning is replayed before its message and function_call items, with the tool result following.
		expect(wireInput(wire.requests[1])).toEqual([
			{ role: 'user', content: [{ type: 'input_text', text: 'do it' }] },
			{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'round one thought' }] },
			{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Let me check.' }] },
			{ type: 'function_call', call_id: 'call_1', name: 'echo', arguments: '{"x":1}' },
			{ type: 'function_call_output', call_id: 'call_1', output: '{"x":1}' },
		])
	})

	test('a message whose reasoning was cleared by edit_context strip_reasoning sends no reasoning item to the wire', async () => {
		let guild = withTool(
			buildGuild(
				{ main: { systemPrompt: 'p', tools: ['echo', 'edit_context', 'finish'] } },
				'main',
			),
			{
				name: 'echo',
				description: 'echo',
				parameters: { type: 'object', properties: { x: { type: 'number' } } },
			},
		)
		guild = withTool(guild, { name: 'edit_context', description: 'Edit context.', parameters: { type: 'object', required: ['operations'], properties: { operations: { type: 'array' } } } })
		const wire = new FakeWire()
		wire.responses = [
			streamOf(sseChunks([
				{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'round one thought' }] },
				{ type: 'message', content: [{ type: 'output_text', text: 'Let me check.' }] },
				{ type: 'function_call', call_id: 'call_1', name: 'echo', arguments: '{"x":1}' },
			])),
			streamOf(sseChunks([
				{ type: 'function_call', call_id: 'call_2', name: 'edit_context', arguments: JSON.stringify({ operations: [{ op: 'strip_reasoning', range: [2, 3] }] }) },
			])),
			streamOf(sseChunks([
				{ type: 'message', content: [{ type: 'output_text', text: 'done' }] },
			])),
		]
		const caller = createLlmCaller(baseModel, undefined, { llmFetch: wire.llmFetch, sleep: () => Promise.resolve(), scheduleTimeout: () => () => undefined, random: () => 1, now: () => 0 })
		const { deps } = makeDeps(caller)
		const depsWithEcho: EngineDependencies = { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { echo: echoHandler }) }

		const result = await runRoleCard(depsWithEcho, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		expect(result.status).toBe('success')
		expect(wire.requests.length).toBe(3)
		// Before the strip, the turn's reasoning is replayed ahead of its items.
		const beforeStrip = wireInput(wire.requests[1])
		expect(beforeStrip[1]).toEqual({ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'round one thought' }] })
		// After the strip the message survives with its reasoning cleared (null — not a string), so the wire payload keeps the message and function_call items but carries no reasoning item at all.
		const afterStrip = wireInput(wire.requests[2])
		expect(afterStrip.some((item) => isRecord(item) && item['type'] === 'reasoning')).toBe(false)
		expect(afterStrip[1]).toEqual({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Let me check.' }] })
		expect(afterStrip[2]).toEqual({ type: 'function_call', call_id: 'call_1', name: 'echo', arguments: '{"x":1}' })
	})

	test('the compaction backstop keeps reasoning: older turns are dropped whole and reasoning on survivors is intact', async () => {
		const guild = withTool(
			buildGuild(
				{ main: { systemPrompt: 'p', tools: ['big', 'finish'] } },
				'main',
			),
			{
				name: 'big',
				description: 'returns a large payload',
				parameters: { type: 'object', properties: {} },
			},
		)
		const bigCall = (id: string): ToolCall => ({ id, type: 'function', function: { name: 'big', arguments: '{}' } })
		const bigHandler: FixtureToolHandler = () => ({ kind: 'success', data: { text: 'x'.repeat(2000) } })
		const llm = new FakeLlm()
		llm.responses = [
			{ kind: 'success', content: '', reasoning: 'round one thinking', toolCalls: [bigCall('b1')], usage: { promptTokens: 10, completionTokens: 5 } },
			{ kind: 'success', content: '', reasoning: 'round two thinking', toolCalls: [bigCall('b2')], usage: { promptTokens: 10, completionTokens: 5 } },
			contextExceeded(0, 1000),
			success([finishCall({ status: 'success', summary: 'recovered' })]),
		]
		const { deps, events } = makeDeps(llm)
		const depsWithBig: EngineDependencies = { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { big: bigHandler }) }

		const result = await runRoleCard(depsWithBig, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		expect(result).toEqual({ status: 'success', summary: 'recovered' })
		const compactedEvent = events.find((e) => e.type === 'context_compacted')
		if (compactedEvent === undefined) throw new Error('expected a context_compacted event')
		expect(payloadField(compactedEvent, 'droppedMessages')).toBe(2)
		expect(payloadField(compactedEvent, 'strippedReasoningMessages')).toBe(0)
		const recoveryMessages = llm.calls[3]?.messages ?? []
		// The oldest turn was dropped whole; the surviving assistant turn's reasoning was not stripped.
		expect(recoveryMessages.length).toBe(5)
		expect(recoveryMessages[2]?.reasoning).toBe('round two thinking')
		// The recovery notice reports that reasoning survived because the drop alone already fit.
		expect(recoveryMessages[recoveryMessages.length - 1]?.content.includes('reasoning was not removed')).toBe(true)
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
		const bigHandler: FixtureToolHandler = () => ({ kind: 'success', data: { text: 'x'.repeat(200) } })
		const llm = new FakeLlm()
		llm.responses = [
			success([bigCall]),
			success([finishCall({ status: 'success', summary: 'done' })]),
		]
		const { deps } = makeDeps(llm)
		const depsWithBig: EngineDependencies = {
			...deps,
			toolPlatform: withExtraHandlers(deps.toolPlatform, { big: bigHandler }),
		}

		await runRoleCard(depsWithBig, {
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

	test('an extra handler under a built-in name does not shadow the built-in', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [success([finishCall({ status: 'success', summary: 'built-in finish won' })])]
		const { deps, events } = makeDeps(llm)
		// The platform spreads built-ins last over any extra handler, so this handler must never run: had it won, its non-ResultCard payload would not have finalized the role and FakeLlm would run out of responses.
		const shadowingHandler: FixtureToolHandler = () => ({ kind: 'success', data: { shadowed: true } })
		const depsWithShadow: EngineDependencies = { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { finish: shadowingHandler }) }

		const result = await runRoleCard(depsWithShadow, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result).toEqual({ status: 'success', summary: 'built-in finish won' })
		expect(llm.calls.length).toBe(1)
		// The recorded tool result is the built-in's validated ResultCard, not the shadow payload.
		const toolResult = events.find((e) => e.type === 'tool_result' && payloadField(e, 'tool') === 'finish')
		expect(toolResult).toBeDefined()
		const toolResultEvent = defined(toolResult, 'finish tool_result event')
		expect(payloadField(toolResultEvent, 'result')).toEqual({ kind: 'success', data: { status: 'success', summary: 'built-in finish won' } })
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

		await runRoleCard(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		const starts = events.filter((e) => e.type === 'role_start')
		expect(starts.length).toBe(1)
		const startEvent = defined(starts[0], 'role_start event')
		expect(payloadField(startEvent, 'role')).toBe('main')
		expect(payloadField(startEvent, 'depth')).toBe(0)
		expect(payloadField(startEvent, 'task')).toBe('do it')
		expect(payloadField(startEvent, 'parent')).toBeUndefined()

		const finishes = events.filter((e) => e.type === 'role_finished')
		expect(finishes.length).toBe(1)
		const finishEvent = defined(finishes[0], 'role_finished event')
		expect(payloadField(finishEvent, 'role')).toBe('main')
		expect(payloadField(finishEvent, 'depth')).toBe(0)
		expect(payloadField(finishEvent, 'status')).toBe('success')
		expect(payloadField(finishEvent, 'parent')).toBeUndefined()
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

		await runRoleCard(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'parent',
			task: 'delegate',
		})

		const starts = events.filter((e) => e.type === 'role_start')
		// Exactly two role_start events: one for the entry parent, one for the child.
		expect(starts.length).toBe(2)
		const childStart = defined(starts.find((e) => payloadField(e, 'role') === 'child'), 'child role_start event')
		expect(childStart).toBeDefined()
		expect(payloadField(childStart, 'parent')).toBe('parent')
		expect(payloadField(childStart, 'depth')).toBe(1)
		expect(payloadField(childStart, 'task')).toBe('subtask')

		const agentCalls = events.filter((e) => e.type === 'agent_call')
		expect(agentCalls.length).toBe(1)
		const agentCallEvent = defined(agentCalls[0], 'agent_call event')
		expect(payloadField(agentCallEvent, 'parent')).toBe('parent')
		expect(payloadField(agentCallEvent, 'child')).toBe('child')
		expect(payloadField(agentCallEvent, 'depth')).toBe(1)

		const finishes = events.filter((e) => e.type === 'role_finished')
		expect(finishes.length).toBe(2)
		const childFinish = defined(finishes.find((e) => payloadField(e, 'role') === 'child'), 'child role_finished event')
		expect(payloadField(childFinish, 'parent')).toBe('parent')
		expect(payloadField(childFinish, 'depth')).toBe(1)
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

		await runRoleCard(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'parent',
			task: 'delegate',
		})

		const starts = events.filter((e) => e.type === 'role_start')
		// Only the parent's role_start; the refused child never runs.
		expect(starts.length).toBe(1)
		expect(payloadField(defined(starts[0], 'role_start event'), 'role')).toBe('parent')
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

		await runRoleCard(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		const llmCall = events.find((e) => e.type === 'llm_call')
		expect(llmCall).toBeDefined()
		const payload = defined(llmCall, 'llm_call event').payload
		expect(isRecord(payload)).toBe(true)
		if (!isRecord(payload)) throw new Error('llm_call payload is not a record')
		expect(payload['messageCount']).toBe(2)
		// The sent message list carries role and content for each message, with tool_calls on assistant messages included.
		const sent = payload['sent']
		expect(Array.isArray(sent)).toBe(true)
		if (!isRoleList(sent)) throw new Error('expected the sent message list')
		expect(sent.length).toBe(2)
		expect(defined(sent[0], 'first sent message').role).toBe('system')
		expect(defined(sent[1], 'second sent message').role).toBe('user')
		// The received response carries the assistant content and the parsed tool calls with name and arguments.
		const received = payload['received']
		if (!isReceivedLlmResponse(received)) throw new Error('expected the received LLM response')
		expect(received.content).toBe('the answer')
		expect(received.toolCalls.length).toBe(1)
		const receivedToolCall = defined(received.toolCalls[0], 'first received tool call')
		expect(receivedToolCall.function.name).toBe('finish')
		expect(receivedToolCall.function.arguments).toBe(finish.function.arguments)
		expect(payload['finishReason']).toBe('tool_calls')
		const usage = payload['usage']
		if (!isUsageTotals(usage)) throw new Error('expected the per-call usage totals')
		expect(usage.promptTokens).toBe(42)
		expect(usage.completionTokens).toBe(7)
		expect(usage.totalTokens).toBe(49)
	})

	test('llm_call is not emitted on the model-output failure path', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [llmUnavailable()]
		const { deps, events } = makeDeps(llm)

		await runRoleCard(deps, {
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
			contextExceeded(0, 32768),
			success([finishCall({ status: 'success', summary: 'recovered' })]),
		]
		const { deps, events } = makeDeps(llm)

		await runRoleCard(deps, {
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
		const bigHandler: FixtureToolHandler = () => ({ kind: 'success', data: { text: 'x'.repeat(200) } })
		const llm = new FakeLlm()
		llm.responses = [
			success([bigCall]),
			success([finishCall({ status: 'success', summary: 'done' })]),
		]
		const { deps, events } = makeDeps(llm)
		const depsWithBig: EngineDependencies = {
			...deps,
			toolPlatform: withExtraHandlers(deps.toolPlatform, { big: bigHandler }),
		}

		await runRoleCard(depsWithBig, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		const toolCall = events.find((e) => e.type === 'tool_call' && payloadField(e, 'tool') === 'big')
		expect(toolCall).toBeDefined()
		expect(payloadField(defined(toolCall, 'big tool_call event'), 'arguments')).toBe('{"path":"x.txt"}')

		const toolResult = events.find((e) => e.type === 'tool_result' && payloadField(e, 'tool') === 'big')
		expect(toolResult).toBeDefined()
		const toolResultEvent = defined(toolResult, 'big tool_result event')
		expect(payloadField(toolResultEvent, 'kind')).toBe('success')
		// The logged result is the full un-truncated ToolResult, so its data retains the full 200-char string even though truncation applies to what is appended to the conversation.
		const loggedResult = payloadField(toolResultEvent, 'result')
		if (!isLoggedToolResult(loggedResult)) throw new Error('expected the logged tool result')
		expect(loggedResult.kind).toBe('success')
		expect(loggedResult.data.text.length).toBe(200)
	})
})

const triggerInterruptManifest: ToolManifest = {
	name: 'trigger_interrupt',
	description: 'Apply an interrupt decision.',
	parameters: {
		type: 'object',
		required: ['targetRole', 'action', 'reason'],
		properties: {
			targetRole: { type: 'string' },
			action: { type: 'string' },
			reason: { type: 'string' },
		},
	},
}

const recentRoleToolCallsManifest: ToolManifest = {
	name: 'recent_role_tool_calls',
	description: 'Trace recent tool calls.',
	parameters: { type: 'object', required: ['targetRole'], properties: { targetRole: { type: 'string' }, limit: { type: 'number' } } },
}

const searchRoleBlocksManifest: ToolManifest = {
	name: 'search_role_blocks',
	description: 'Search content and reasoning.',
	parameters: { type: 'object', required: ['targetRole', 'pattern'], properties: { targetRole: { type: 'string' }, pattern: { type: 'string' } } },
}

function namedCall(id: string, name: string, args: unknown): ToolCall {
	return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

function buildInterruptGuild(roles: Record<string, RoleDefinition>, entryRole: string, triggers: { everyToolCalls?: number; everyTokens?: number; planOwnerRole?: string } = {}): LoadedGuild {
	const guild = buildGuild(roles, entryRole, {
		executor: {
			...baseExecutor,
			interruptTriggers: {
				handlerRole: 'loop_detector',
				// Base 1 with no effort on the test contexts (the engine's effort-less fallback scales by the quick tier's 2×): the effective cadence is two tool calls, so the fixtures below stay sequenced around a trigger at the third turn top.
				everyToolCalls: triggers.everyToolCalls ?? 1,
				everyTokens: triggers.everyTokens ?? 1_000_000,
				...(triggers.planOwnerRole !== undefined ? { planOwnerRole: triggers.planOwnerRole } : {}),
			},
		},
	})
	let withManifests = withTool(guild, { name: 'echo', description: 'echo', parameters: { type: 'object', properties: {} } })
	withManifests = withTool(withManifests, recentRoleToolCallsManifest)
	withManifests = withTool(withManifests, searchRoleBlocksManifest)
	withManifests = withTool(withManifests, triggerInterruptManifest)
	return withManifests
}

// The inquiry-handler fixture mirrors the loop-detector one: the guild names an inquiry handler role via executor.inquiryHandlerRole, and the handler investigates with the read-only inspection tools before finishing with the answer as its summary.
const mainAndInquirer = {
	main: { systemPrompt: 'p', tools: ['echo', 'finish'] },
	inquirer: { systemPrompt: 'inq', tools: ['recent_role_tool_calls', 'finish'] },
}

function buildInquiryGuild(roles: Record<string, RoleDefinition> = mainAndInquirer, entryRole = 'main'): LoadedGuild {
	const guild = buildGuild(roles, entryRole, {
		executor: { ...baseExecutor, inquiryHandlerRole: 'inquirer' },
	})
	let withManifests = withTool(guild, { name: 'echo', description: 'echo', parameters: { type: 'object', properties: {} } })
	withManifests = withTool(withManifests, recentRoleToolCallsManifest)
	return withManifests
}

describe('runRole — interrupt platform', () => {
	const mainAndDetector = {
		main: { systemPrompt: 'p', tools: ['echo', 'finish'] },
		loop_detector: { systemPrompt: 'ld', tools: ['recent_role_tool_calls', 'search_role_blocks', 'trigger_interrupt', 'finish'] },
	}

	test('(a) consecutive identical tool calls trigger the handler, which aborts the target with loop_detected', async () => {
		const guild = buildInterruptGuild(mainAndDetector, 'main')
		const llm = new FakeLlm()
		llm.responses = [
			success([namedCall('c1', 'echo', { x: 1 })]),
			success([namedCall('c2', 'echo', { x: 1 })]),
			// The cadence fires at the third turn top; the detector investigates and aborts.
			success([namedCall('d1', 'recent_role_tool_calls', { targetRole: 'main-0-1' })]),
			success([namedCall('d2', 'trigger_interrupt', { targetRole: 'main-0-1', action: 'abort', reason: 'stuck repeating the same call' })]),
			success([finishCall({ status: 'success', summary: 'aborted the looper' })]),
		]
		const { deps, events } = makeDeps(llm)

		const result = await runRoleCard(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result.status).toBe('error')
		expect(result.error?.kind).toBe('loop_detected')
		expect(result.error?.message).toBe('stuck repeating the same call')
		expect(llm.calls.length).toBe(5)
		const interrupt = events.find((e) => e.type === 'interrupt')
		expect(interrupt).toBeDefined()
		const interruptEvent = defined(interrupt, 'interrupt event')
		expect(payloadField(interruptEvent, 'trigger')).toBe('loop_check')
		expect(payloadField(interruptEvent, 'handler')).toBe('loop_detector')
		expect(payloadField(interruptEvent, 'target')).toBe('main-0-1')
		const resolved = events.find((e) => e.type === 'interrupt_resolved')
		expect(payloadField(defined(resolved, 'interrupt_resolved event'), 'action')).toBe('abort')
		const interruptCallId = payloadField(interruptEvent, 'callId')
		expect(typeof interruptCallId).toBe('string')
		expect(payloadField(interruptEvent, 'parentCallId')).toBe('role:main-0-1')
		expect(payloadField(defined(resolved, 'interrupt_resolved event'), 'callId')).toBe(interruptCallId)
		// The detector ran as a role nested under the target and finished before the target's role_finished.
		const detectorStart = events.find((e) => e.type === 'role_start' && payloadField(e, 'role') === 'loop_detector')
		expect(detectorStart).toBeDefined()
		expect(payloadField(defined(detectorStart, 'loop_detector role_start event'), 'parent')).toBe('main')
		expect(payloadField(defined(detectorStart, 'loop_detector role_start event'), 'parentCallId')).toBe(interruptCallId)
		const finishOrder = events.filter((e) => e.type === 'role_finished').map((e) => payloadField(e, 'role'))
		expect(finishOrder).toEqual(['loop_detector', 'main'])
		// Role identity is carried on start and finish, and the entry role has no parent call.
		const mainStart = events.find((e) => e.type === 'role_start' && payloadField(e, 'role') === 'main')
		expect(payloadField(defined(mainStart, 'main role_start event'), 'callId')).toBe('role:main-0-1')
		expect(payloadField(defined(mainStart, 'main role_start event'), 'parentCallId')).toBeUndefined()
		const mainFinish = events.find((e) => e.type === 'role_finished' && payloadField(e, 'role') === 'main')
		expect(payloadField(defined(mainFinish, 'main role_finished event'), 'callId')).toBe('role:main-0-1')
	})

	test('(b) the handler redirects: the reason is injected as a user message and the target resumes', async () => {
		const guild = buildInterruptGuild(mainAndDetector, 'main')
		const llm = new FakeLlm()
		llm.responses = [
			success([namedCall('c1', 'echo', { x: 1 })]),
			success([namedCall('c2', 'echo', { x: 1 })]),
			success([namedCall('d1', 'search_role_blocks', { targetRole: 'main-0-1', pattern: 'echo' })]),
			success([namedCall('d2', 'trigger_interrupt', { targetRole: 'main-0-1', action: 'redirect', reason: 'stop repeating; call finish now' })]),
			success([finishCall({ status: 'success', summary: 'redirected the looper' })]),
			success([finishCall({ status: 'success', summary: 'main done' })]),
		]
		const { deps, events } = makeDeps(llm)

		const result = await runRoleCard(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result).toEqual({ status: 'success', summary: 'main done' })
		// The target's first post-handler call carries the injected guidance as the latest user message.
		const resumedCall = defined(llm.calls[5], 'resumed main call')
		expect(resumedCall).toBeDefined()
		const lastMessage = resumedCall.messages[resumedCall.messages.length - 1]
		expect(lastMessage).toEqual({ role: 'user', content: 'stop repeating; call finish now' })
		expect(payloadField(defined(events.find((e) => e.type === 'interrupt_resolved'), 'interrupt_resolved event'), 'action')).toBe('redirect')
	})

	test('a handler that finishes without trigger_interrupt resumes the target unchanged', async () => {
		const guild = buildInterruptGuild(mainAndDetector, 'main')
		const llm = new FakeLlm()
		llm.responses = [
			success([namedCall('c1', 'echo', { x: 1 })]),
			success([namedCall('c2', 'echo', { x: 1 })]),
			success([finishCall({ status: 'success', summary: 'no action taken' })]),
			success([finishCall({ status: 'success', summary: 'main done' })]),
		]
		const { deps, events } = makeDeps(llm)

		const result = await runRoleCard(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result).toEqual({ status: 'success', summary: 'main done' })
		const resolved = defined(events.find((e) => e.type === 'interrupt_resolved'), 'interrupt_resolved event')
		expect(payloadField(resolved, 'action')).toBe('continue')
	})

	test('(c) an operator inquiry is answered by a fresh handler role at the next safe point and the run resumes', async () => {
		const guild = buildInquiryGuild()
		const llm = new FakeLlm()
		llm.responses = [
			// The drain fires before main's first LLM call, so the handler's turns come first.
			success([namedCall('i1', 'recent_role_tool_calls', { targetRole: 'main-0-1' })]),
			success([finishCall({ status: 'success', summary: 'the run is building the parser' })]),
			// main's own first turn happens only after the handler finished.
			success([finishCall({ status: 'success', summary: 'main done' })]),
		]
		const { deps, events } = makeDeps(llm)
		deps.interruptQueue.submit({ kind: 'inquiry', message: 'what are you working on?' })

		const result = await runRoleCard(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result).toEqual({ status: 'success', summary: 'main done' })
		// The interrupt event carries the question verbatim and lands before the handler's role_start.
		const interrupt = events.find((e) => e.type === 'interrupt')
		if (interrupt === undefined) throw new Error('expected an interrupt event')
		expect(payloadField(interrupt, 'trigger')).toBe('inquiry')
		expect(payloadField(interrupt, 'handler')).toBe('inquirer')
		expect(payloadField(interrupt, 'target')).toBe('main-0-1')
		expect(payloadField(interrupt, 'message')).toBe('what are you working on?')
		const handlerStart = events.find((e) => e.type === 'role_start' && payloadField(e, 'role') === 'inquirer')
		if (handlerStart === undefined) throw new Error('expected the handler role_start')
		expect(events.indexOf(interrupt)).toBeLessThan(events.indexOf(handlerStart))
		expect(payloadField(handlerStart, 'parent')).toBe('main')
		// The handler's briefing carries the question, the live-instance list root first, and the run-log tool pointer for finished roles.
		const briefing = defined(llm.calls[0], 'handler briefing call').messages[1]
		expect(briefing?.role).toBe('user')
		expect(briefing?.content).toContain('[Operator inquiry]')
		expect(briefing?.content).toContain('what are you working on?')
		expect(briefing?.content).toContain('- main-0-1 (main, depth 0)')
		expect(briefing?.content).toContain('read_run_log')
		expect(briefing?.content).toContain('search_run_log')
		// The handler's finish summary is the answer on interrupt_resolved.
		const resolved = events.find((e) => e.type === 'interrupt_resolved')
		if (resolved === undefined) throw new Error('expected an interrupt_resolved event')
		expect(payloadField(resolved, 'trigger')).toBe('inquiry')
		expect(payloadField(resolved, 'action')).toBe('answered')
		expect(payloadField(resolved, 'summary')).toBe('the run is building the parser')
		// The question never enters the suspended role's history, and no operator_inquiry event is emitted.
		expect(defined(llm.calls[2], 'resumed main call').messages.some((m) => m.content.includes('what are you working on?'))).toBe(false)
		expect(events.some((e) => e.type === 'operator_inquiry')).toBe(false)
		// The suspended role resumes its turn loop once the handler finishes.
		const finishOrder = events.filter((e) => e.type === 'role_finished').map((e) => payloadField(e, 'role'))
		expect(finishOrder).toEqual(['inquirer', 'main'])
	})

	test('an inquiry briefing on a standard-detail run does not promise llm_call message bodies', async () => {
		const guild = buildInquiryGuild()
		const llm = new FakeLlm()
		llm.responses = [
			success([finishCall({ status: 'success', summary: 'answered from the workspace' })]),
			success([finishCall({ status: 'success', summary: 'main done' })]),
		]
		const { deps } = makeDeps(llm)
		deps.interruptQueue.submit({ kind: 'inquiry', message: 'what files changed?' })

		await runRoleCard(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
			logLevel: 'standard',
		})

		const briefing = defined(llm.calls[0], 'handler briefing call').messages[1]
		expect(briefing?.content).toContain('read_run_log')
		expect(briefing?.content).toContain('carry no message bodies')
		expect(briefing?.content).not.toContain('carry the full sent and received messages')
	})

	test('an inquiry with no inquiryHandlerRole configured is dropped, not answered, and the run continues', async () => {
		const guild = buildInterruptGuild(mainAndDetector, 'main')
		const llm = new FakeLlm()
		llm.responses = [success([finishCall({ status: 'success', summary: 'undisturbed' })])]
		const { deps, events } = makeDeps(llm)
		deps.interruptQueue.submit({ kind: 'inquiry', message: 'anyone there?' })

		const result = await runRoleCard(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result).toEqual({ status: 'success', summary: 'undisturbed' })
		expect(llm.calls.length).toBe(1)
		const dropped = events.find((e) => e.type === 'inquiry_dropped')
		if (dropped === undefined) throw new Error('expected an inquiry_dropped event')
		expect(payloadField(dropped, 'message')).toBe('anyone there?')
		expect(payloadField(dropped, 'reason')).toBe('executor.inquiryHandlerRole is not configured')
		expect(events.some((e) => e.type === 'interrupt')).toBe(false)
		// A dropped inquiry touches nothing: the question never enters main's history.
		expect(defined(llm.calls[0], 'first call').messages.some((m) => m.content.includes('anyone there?'))).toBe(false)
	})

	test('a notice injects a marked user message into the chain root and logs operator_notice', async () => {
		const guild = buildInterruptGuild(mainAndDetector, 'main')
		const llm = new FakeLlm()
		llm.responses = [success([finishCall({ status: 'success', summary: 'noticed and done' })])]
		const { deps, events } = makeDeps(llm)
		deps.interruptQueue.submit({ kind: 'notice', message: 'wrap up soon' })

		const result = await runRoleCard(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result).toEqual({ status: 'success', summary: 'noticed and done' })
		const callMessages = defined(llm.calls[0], 'first call').messages
		const injected = callMessages[callMessages.length - 1]
		expect(injected?.role).toBe('user')
		expect(injected?.content).toContain('[Operator notice')
		expect(injected?.content).toContain('wrap up soon')
		const noticeEvent = events.find((e) => e.type === 'operator_notice')
		if (noticeEvent === undefined) throw new Error('expected an operator_notice event')
		expect(payloadField(noticeEvent, 'role')).toBe('main')
		expect(payloadField(noticeEvent, 'roleId')).toBe('main-0-1')
		expect(payloadField(noticeEvent, 'message')).toBe('wrap up soon')
	})

	test('(d) a plan modification aborts the leaf and intermediates and delivers the change to the top-level planner', async () => {
		const guild = buildInterruptGuild(
			{
				planner: { systemPrompt: 'p', tools: ['agent', 'finish'] },
				coder: { systemPrompt: 'c', tools: ['agent', 'finish'] },
				'sub-coder': { systemPrompt: 'sc', tools: ['echo', 'finish'] },
			},
			'planner',
			{ planOwnerRole: 'planner' },
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([agentCall('coder', 'implement the plan')]),
			success([agentCall('sub-coder', 'do the work')]),
			success([namedCall('sc1', 'echo', {})]),
			success([finishCall({ status: 'success', summary: 'revised plan done' })]),
		]
		const { deps, events } = makeDeps(llm)
		const depsWithEcho: EngineDependencies = {
			...deps,
			toolPlatform: withExtraHandlers(deps.toolPlatform, {
				// The sub-coder's first tool call is where the operator's modification lands; the sub-coder's next turn top routes it.
				echo: () => {
					deps.interruptQueue.submit({ kind: 'plan_modification', message: 'use Postgres instead of SQLite' })
					return { kind: 'success', data: {} }
				},
			}),
		}

		const result = await runRoleCard(depsWithEcho, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'planner',
			task: 'build an app',
		})

		expect(result).toEqual({ status: 'success', summary: 'revised plan done' })
		// The leaf and the intermediate aborted with interrupted; the planner received the modification and finished the run.
		const finishes = events.filter((e) => e.type === 'role_finished')
		const errored = finishes.filter((e) => payloadField(e, 'status') === 'error').map((e) => payloadField(e, 'role'))
		expect(errored).toEqual(['sub-coder', 'coder'])
		for (const event of finishes.filter((e) => payloadField(e, 'status') === 'error')) {
			const errorPayload = payloadField(event, 'error')
			expect(isRecord(errorPayload) && errorPayload['kind'] === 'interrupted').toBe(true)
		}
		const planMod = events.find((e) => e.type === 'plan_modification')
		expect(planMod).toBeDefined()
		const planModEvent = defined(planMod, 'plan_modification event')
		expect(payloadField(planModEvent, 'target')).toBe('planner-0-1')
		expect(payloadField(planModEvent, 'aborted')).toEqual(['sub-coder-2-3', 'coder-1-2'])
		const plannerResumed = defined(llm.calls[3], 'planner resume call')
		const lastMessage = plannerResumed.messages[plannerResumed.messages.length - 1]
		expect(lastMessage?.role).toBe('user')
		expect(lastMessage?.content).toContain('[Operator plan modification')
		expect(lastMessage?.content).toContain('use Postgres instead of SQLite')
	})

	test('an inquiry during a delegation is answered by the handler against the suspended chain, never touching a running role\\u2019s history', async () => {
		const guild = buildInquiryGuild(
			{
				parent: { systemPrompt: 'p', tools: ['agent', 'finish'] },
				child: { systemPrompt: 'c', tools: ['echo', 'finish'] },
				inquirer: { systemPrompt: 'inq', tools: ['recent_role_tool_calls', 'finish'] },
			},
			'parent',
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([agentCall('child', 'do the work')]),
			success([namedCall('k1', 'echo', {})]),
			// The child's next turn top drains the inquiry: the handler runs against the suspended child.
			success([finishCall({ status: 'success', summary: 'the child is doing the work' })]),
			success([finishCall({ status: 'success', summary: 'child done' })]),
			success([finishCall({ status: 'success', summary: 'parent done' })]),
		]
		const { deps, events } = makeDeps(llm)
		const depsWithEcho: EngineDependencies = {
			...deps,
			toolPlatform: withExtraHandlers(deps.toolPlatform, {
				// The child's tool call is where the operator's question lands; the child's next turn top hands it to the handler.
				echo: () => {
					deps.interruptQueue.submit({ kind: 'inquiry', message: 'how is the run going?' })
					return { kind: 'success', data: {} }
				},
			}),
		}

		const result = await runRoleCard(depsWithEcho, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'parent',
			task: 'delegate',
		})

		expect(result).toEqual({ status: 'success', summary: 'parent done' })
		// The handler targeted the draining leaf (the child), and its briefing lists the whole live chain root first.
		const interrupt = events.find((e) => e.type === 'interrupt')
		if (interrupt === undefined) throw new Error('expected an interrupt event')
		expect(payloadField(interrupt, 'trigger')).toBe('inquiry')
		expect(payloadField(interrupt, 'target')).toBe('child-1-2')
		expect(payloadField(interrupt, 'message')).toBe('how is the run going?')
		const briefing = defined(llm.calls[2], 'handler briefing call').messages[1]
		expect(briefing?.content).toContain('how is the run going?')
		expect(briefing?.content).toContain('- parent-0-1 (parent, depth 0)')
		expect(briefing?.content).toContain('- child-1-2 (child, depth 1), child of parent-0-1')
		// The finished-roles note is unconditional now: it points at the run-log tools, never at a path.
		expect(briefing?.content).toContain('their work is recorded in the run log')
		expect(briefing?.content).toContain('read_run_log')
		// Neither the child nor the parent ever receives the question in its history.
		expect(defined(llm.calls[3], 'child resume call').messages.some((m) => m.content.includes('how is the run going?'))).toBe(false)
		expect(defined(llm.calls[4], 'parent resume call').messages.some((m) => m.content.includes('how is the run going?'))).toBe(false)
		const resolved = events.find((e) => e.type === 'interrupt_resolved')
		if (resolved === undefined) throw new Error('expected an interrupt_resolved event')
		expect(payloadField(resolved, 'action')).toBe('answered')
		expect(payloadField(resolved, 'summary')).toBe('the child is doing the work')
	})

	test('(e) the drain does not interrupt an in-flight LLM call: an inquiry submitted mid-call reaches the handler at the next safe point', async () => {
		const guild = buildInquiryGuild()
		const llm = new FakeLlm()
		const { deps, events } = makeDeps(llm)
		// Submits the inquiry while the first call is in flight, proving the drain waits for the turn boundary.
		const submittingLlm: LlmCaller = {
			async call(request) {
				llm.calls.push(request)
				if (llm.calls.length === 1) {
					deps.interruptQueue.submit({ kind: 'inquiry', message: 'mid-call question' })
				}
				const next = llm.responses.shift()
				if (next === undefined) throw new Error('FakeLlm ran out of responses')
				return next
			},
		}
		llm.responses = [
			success([namedCall('c1', 'echo', {})]),
			// The handler's turn runs at the next safe point, ahead of main's second call.
			success([finishCall({ status: 'success', summary: 'answered mid-call' })]),
			success([finishCall({ status: 'success', summary: 'done' })]),
		]
		const depsWithSubmittingLlm: EngineDependencies = { ...deps, llmCaller: submittingLlm }

		const result = await runRoleCard(depsWithSubmittingLlm, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result).toEqual({ status: 'success', summary: 'done' })
		// The first call's messages predate the submission, and the interrupt event lands only after that call's llm_call event: the drain waited for the turn boundary.
		expect(defined(llm.calls[0], 'first call').messages.some((m) => m.content.includes('mid-call question'))).toBe(false)
		const firstLlmCallIndex = events.findIndex((e) => e.type === 'llm_call')
		const interruptIndex = events.findIndex((e) => e.type === 'interrupt')
		expect(interruptIndex).toBeGreaterThan(firstLlmCallIndex)
		// The question lands in the handler's briefing, not in any running role's history.
		expect(defined(llm.calls[1], 'handler briefing call').messages.some((m) => m.content.includes('mid-call question'))).toBe(true)
		expect(defined(llm.calls[2], 'resumed main call').messages.some((m) => m.content.includes('mid-call question'))).toBe(false)
	})

	test('the handler role itself is never interrupted by the cadence trigger', async () => {
		const guild = buildInterruptGuild(mainAndDetector, 'main')
		const llm = new FakeLlm()
		// The effective cadence is two tool calls: the detector's own inspect calls would retrigger if it were not exempt.
		llm.responses = [
			success([namedCall('c1', 'echo', { x: 1 })]),
			success([namedCall('c2', 'echo', { x: 1 })]),
			success([namedCall('d1', 'recent_role_tool_calls', { targetRole: 'main-0-1' })]),
			success([namedCall('d2', 'search_role_blocks', { targetRole: 'main-0-1', pattern: 'x' })]),
			success([namedCall('d3', 'trigger_interrupt', { targetRole: 'main-0-1', action: 'continue', reason: '' })]),
			success([finishCall({ status: 'success', summary: 'clean' })]),
			success([finishCall({ status: 'success', summary: 'main done' })]),
		]
		const { deps, events } = makeDeps(llm)

		const result = await runRoleCard(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result).toEqual({ status: 'success', summary: 'main done' })
		// Exactly one interrupt stack: the detector was invoked once and never re-invoked against itself.
		expect(events.filter((e) => e.type === 'interrupt').length).toBe(1)
		expect(events.filter((e) => e.type === 'role_start' && payloadField(e, 'role') === 'loop_detector').length).toBe(1)
	})
})

describe('runRole — observe emission', () => {
	const listRoleMessagesManifest: ToolManifest = {
		name: 'list_role_messages',
		description: 'List messages.',
		parameters: { type: 'object', required: ['targetRole'], properties: { targetRole: { type: 'string' } } },
	}

	function buildObserverGuild(): LoadedGuild {
		const guild = buildGuild(
			{
				parent: { systemPrompt: 'p', tools: ['agent', 'finish'] },
				child: { systemPrompt: 'c', tools: ['list_role_messages', 'context_info', 'echo', 'finish'] },
			},
			'parent',
		)
		let withManifests = withTool(guild, listRoleMessagesManifest)
		withManifests = withTool(withManifests, { name: 'context_info', description: 'Context info.', parameters: { type: 'object', properties: {} } })
		withManifests = withTool(withManifests, { name: 'echo', description: 'echo', parameters: { type: 'object', properties: {} } })
		return withManifests
	}

	test('a cross-role inspection success logs tool_call, observe, tool_result in that order', async () => {
		const guild = buildObserverGuild()
		const llm = new FakeLlm()
		llm.responses = [
			success([agentCall('child', 'inspect me')]),
			success([namedCall('l1', 'list_role_messages', { targetRole: 'parent-0-1' })]),
			success([finishCall({ status: 'success', summary: 'child done' })]),
			success([finishCall({ status: 'success', summary: 'parent done' })]),
		]
		const { deps, events } = makeDeps(llm)

		await runRoleCard(deps, { loadedGuild: guild, depth: 0, roleName: 'parent', task: 'delegate' })

		const callIndex = events.findIndex((e) => e.type === 'tool_call' && payloadField(e, 'tool') === 'list_role_messages')
		const observeIndex = events.findIndex((e) => e.type === 'observe')
		const resultIndex = events.findIndex((e) => e.type === 'tool_result' && payloadField(e, 'tool') === 'list_role_messages')
		expect(callIndex).toBeGreaterThanOrEqual(0)
		expect(observeIndex).toBe(callIndex + 1)
		expect(resultIndex).toBe(observeIndex + 1)
		const observe = events[observeIndex]
		const observeEvent = defined(observe, 'observe event')
		expect(payloadField(observeEvent, 'role')).toBe('parent')
		expect(payloadField(observeEvent, 'roleId')).toBe('parent-0-1')
		expect(payloadField(observeEvent, 'details')).toBe('list_role_messages')
	})

	test('a self-targeted or target-free inspection emits no observe', async () => {
		const guild = buildObserverGuild()
		const llm = new FakeLlm()
		llm.responses = [
			success([agentCall('child', 'inspect yourself')]),
			// list_role_messages names the caller's own instance id; context_info omits targetRole, so its data carries none. Both succeed without an observe.
			success([namedCall('l1', 'list_role_messages', { targetRole: 'child-1-2' }), namedCall('ci1', 'context_info', {})]),
			success([finishCall({ status: 'success', summary: 'child done' })]),
			success([finishCall({ status: 'success', summary: 'parent done' })]),
		]
		const { deps, events } = makeDeps(llm)

		await runRoleCard(deps, { loadedGuild: guild, depth: 0, roleName: 'parent', task: 'delegate' })

		expect(events.some((e) => e.type === 'observe')).toBe(false)
		const selfListing = events.find((e) => e.type === 'tool_result' && payloadField(e, 'tool') === 'list_role_messages')
		expect(payloadField(defined(selfListing, 'self listing tool_result event'), 'kind')).toBe('success')
	})

	test('a non-inspection tool emits no observe even when its result data carries a targetRole string', async () => {
		const guild = buildObserverGuild()
		const llm = new FakeLlm()
		llm.responses = [
			success([agentCall('child', 'echo something')]),
			success([namedCall('e1', 'echo', { targetRole: 'parent-0-1' })]),
			success([finishCall({ status: 'success', summary: 'child done' })]),
			success([finishCall({ status: 'success', summary: 'parent done' })]),
		]
		const { deps, events } = makeDeps(llm)
		const depsWithEcho: EngineDependencies = { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { echo: echoHandler }) }

		await runRoleCard(depsWithEcho, { loadedGuild: guild, depth: 0, roleName: 'parent', task: 'delegate' })

		expect(events.some((e) => e.type === 'observe')).toBe(false)
	})

	test('an inspection whose target is no longer registered emits no observe', async () => {
		const guild = buildObserverGuild()
		const llm = new FakeLlm()
		llm.responses = [
			success([agentCall('child', 'inspect a ghost')]),
			success([namedCall('l1', 'list_role_messages', { targetRole: 'ghost-0-9' })]),
			success([finishCall({ status: 'success', summary: 'child done' })]),
			success([finishCall({ status: 'success', summary: 'parent done' })]),
		]
		const { deps, events } = makeDeps(llm)

		await runRoleCard(deps, { loadedGuild: guild, depth: 0, roleName: 'parent', task: 'delegate' })

		expect(events.some((e) => e.type === 'observe')).toBe(false)
		// The real built-in rejects an unregistered instance, so the stale-target skip rides the failure path: no observe, and the tool_result carries the rejection.
		const toolResult = events.find((e) => e.type === 'tool_result' && payloadField(e, 'tool') === 'list_role_messages')
		expect(payloadField(defined(toolResult, 'ghost listing tool_result event'), 'kind')).toBe('invalid_arguments')
	})
})

describe('runRole — context pressure handoff', () => {
	// Static budget for every test here: window 1000 minus the 100-token completion reservation = 900, so the 0.8 threshold fires at 720 reported prompt tokens.
	function buildPressureGuild(roles: Record<string, RoleDefinition> = { main: { systemPrompt: 'p', tools: ['echo', 'finish'] } }, threshold?: number): LoadedGuild {
		const guild = buildGuild(roles, 'main', {
			model: { ...baseModel, contextWindow: 1000, generation: { maxTokens: 100 } },
			executor: threshold === undefined ? baseExecutor : { ...baseExecutor, contextPressureThreshold: threshold },
		})
		return withTool(guild, { name: 'echo', description: 'echo', parameters: { type: 'object', properties: {} } })
	}

	function noticeCount(messages: Message[]): number {
		return messages.filter((m) => m.role === 'user' && m.content.includes('[Platform notice — context pressure]')).length
	}

	test('fires once usage crosses the threshold — not below — and the notice lands after the turn\u2019s tool results in valid wire order', async () => {
		const guild = buildPressureGuild()
		const llm = new FakeLlm()
		llm.responses = [
			success([namedCall('e1', 'echo', { x: 1 })], { promptTokens: 700 }),
			success([namedCall('e2', 'echo', { x: 2 })], { promptTokens: 800 }),
			success([finishCall({ status: 'success', summary: 'done' })], { promptTokens: 810 }),
		]
		const { deps, events } = makeDeps(llm)

		const result = await runRoleCard(deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		expect(result.status).toBe('success')
		const pressureEvents = events.filter((e) => e.type === 'context_pressure')
		expect(pressureEvents.length).toBe(1)
		const pressureEvent = defined(pressureEvents[0], 'context_pressure event')
		expect(payloadField(pressureEvent, 'role')).toBe('main')
		expect(payloadField(pressureEvent, 'promptTokens')).toBe(800)
		expect(payloadField(pressureEvent, 'effectiveBudget')).toBe(900)

		// The turn below the threshold carried no notice; the crossing turn's notice rides the next request.
		expect(noticeCount(llm.calls[1]?.messages ?? [])).toBe(0)
		const notified = llm.calls[2]?.messages ?? []
		expect(noticeCount(notified)).toBe(1)
		// Wire order: assistant tool_calls, then its tool result, then the user notice — never a notice stranded between a call and its result.
		const assistantTurn = notified[notified.length - 3]
		const toolResult = notified[notified.length - 2]
		const notice = notified[notified.length - 1]
		expect(assistantTurn?.role).toBe('assistant')
		expect(assistantTurn?.tool_calls?.[0]?.id).toBe('e2')
		expect(toolResult?.role).toBe('tool')
		expect(toolResult?.tool_call_id).toBe('e2')
		expect(notice?.role).toBe('user')
		expect(notice?.content).toContain('[Platform notice — context pressure]')
		expect(notice?.content).toContain('89%')
		expect(notice?.content).toContain('context_handoff')
	})

	test('fires once per role instance even while usage stays above the threshold', async () => {
		const guild = buildPressureGuild()
		const llm = new FakeLlm()
		llm.responses = [
			success([namedCall('e1', 'echo', { x: 1 })], { promptTokens: 800 }),
			success([namedCall('e2', 'echo', { x: 2 })], { promptTokens: 810 }),
			success([namedCall('e3', 'echo', { x: 3 })], { promptTokens: 820 }),
			success([finishCall({ status: 'success', summary: 'done' })], { promptTokens: 830 }),
		]
		const { deps, events } = makeDeps(llm)

		const result = await runRoleCard(deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		expect(result.status).toBe('success')
		expect(events.filter((e) => e.type === 'context_pressure').length).toBe(1)
		// The notice is appended exactly once; later turns inherit it as ordinary history without a fresh copy.
		expect(noticeCount(llm.calls[3]?.messages ?? [])).toBe(1)
	})

	test('applies the 0.8 default when contextPressureThreshold is unset', async () => {
		const guild = buildPressureGuild()
		const llm = new FakeLlm()
		llm.responses = [
			success([namedCall('e1', 'echo', { x: 1 })], { promptTokens: 750 }),
			success([finishCall({ status: 'success', summary: 'done' })]),
		]
		const { deps, events } = makeDeps(llm)

		await runRoleCard(deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		const pressureEvents = events.filter((e) => e.type === 'context_pressure')
		expect(pressureEvents.length).toBe(1)
		expect(payloadField(defined(pressureEvents[0], 'context_pressure event'), 'effectiveBudget')).toBe(900)
	})

	test('a reported wall rejection tightens the effective budget for every later role in the run', async () => {
		const guild = buildPressureGuild({
			main: { systemPrompt: 'p', tools: ['agent', 'finish'] },
			child_a: { systemPrompt: 'a', tools: ['finish'] },
			child_b: { systemPrompt: 'b', tools: ['echo', 'finish'] },
		})
		const llm = new FakeLlm()
		llm.responses = [
			success([agentCall('child_a', 'task a')]),
			// child_a hits the wall with a reported count of 500: the run's learned ceiling becomes 500, so the threshold drops from 720 to 400.
			contextExceeded(500, 1000),
			success([finishCall({ status: 'success', summary: 'a done' })], { promptTokens: 20 }),
			success([agentCall('child_b', 'task b')]),
			// 450 is below the static threshold (720) but above the learned one (400): the notice fires only because of the shared ceiling.
			success([namedCall('b1', 'echo', { x: 1 })], { promptTokens: 450 }),
			success([finishCall({ status: 'success', summary: 'b done' })], { promptTokens: 460 }),
			success([finishCall({ status: 'success', summary: 'main done' })]),
		]
		const { deps, events } = makeDeps(llm)

		const result = await runRoleCard(deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'delegate' })

		expect(result.status).toBe('success')
		const pressureEvents = events.filter((e) => e.type === 'context_pressure')
		expect(pressureEvents.length).toBe(1)
		const pressureEvent = defined(pressureEvents[0], 'context_pressure event')
		expect(payloadField(pressureEvent, 'role')).toBe('child_b')
		expect(payloadField(pressureEvent, 'promptTokens')).toBe(450)
		expect(payloadField(pressureEvent, 'effectiveBudget')).toBe(500)
		const notified = llm.calls[5]?.messages ?? []
		const notice = notified[notified.length - 1]
		expect(notice?.role).toBe('user')
		expect(notice?.content).toContain('90%')
	})

	test('a context_handoff finish card reaches the parent unchanged', async () => {
		const guild = buildPressureGuild({
			main: { systemPrompt: 'p', tools: ['agent', 'finish'] },
			child: { systemPrompt: 'c', tools: ['finish'] },
		})
		const brief = 'HANDOFF BRIEF — done: wrote src/a.ts; remaining: wire the CLI; next: read src/index.ts'
		const llm = new FakeLlm()
		llm.responses = [
			success([agentCall('child', 'do the work')]),
			success([namedCall('f1', 'finish', { status: 'error', summary: brief, error: { kind: 'context_handoff', message: 'handing off at 85% of the context budget' } })], { promptTokens: 800 }),
			success([finishCall({ status: 'success', summary: 're-spawned and done' })]),
		]
		const { deps, events } = makeDeps(llm)

		const result = await runRoleCard(deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'delegate' })

		expect(result).toEqual({ status: 'success', summary: 're-spawned and done' })
		const agentResult = events.find((e) => e.type === 'tool_result' && payloadField(e, 'tool') === 'agent')
		if (agentResult === undefined) throw new Error('expected an agent tool_result')
		expect(payloadField(agentResult, 'result')).toEqual({
			kind: 'success',
			data: {
				status: 'error',
				summary: brief,
				error: { kind: 'context_handoff', message: 'handing off at 85% of the context budget' },
			},
		})
		// The child's own context_pressure event fired on the way out (800 ≥ 720): the scripted handoff follows the notice, as the protocol prescribes.
		expect(events.some((e) => e.type === 'context_pressure' && payloadField(e, 'role') === 'child')).toBe(true)
	})
})

describe('runRole — context manager routing', () => {
	const mainAndManager = {
		main: { systemPrompt: 'p', tools: ['echo', 'finish'] },
		context_manager: { systemPrompt: 'cm', tools: ['list_role_messages', 'edit_context', 'context_info', 'finish'] },
	}

	// Static budget 900 (window 1000 minus 100 reserved), so the default 0.8 threshold fires at 720 reported prompt tokens.
	function buildCompactionGuild(roles: Record<string, RoleDefinition> = mainAndManager): LoadedGuild {
		const guild = buildGuild(roles, 'main', {
			model: { ...baseModel, contextWindow: 1000, generation: { maxTokens: 100 } },
			executor: { ...baseExecutor, contextHandlerRole: 'context_manager' },
		})
		let withManifests = withTool(guild, { name: 'echo', description: 'echo', parameters: { type: 'object', properties: {} } })
		withManifests = withTool(withManifests, { name: 'edit_context', description: 'Edit context.', parameters: { type: 'object', required: ['operations'], properties: { operations: { type: 'array' } } } })
		withManifests = withTool(withManifests, { name: 'context_info', description: 'Context info.', parameters: { type: 'object', properties: {} } })
		withManifests = withTool(withManifests, { name: 'list_role_messages', description: 'List messages.', parameters: { type: 'object', required: ['targetRole'], properties: { targetRole: { type: 'string' } } } })
		return withManifests
	}

	test('depth-0 pressure suspends the role, the handler compacts it, and it resumes with the managed notice', async () => {
		const guild = buildCompactionGuild()
		const llm = new FakeLlm()
		llm.responses = [
			success([namedCall('e1', 'echo', { x: 1 })], { promptTokens: 800 }),
			// The flag set by that turn fires at the next turn top: the handler investigates the suspended main instance and prunes the stale turn.
			success([namedCall('l1', 'list_role_messages', { targetRole: 'main-0-1' })]),
			success([namedCall('ec1', 'edit_context', { targetRole: 'main-0-1', operations: [{ op: 'drop', range: [2, 4] }] })]),
			success([namedCall('ci1', 'context_info', { targetRole: 'main-0-1' })]),
			success([finishCall({ status: 'success', summary: 'compacted 4 messages to 2' })]),
			success([finishCall({ status: 'success', summary: 'main done' })], { promptTokens: 100 }),
		]
		const { deps, events } = makeDeps(llm)

		const result = await runRoleCard(deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		expect(result).toEqual({ status: 'success', summary: 'main done' })
		expect(events.some((e) => e.type === 'context_pressure')).toBe(true)
		const interrupt = events.find((e) => e.type === 'interrupt')
		if (interrupt === undefined) throw new Error('expected an interrupt event')
		expect(payloadField(interrupt, 'trigger')).toBe('context_pressure')
		expect(payloadField(interrupt, 'handler')).toBe('context_manager')
		expect(payloadField(interrupt, 'target')).toBe('main-0-1')
		const resolved = events.find((e) => e.type === 'interrupt_resolved')
		if (resolved === undefined) throw new Error('expected an interrupt_resolved event')
		expect(payloadField(resolved, 'action')).toBe('compacted')
		// The handler's edit applied before the resume: the next request is system, task, and the managed notice — the dropped turn is gone.
		const resumed = llm.calls[5]?.messages ?? []
		expect(resumed.length).toBe(3)
		const notice = resumed[resumed.length - 1]
		expect(notice?.role).toBe('user')
		expect(notice?.content).toContain('[Platform notice — context compacted]')
		expect(notice?.content).toContain('compacted 4 messages to 2')
		// With a handler configured, a depth-0 role never receives the handoff notice.
		expect(resumed.some((m) => m.content.includes('[Platform notice — context pressure]'))).toBe(false)
	})

	test('a child role under pressure still gets the handoff notice, not the handler', async () => {
		const guild = buildCompactionGuild({
			main: { systemPrompt: 'p', tools: ['agent', 'finish'] },
			child: { systemPrompt: 'c', tools: ['echo', 'finish'] },
			context_manager: { systemPrompt: 'cm', tools: ['list_role_messages', 'edit_context', 'context_info', 'finish'] },
		})
		const llm = new FakeLlm()
		llm.responses = [
			success([agentCall('child', 'work')]),
			success([namedCall('e1', 'echo', { x: 1 })], { promptTokens: 800 }),
			success([finishCall({ status: 'success', summary: 'child done' })], { promptTokens: 810 }),
			success([finishCall({ status: 'success', summary: 'main done' })]),
		]
		const { deps, events } = makeDeps(llm)

		const result = await runRoleCard(deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'delegate' })

		expect(result.status).toBe('success')
		expect(events.some((e) => e.type === 'role_start' && payloadField(e, 'role') === 'context_manager')).toBe(false)
		const notified = llm.calls[2]?.messages ?? []
		const last = notified[notified.length - 1]
		expect(last?.role).toBe('user')
		expect(last?.content).toContain('[Platform notice — context pressure]')
	})

	test('the depth-0 handler runs once per role instance even while usage stays above the threshold', async () => {
		const guild = buildCompactionGuild()
		const llm = new FakeLlm()
		llm.responses = [
			success([namedCall('e1', 'echo', { x: 1 })], { promptTokens: 800 }),
			success([finishCall({ status: 'success', summary: 'nothing worth removing' })]),
			success([namedCall('e2', 'echo', { x: 2 })], { promptTokens: 850 }),
			success([namedCall('e3', 'echo', { x: 3 })], { promptTokens: 860 }),
			success([finishCall({ status: 'success', summary: 'done' })], { promptTokens: 870 }),
		]
		const { deps, events } = makeDeps(llm)

		const result = await runRoleCard(deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		expect(result.status).toBe('success')
		expect(events.filter((e) => e.type === 'interrupt').length).toBe(1)
		expect(events.filter((e) => e.type === 'role_start' && payloadField(e, 'role') === 'context_manager').length).toBe(1)
	})

	test('a failed depth-0 handler falls back to the handoff notice', async () => {
		const guild = buildCompactionGuild()
		const llm = new FakeLlm()
		llm.responses = [
			success([namedCall('e1', 'echo', { x: 1 })], { promptTokens: 800 }),
			success([namedCall('f1', 'finish', { status: 'error', summary: 'cannot compact without losing the plot', error: { kind: 'compaction_failed' } })]),
			success([finishCall({ status: 'success', summary: 'done' })], { promptTokens: 100 }),
		]
		const { deps, events } = makeDeps(llm)

		const result = await runRoleCard(deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		expect(result.status).toBe('success')
		const resolved = events.find((e) => e.type === 'interrupt_resolved')
		if (resolved === undefined) throw new Error('expected an interrupt_resolved event')
		expect(payloadField(resolved, 'action')).toBe('failed')
		const notified = llm.calls[2]?.messages ?? []
		expect(notified[notified.length - 1]?.content).toContain('[Platform notice — context pressure]')
	})

	test('a wall rejection suspends the role for the handler instead of running the naive backstop', async () => {
		const guild = buildCompactionGuild()
		const llm = new FakeLlm()
		llm.responses = [
			success([namedCall('e1', 'echo', { x: 1 })]),
			contextExceeded(950, 1000),
			success([namedCall('ec1', 'edit_context', { targetRole: 'main-0-1', operations: [{ op: 'drop', range: [2, 4] }] })]),
			success([finishCall({ status: 'success', summary: 'dropped the stale turn' })]),
			success([finishCall({ status: 'success', summary: 'recovered' })], { promptTokens: 100 }),
		]
		const { deps, events } = makeDeps(llm)

		const result = await runRoleCard(deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		expect(result).toEqual({ status: 'success', summary: 'recovered' })
		expect(events.some((e) => e.type === 'context_compacted')).toBe(false)
		const interrupt = events.find((e) => e.type === 'interrupt')
		if (interrupt === undefined) throw new Error('expected an interrupt event')
		expect(payloadField(interrupt, 'trigger')).toBe('context_budget_exceeded')
		const resolved = events.find((e) => e.type === 'interrupt_resolved')
		if (resolved === undefined) throw new Error('expected an interrupt_resolved event')
		expect(payloadField(resolved, 'action')).toBe('compacted')
		const resumed = llm.calls[4]?.messages ?? []
		expect(resumed.length).toBe(3)
		expect(resumed[resumed.length - 1]?.content).toContain('[Platform notice — context compacted]')
	})

	test('a failed wall handler falls back to the naive backstop', async () => {
		const guild = buildCompactionGuild()
		const llm = new FakeLlm()
		llm.responses = [
			success([namedCall('e1', 'echo', { x: 1 })]),
			contextExceeded(0, 1000),
			success([namedCall('f1', 'finish', { status: 'error', summary: 'cannot do it', error: { kind: 'compaction_failed' } })]),
			success([finishCall({ status: 'success', summary: 'recovered' })], { promptTokens: 100 }),
		]
		const { deps, events } = makeDeps(llm)

		const result = await runRoleCard(deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		expect(result).toEqual({ status: 'success', summary: 'recovered' })
		expect(events.some((e) => e.type === 'context_compacted')).toBe(true)
		const resumed = llm.calls[3]?.messages ?? []
		expect(resumed[resumed.length - 1]?.content).toContain('[Platform notice — context window exceeded]')
	})

	test('the rejection cap still bounds the deferral loop when the handler cannot shrink the history', async () => {
		const guild = buildCompactionGuild()
		const llm = new FakeLlm()
		llm.responses = [
			contextExceeded(0, 1000),
			success([finishCall({ status: 'success', summary: 'nothing to drop' })]),
			contextExceeded(0, 1000),
			success([finishCall({ status: 'success', summary: 'nothing to drop' })]),
			contextExceeded(0, 1000),
			success([finishCall({ status: 'success', summary: 'nothing to drop' })]),
			contextExceeded(0, 1000),
		]
		const { deps, events } = makeDeps(llm)

		const result = await runRoleCard(deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		expect(result.status).toBe('error')
		expect(result.error?.kind).toBe('context_budget_exceeded')
		expect(llm.calls.length).toBe(7)
		expect(events.filter((e) => e.type === 'interrupt').length).toBe(3)
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

		await runRoleCard(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
			effort: 'standard',
		})

		expect(llm.calls.length).toBe(1)
		const messages = defined(llm.calls[0], 'entry call').messages
		// The directive is merged into the single system message, not emitted as a second one — many chat templates reject a system message that is not the first message.
		expect(messages).toHaveLength(2)
		expect(messages[0]).toEqual({ role: 'system', content: `prompt for main\n\n${effortDirective('standard')}` })
		expect(defined(messages[0], 'system message').content).toContain('Quality level: standard')
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

		await runRoleCard(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		const messages = defined(llm.calls[0], 'entry call').messages
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

		await runRoleCard(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'parent',
			task: 'delegate',
			effort: 'thorough',
		})

		// calls[0] = parent (entry, has directive); calls[1] = child (depth 1, no directive); calls[2] = parent follow-up.
		const childMessages = defined(llm.calls[1], 'child call').messages
		expect(childMessages[0]).toEqual({ role: 'system', content: 'prompt for child' })
		expect(childMessages[1]).toEqual({ role: 'user', content: 'subtask' })
		expect(childMessages.length).toBe(2)
		expect(childMessages.some((m) => m.content.includes('Quality level'))).toBe(false)
	})
})

describe('runRole involvement directive injection', () => {
	test('the entry role receives the involvement directive merged into its single system message', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [success([finishCall({ status: 'success', summary: 'Done' })])]
		const { deps } = makeDeps(llm)

		await runRoleCard(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
			involvement: 'collaborative',
		})

		expect(llm.calls.length).toBe(1)
		const messages = defined(llm.calls[0], 'entry call').messages
		// The directive is merged into the single system message, not emitted as a second one — many chat templates reject a system message that is not the first message.
		expect(messages).toHaveLength(2)
		expect(messages[0]).toEqual({ role: 'system', content: `prompt for main\n\n${involvementDirective('collaborative')}` })
		expect(defined(messages[0], 'system message').content).toContain('Human involvement: collaborative')
		expect(messages[1]).toEqual({ role: 'user', content: 'do it' })
	})

	test('the entry role receives no involvement directive when the context carries none', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [success([finishCall({ status: 'success', summary: 'Done' })])]
		const { deps } = makeDeps(llm)

		await runRoleCard(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		const messages = defined(llm.calls[0], 'entry call').messages
		expect(messages.length).toBe(2)
		expect(messages[0]).toEqual({ role: 'system', content: 'prompt for main' })
	})

	test('a child role does not receive the involvement directive even though the context is spread from the parent', async () => {
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

		await runRoleCard(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'parent',
			task: 'delegate',
			involvement: 'collaborative',
		})

		const childMessages = defined(llm.calls[1], 'child call').messages
		expect(childMessages[0]).toEqual({ role: 'system', content: 'prompt for child' })
		expect(childMessages[1]).toEqual({ role: 'user', content: 'subtask' })
		expect(childMessages.length).toBe(2)
		expect(childMessages.some((m) => m.content.includes('Human involvement'))).toBe(false)
	})
})

describe('run persistence and resumption', () => {
	const echoManifest: ToolManifest = {
		name: 'echo',
		description: 'Echoes its arguments.',
		parameters: { type: 'object', properties: {} },
	}

	function echoCall(id: string): ToolCall {
		return { id, type: 'function', function: { name: 'echo', arguments: '{}' } }
	}

	function buildDelegationGuild(): LoadedGuild {
		return withTool(
			buildGuild(
				{
					orchestrator: { systemPrompt: 'p', tools: ['agent', 'finish'] },
					coder: { systemPrompt: 'c', tools: ['echo', 'finish'] },
				},
				'orchestrator',
			),
			echoManifest,
		)
	}

	// Drives a full orchestrator→coder descent against a scripted LLM: orchestrator delegates, coder makes one echo tool call (so its accumulators are non-trivial at the checkpoint), coder finishes, orchestrator finishes. Returns the final card plus every checkpoint the recorder wrote — the sink deep-freezes each write, so later writes never mutate earlier ones.
	async function driveUninterruptedRun(): Promise<{ card: ResultCard; checkpoints: RunCheckpoint[] }> {
		const guild = buildDelegationGuild()
		const llm = new FakeLlm()
		llm.responses = [
			success([agentCall('coder', 'subtask')]),
			success([echoCall('e1')]),
			success([finishCall({ status: 'success', summary: 'child done' })]),
			success([finishCall({ status: 'success', summary: 'parent done' })]),
		]
		const { deps, checkpoints } = makeDeps(llm)
		const depsWithEcho: EngineDependencies = { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { echo: echoHandler }) }
		const card = await runRoleCard(depsWithEcho, { loadedGuild: guild, depth: 0, roleName: 'orchestrator', task: 'do it' })
		return { card, checkpoints }
	}

	function findCheckpoint(checkpoints: RunCheckpoint[], predicate: (checkpoint: RunCheckpoint) => boolean): RunCheckpoint {
		const checkpoint = checkpoints.find(predicate)
		if (checkpoint === undefined) throw new Error(`no checkpoint matched among ${checkpoints.length} writes`)
		return checkpoint
	}

	// The checkpoint after the child's ordinary echo settled but while the child still runs: the parent suspension is durable and the leaf's history already carries the echo result.
	function checkpointAfterChildEcho(checkpoints: RunCheckpoint[]): RunCheckpoint {
		return findCheckpoint(checkpoints, (checkpoint) =>
			checkpoint.frames.length === 2 &&
			checkpoint.frames[0]?.pending !== undefined &&
			checkpoint.frames[0]?.pending?.childCard === undefined &&
			checkpoint.frames[1]?.pending === undefined &&
			checkpoint.frames[1]?.roleState.toolCallCount === 1,
		)
	}

	test('a checkpoint taken while the child runs captures the suspended parent chain and the leaf state', async () => {
		const { checkpoints } = await driveUninterruptedRun()
		const checkpoint = checkpointAfterChildEcho(checkpoints)

		expect(checkpoint.frames.length).toBe(2)
		const parent = checkpoint.frames[0]
		const leaf = checkpoint.frames[1]
		expect(parent?.roleName).toBe('orchestrator')
		expect(parent?.pending?.toolCalls[parent.pending === undefined ? 0 : parent.pending.index]?.function.name).toBe('agent')
		expect(parent?.pending?.childCard).toBeUndefined()
		expect(leaf?.roleName).toBe('coder')
		expect(leaf?.parentRoleId).toBe(parent?.roleId)
		expect(leaf?.pending).toBeUndefined()
		// The leaf's accumulators reflect the echo call it already made.
		expect(leaf?.roleState.toolCallCount).toBe(1)
		expect(leaf?.roleState.history.length).toBe(4)
	})

	test('a run resumed at the suspended leaf continues the descent and produces the uninterrupted result', async () => {
		const uninterrupted = await driveUninterruptedRun()
		const checkpoint = checkpointAfterChildEcho(uninterrupted.checkpoints)
		const parentRoleId = checkpoint.frames[0]?.roleId
		const leafRoleId = checkpoint.frames[1]?.roleId

		const guild = buildDelegationGuild()
		const llm = new FakeLlm()
		llm.responses = [
			success([finishCall({ status: 'success', summary: 'child done' })]),
			success([finishCall({ status: 'success', summary: 'parent done' })]),
		]
		const { deps, events, checkpoints: resumedWrites } = makeDeps(llm)
		const depsWithEcho: EngineDependencies = { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { echo: echoHandler }) }

		const card = await resumeRoleStackCard(runRole, depsWithEcho, guild, checkpoint)

		expect(card).toEqual(uninterrupted.card)
		// Exactly two turns happen after the resume: the coder's finish and the orchestrator's follow-up — no earlier turn is replayed.
		expect(llm.calls.length).toBe(2)
		// The resumed coder's first LLM call carries its preserved conversation (system, task, the pre-crash echo exchange).
		const coderMessages = llm.calls[0]?.messages ?? []
		expect(coderMessages[0]?.role).toBe('system')
		expect(coderMessages.length).toBe(4)
		// Resumed roles keep their pre-crash instance ids and do not re-emit role_start; role_finished pairs with the pre-crash role_start.
		expect(events.some((event) => event.type === 'role_start')).toBe(false)
		const finishedIds = events.filter((event) => event.type === 'role_finished').map((event) => payloadField(event, 'roleId'))
		expect(finishedIds).toEqual([leafRoleId, parentRoleId])
		// The parent receives the child's card as the agent call's tool result.
		const agentResult = events.find((event) => event.type === 'tool_result' && payloadField(event, 'tool') === 'agent')
		expect(agentResult).toBeDefined()
		// Budget accumulators survive the resume: the first post-resume write still shows the pre-crash tool-call count, not a reset to zero.
		const firstWrite = resumedWrites[0]
		expect(firstWrite?.frames[1]?.roleState.toolCallCount).toBe(1)
	})

	test('a checkpoint with a recorded child card resumes without re-running the child', async () => {
		const { checkpoints } = await driveUninterruptedRun()
		const checkpoint = findCheckpoint(checkpoints, (candidate) => candidate.frames.length === 1 && candidate.frames[0]?.pending?.childCard !== undefined)
		expect(checkpoint.frames.length).toBe(1)
		expect(checkpoint.frames[0]?.pending?.childCard).toEqual({ status: 'success', summary: 'child done' })

		const guild = buildDelegationGuild()
		const llm = new FakeLlm()
		llm.responses = [success([finishCall({ status: 'success', summary: 'parent done' })])]
		const { deps, events } = makeDeps(llm)
		const depsWithEcho: EngineDependencies = { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { echo: echoHandler }) }

		const card = await resumeRoleStackCard(runRole, depsWithEcho, guild, checkpoint)

		expect(card).toEqual({ status: 'success', summary: 'parent done' })
		// One turn only: the orchestrator's follow-up. The finished child is not re-run.
		expect(llm.calls.length).toBe(1)
		const agentResult = events.find((event) => event.type === 'tool_result' && payloadField(event, 'tool') === 'agent')
		expect(agentResult).toBeDefined()
	})

	test('roles spawned after a resume mint fresh ids that cannot collide with preserved ones', async () => {
		const { checkpoints } = await driveUninterruptedRun()
		const checkpoint = checkpointAfterChildEcho(checkpoints)

		const guild = buildDelegationGuild()
		const llm = new FakeLlm()
		llm.responses = [
			success([finishCall({ status: 'success', summary: 'child done' })]),
			success([agentCall('coder', 'again')]),
			success([finishCall({ status: 'success', summary: 'second child done' })]),
			success([finishCall({ status: 'success', summary: 'parent done' })]),
		]
		const { deps, events } = makeDeps(llm)
		const depsWithEcho: EngineDependencies = { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { echo: echoHandler }) }

		const card = await resumeRoleStackCard(runRole, depsWithEcho, guild, checkpoint)

		expect(card.status).toBe('success')
		// The coder spawned after the resume is a fresh instance, so it mints a new id (the test registry starts at 0 and restored registrations do not advance it) and emits role_start — resumed roles do not.
		const starts = events.filter((event) => event.type === 'role_start').map((event) => payloadField(event, 'roleId'))
		expect(starts).toEqual(['coder-1-1'])
	})
})

describe('runRole — llm_call delta protocol', () => {
	const echoManifest: ToolManifest = {
		name: 'echo',
		description: 'Echoes its arguments.',
		parameters: { type: 'object', properties: {} },
	}

	function echoCall(id: string): ToolCall {
		return { id, type: 'function', function: { name: 'echo', arguments: '{}' } }
	}

	function bigCall(id: string): ToolCall {
		return { id, type: 'function', function: { name: 'big', arguments: '{}' } }
	}

	function buildEchoGuild(roles: Record<string, RoleDefinition>, extras: Partial<DeploymentConfig> = {}): LoadedGuild {
		let guild = withTool(buildGuild(roles, 'main', extras), echoManifest)
		guild = withTool(guild, { name: 'edit_context', description: 'Edit context.', parameters: { type: 'object', required: ['operations'], properties: { operations: { type: 'array' } } } })
		return guild
	}

	function llmCallsOf(events: LogEvent[], role: string): LogEvent[] {
		return events.filter((e) => e.type === 'llm_call' && payloadField(e, 'role') === role)
	}

	function numberOf(event: LogEvent, field: string): number {
		const value = payloadField(event, field)
		if (typeof value !== 'number') throw new Error(`expected ${field} to be a number`)
		return value
	}

	function sentOf(event: LogEvent): Array<{ role: string; content: string }> {
		const sent = payloadField(event, 'sent')
		if (!Array.isArray(sent) || !sent.every((entry) => isRecord(entry) && typeof entry['role'] === 'string' && typeof entry['content'] === 'string')) throw new Error('expected the shaped sent message list')
		return sent
	}

	// Mirrors the payload's message shaping so a fold can be compared against the request the model actually received.
	function shapedRequest(messages: Message[]): Array<{ role: string; content: string; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> }> {
		return messages.map((m) => {
			if (m.tool_calls !== undefined && m.tool_calls.length > 0) {
				return {
					role: m.role,
					content: m.content,
					tool_calls: m.tool_calls.map((c) => ({ id: c.id, type: c.type, function: { name: c.function.name, arguments: c.function.arguments } })),
				}
			}
			return { role: m.role, content: m.content }
		})
	}

	test('the first llm_call is a full snapshot and later turns are deltas that chain off it', async () => {
		const guild = buildEchoGuild({ main: { systemPrompt: 'p', tools: ['echo', 'finish'] } })
		const llm = new FakeLlm()
		llm.responses = [
			success([echoCall('e1')]),
			success([echoCall('e2')]),
			success([finishCall({ status: 'success', summary: 'done' })]),
		]
		const { deps, events } = makeDeps(llm)
		const depsWithEcho: EngineDependencies = { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { echo: echoHandler }) }

		await runRoleCard(depsWithEcho, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		const llmCalls = llmCallsOf(events, 'main')
		expect(llmCalls.length).toBe(3)
		// Turn 1 logs the whole request: sentFrom 0 with sent covering every message.
		const first = defined(llmCalls[0], 'first llm_call')
		expect(numberOf(first, 'sentFrom')).toBe(0)
		expect(numberOf(first, 'messageCount')).toBe(2)
		expect(sentOf(first).length).toBe(2)
		// The payload carries the role-instance id (the same one role_start carries), so a role's turns stay groupable per instance even when a same-named child's events interleave.
		expect(payloadField(first, 'roleId')).toBe('main-0-1')
		// Later turns log only the messages added since the previous logged request: each delta starts exactly where that request ended, and its length is the difference from its size.
		const second = defined(llmCalls[1], 'second llm_call')
		expect(numberOf(second, 'sentFrom')).toBe(2)
		expect(numberOf(second, 'messageCount')).toBe(4)
		expect(sentOf(second).length).toBe(2)
		const third = defined(llmCalls[2], 'third llm_call')
		expect(numberOf(third, 'sentFrom')).toBe(4)
		expect(numberOf(third, 'messageCount')).toBe(6)
		expect(sentOf(third).length).toBe(2)
		// The deltas concatenate to exactly the requests the model received, so log growth stays linear in the turns (2+2+2 instead of 2+4+6).
		const foldedSecond = [...sentOf(first), ...sentOf(second)]
		expect(foldedSecond).toEqual(shapedRequest(defined(llm.calls[1], 'second request').messages))
		expect([...foldedSecond, ...sentOf(third)]).toEqual(shapedRequest(defined(llm.calls[2], 'third request').messages))
	})

	test('a cross-role edit_context invalidates the suspended role’s baseline: its next llm_call is a full snapshot', async () => {
		// Static budget 900 (window 1000 minus 100 reserved), so the default 0.8 threshold fires at 720 reported prompt tokens.
		const guild = buildEchoGuild(
			{
				main: { systemPrompt: 'p', tools: ['echo', 'finish'] },
				context_manager: { systemPrompt: 'cm', tools: ['edit_context', 'finish'] },
			},
			{
				model: { ...baseModel, contextWindow: 1000, generation: { maxTokens: 100 } },
				executor: { ...baseExecutor, contextHandlerRole: 'context_manager' },
			},
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([echoCall('e1')], { promptTokens: 800 }),
			success([namedCall('ec1', 'edit_context', { targetRole: 'main-0-1', operations: [{ op: 'drop', range: [2, 4] }] })]),
			success([finishCall({ status: 'success', summary: 'compacted' })]),
			success([finishCall({ status: 'success', summary: 'main done' })], { promptTokens: 100 }),
		]
		const { deps, events } = makeDeps(llm)
		const depsWithEcho: EngineDependencies = { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { echo: echoHandler }) }

		await runRoleCard(depsWithEcho, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		const mainCalls = llmCallsOf(events, 'main')
		expect(mainCalls.length).toBe(2)
		// Turn 1 was a full snapshot with a valid baseline of 2; the context manager's cross-role drop rewrote the suspended role's history, so the resumed turn must re-log everything it now sends.
		expect(numberOf(defined(mainCalls[0], 'first main llm_call'), 'sentFrom')).toBe(0)
		const resumed = defined(mainCalls[1], 'resumed main llm_call')
		expect(numberOf(resumed, 'sentFrom')).toBe(0)
		expect(numberOf(resumed, 'messageCount')).toBe(3)
		expect(sentOf(resumed).length).toBe(3)
		expect(sentOf(resumed)[2]?.content).toContain('[Platform notice — context compacted]')
	})

	test('a self edit_context invalidates the caller’s baseline: a replaced message is visible in the next full snapshot', async () => {
		const guild = buildEchoGuild({ main: { systemPrompt: 'p', tools: ['echo', 'edit_context', 'finish'] } })
		const llm = new FakeLlm()
		llm.responses = [
			success([echoCall('e1')]),
			success([namedCall('ec1', 'edit_context', { operations: [{ op: 'replace', index: 2, content: 'rewritten' }] })]),
			success([finishCall({ status: 'success', summary: 'done' })]),
		]
		const { deps, events } = makeDeps(llm)
		const depsWithEcho: EngineDependencies = { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { echo: echoHandler }) }

		await runRoleCard(depsWithEcho, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		const llmCalls = llmCallsOf(events, 'main')
		expect(llmCalls.length).toBe(3)
		// Turn 2 was a plain delta; the replace then rewrote the history out from under the baseline.
		expect(numberOf(defined(llmCalls[1], 'second llm_call'), 'sentFrom')).toBe(2)
		const after = defined(llmCalls[2], 'third llm_call')
		expect(numberOf(after, 'sentFrom')).toBe(0)
		expect(numberOf(after, 'messageCount')).toBe(6)
		expect(sentOf(after).length).toBe(6)
		expect(sentOf(after)[2]?.content).toBe('rewritten')
	})

	test('a platform compaction (the naive backstop) forces the recovery turn back to a full snapshot', async () => {
		const guild = buildEchoGuild(
			{ main: { systemPrompt: 'p', tools: ['big', 'finish'] } },
			{ contextPolicy: { maxToolOutputChars: 4000 } },
		)
		guild.tools['big'] = { name: 'big', description: 'returns a large payload', parameters: { type: 'object', properties: {} } }
		const bigHandler: FixtureToolHandler = () => ({ kind: 'success', data: { text: 'x'.repeat(2000) } })
		const llm = new FakeLlm()
		llm.responses = [
			success([bigCall('b1')]),
			success([bigCall('b2')]),
			success([bigCall('b3')]),
			contextExceeded(0, 1000),
			success([finishCall({ status: 'success', summary: 'recovered' })]),
		]
		const { deps, events } = makeDeps(llm)
		const depsWithBig: EngineDependencies = { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { big: bigHandler }) }

		await runRoleCard(depsWithBig, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		const llmCalls = llmCallsOf(events, 'main')
		expect(llmCalls.length).toBe(4)
		// Turns 1–3 chain as deltas; the backstop's truncation changes content without changing length, so the recovery turn must not trust the baseline.
		expect(numberOf(defined(llmCalls[2], 'third llm_call'), 'sentFrom')).toBe(4)
		const recovery = defined(llmCalls[3], 'recovery llm_call')
		expect(numberOf(recovery, 'sentFrom')).toBe(0)
		expect(numberOf(recovery, 'messageCount')).toBe(5)
		expect(sentOf(recovery).length).toBe(5)
		expect(sentOf(recovery)[4]?.content).toContain('[Platform notice — context window exceeded]')
	})

	test('a resumed role continues delta-ing from the checkpointed baseline instead of re-logging its conversation', async () => {
		const guild = buildEchoGuild({
			orchestrator: { systemPrompt: 'p', tools: ['agent', 'finish'] },
			coder: { systemPrompt: 'c', tools: ['echo', 'finish'] },
		})
		// Drives orchestrator→coder with the coder making one echo call, so the checkpoint taken at the coder's next loop top carries its baseline from the turn it just logged.
		const uninterruptedLlm = new FakeLlm()
		uninterruptedLlm.responses = [
			success([agentCall('coder', 'subtask')]),
			success([echoCall('e1')]),
			success([finishCall({ status: 'success', summary: 'child done' })]),
			success([finishCall({ status: 'success', summary: 'parent done' })]),
		]
		const uninterruptedDeps = makeDeps(uninterruptedLlm)
		await runRoleCard({ ...uninterruptedDeps.deps, toolPlatform: withExtraHandlers(uninterruptedDeps.deps.toolPlatform, { echo: echoHandler }) }, { loadedGuild: guild, depth: 0, roleName: 'orchestrator', task: 'do it' })
		const checkpoint = defined(
			uninterruptedDeps.checkpoints.find((candidate) => candidate.frames.length === 2 && candidate.frames[1]?.roleState.logSentBaseline === 2),
			'checkpoint at the coder\u2019s second loop top',
		)
		expect(checkpoint.frames[1]?.roleName).toBe('coder')
		// The coder's turn-1 request was [system, task], so its baseline is 2 — and the fake sink's JSON copy proves the field survives the checkpoint round-trip validation.
		expect(checkpoint.frames[1]?.roleState.logSentBaseline).toBe(2)

		const resumedLlm = new FakeLlm()
		resumedLlm.responses = [
			success([finishCall({ status: 'success', summary: 'child done' })]),
			success([finishCall({ status: 'success', summary: 'parent done' })]),
		]
		const { deps, events } = makeDeps(resumedLlm)

		await resumeRoleStackCard(runRole, { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { echo: echoHandler }) }, guild, checkpoint)

		// The resumed coder's next request is its preserved 4-message conversation, logged as a delta from the preserved baseline — not a re-logged full snapshot.
		const coderCalls = llmCallsOf(events, 'coder')
		expect(coderCalls.length).toBe(1)
		const resumedCall = defined(coderCalls[0], 'resumed coder llm_call')
		expect(numberOf(resumedCall, 'sentFrom')).toBe(2)
		expect(numberOf(resumedCall, 'messageCount')).toBe(4)
		expect(sentOf(resumedCall).length).toBe(2)
	})
})

describe('runRole — streamed delta publishing', () => {
	test('the caller\'s onDelta reaches publishDelta stamped with the publishing role\'s identity, in emission order', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [success([finishCall({ status: 'success', summary: 'Done' })])]
		llm.deltasPerCall = [
			[{ field: 'reasoning', text: 'thin' }, { field: 'content', text: 'Hello' }],
		]
		const { deps } = makeDeps(llm)
		const published: RoleDelta[] = []
		const depsWithTap: EngineDependencies = { ...deps, publishDelta: (delta) => published.push(delta) }

		const result = await runRoleCard(depsWithTap, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result.status).toBe('success')
		expect(published).toEqual([
			{ roleId: 'main-0-1', role: 'main', field: 'reasoning', text: 'thin' },
			{ roleId: 'main-0-1', role: 'main', field: 'content', text: 'Hello' },
		])
	})

	test('a child role\'s deltas carry the child\'s own instance identity, not the parent\'s', async () => {
		const guild = buildGuild({
			orchestrator: { systemPrompt: 'p', tools: ['agent', 'finish'] },
			coder: { systemPrompt: 'c', tools: ['finish'] },
		}, 'orchestrator')
		const llm = new FakeLlm()
		llm.responses = [
			success([agentCall('coder', 'subtask')]),
			success([finishCall({ status: 'success', summary: 'child done' })]),
			success([finishCall({ status: 'success', summary: 'parent done' })]),
		]
		llm.deltasPerCall = [
			[{ field: 'content', text: 'parent text' }],
			[{ field: 'reasoning', text: 'child thinking' }],
		]
		const { deps } = makeDeps(llm)
		const published: RoleDelta[] = []
		const depsWithTap: EngineDependencies = { ...deps, publishDelta: (delta) => published.push(delta) }

		const result = await runRoleCard(depsWithTap, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'orchestrator',
			task: 'do it',
		})

		expect(result.status).toBe('success')
		expect(published).toEqual([
			{ roleId: 'orchestrator-0-1', role: 'orchestrator', field: 'content', text: 'parent text' },
			{ roleId: 'coder-1-2', role: 'coder', field: 'reasoning', text: 'child thinking' },
		])
	})
})

describe('runRole — the pre-write park rule', () => {
	const askHumanManifest: ToolManifest = {
		name: 'ask_human',
		description: 'Ask a human a question.',
		parameters: {
			type: 'object',
			required: ['question'],
			properties: { question: { type: 'string' }, context: { type: 'string' } },
		},
	}

	function askCall(question: string): ToolCall {
		return { id: 'ask_1', type: 'function', function: { name: 'ask_human', arguments: JSON.stringify({ question }) } }
	}

	function buildParkGuild(roles: Record<string, RoleDefinition>, entryRole: string): LoadedGuild {
		return withTool(buildGuild(roles, entryRole), askHumanManifest)
	}

	test('a queue-tracked pre-write ask_human parks the run: the backend is never called and the run ends needs_clarification with the platform summary', async () => {
		const guild = buildParkGuild(
			{ main: { systemPrompt: 'p', tools: ['ask_human', 'finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [success([askCall('Which database should I use?')])]
		const { deps, events, parkTracker, checkpoints } = makeDeps(llm)
		const human = recordingHumanBackend()
		const depsWithHuman: EngineDependencies = { ...deps, humanBackend: human }
		// The dispatch path marks a queue-dispatched run; only such a run parks (docs/queueing.md "Parking: the pre-write rule").
		parkTracker.queueTracked = true

		const result = await runRoleCard(depsWithHuman, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result.status).toBe('needs_clarification')
		expect(result.summary).toBe('waiting for an answer to: Which database should I use?')
		// The human backend is never called — no pending question is registered; answering happens through the queue item.
		expect(human.questions).toEqual([])
		// No further LLM request after the mark is set: the run never gets a turn to talk itself out of parking.
		expect(llm.calls.length).toBe(1)
		expect(parkTracker.parkedQuestion).toBe('Which database should I use?')
		// The frozen park checkpoint carries the ask and its tool result, ready for the answer resume.
		const parkCheckpoint = checkpoints[checkpoints.length - 1]
		expect(parkCheckpoint?.parkedAsk).toMatchObject({ roleId: 'main-0-1', toolCallId: 'ask_1', callId: 'tool:ask_1', questionId: 'ask_1', question: 'Which database should I use?' })
		const parkedHistory = parkCheckpoint?.frames[0]?.roleState.history ?? []
		expect(parkedHistory[parkedHistory.length - 1]).toEqual({ role: 'tool', content: '{"question":"Which database should I use?","parked":true}', tool_call_id: 'ask_1' })
		// The run's own log stays a faithful record: the ask_human event fired with the pairing id, marked as parked.
		const askEvent = events.find((e) => e.type === 'ask_human')
		expect(askEvent).toBeDefined()
		const askPayload = defined(askEvent, 'ask_human event').payload
		expect(isRecord(askPayload) && askPayload['parked'] === true).toBe(true)
		expect(isRecord(askPayload) && askPayload['id'] === 'ask_1').toBe(true)
	})

	test('a run the queue does not track blocks on a pre-write ask exactly as today: the backend receives the question and a pending question registers', async () => {
		const guild = buildParkGuild(
			{ main: { systemPrompt: 'p', tools: ['ask_human', 'finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([askCall('Which database should I use?')]),
			success([finishCall({ status: 'success', summary: 'done' })]),
		]
		const { deps, parkTracker } = makeDeps(llm)
		const human = recordingHumanBackend()
		const depsWithHuman: EngineDependencies = { ...deps, humanBackend: human }

		const result = await runRoleCard(depsWithHuman, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result).toEqual({ status: 'success', summary: 'done' })
		// Today's blocking behavior: the backend received the question and its pending entry registered.
		expect(human.questions).toEqual([{ question: 'Which database should I use?', context: undefined }])
		expect(llm.calls.length).toBe(2)
		expect(parkTracker.parkedQuestion).toBeUndefined()
	})

	test('a batched ask_human + agent turn parks before the child role starts', async () => {
		const guild = buildParkGuild(
			{
				main: { systemPrompt: 'p', tools: ['ask_human', 'agent', 'finish'] },
				coder: { systemPrompt: 'c', tools: ['finish'] },
			},
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [success([askCall('Which database?'), agentCall('coder', 'do the work')])]
		const { deps, events, parkTracker } = makeDeps(llm)
		parkTracker.queueTracked = true

		const result = await runRoleCard(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result.status).toBe('needs_clarification')
		expect(result.summary).toBe('waiting for an answer to: Which database?')
		// The between-dispatch check is load-bearing: the coder must not start after the park decision.
		expect(llm.calls.length).toBe(1)
		expect(events.some((e) => e.type === 'agent_call')).toBe(false)
		expect(events.some((e) => e.type === 'role_start' && payloadField(e, 'role') === 'coder')).toBe(false)
	})

	test('after a write-capable role has started, ask_human blocks on the human backend exactly as today', async () => {
		const guild = buildParkGuild(
			{ main: { systemPrompt: 'p', tools: ['run_shell', 'ask_human', 'finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([askCall('Which database should I use?')]),
			success([finishCall({ status: 'success', summary: 'done' })]),
		]
		const { deps, parkTracker } = makeDeps(llm)
		const human = recordingHumanBackend()
		const depsWithHuman: EngineDependencies = { ...deps, humanBackend: human }
		// Tracked and post-write: the write-capability half of the gate is what keeps this ask blocking.
		parkTracker.queueTracked = true

		const result = await runRoleCard(depsWithHuman, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(result).toEqual({ status: 'success', summary: 'done' })
		expect(human.questions).toEqual([{ question: 'Which database should I use?', context: undefined }])
		expect(llm.calls.length).toBe(2)
		expect(parkTracker.writeCapableStarted).toBe(true)
		expect(parkTracker.parkedQuestion).toBeUndefined()
	})

	test('the write-capability flag rides the checkpoint so a restart cannot reset it', async () => {
		const guild = buildParkGuild(
			{ main: { systemPrompt: 'p', tools: ['run_shell', 'finish'] } },
			'main',
		)
		const llm = new FakeLlm()
		llm.responses = [success([finishCall({ status: 'success', summary: 'done' })])]
		const { deps, checkpoints, parkTracker } = makeDeps(llm)

		await runRoleCard(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'main',
			task: 'do it',
		})

		expect(parkTracker.writeCapableStarted).toBe(true)
		expect(checkpoints.length).toBeGreaterThan(0)
		expect(checkpoints.every((checkpoint) => checkpoint.writeCapableStarted === true)).toBe(true)
	})

	test('a park in a child role unwinds the suspended parent with the same park card', async () => {
		const guild = buildParkGuild(
			{
				parent: { systemPrompt: 'p', tools: ['agent', 'finish'] },
				coder: { systemPrompt: 'c', tools: ['ask_human', 'finish'] },
			},
			'parent',
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([agentCall('coder', 'do the work')]),
			success([askCall('Which database?')]),
		]
		const { deps, events, parkTracker, checkpoints } = makeDeps(llm)
		parkTracker.queueTracked = true

		const result = await runRoleCard(deps, {
			loadedGuild: guild,
			depth: 0,
			roleName: 'parent',
			task: 'do it',
		})

		expect(result.status).toBe('needs_clarification')
		expect(result.summary).toBe('waiting for an answer to: Which database?')
		// The child parked while it was the leaf; its frozen checkpoint is the answer resume's re-entry point.
		const parkCheckpoint = checkpoints[checkpoints.length - 1]
		expect(parkCheckpoint?.parkedAsk).toMatchObject({ roleId: 'coder-1-2', toolCallId: 'ask_1', callId: 'tool:ask_1', questionId: 'ask_1', question: 'Which database?' })
		expect(parkCheckpoint?.frames.map((frame) => frame.roleName)).toEqual(['parent', 'coder'])
		// The child asked and parked; the parent finished with the same card without another LLM request.
		expect(llm.calls.length).toBe(2)
		const finishes = events.filter((e) => e.type === 'role_finished').map((e) => payloadField(e, 'status'))
		expect(finishes).toEqual(['needs_clarification', 'needs_clarification'])
	})

	test('a nested parked run emits its true final terminals after the answer resume, not the pause events', async () => {
		const guild = buildParkGuild(
			{
				parent: { systemPrompt: 'p', tools: ['agent', 'finish'] },
				coder: { systemPrompt: 'c', tools: ['ask_human', 'finish'] },
			},
			'parent',
		)
		const parkedLlm = new FakeLlm()
		parkedLlm.responses = [
			success([agentCall('coder', 'do the work')]),
			success([askCall('Which database?')]),
		]
		const parked = makeDeps(parkedLlm)
		parked.parkTracker.queueTracked = true
		await runRoleCard(parked.deps, { loadedGuild: guild, depth: 0, roleName: 'parent', task: 'do it' })
		const checkpoint = parked.checkpoints[parked.checkpoints.length - 1]
		if (checkpoint === undefined) throw new Error('expected the parked checkpoint')

		const resumeLlm = new FakeLlm()
		resumeLlm.responses = [
			success([finishCall({ status: 'success', summary: 'child answered' })]),
			success([finishCall({ status: 'success', summary: 'parent answered' })]),
		]
		const resumed = makeDeps(resumeLlm)
		resumed.parkTracker.queueTracked = true
		resumed.parkTracker.parkedAsk = checkpoint.parkedAsk

		const card = await resumeRoleStackCard(runRole, resumed.deps, guild, checkpoint, { parkedAnswer: { question: 'Which database?', answer: 'postgres', toolCallId: 'ask_1' } })

		expect(card).toEqual({ status: 'success', summary: 'parent answered' })
		const realFinishes = resumed.events.filter((event) => event.type === 'role_finished' && payloadField(event, 'paused') !== true)
		expect(realFinishes.map((event) => payloadField(event, 'role'))).toEqual(['coder', 'parent'])
		expect(realFinishes.map((event) => payloadField(event, 'status'))).toEqual(['success', 'success'])
		expect(resumed.events.filter((event) => event.type === 'role_finished' && payloadField(event, 'role') === 'coder').length).toBe(1)
		expect(resumed.events.filter((event) => event.type === 'role_finished' && payloadField(event, 'role') === 'parent').length).toBe(1)
	})

	test('resuming a parked run delivers the answer into the same tool message, logs it, clears the park state, and sends it to the next request', async () => {
		const guild = buildParkGuild({ main: { systemPrompt: 'p', tools: ['ask_human', 'finish'] } }, 'main')
		const parkedLlm = new FakeLlm()
		parkedLlm.responses = [success([askCall('Which database?')])]
		const parked = makeDeps(parkedLlm)
		parked.parkTracker.queueTracked = true
		await runRoleCard(parked.deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })
		const checkpoint = parked.checkpoints[parked.checkpoints.length - 1]
		if (checkpoint === undefined) throw new Error('expected a parked checkpoint')

		const before = structuredClone(checkpoint.frames[0]?.roleState.history ?? [])
		const resumeLlm = new FakeLlm()
		resumeLlm.responses = [success([finishCall({ status: 'success', summary: 'built it' })])]
		const resumed = makeDeps(resumeLlm)
		resumed.parkTracker.queueTracked = true
		resumed.parkTracker.parkedAsk = checkpoint.parkedAsk

		const card = await resumeRoleStackCard(runRole, resumed.deps, guild, checkpoint, { parkedAnswer: { question: 'Which database?', answer: 'postgres', toolCallId: 'ask_1' } })

		expect(card).toEqual({ status: 'success', summary: 'built it' })
		const postCheckpoint = resumed.checkpoints[0]
		const after = postCheckpoint?.frames[0]?.roleState.history ?? []
		// Only the ask's tool result changes; the whole conversation prefix (and its prompt cache) is untouched.
		expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, before.length - 1))
		expect(after[before.length - 1]).toEqual({ role: 'tool', content: '{"question":"Which database?","answer":"postgres"}', tool_call_id: 'ask_1' })
		const answerEvent = resumed.events.find((event) => event.type === 'human_answer')
		expect(answerEvent?.payload).toEqual({ id: 'ask_1', callId: 'tool:ask_1', question: 'Which database?', answer: 'postgres' })
		expect(resumed.parkTracker.parkedQuestion).toBeUndefined()
		expect(resumed.parkTracker.parkedAsk).toBeUndefined()
		const sent = resumeLlm.calls[0]?.messages ?? []
		expect(sent.some((message) => message.role === 'tool' && message.content.includes('postgres'))).toBe(true)
	})

	test('a batched ask_human + agent turn dispatches the remaining calls after the answer', async () => {
		const guild = buildParkGuild(
			{
				main: { systemPrompt: 'p', tools: ['ask_human', 'agent', 'finish'] },
				coder: { systemPrompt: 'c', tools: ['finish'] },
			},
			'main',
		)
		const parkedLlm = new FakeLlm()
		parkedLlm.responses = [success([askCall('Which database?'), agentCall('coder', 'do the work')])]
		const parked = makeDeps(parkedLlm)
		parked.parkTracker.queueTracked = true
		await runRoleCard(parked.deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })
		const checkpoint = parked.checkpoints[parked.checkpoints.length - 1]
		if (checkpoint === undefined) throw new Error('expected a parked checkpoint')
		// The frozen checkpoint ends at the ask's tool result: the batch's agent call must not have dispatched.
		const parkedToolMessages = checkpoint.frames[0]?.roleState.history.filter((message) => message.role === 'tool') ?? []
		expect(parkedToolMessages).toEqual([{ role: 'tool', content: '{"question":"Which database?","parked":true}', tool_call_id: 'ask_1' }])

		const resumeLlm = new FakeLlm()
		resumeLlm.responses = [success([finishCall({ status: 'success', summary: 'child done' })]), success([finishCall({ status: 'success', summary: 'parent done' })])]
		const resumed = makeDeps(resumeLlm)
		resumed.parkTracker.queueTracked = true
		resumed.parkTracker.parkedAsk = checkpoint.parkedAsk

		const card = await resumeRoleStackCard(runRole, resumed.deps, guild, checkpoint, { parkedAnswer: { question: 'Which database?', answer: 'postgres', toolCallId: 'ask_1' } })

		expect(card).toEqual({ status: 'success', summary: 'parent done' })
		expect(resumed.events.some((event) => event.type === 'agent_call')).toBe(true)
		expect(resumed.events.some((event) => event.type === 'role_start' && payloadField(event, 'role') === 'coder')).toBe(true)
		expect(resumed.events.some((event) => event.type === 'human_answer')).toBe(true)
	})

	test('the unparked checkpoint is written only after the remaining call completes, and boot/error resumes re-enter a well-formed request', async () => {
		const echoManifest: ToolManifest = { name: 'echo', description: 'Echoes its arguments.', parameters: { type: 'object', properties: {} } }
		const guild = withTool(buildParkGuild({ main: { systemPrompt: 'p', tools: ['ask_human', 'echo', 'finish'] } }, 'main'), echoManifest)
		const echoCall: ToolCall = { id: 'echo_1', type: 'function', function: { name: 'echo', arguments: '{"value":42}' } }
		const parkedLlm = new FakeLlm()
		parkedLlm.responses = [success([askCall('Which database?'), echoCall])]
		const parked = makeDeps(parkedLlm)
		parked.parkTracker.queueTracked = true
		const parkedDeps: EngineDependencies = { ...parked.deps, toolPlatform: withExtraHandlers(parked.deps.toolPlatform, { echo: echoHandler }) }
		await runRoleCard(parkedDeps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })
		const checkpoint = parked.checkpoints[parked.checkpoints.length - 1]
		if (checkpoint === undefined) throw new Error('expected a parked checkpoint')
		expect(checkpoint.parkedAsk?.toolCallId).toBe('ask_1')
		expect(checkpoint.frames[0]?.roleState.history.filter((message) => message.role === 'tool').map((message) => message.tool_call_id)).toEqual(['ask_1'])

		const resumeLlm = new FakeLlm()
		resumeLlm.responses = [success([finishCall({ status: 'success', summary: 'built it' })])]
		const resumed = makeDeps(resumeLlm)
		resumed.parkTracker.queueTracked = true
		resumed.parkTracker.parkedAsk = checkpoint.parkedAsk
		const resumedDeps: EngineDependencies = { ...resumed.deps, toolPlatform: withExtraHandlers(resumed.deps.toolPlatform, { echo: echoHandler }) }
		const card = await resumeRoleStackCard(runRole, resumedDeps, guild, checkpoint, { parkedAnswer: { question: 'Which database?', answer: 'postgres', toolCallId: 'ask_1' } })

		expect(card).toEqual({ status: 'success', summary: 'built it' })
		const completed = resumed.checkpoints.find((candidate) => candidate.frames[0]?.roleState.history.some((message) => message.role === 'tool' && message.tool_call_id === 'echo_1'))
		if (completed === undefined) throw new Error('expected the completed-turn checkpoint')
		expect(completed.parkedAsk).toBeUndefined()
		const completedTools = completed.frames[0]?.roleState.history.filter((message) => message.role === 'tool') ?? []
		expect(completedTools.map((message) => message.tool_call_id)).toEqual(['ask_1', 'echo_1'])
		expect(completedTools[1]?.content).toBe('{"value":42}')

		const assertWellFormedToolCalls = (messages: Message[]): void => {
			const unanswered = new Set<string>()
			for (const message of messages) {
				for (const call of message.tool_calls ?? []) unanswered.add(call.id)
				if (message.role === 'tool' && message.tool_call_id !== undefined) unanswered.delete(message.tool_call_id)
			}
			expect([...unanswered]).toEqual([])
		}

		const bootLlm = new FakeLlm()
		bootLlm.responses = [success([finishCall({ status: 'success', summary: 'boot done' })])]
		const boot = makeDeps(bootLlm)
		const bootDeps: EngineDependencies = { ...boot.deps, toolPlatform: withExtraHandlers(boot.deps.toolPlatform, { echo: echoHandler }) }
		const bootCard = await resumeRoleStackCard(runRole, bootDeps, guild, structuredClone(completed))

		expect(bootCard).toEqual({ status: 'success', summary: 'boot done' })
		const bootMessages = bootLlm.calls[0]?.messages ?? []
		assertWellFormedToolCalls(bootMessages)
		expect(bootMessages.some((message) => message.role === 'tool' && message.tool_call_id === 'echo_1')).toBe(true)

		const errorLlm = new FakeLlm()
		errorLlm.responses = [success([finishCall({ status: 'success', summary: 'error resume done' })])]
		const errorResume = makeDeps(errorLlm)
		const errorDeps: EngineDependencies = { ...errorResume.deps, toolPlatform: withExtraHandlers(errorResume.deps.toolPlatform, { echo: echoHandler }) }
		const errorCard = await resumeRoleStackCard(runRole, errorDeps, guild, structuredClone(completed), { resumeNote: 'The operator resumed this run after a failure. Message from the operator: carry on' })

		expect(errorCard).toEqual({ status: 'success', summary: 'error resume done' })
		assertWellFormedToolCalls(errorLlm.calls[0]?.messages ?? [])
	})

	test('a remaining call that spawns a child which parks keeps the new child park checkpoint', async () => {
		const guild = buildParkGuild(
			{
				main: { systemPrompt: 'p', tools: ['ask_human', 'agent', 'finish'] },
				coder: { systemPrompt: 'c', tools: ['ask_human', 'finish'] },
			},
			'main',
		)
		const parkedLlm = new FakeLlm()
		parkedLlm.responses = [success([askCall('Which database?'), agentCall('coder', 'do the work')])]
		const parked = makeDeps(parkedLlm)
		parked.parkTracker.queueTracked = true
		await runRoleCard(parked.deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })
		const checkpoint = parked.checkpoints[parked.checkpoints.length - 1]
		if (checkpoint === undefined) throw new Error('expected a parked checkpoint')

		const resumeLlm = new FakeLlm()
		resumeLlm.responses = [success([{ id: 'ask_2', type: 'function', function: { name: 'ask_human', arguments: JSON.stringify({ question: 'And the port?' }) } }])]
		const resumed = makeDeps(resumeLlm)
		resumed.parkTracker.queueTracked = true
		resumed.parkTracker.parkedAsk = checkpoint.parkedAsk
		const card = await resumeRoleStackCard(runRole, resumed.deps, guild, checkpoint, { parkedAnswer: { question: 'Which database?', answer: 'postgres', toolCallId: 'ask_1' } })

		expect(card.status).toBe('needs_clarification')
		expect(card.summary).toBe('waiting for an answer to: And the port?')
		const finalCheckpoint = resumed.checkpoints[resumed.checkpoints.length - 1]
		expect(finalCheckpoint?.parkedAsk).toMatchObject({ roleId: 'coder-1-1', toolCallId: 'ask_2', callId: 'tool:ask_2', questionId: 'ask_2', question: 'And the port?' })
		expect(finalCheckpoint?.frames.map((frame) => frame.roleName)).toEqual(['main', 'coder'])
	})

	test('an answer with the wrong tool call fails fast instead of writing a broken turn', async () => {
		const guild = buildParkGuild({ main: { systemPrompt: 'p', tools: ['ask_human', 'finish'] } }, 'main')
		const parkedLlm = new FakeLlm()
		parkedLlm.responses = [success([askCall('Which database?')])]
		const parked = makeDeps(parkedLlm)
		parked.parkTracker.queueTracked = true
		await runRoleCard(parked.deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })
		const checkpoint = parked.checkpoints[parked.checkpoints.length - 1]
		if (checkpoint === undefined) throw new Error('expected a parked checkpoint')

		const resumeLlm = new FakeLlm()
		resumeLlm.responses = [success([finishCall({ status: 'success', summary: 'built it' })])]
		const resumed = makeDeps(resumeLlm)
		resumed.parkTracker.parkedAsk = checkpoint.parkedAsk

		await expect(resumeRoleStack(runRole, resumed.deps, guild, checkpoint, { parkedAnswer: { question: 'Which database?', answer: 'postgres', toolCallId: 'other_call' } })).rejects.toThrow('no tool result for parked call other_call')
	})

	test('a re-park after an answer records the new tool call id', async () => {
		const guild = buildParkGuild({ main: { systemPrompt: 'p', tools: ['ask_human', 'finish'] } }, 'main')
		const parkedLlm = new FakeLlm()
		parkedLlm.responses = [success([askCall('Which database?')])]
		const parked = makeDeps(parkedLlm)
		parked.parkTracker.queueTracked = true
		await runRoleCard(parked.deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })
		const checkpoint = parked.checkpoints[parked.checkpoints.length - 1]
		if (checkpoint === undefined) throw new Error('expected a parked checkpoint')

		const reParkLlm = new FakeLlm()
		reParkLlm.responses = [success([{ id: 'ask_2', type: 'function', function: { name: 'ask_human', arguments: JSON.stringify({ question: 'And the port?' }) } }])]
		const resumed = makeDeps(reParkLlm)
		resumed.parkTracker.queueTracked = true
		resumed.parkTracker.parkedAsk = checkpoint.parkedAsk

		const card = await resumeRoleStackCard(runRole, resumed.deps, guild, checkpoint, { parkedAnswer: { question: 'Which database?', answer: 'postgres', toolCallId: 'ask_1' } })

		expect(card.status).toBe('needs_clarification')
		const reParked = resumed.checkpoints.find((candidate) => candidate.parkedAsk?.toolCallId === 'ask_2')
		expect(reParked?.parkedAsk).toMatchObject({ roleId: 'main-0-1', toolCallId: 'ask_2', callId: 'tool:ask_2', questionId: 'ask_2', question: 'And the port?' })
	})
})

describe('runRole — usage accounting and retry spend', () => {
	const echoManifest: ToolManifest = {
		name: 'echo',
		description: 'Echoes its arguments.',
		parameters: { type: 'object', properties: {} },
	}

	function echoTurnCall(id: string): ToolCall {
		return { id, type: 'function', function: { name: 'echo', arguments: '{}' } }
	}

	// A success the endpoint answered without a usage report: the result carries no usage object at all.
	function successWithoutUsage(toolCalls: ToolCall[]): LlmCallResult {
		return { kind: 'success', content: '', reasoning: null, toolCalls }
	}

	function usagePayloadOf(event: LogEvent): { promptTokens: number; completionTokens: number; totalTokens: number; cachedPromptTokens?: number } {
		const usage = payloadField(event, 'usage')
		if (!isUsageTotals(usage)) throw new Error('expected the event to carry usage totals')
		return usage
	}

	test('a success without endpoint-reported usage omits the llm_call usage field and updates no accumulator', async () => {
		const guild = withTool(buildGuild({ main: { systemPrompt: 'p', tools: ['echo', 'finish'] } }, 'main'), echoManifest)
		const llm = new FakeLlm()
		llm.responses = [
			success([echoTurnCall('e1')]),
			successWithoutUsage([echoTurnCall('e2')]),
			success([finishCall({ status: 'success', summary: 'done' })]),
		]
		const { deps, events, checkpoints } = makeDeps(llm)
		const depsWithEcho: EngineDependencies = { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { echo: echoHandler }) }

		const result = await runRoleCard(depsWithEcho, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		expect(result).toEqual({ status: 'success', summary: 'done' })
		const llmCalls = events.filter((e) => e.type === 'llm_call')
		expect(llmCalls.length).toBe(3)
		// The reported turn carries its usage; the unreported turn's event has no usage field at all.
		expect(usagePayloadOf(defined(llmCalls[0], 'first llm_call'))).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 })
		const unreported = defined(llmCalls[1], 'second llm_call')
		expect(payloadField(unreported, 'usage')).toBeUndefined()
		// The unreported turn neither reset lastPromptTokens to 0 nor added tokens: the checkpoint at the third loop top still shows the first turn's reported values.
		const thirdLoopTop = defined(checkpoints[2], 'checkpoint at the third loop top')
		const roleState = defined(thirdLoopTop.frames[0], 'entry frame').roleState
		expect(roleState.lastPromptTokens).toBe(10)
		expect(roleState.generatedTokens).toBe(5)
	})

	test('a reported zero-valued usage is real endpoint data: the llm_call carries it and the accumulators record it', async () => {
		const guild = withTool(buildGuild({ main: { systemPrompt: 'p', tools: ['echo', 'finish'] } }, 'main'), echoManifest)
		const llm = new FakeLlm()
		llm.responses = [
			success([echoTurnCall('e1')], { promptTokens: 0, completionTokens: 7 }),
			success([finishCall({ status: 'success', summary: 'done' })]),
		]
		const { deps, events, checkpoints } = makeDeps(llm)
		const depsWithEcho: EngineDependencies = { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { echo: echoHandler }) }

		await runRoleCard(depsWithEcho, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		const firstCall = defined(events.find((e) => e.type === 'llm_call'), 'first llm_call')
		expect(usagePayloadOf(firstCall)).toEqual({ promptTokens: 0, completionTokens: 7, totalTokens: 7 })
		// A real 0 must still be recorded as 0, and the reported completions still accumulate.
		const stateAfterZeroUsage = defined(checkpoints.map((checkpoint) => checkpoint.frames[0]?.roleState).find((state) => state?.generatedTokens === 7), 'checkpoint after the zero-usage turn')
		expect(stateAfterZeroUsage.lastPromptTokens).toBe(0)
		expect(stateAfterZeroUsage.generatedTokens).toBe(7)
	})

	test('a success carrying discarded retry spend emits llm_retry ahead of the llm_call, whose usage stays the final attempt\u2019s', async () => {
		const guild = buildGuild({ main: { systemPrompt: 'p', tools: ['finish'] } }, 'main')
		const llm = new FakeLlm()
		const retriedSuccess: LlmCallResult = {
			kind: 'success',
			content: '',
			reasoning: null,
			toolCalls: [finishCall({ status: 'success', summary: 'done' })],
			usage: { promptTokens: 110, completionTokens: 3 },
			discardedRetrySpend: { attempts: 2, usage: { promptTokens: 220, completionTokens: 4, cachedPromptTokens: 80 } },
			finishReason: 'tool_calls',
		}
		llm.responses = [retriedSuccess]
		const { deps, events } = makeDeps(llm)

		await runRoleCard(deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		const retryEvents = events.filter((e) => e.type === 'llm_retry')
		expect(retryEvents.length).toBe(1)
		const retryEvent = defined(retryEvents[0], 'llm_retry event')
		expect(payloadField(retryEvent, 'role')).toBe('main')
		expect(payloadField(retryEvent, 'roleId')).toBe('main-0-1')
		expect(payloadField(retryEvent, 'discardedAttempts')).toBe(2)
		expect(usagePayloadOf(retryEvent)).toEqual({ promptTokens: 220, completionTokens: 4, totalTokens: 224, cachedPromptTokens: 80 })
		// The llm_call follows the retry event and carries only the final attempt's usage: pressure and context semantics must keep reflecting the live conversation size, with retry spend as separate bookkeeping.
		const llmCallEvent = defined(events.find((e) => e.type === 'llm_call'), 'llm_call event')
		expect(events.indexOf(retryEvent)).toBeLessThan(events.indexOf(llmCallEvent))
		expect(usagePayloadOf(llmCallEvent)).toEqual({ promptTokens: 110, completionTokens: 3, totalTokens: 113 })
	})

	test('a clean success emits no llm_retry', async () => {
		const guild = buildGuild({ main: { systemPrompt: 'p', tools: ['finish'] } }, 'main')
		const llm = new FakeLlm()
		llm.responses = [success([finishCall({ status: 'success', summary: 'done' })])]
		const { deps, events } = makeDeps(llm)

		await runRoleCard(deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		expect(events.some((e) => e.type === 'llm_retry')).toBe(false)
	})

	test('a retry spend with no reported usage emits llm_retry without a usage field', async () => {
		const guild = buildGuild({ main: { systemPrompt: 'p', tools: ['finish'] } }, 'main')
		const llm = new FakeLlm()
		const retriedSuccess: LlmCallResult = {
			kind: 'success',
			content: '',
			reasoning: null,
			toolCalls: [finishCall({ status: 'success', summary: 'done' })],
			usage: { promptTokens: 110, completionTokens: 3 },
			// No discarded attempt reported usage, so the retry spend carries the count only.
			discardedRetrySpend: { attempts: 2 },
			finishReason: 'tool_calls',
		}
		llm.responses = [retriedSuccess]
		const { deps, events } = makeDeps(llm)

		await runRoleCard(deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		const retryEvent = defined(events.find((e) => e.type === 'llm_retry'), 'llm_retry event')
		expect(payloadField(retryEvent, 'discardedAttempts')).toBe(2)
		expect(payloadField(retryEvent, 'usage')).toBeUndefined()
	})

	test('through the real caller, a degenerate first stream retried into a success emits llm_retry with the discarded spend', async () => {
		const guild = buildGuild({ main: { systemPrompt: 'p', tools: ['finish'] } }, 'main')
		const wire = new FakeWire()
		wire.responses = [
			// The first attempt completes with usage but an empty response, so the caller discards and retries it.
			streamOf([new TextEncoder().encode(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 100, output_tokens: 0 } } })}\n\n`)]),
			streamOf(sseChunks([{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }])),
		]
		const caller = createLlmCaller(baseModel, undefined, { llmFetch: wire.llmFetch, sleep: () => Promise.resolve(), scheduleTimeout: () => () => undefined, random: () => 1, now: () => 0 })
		const { deps, events } = makeDeps(caller)

		const result = await runRoleCard(deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		expect(result.status).toBe('success')
		expect(wire.requests.length).toBe(2)
		const retryEvent = defined(events.find((e) => e.type === 'llm_retry'), 'llm_retry event')
		expect(payloadField(retryEvent, 'role')).toBe('main')
		expect(payloadField(retryEvent, 'discardedAttempts')).toBe(1)
		expect(usagePayloadOf(retryEvent)).toEqual({ promptTokens: 100, completionTokens: 0, totalTokens: 100 })
		// The final attempt's usage is the sseChunks terminal's reported 10/5 — the retry's 100 prompt tokens never inflate it.
		const llmCallEvent = defined(events.find((e) => e.type === 'llm_call'), 'llm_call event')
		expect(usagePayloadOf(llmCallEvent)).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 })
	})
})

describe('runRole — continue_agent', () => {
	test('continues a finished child as a new instance seeded with the appended comment', async () => {
		const guild = continueAgentGuild()
		const llm = new FakeLlm()
		llm.responses = [
			success([agentCall('child', 'subtask')]),
			success([finishCall({ status: 'success', summary: 'child done' })]),
			success([continueAgentCall('child', 'keep going')]),
			success([finishCall({ status: 'success', summary: 'child continued' })]),
			success([finishCall({ status: 'success', summary: 'parent done' })]),
		]
		const { deps, events } = makeDeps(llm)

		const result = await runRoleCard(deps, { loadedGuild: guild, depth: 0, roleName: 'parent', task: 'delegate' })

		expect(result).toEqual({ status: 'success', summary: 'parent done' })
		expect(llm.calls.length).toBe(5)

		// A new child instance with a fresh id, whose role_start names the instance it continues.
		const childStarts = events.filter((e) => e.type === 'role_start' && payloadField(e, 'role') === 'child')
		expect(childStarts.length).toBe(2)
		const firstChildStart = defined(childStarts[0], 'first child role_start')
		const secondChildStart = defined(childStarts[1], 'second child role_start')
		const firstChildId = payloadField(firstChildStart, 'roleId')
		const secondChildId = payloadField(secondChildStart, 'roleId')
		expect(typeof firstChildId).toBe('string')
		expect(typeof secondChildId).toBe('string')
		expect(secondChildId).not.toBe(firstChildId)
		expect(payloadField(secondChildStart, 'continuedFrom')).toBe(firstChildId)

		// The continued instance's first request begins with the finished child's full history plus the comment.
		const continuedCall = defined(llm.calls[3], 'continued child call')
		expect(continuedCall.messages.length).toBe(5)
		expect(continuedCall.messages[0]?.role).toBe('system')
		expect(continuedCall.messages[1]).toEqual({ role: 'user', content: 'subtask' })
		expect(continuedCall.messages[2]?.role).toBe('assistant')
		expect(continuedCall.messages[3]?.role).toBe('tool')
		expect(continuedCall.messages[4]).toEqual({ role: 'user', content: 'keep going' })

		// The parent receives the continued child's new card.
		const continueResult = events.find((e) => e.type === 'tool_result' && payloadField(e, 'tool') === 'continue_agent')
		const continueEvent = defined(continueResult, 'continue_agent tool_result event')
		expect(payloadField(continueEvent, 'result')).toEqual({ kind: 'success', data: { status: 'success', summary: 'child continued' } })
	})

	test('without a comment the seed truncates the finished child terminal finish block', async () => {
		const guild = continueAgentGuild()
		const llm = new FakeLlm()
		llm.responses = [
			success([agentCall('child', 'subtask')]),
			success([finishCall({ status: 'success', summary: 'child done' })]),
			success([continueAgentCall('child')]),
			success([finishCall({ status: 'success', summary: 'child continued' })]),
			success([finishCall({ status: 'success', summary: 'parent done' })]),
		]
		const { deps } = makeDeps(llm)

		const result = await runRoleCard(deps, { loadedGuild: guild, depth: 0, roleName: 'parent', task: 'delegate' })

		expect(result).toEqual({ status: 'success', summary: 'parent done' })
		const continuedCall = defined(llm.calls[3], 'continued child call')
		expect(continuedCall.messages).toEqual([
			{ role: 'system', content: 'prompt for child' },
			{ role: 'user', content: 'subtask' },
		])
	})

	test('returns an error card when no finished child matches', async () => {
		const guild = continueAgentGuild()
		const llm = new FakeLlm()
		llm.responses = [
			success([continueAgentCall('child', 'go')]),
			success([finishCall({ status: 'success', summary: 'parent done' })]),
		]
		const { deps, events } = makeDeps(llm)

		const result = await runRoleCard(deps, { loadedGuild: guild, depth: 0, roleName: 'parent', task: 'delegate' })

		expect(result).toEqual({ status: 'success', summary: 'parent done' })
		const card = continueAgentCard(events)
		expect(card.status).toBe('error')
		expect(card.error?.kind).toBe('invalid_arguments')
	})

	test('returns an error card for a finished child that belongs to a different parent', async () => {
		const guild = continueAgentGuild()
		const llm = new FakeLlm()
		llm.responses = [
			success([continueAgentCall('child', undefined, 'child-1-2')]),
			success([finishCall({ status: 'success', summary: 'parent done' })]),
		]
		const { deps, events, roleSnapshots } = makeDeps(llm)
		roleSnapshots.write({ roleId: 'child-1-2', roleName: 'child', depth: 1, task: 'subtask', parentRoleId: 'other-0-9', finishedAt: '2026-01-01T00:00:00.000Z', history: [] })

		const result = await runRoleCard(deps, { loadedGuild: guild, depth: 0, roleName: 'parent', task: 'delegate' })

		expect(result).toEqual({ status: 'success', summary: 'parent done' })
		expect(continueAgentCard(events).status).toBe('error')
	})

	test('returns an error card for an unknown instance id of the parent own child', async () => {
		const guild = continueAgentGuild()
		const llm = new FakeLlm()
		llm.responses = [
			success([continueAgentCall('child', undefined, 'child-9-9')]),
			success([finishCall({ status: 'success', summary: 'parent done' })]),
		]
		const { deps, events, roleSnapshots } = makeDeps(llm)
		roleSnapshots.write({ roleId: 'child-1-2', roleName: 'child', depth: 1, task: 'subtask', parentRoleId: 'parent-0-1', finishedAt: '2026-01-01T00:00:00.000Z', history: [] })

		const result = await runRoleCard(deps, { loadedGuild: guild, depth: 0, roleName: 'parent', task: 'delegate' })

		expect(result).toEqual({ status: 'success', summary: 'parent done' })
		expect(continueAgentCard(events).status).toBe('error')
	})

	// Drives a full parent→child→continue→child descent: the parent delegates, the child finishes (storing its snapshot), the parent continues it with a comment, the continued child finishes, and the parent finishes. Returns the final card plus every checkpoint written.
	async function driveContinueRun(): Promise<{ card: ResultCard; checkpoints: RunCheckpoint[] }> {
		const guild = continueAgentGuild()
		const llm = new FakeLlm()
		llm.responses = [
			success([agentCall('child', 'subtask')]),
			success([finishCall({ status: 'success', summary: 'child done' })]),
			success([continueAgentCall('child', 'keep going')]),
			success([finishCall({ status: 'success', summary: 'child continued' })]),
			success([finishCall({ status: 'success', summary: 'parent done' })]),
		]
		const { deps, checkpoints } = makeDeps(llm)
		const card = await runRoleCard(deps, { loadedGuild: guild, depth: 0, roleName: 'parent', task: 'delegate' })
		return { card, checkpoints }
	}

	// Finds the first checkpoint holding a pending suspension on the named tool, either while its child still runs (no recorded card) or after the child returned (recorded card).
	function findPendingCheckpoint(checkpoints: RunCheckpoint[], tool: string, hasCard: boolean): RunCheckpoint {
		const match = checkpoints.find((checkpoint) => {
			if (!hasCard && checkpoint.frames.length < 2) return false
			return checkpoint.frames.some((frame) => {
				const pending = frame.pending
				if (pending === undefined) return false
				if (pending.toolCalls[pending.index]?.function.name !== tool) return false
				return hasCard ? pending.childCard !== undefined : pending.childCard === undefined
			})
		})
		if (match === undefined) throw new Error(`no checkpoint pending on ${tool} with hasCard=${hasCard}`)
		return match
	}

	test('a suspended continue_agent turn is accepted by the guard and resumes from the recorded child card without re-running the child', async () => {
		const { checkpoints } = await driveContinueRun()

		// While the continued child runs the parent is the non-leaf frame suspended on the continue_agent call, with no recorded card.
		const whileRunning = findPendingCheckpoint(checkpoints, 'continue_agent', false)
		expect(whileRunning.frames.length).toBe(2)
		expect(whileRunning.frames[0]?.roleName).toBe('parent')
		expect(whileRunning.frames[1]?.roleName).toBe('child')
		expect(isRunCheckpoint(whileRunning)).toBe(true)

		// Once the continued child returns the parent is the leaf frame and its pending carries the recorded card.
		const withCard = findPendingCheckpoint(checkpoints, 'continue_agent', true)
		expect(withCard.frames.length).toBe(1)
		expect(withCard.frames[0]?.pending?.childCard).toEqual({ status: 'success', summary: 'child continued' })
		expect(isRunCheckpoint(withCard)).toBe(true)

		const guild = continueAgentGuild()
		const llm = new FakeLlm()
		llm.responses = [success([finishCall({ status: 'success', summary: 'parent done' })])]
		const { deps, events } = makeDeps(llm)

		const card = await resumeRoleStackCard(runRole, deps, guild, withCard)

		expect(card).toEqual({ status: 'success', summary: 'parent done' })
		// One turn only: the parent's follow-up. The finished continued child is not re-run.
		expect(llm.calls.length).toBe(1)
		const continueResult = events.find((event) => event.type === 'tool_result' && payloadField(event, 'tool') === 'continue_agent')
		const continueEvent = defined(continueResult, 'continue_agent tool_result event')
		expect(payloadField(continueEvent, 'result')).toEqual({ kind: 'success', data: { status: 'success', summary: 'child continued' } })
	})

	test('the continued instance starts with fresh RoleState counters even though its history is seeded', async () => {
		const { checkpoints } = await driveContinueRun()
		const whileRunning = findPendingCheckpoint(checkpoints, 'continue_agent', false)
		const continuedLeaf = whileRunning.frames[1]
		if (continuedLeaf === undefined) throw new Error('missing continued child frame')

		// The seed carries the finished child's full conversation plus the appended comment.
		expect(continuedLeaf.roleState.history.length).toBe(5)
		// Every accumulator starts fresh: only the history is inherited.
		expect(continuedLeaf.roleState.toolCallCount).toBe(0)
		expect(continuedLeaf.roleState.generatedTokens).toBe(0)
		expect(continuedLeaf.roleState.contextExceededAttempts).toBe(0)
		expect(continuedLeaf.roleState.loopCheckToolCallWatermark).toBe(0)
		expect(continuedLeaf.roleState.loopCheckTokenWatermark).toBe(0)
		expect(continuedLeaf.roleState.recentToolCalls).toEqual([])
		expect(continuedLeaf.roleState.logSentBaseline).toBeUndefined()
	})

	test('snapshots only non-entry, non-handler children', async () => {
		const guild = continueAgentGuild()
		const llm = new FakeLlm()
		llm.responses = [
			success([agentCall('child', 'subtask')]),
			success([finishCall({ status: 'success', summary: 'child done' })]),
			success([finishCall({ status: 'success', summary: 'parent done' })]),
		]
		const { deps, roleSnapshots } = makeDeps(llm)

		await runRoleCard(deps, { loadedGuild: guild, depth: 0, roleName: 'parent', task: 'delegate' })

		// The entry role (parent) has no parent to continue it, so only the child is stored.
		const summaries = roleSnapshots.list()
		expect(summaries.length).toBe(1)
		expect(summaries[0]?.roleName).toBe('child')
		expect(summaries[0]?.parentRoleId).toBeDefined()
	})

	test('a handler invocation is not snapshotted even when it has a parent', async () => {
		const guild = continueAgentGuild()
		const llm = new FakeLlm()
		llm.responses = [success([finishCall({ status: 'success', summary: 'handler done' })])]
		const { deps, roleSnapshots } = makeDeps(llm)

		await runRoleCard(deps, {
			loadedGuild: guild,
			depth: 1,
			roleName: 'child',
			task: 'inspect',
			parent: 'parent',
			parentRoleId: 'parent-0-1',
			handlerOf: 'child-1-1',
		})

		expect(roleSnapshots.list()).toEqual([])
	})
})

describe('durable pending invocation reconciliation', () => {
	const echoManifest: ToolManifest = {
		name: 'echo',
		description: 'Echoes its arguments.',
		parameters: { type: 'object', properties: {} },
	}

	const pendingAskManifest: ToolManifest = {
		name: 'ask_human',
		description: 'Ask a human a question.',
		parameters: { type: 'object', required: ['question'], properties: { question: { type: 'string' } } },
	}

	function echoCall(id: string): ToolCall {
		return { id, type: 'function', function: { name: 'echo', arguments: '{"value":7}' } }
	}

	function askCall(id: string, question: string): ToolCall {
		return { id, type: 'function', function: { name: 'ask_human', arguments: JSON.stringify({ question }) } }
	}

	function buildPendingGuild(tools: string[]): LoadedGuild {
		const guild = buildGuild({ main: { systemPrompt: 'p', tools } }, 'main')
		return withTool(withTool(guild, echoManifest), pendingAskManifest)
	}

	function pendingCheckpoint(toolCall: ToolCall): RunCheckpoint {
		return {
			version: 2,
			runId: 'test-run',
			startTime: '2026-01-01T00:00:00.000Z',
			registryCounter: 1,
			frames: [{
				roleId: 'main-0-1',
				roleName: 'main',
				depth: 0,
				task: 'do it',
				roleState: createEmptyRoleState({
					history: [
						{ role: 'system', content: 'prompt' },
						{ role: 'user', content: 'do it' },
						{ role: 'assistant', content: '', tool_calls: [toolCall] },
					],
				}),
				pending: { callId: `tool:${toolCall.id}`, parentCallId: 'role:main-0-1', toolCalls: [toolCall], index: 0 },
			}],
		}
	}

	function startEvent(callId: string, tool: string): LogEvent {
		return { timestamp: 't1', type: 'tool_call', payload: { role: 'main', tool, arguments: '{"value":7}', callId, parentCallId: 'role:main-0-1' } }
	}

	function terminalEvent(callId: string, tool: string, result?: ToolResult): LogEvent {
		return { timestamp: 't2', type: 'tool_result', payload: { role: 'main', tool, kind: 'success', callId, ...(result !== undefined ? { result } : {}) } }
	}

	test('a live ordinary tool records a pending invocation with its identity before dispatch', async () => {
		const guild = buildPendingGuild(['echo', 'finish'])
		const llm = new FakeLlm()
		llm.responses = [success([echoCall('e1')]), success([finishCall({ status: 'success', summary: 'done' })])]
		const { deps, checkpoints } = makeDeps(llm)
		const depsWithEcho: EngineDependencies = { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { echo: echoHandler }) }

		await runRoleCard(depsWithEcho, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		const pendingRecord = checkpoints
			.flatMap((checkpoint) => checkpoint.frames)
			.map((frame) => frame.pending)
			.find((pending) => pending !== undefined && 'index' in pending && pending.callId === 'tool:e1')
		expect(pendingRecord).toEqual({
			callId: 'tool:e1',
			parentCallId: 'role:main-0-1',
			toolCalls: [echoCall('e1')],
			index: 0,
		})
	})

	test('a crash after the start but before the terminal replays the call, writes one terminal, and appends one result', async () => {
		const guild = buildPendingGuild(['echo', 'finish'])
		const checkpoint = pendingCheckpoint(echoCall('e1'))
		const llm = new FakeLlm()
		llm.responses = [success([finishCall({ status: 'success', summary: 'done' })])]
		const { deps, events } = makeDeps(llm)
		events.push(startEvent('tool:e1', 'echo'))
		let echoCalls = 0
		const depsWithEcho: EngineDependencies = {
			...deps,
			toolPlatform: withExtraHandlers(deps.toolPlatform, {
				echo: () => {
					echoCalls += 1
					return { kind: 'success', data: { value: 7 } }
				},
			}),
		}

		const card = await resumeRoleStackCard(runRole, depsWithEcho, guild, checkpoint)

		expect(card).toEqual({ status: 'success', summary: 'done' })
		expect(echoCalls).toBe(1)
		expect(events.filter((event) => event.type === 'tool_call' && payloadField(event, 'callId') === 'tool:e1').length).toBe(1)
		expect(events.filter((event) => event.type === 'tool_result' && payloadField(event, 'callId') === 'tool:e1').length).toBe(1)
		const frame = defined(checkpoint.frames[0], 'restored frame')
		expect(frame.roleState.history.filter((message) => message.role === 'tool' && message.tool_call_id === 'e1').length).toBe(1)
	})

	test('a crash after the terminal but before the clear appends the recorded result once without re-dispatching', async () => {
		const guild = buildPendingGuild(['echo', 'finish'])
		const checkpoint = pendingCheckpoint(echoCall('e1'))
		const llm = new FakeLlm()
		llm.responses = [success([finishCall({ status: 'success', summary: 'done' })])]
		const { deps, events } = makeDeps(llm)
		events.push(startEvent('tool:e1', 'echo'), terminalEvent('tool:e1', 'echo', { kind: 'success', data: { value: 7 } }))
		let echoCalls = 0
		const depsWithEcho: EngineDependencies = {
			...deps,
			toolPlatform: withExtraHandlers(deps.toolPlatform, {
				echo: () => {
					echoCalls += 1
					return { kind: 'success', data: { value: 7 } }
				},
			}),
		}

		const card = await resumeRoleStackCard(runRole, depsWithEcho, guild, checkpoint)

		expect(card).toEqual({ status: 'success', summary: 'done' })
		expect(echoCalls).toBe(0)
		expect(events.filter((event) => event.type === 'tool_result' && payloadField(event, 'callId') === 'tool:e1').length).toBe(1)
		const frame = defined(checkpoint.frames[0], 'restored frame')
		const toolMessage = frame.roleState.history.find((message) => message.role === 'tool' && message.tool_call_id === 'e1')
		expect(toolMessage?.content).toBe('{"value":7}')
	})

	test('under standard logging an existing terminal without its body restores a clear placeholder', async () => {
		const guild = buildPendingGuild(['echo', 'finish'])
		const checkpoint = pendingCheckpoint(echoCall('e1'))
		const llm = new FakeLlm()
		llm.responses = [success([finishCall({ status: 'success', summary: 'done' })])]
		const { deps, events } = makeDeps(llm)
		events.push(startEvent('tool:e1', 'echo'), terminalEvent('tool:e1', 'echo'))
		const depsWithEcho: EngineDependencies = { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { echo: echoHandler }) }

		await resumeRoleStackCard(runRole, depsWithEcho, guild, checkpoint)

		const frame = defined(checkpoint.frames[0], 'restored frame')
		const toolMessage = frame.roleState.history.find((message) => message.role === 'tool' && message.tool_call_id === 'e1')
		expect(toolMessage?.content).toContain('not retained at standard logging')
	})

	test('a pending ask with a durable human_answer restores the pair without re-asking or duplicating the terminal', async () => {
		const guild = buildPendingGuild(['ask_human', 'finish'])
		const checkpoint = pendingCheckpoint(askCall('ask_1', 'which?'))
		const llm = new FakeLlm()
		llm.responses = [success([finishCall({ status: 'success', summary: 'done' })])]
		const { deps, events } = makeDeps(llm)
		const human = recordingHumanBackend()
		events.push(
			{ timestamp: 't1', type: 'ask_human', payload: { id: 'ask_1', callId: 'tool:ask_1', parentCallId: 'role:main-0-1', question: 'which?' } },
			{ timestamp: 't2', type: 'human_answer', payload: { id: 'ask_1', callId: 'tool:ask_1', question: 'which?', answer: 'this one' } },
		)

		const card = await resumeRoleStackCard(runRole, { ...deps, humanBackend: human }, guild, checkpoint)

		expect(card).toEqual({ status: 'success', summary: 'done' })
		expect(human.questions).toEqual([])
		expect(events.filter((event) => event.type === 'human_answer').length).toBe(1)
		const frame = defined(checkpoint.frames[0], 'restored frame')
		const toolMessage = frame.roleState.history.find((message) => message.role === 'tool' && message.tool_call_id === 'ask_1')
		expect(toolMessage?.content).toBe('{"question":"which?","answer":"this one"}')
		expect(frame.roleState.history.some((message) => message.role === 'assistant')).toBe(true)
	})

	test('a pending ask without a human_answer re-asks and appends the new answer', async () => {
		const guild = buildPendingGuild(['ask_human', 'finish'])
		const checkpoint = pendingCheckpoint(askCall('ask_1', 'which?'))
		const llm = new FakeLlm()
		llm.responses = [success([finishCall({ status: 'success', summary: 'done' })])]
		const { deps } = makeDeps(llm)
		const human = recordingHumanBackend()

		const card = await resumeRoleStackCard(runRole, { ...deps, humanBackend: human }, guild, checkpoint)

		expect(card).toEqual({ status: 'success', summary: 'done' })
		expect(human.questions).toEqual([{ question: 'which?', context: undefined }])
		const frame = defined(checkpoint.frames[0], 'restored frame')
		const toolMessage = frame.roleState.history.find((message) => message.role === 'tool' && message.tool_call_id === 'ask_1')
		expect(toolMessage?.content).toContain('use your best judgement')
	})

	test('invalid and unknown tools still emit only their diagnostics and no invocation lifecycle', async () => {
		const guild = withTool(buildGuild({ main: { systemPrompt: 'p', tools: ['finish'] } }, 'main'), {
			name: 'read_file',
			description: 'Read a file.',
			parameters: { type: 'object', properties: { path: { type: 'string' } } },
		})
		const llm = new FakeLlm()
		llm.responses = [
			success([
				{ id: 'bad_allowed', type: 'function', function: { name: 'read_file', arguments: '{}' } },
				{ id: 'bad_unknown', type: 'function', function: { name: 'missing_tool', arguments: '{}' } },
			]),
			success([finishCall({ status: 'success', summary: 'done' })]),
		]
		const { deps, events, checkpoints } = makeDeps(llm)

		await runRoleCard(deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		expect(events.some((event) => event.type === 'invalid_tool_call')).toBe(true)
		expect(events.some((event) => event.type === 'unknown_tool')).toBe(true)
		expect(events.some((event) => event.type === 'tool_call' && payloadField(event, 'callId') === 'tool:bad_allowed')).toBe(false)
		expect(events.some((event) => event.type === 'tool_call' && payloadField(event, 'callId') === 'tool:bad_unknown')).toBe(false)
		const invokedInvalid = checkpoints.some((checkpoint) => checkpoint.frames.some((frame) => frame.pending !== undefined && frame.pending.toolCalls[frame.pending.index]?.id.startsWith('bad_')))
		expect(invokedInvalid).toBe(false)
	})

	test('a two-call turn that crashed after call 1 resumes without an incomplete turn and with one result per call', async () => {
		const guild = buildPendingGuild(['echo', 'finish'])
		const calls = [echoCall('e1'), echoCall('e2')]
		const checkpoint: RunCheckpoint = {
			version: 2,
			runId: 'test-run',
			startTime: '2026-01-01T00:00:00.000Z',
			registryCounter: 1,
			frames: [{
				roleId: 'main-0-1',
				roleName: 'main',
				depth: 0,
				task: 'do it',
				roleState: createEmptyRoleState({
					history: [
						{ role: 'system', content: 'prompt' },
						{ role: 'user', content: 'do it' },
						{ role: 'assistant', content: '', tool_calls: calls },
						{ role: 'tool', content: '{"value":7}', tool_call_id: 'e1' },
					],
				}),
				pending: { callId: 'tool:e2', parentCallId: 'role:main-0-1', toolCalls: calls, index: 1 },
			}],
		}
		const llm = new FakeLlm()
		llm.responses = [success([finishCall({ status: 'success', summary: 'done' })])]
		const { deps, events } = makeDeps(llm)
		events.push(startEvent('tool:e1', 'echo'), terminalEvent('tool:e1', 'echo', { kind: 'success', data: { value: 7 } }), startEvent('tool:e2', 'echo'))
		let echoCalls = 0
		const depsWithEcho: EngineDependencies = {
			...deps,
			toolPlatform: withExtraHandlers(deps.toolPlatform, {
				echo: () => {
					echoCalls += 1
					return { kind: 'success', data: { value: 7 } }
				},
			}),
		}

		const card = await resumeRoleStackCard(runRole, depsWithEcho, guild, checkpoint)

		expect(card).toEqual({ status: 'success', summary: 'done' })
		expect(echoCalls).toBe(1)
		expect(events.filter((event) => event.type === 'tool_result' && payloadField(event, 'callId') === 'tool:e1').length).toBe(1)
		expect(events.filter((event) => event.type === 'tool_result' && payloadField(event, 'callId') === 'tool:e2').length).toBe(1)
		const frame = defined(checkpoint.frames[0], 'restored frame')
		expect(frame.roleState.history.filter((message) => message.role === 'tool' && message.tool_call_id === 'e1').length).toBe(1)
		expect(frame.roleState.history.filter((message) => message.role === 'tool' && message.tool_call_id === 'e2').length).toBe(1)
		const firstRequest = defined(llm.calls[0], 'first post-resume request')
		const answerIds = new Set(firstRequest.messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id))
		expect(answerIds.has('e1')).toBe(true)
		expect(answerIds.has('e2')).toBe(true)
	})

	test('a multi-call error-resume note lands after every remaining tool result', async () => {
		const guild = buildPendingGuild(['echo', 'finish'])
		const calls = [echoCall('e1'), echoCall('e2'), echoCall('e3')]
		const checkpoint: RunCheckpoint = {
			version: 2,
			runId: 'test-run',
			startTime: '2026-01-01T00:00:00.000Z',
			registryCounter: 1,
			frames: [{
				roleId: 'main-0-1',
				roleName: 'main',
				depth: 0,
				task: 'do it',
				roleState: createEmptyRoleState({
					history: [
						{ role: 'system', content: 'prompt' },
						{ role: 'user', content: 'do it' },
						{ role: 'assistant', content: '', tool_calls: calls },
						{ role: 'tool', content: '{"value":7}', tool_call_id: 'e1' },
					],
				}),
				pending: { callId: 'tool:e2', parentCallId: 'role:main-0-1', toolCalls: calls, index: 1 },
			}],
		}
		const llm = new FakeLlm()
		llm.responses = [success([finishCall({ status: 'success', summary: 'done' })])]
		const { deps, events } = makeDeps(llm)
		events.push(startEvent('tool:e1', 'echo'), terminalEvent('tool:e1', 'echo', { kind: 'success', data: { value: 7 } }), startEvent('tool:e2', 'echo'), terminalEvent('tool:e2', 'echo', { kind: 'success', data: { value: 7 } }))
		const depsWithEcho: EngineDependencies = { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { echo: echoHandler }) }

		await resumeRoleStackCard(runRole, depsWithEcho, guild, checkpoint, { resumeNote: 'carry on after restart' })

		const frame = defined(checkpoint.frames[0], 'restored frame')
		const history = frame.roleState.history
		const noteIndex = history.findIndex((message) => message.role === 'user' && message.content === 'carry on after restart')
		const e3Index = history.findIndex((message) => message.role === 'tool' && message.tool_call_id === 'e3')
		expect(noteIndex).toBeGreaterThan(e3Index)
	})

	test('an invalid ask emits a visible generic tool lifecycle without an ask_human event', async () => {
		const guild = buildPendingGuild(['ask_human', 'finish'])
		const llm = new FakeLlm()
		llm.responses = [
			success([{ id: 'ask_bad', type: 'function', function: { name: 'ask_human', arguments: '{}' } }]),
			success([finishCall({ status: 'success', summary: 'done' })]),
		]
		const { deps, events } = makeDeps(llm)

		const card = await runRoleCard(deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		expect(card).toEqual({ status: 'success', summary: 'done' })
		expect(events.some((event) => event.type === 'ask_human')).toBe(false)
		expect(events.filter((event) => event.type === 'tool_call' && payloadField(event, 'callId') === 'tool:ask_bad').length).toBe(1)
		const terminal = events.find((event) => event.type === 'tool_result' && payloadField(event, 'callId') === 'tool:ask_bad')
		expect(payloadField(defined(terminal, 'ask terminal'), 'kind')).toBe('invalid_arguments')
	})

	test('a resume whose pending tool was removed from the Guild closes the started invocation with a terminal', async () => {
		const guild = buildGuild({ main: { systemPrompt: 'p', tools: ['finish'] } }, 'main')
		const checkpoint = pendingCheckpoint(echoCall('e1'))
		const llm = new FakeLlm()
		llm.responses = [success([finishCall({ status: 'success', summary: 'done' })])]
		const { deps, events } = makeDeps(llm)
		events.push(startEvent('tool:e1', 'echo'))

		const card = await resumeRoleStackCard(runRole, deps, guild, checkpoint)

		expect(card).toEqual({ status: 'success', summary: 'done' })
		expect(events.some((event) => event.type === 'unknown_tool')).toBe(true)
		const terminal = events.find((event) => event.type === 'tool_result' && payloadField(event, 'callId') === 'tool:e1')
		expect(payloadField(defined(terminal, 'resume terminal'), 'kind')).toBe('unknown_tool')
	})

	test('a standard terminal with neither a result body nor a valid kind fails fast', async () => {
		const guild = buildPendingGuild(['echo', 'finish'])
		const checkpoint = pendingCheckpoint(echoCall('e1'))
		const llm = new FakeLlm()
		llm.responses = [success([finishCall({ status: 'success', summary: 'done' })])]
		const { deps, events } = makeDeps(llm)
		events.push(startEvent('tool:e1', 'echo'), { timestamp: 't2', type: 'tool_result', payload: { role: 'main', tool: 'echo', callId: 'tool:e1' } })

		await expect(resumeRoleStack(runRole, deps, guild, checkpoint)).rejects.toThrow('neither a result body nor a valid kind')
	})

	test('stale handler and interrupt invocations are closed before the role loop re-enters', async () => {
		const guild = buildPendingGuild(['finish'])
		const checkpoint: RunCheckpoint = {
			version: 2,
			runId: 'test-run',
			startTime: '2026-01-01T00:00:00.000Z',
			registryCounter: 2,
			frames: [{
				roleId: 'main-0-1',
				roleName: 'main',
				depth: 0,
				task: 'do it',
				roleState: createEmptyRoleState({ history: [{ role: 'system', content: 'prompt' }, { role: 'user', content: 'do it' }] }),
			}],
		}
		const llm = new FakeLlm()
		llm.responses = [success([finishCall({ status: 'success', summary: 'done' })])]
		const { deps, events } = makeDeps(llm)
		events.push(
			{ timestamp: 't1', type: 'role_start', payload: { role: 'main', roleId: 'main-0-1', callId: 'role:main-0-1', depth: 0 } },
			{ timestamp: 't2', type: 'interrupt', payload: { trigger: 'loop_check', handler: 'detector', target: 'main-0-1', callId: 'interrupt:1', parentCallId: 'role:main-0-1' } },
			{ timestamp: 't3', type: 'role_start', payload: { role: 'detector', roleId: 'detector-1-2', callId: 'role:detector-1-2', depth: 1, parent: 'main' } },
			{ timestamp: 't4', type: 'tool_call', payload: { role: 'detector', tool: 'recent_role_tool_calls', callId: 'tool:handler-1', parentCallId: 'role:detector-1-2' } },
		)

		await resumeRoleStackCard(runRole, deps, guild, checkpoint)

		expect(events.filter((event) => event.type === 'interrupt').length).toBe(1)
		expect(events.filter((event) => event.type === 'interrupt_resolved').length).toBe(1)
		expect(events.filter((event) => event.type === 'role_start' && payloadField(event, 'role') === 'detector').length).toBe(1)
		expect(events.filter((event) => event.type === 'role_finished' && payloadField(event, 'role') === 'detector').length).toBe(1)
		expect(events.filter((event) => event.type === 'tool_result' && payloadField(event, 'callId') === 'tool:handler-1').length).toBe(1)
	})

	test('a handler-delegated child is parented to the handler role call and does not inherit handlerOf', async () => {
		const guild = withTool(
			buildGuild(
				{
					main: { systemPrompt: 'm', tools: ['echo', 'finish'] },
					detector: { systemPrompt: 'd', tools: ['agent', 'finish'] },
					coder: { systemPrompt: 'c', tools: ['finish'] },
				},
				'main',
				{ executor: { ...baseExecutor, interruptTriggers: { handlerRole: 'detector', everyToolCalls: 1, everyTokens: 100000 } } },
			),
			echoManifest,
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([echoCall('e1'), echoCall('e2')]),
			success([agentCall('coder', 'subtask')]),
			success([finishCall({ status: 'success', summary: 'child done' })]),
			success([finishCall({ status: 'success', summary: 'handler done' })]),
			success([finishCall({ status: 'success', summary: 'main done' })]),
		]
		const { deps, events } = makeDeps(llm)
		const depsWithEcho: EngineDependencies = { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { echo: echoHandler }) }

		const card = await runRoleCard(depsWithEcho, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		expect(card.summary).toBe('main done')
		const detectorStart = events.find((event) => event.type === 'role_start' && payloadField(event, 'role') === 'detector')
		const detectorRoleId = payloadField(defined(detectorStart, 'detector start'), 'roleId')
		expect(typeof detectorRoleId).toBe('string')
		const childStart = events.find((event) => event.type === 'role_start' && payloadField(event, 'role') === 'coder')
		expect(payloadField(defined(childStart, 'child start'), 'parentRoleId')).toBe(detectorRoleId)
		expect(payloadField(defined(childStart, 'child start'), 'parentCallId')).toBe(`role:${String(detectorRoleId)}`)
		const childFinish = events.find((event) => event.type === 'role_finished' && payloadField(event, 'role') === 'coder')
		expect(payloadField(defined(childFinish, 'child finish'), 'callId')).toBe(`role:${String(payloadField(defined(childStart, 'child start'), 'roleId'))}`)
	})

	test('an invalid last call clears the pending marker so resume has one result per call', async () => {
		const guild = buildPendingGuild(['echo', 'finish'])
		const llm = new FakeLlm()
		llm.responses = [
			success([echoCall('e1'), { id: 'bad_1', type: 'function', function: { name: 'missing_tool', arguments: '{}' } }]),
			success([finishCall({ status: 'success', summary: 'done' })]),
		]
		const { deps, checkpoints } = makeDeps(llm)
		const depsWithEcho: EngineDependencies = { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { echo: echoHandler }) }

		await runRoleCard(depsWithEcho, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		const checkpoint = checkpoints.find((candidate) => {
			const frame = candidate.frames[0]
			if (frame === undefined || frame.pending !== undefined) return false
			const ids = frame.roleState.history.filter((message) => message.role === 'tool').map((message) => message.tool_call_id)
			return ids.length === 2 && ids[0] === 'e1' && ids[1] === 'bad_1'
		})
		if (checkpoint === undefined) throw new Error('expected the safe-point checkpoint after the invalid last call')

		const resumeLlm = new FakeLlm()
		resumeLlm.responses = [success([finishCall({ status: 'success', summary: 'resumed done' })])]
		const resumed = makeDeps(resumeLlm)
		await resumeRoleStackCard(runRole, { ...resumed.deps, toolPlatform: withExtraHandlers(resumed.deps.toolPlatform, { echo: echoHandler }) }, guild, structuredClone(checkpoint))

		const toolIds = defined(checkpoint.frames[0], 'restored frame').roleState.history.filter((message) => message.role === 'tool').map((message) => message.tool_call_id)
		expect(toolIds).toEqual(['e1', 'bad_1'])
		const diagnosticMessages = defined(checkpoint.frames[0], 'restored frame').roleState.history.filter((message) => message.role === 'tool' && message.tool_call_id === 'bad_1')
		expect(diagnosticMessages.length).toBe(1)
	})

	test('a standard-level pending finish replays its ResultCard from the call arguments and ends the role', async () => {
		const guild = buildPendingGuild(['finish'])
		const card = { status: 'success' as const, summary: 'finished cleanly', artifacts: ['out.txt'] }
		const finish = finishCall(card)
		const checkpoint = pendingCheckpoint(finish)
		const llm = new FakeLlm()
		const { deps, events } = makeDeps(llm)
		events.push(startEvent('tool:finish_1', 'finish'), terminalEvent('tool:finish_1', 'finish'))

		const resumed = await resumeRoleStackCard(runRole, deps, guild, checkpoint)

		expect(resumed).toEqual(card)
		expect(llm.calls.length).toBe(0)
		const frame = defined(checkpoint.frames[0], 'restored frame')
		const finishMessage = frame.roleState.history.find((message) => message.role === 'tool' && message.tool_call_id === 'finish_1')
		expect(finishMessage?.content).toContain('finished cleanly')
	})

	test('a handler-delegated child inherits handlerOf, so a pre-write ask cannot park', async () => {
		const guild = withTool(
			buildGuild(
				{
					main: { systemPrompt: 'm', tools: ['echo', 'finish'] },
					detector: { systemPrompt: 'd', tools: ['agent', 'finish'] },
					coder: { systemPrompt: 'c', tools: ['ask_human', 'finish'] },
				},
				'main',
				{ executor: { ...baseExecutor, interruptTriggers: { handlerRole: 'detector', everyToolCalls: 1, everyTokens: 100000 } } },
			),
			echoManifest,
		)
		const withAsk = withTool(guild, pendingAskManifest)
		const llm = new FakeLlm()
		llm.responses = [
			success([echoCall('e1'), echoCall('e2')]),
			success([agentCall('coder', 'subtask')]),
			success([askCall('ask_child', 'Which database?')]),
			success([finishCall({ status: 'success', summary: 'child done' })]),
			success([finishCall({ status: 'success', summary: 'handler done' })]),
			success([finishCall({ status: 'success', summary: 'main done' })]),
		]
		const { deps } = makeDeps(llm)
		const human = recordingHumanBackend()
		deps.parkTracker.queueTracked = true
		const depsWithEcho: EngineDependencies = { ...deps, humanBackend: human, toolPlatform: withExtraHandlers(deps.toolPlatform, { echo: echoHandler }) }

		const card = await runRoleCard(depsWithEcho, { loadedGuild: withAsk, depth: 0, roleName: 'main', task: 'do it' })

		expect(card.summary).toBe('main done')
		expect(human.questions).toEqual([{ question: 'Which database?', context: undefined }])
		expect(deps.parkTracker.parkedAsk).toBeUndefined()
		expect(deps.parkTracker.parkedQuestion).toBeUndefined()
	})

	test('a no-note reconciliation of a pending finish closes later calls and writes the completed checkpoint', async () => {
		const guild = buildPendingGuild(['echo', 'finish'])
		const calls = [finishCall({ status: 'success', summary: 'already done' }), echoCall('e2')]
		const checkpoint: RunCheckpoint = {
			version: 2,
			runId: 'test-run',
			startTime: '2026-01-01T00:00:00.000Z',
			registryCounter: 1,
			frames: [{
				roleId: 'main-0-1',
				roleName: 'main',
				depth: 0,
				task: 'do it',
				roleState: createEmptyRoleState({
					history: [
						{ role: 'system', content: 'prompt' },
						{ role: 'user', content: 'do it' },
						{ role: 'assistant', content: '', tool_calls: calls },
					],
				}),
				pending: { callId: 'tool:finish_1', parentCallId: 'role:main-0-1', toolCalls: calls, index: 0 },
			}],
		}
		const llm = new FakeLlm()
		const { deps, events, checkpoints } = makeDeps(llm)
		events.push(startEvent('tool:finish_1', 'finish'), { timestamp: 't2', type: 'tool_result', payload: { role: 'main', tool: 'finish', kind: 'success', callId: 'tool:finish_1', result: { kind: 'success', data: { status: 'success', summary: 'already done' } } } })

		const card = await resumeRoleStackCard(runRole, deps, guild, checkpoint)

		expect(card).toEqual({ status: 'success', summary: 'already done' })
		expect(llm.calls.length).toBe(0)
		const frame = defined(checkpoint.frames[0], 'restored frame')
		const toolMessages = frame.roleState.history.filter((message) => message.role === 'tool')
		expect(toolMessages.map((message) => message.tool_call_id)).toEqual(['finish_1', 'e2'])
		expect(toolMessages[1]?.content).toContain('Not executed because an earlier call in the batch ended the role.')
		expect(checkpoints.some((written) => written.frames[0]?.pending === undefined && written.frames[0]?.roleState.history.some((message) => message.role === 'tool' && message.tool_call_id === 'e2'))).toBe(true)
	})

	test('a standard-level invalid finish terminal is a placeholder failure, not a reconstruction attempt', async () => {
		const guild = buildPendingGuild(['finish'])
		const checkpoint = pendingCheckpoint(finishCall({ status: 'success', summary: 'never accepted' }))
		const llm = new FakeLlm()
		llm.responses = [success([finishCall({ status: 'success', summary: 'recovered' })])]
		const { deps, events } = makeDeps(llm)
		events.push(startEvent('tool:finish_1', 'finish'), { timestamp: 't2', type: 'tool_result', payload: { role: 'main', tool: 'finish', kind: 'invalid_arguments', callId: 'tool:finish_1' } })

		const card = await resumeRoleStackCard(runRole, deps, guild, checkpoint)

		expect(card).toEqual({ status: 'success', summary: 'recovered' })
		expect(llm.calls.length).toBe(1)
	})

	test('a child needs_clarification card that does not pause the run is a normal role terminal', async () => {
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
			success([finishCall({ status: 'needs_clarification', summary: 'child needs a decision' })]),
			success([finishCall({ status: 'success', summary: 'parent done' })]),
		]
		const { deps, events } = makeDeps(llm)

		const card = await runRoleCard(deps, { loadedGuild: guild, depth: 0, roleName: 'parent', task: 'do it' })

		expect(card.summary).toBe('parent done')
		const childFinish = events.find((event) => event.type === 'role_finished' && payloadField(event, 'role') === 'child')
		expect(payloadField(defined(childFinish, 'child finish'), 'status')).toBe('needs_clarification')
		expect(payloadField(defined(childFinish, 'child finish'), 'paused')).toBeUndefined()
	})

	test('a handler needs_clarification card closes normally and resolves its interrupt', async () => {
		const guild = buildGuild(
			{
				main: { systemPrompt: 'm', tools: ['echo', 'finish'] },
				detector: { systemPrompt: 'd', tools: ['finish'] },
			},
			'main',
			{ executor: { ...baseExecutor, interruptTriggers: { handlerRole: 'detector', everyToolCalls: 1, everyTokens: 100000 } } },
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([echoCall('e1'), echoCall('e2')]),
			success([finishCall({ status: 'needs_clarification', summary: 'handler uncertain' })]),
			success([finishCall({ status: 'success', summary: 'main done' })]),
		]
		const { deps, events } = makeDeps(llm)
		const depsWithEcho: EngineDependencies = { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { echo: echoHandler }) }

		const card = await runRoleCard(depsWithEcho, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		expect(card.summary).toBe('main done')
		const detectorFinish = events.find((event) => event.type === 'role_finished' && payloadField(event, 'role') === 'detector')
		expect(payloadField(defined(detectorFinish, 'detector finish'), 'paused')).toBeUndefined()
		expect(events.filter((event) => event.type === 'interrupt_resolved').length).toBe(1)
	})

	test('a root direct clarification still marks its role_finished as paused', async () => {
		const guild = buildPendingGuild(['finish'])
		const llm = new FakeLlm()
		llm.responses = [success([finishCall({ status: 'needs_clarification', summary: 'need a decision' })])]
		const { deps, events } = makeDeps(llm)

		const card = await runRoleCard(deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		expect(card.status).toBe('needs_clarification')
		const finish = events.find((event) => event.type === 'role_finished')
		expect(payloadField(defined(finish, 'role finish'), 'paused')).toBe(true)
	})

	test('a live batch with a rejected finish before a real finish does not crash the completed-turn check', async () => {
		const guild = buildPendingGuild(['finish'])
		const llm = new FakeLlm()
		llm.responses = [success([
			{ id: 'bad_finish', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ status: 'success', summary: '' }) } },
			finishCall({ status: 'error', summary: 'the endpoint is down' }),
		])]
		const { deps, events } = makeDeps(llm)

		const card = await runRoleCard(deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		expect(card.status).toBe('error')
		expect(card.summary).toBe('the endpoint is down')
		expect(events.filter((event) => event.type === 'role_finished').length).toBe(1)
	})

	test('boot resume of a rejected finish followed by another call continues instead of crashing', async () => {
		const guild = buildPendingGuild(['echo', 'finish'])
		const badFinish: ToolCall = { id: 'bad_finish', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ status: 'success', summary: '' }) } }
		const echo = echoCall('e1')
		const checkpoint: RunCheckpoint = {
			version: 2,
			runId: 'test-run',
			startTime: '2026-01-01T00:00:00.000Z',
			registryCounter: 1,
			frames: [{
				roleId: 'main-0-1',
				roleName: 'main',
				depth: 0,
				task: 'do it',
				roleState: createEmptyRoleState({
					history: [
						{ role: 'system', content: 'prompt' },
						{ role: 'user', content: 'do it' },
						{ role: 'assistant', content: '', tool_calls: [badFinish, echo] },
						{ role: 'tool', content: '{"kind":"invalid_arguments","message":"summary must be a non-empty string"}', tool_call_id: 'bad_finish' },
						{ role: 'tool', content: '{"value":7}', tool_call_id: 'e1' },
					],
				}),
			}],
		}
		const llm = new FakeLlm()
		llm.responses = [success([finishCall({ status: 'success', summary: 'continued' })])]
		const { deps } = makeDeps(llm)

		const card = await resumeRoleStackCard(runRole, deps, guild, checkpoint)

		expect(card).toEqual({ status: 'success', summary: 'continued' })
		expect(llm.calls.length).toBe(1)
	})

	test('prevented calls sharing a model id each get their own interrupted result', async () => {
		const guild = buildPendingGuild(['echo', 'finish'])
		const llm = new FakeLlm()
		llm.responses = [success([
			finishCall({ status: 'success', summary: 'done' }),
			echoCall('same_id'),
			echoCall('same_id'),
		])]
		const { deps, checkpoints } = makeDeps(llm)

		await runRoleCard(deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		const checkpoint = checkpoints[checkpoints.length - 1]
		if (checkpoint === undefined) throw new Error('expected the completed-turn checkpoint')
		const frame = defined(checkpoint.frames[0], 'completed frame')
		const interrupted = frame.roleState.history.filter((message) => message.role === 'tool' && message.tool_call_id === 'same_id' && message.content.includes('Not executed because an earlier call'))
		expect(interrupted.length).toBe(2)
	})
})

describe('runRole — operator pause', () => {
	const pause = { message: 'The operator paused this run.', pausedAt: '2026-01-01T00:05:00.000Z' }

	test('a request before the first LLM call pauses at the safe point without a role_finished or pending invocation', async () => {
		const guild = buildGuild({ main: { systemPrompt: 'p', tools: ['finish'] } }, 'main')
		const llm = new FakeLlm()
		llm.responses = [success([finishCall({ status: 'success', summary: 'never called' })])]
		const harness = makeDeps(llm)
		harness.deps.operatorPauseQueue.request(pause)

		const outcome = await runRole(harness.deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		expect(outcome.kind).toBe('operator_paused')
		if (outcome.kind !== 'operator_paused') throw new Error('expected an operator pause')
		expect(outcome.pause).toEqual(pause)
		expect(llm.calls.length).toBe(0)
		expect(harness.events.some((event) => event.type === 'role_finished')).toBe(false)
		const pausedEvent = defined(harness.events.find((event) => event.type === 'run_paused'), 'run_paused event')
		expect(payloadField(pausedEvent, 'role')).toBe('main')
		expect(payloadField(pausedEvent, 'roleId')).toBe('main-0-1')
		expect(payloadField(pausedEvent, 'pausedAt')).toBe(pause.pausedAt)
		const checkpoint = harness.checkpoints[harness.checkpoints.length - 1]
		if (checkpoint === undefined) throw new Error('expected a pause checkpoint')
		expect(checkpoint.pause).toEqual(pause)
		expect(checkpoint.suspension).toBeUndefined()
		expect(checkpoint.frames[0]?.pending).toBeUndefined()
	})

	test('a request made mid-turn waits for the whole tool batch and issues no further LLM call', async () => {
		const guild = withTool(buildGuild({ main: { systemPrompt: 'p', tools: ['echo', 'finish'] } }, 'main'), { name: 'echo', description: 'Echoes its arguments.', parameters: { type: 'object', properties: {} } })
		const llm = new FakeLlm()
		const harness = makeDeps(llm)
		const pausingEcho = (args: Record<string, unknown>): ToolResult => {
			if (args['pause'] === true) harness.deps.operatorPauseQueue.request(pause)
			return { kind: 'success', data: args }
		}
		const deps = { ...harness.deps, toolPlatform: withExtraHandlers(harness.deps.toolPlatform, { echo: pausingEcho }) }
		llm.responses = [success([namedCall('e1', 'echo', { pause: true }), namedCall('e2', 'echo', {})])]

		const outcome = await runRole(deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		expect(outcome.kind).toBe('operator_paused')
		expect(llm.calls.length).toBe(1)
		const checkpoint = harness.checkpoints[harness.checkpoints.length - 1]
		if (checkpoint === undefined) throw new Error('expected a pause checkpoint')
		expect(checkpoint.frames[0]?.roleState.history.filter((message) => message.role === 'tool').map((message) => message.tool_call_id)).toEqual(['e1', 'e2'])
		expect(checkpoint.frames[0]?.pending).toBeUndefined()
	})

	test('a resume from a mid-batch pause checkpoint does not re-execute completed tools and issues the next LLM call', async () => {
		const guild = withTool(buildGuild({ main: { systemPrompt: 'p', tools: ['echo', 'finish'] } }, 'main'), { name: 'echo', description: 'Echoes its arguments.', parameters: { type: 'object', properties: {} } })
		const llm = new FakeLlm()
		const harness = makeDeps(llm)
		const toolCalls: string[] = []
		const pausingEcho = (args: Record<string, unknown>): ToolResult => {
			const id = typeof args['id'] === 'string' ? args['id'] : ''
			toolCalls.push(id)
			if (id === 'e2') harness.deps.operatorPauseQueue.request(pause)
			return { kind: 'success', data: args }
		}
		const deps = { ...harness.deps, toolPlatform: withExtraHandlers(harness.deps.toolPlatform, { echo: pausingEcho }) }
		llm.responses = [success([namedCall('e1', 'echo', { id: 'e1' }), namedCall('e2', 'echo', { id: 'e2' })])]

		const outcome = await runRole(deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		expect(outcome.kind).toBe('operator_paused')
		expect(toolCalls).toEqual(['e1', 'e2'])
		expect(llm.calls.length).toBe(1)
		const checkpoint = defined(harness.checkpoints[harness.checkpoints.length - 1], 'pause checkpoint')

		const resumeLlm = new FakeLlm()
		resumeLlm.responses = [success([finishCall({ status: 'success', summary: 'resumed' })])]
		const resumed = makeDeps(resumeLlm)
		let resumedToolCalls = 0
		const countingEcho = (args: Record<string, unknown>): ToolResult => {
			resumedToolCalls++
			return { kind: 'success', data: args }
		}
		await resumeRoleStackCard(runRole, { ...resumed.deps, toolPlatform: withExtraHandlers(resumed.deps.toolPlatform, { echo: countingEcho }) }, guild, checkpoint)

		expect(resumedToolCalls).toBe(0)
		expect(resumeLlm.calls.length).toBe(1)
		const sentToolResults = resumeLlm.calls[0]?.messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id)
		expect(sentToolResults).toEqual(['e1', 'e2'])
	})

	test('a pause with an in-flight child call resumes the pending call without replaying completed tools', async () => {
		const echoManifest: ToolManifest = { name: 'echo', description: 'Echoes its arguments.', parameters: { type: 'object', properties: {} } }
		const guild = withTool(buildGuild({
			orchestrator: { systemPrompt: 'p', tools: ['agent', 'finish'] },
			coder: { systemPrompt: 'c', tools: ['echo', 'finish'] },
		}, 'orchestrator'), echoManifest)
		const llm = new FakeLlm()
		const harness = makeDeps(llm)
		let echoCalls = 0
		const pausingEcho = (args: Record<string, unknown>): ToolResult => {
			echoCalls++
			harness.deps.operatorPauseQueue.request(pause)
			return { kind: 'success', data: args }
		}
		const deps = { ...harness.deps, toolPlatform: withExtraHandlers(harness.deps.toolPlatform, { echo: pausingEcho }) }
		llm.responses = [success([agentCall('coder', 'subtask')]), success([namedCall('e1', 'echo', { id: 'e1' })])]

		const outcome = await runRole(deps, { loadedGuild: guild, depth: 0, roleName: 'orchestrator', task: 'do it' })

		expect(outcome.kind).toBe('operator_paused')
		expect(echoCalls).toBe(1)
		const checkpoint = defined(harness.checkpoints[harness.checkpoints.length - 1], 'pause checkpoint')
		expect(checkpoint.frames.length).toBe(2)
		expect(checkpoint.frames[0]?.pending?.toolCalls[0]?.function.name).toBe('agent')
		expect(checkpoint.frames[0]?.pending?.childCard).toBeUndefined()
		expect(checkpoint.frames[1]?.roleName).toBe('coder')
		expect(checkpoint.frames[1]?.pending).toBeUndefined()

		const resumeLlm = new FakeLlm()
		resumeLlm.responses = [
			success([finishCall({ status: 'success', summary: 'child done' })]),
			success([finishCall({ status: 'success', summary: 'parent done' })]),
		]
		const resumed = makeDeps(resumeLlm)
		let resumedEchoCalls = 0
		const countingEcho = (args: Record<string, unknown>): ToolResult => {
			resumedEchoCalls++
			return { kind: 'success', data: args }
		}
		await resumeRoleStackCard(runRole, { ...resumed.deps, toolPlatform: withExtraHandlers(resumed.deps.toolPlatform, { echo: countingEcho }) }, guild, checkpoint)

		expect(resumedEchoCalls).toBe(0)
		expect(resumeLlm.calls.length).toBe(2)
	})

	test('a provider failure wins over a queued pause request', async () => {
		const guild = buildGuild({ main: { systemPrompt: 'p', tools: ['finish'] } }, 'main')
		const base = new FakeLlm()
		base.responses = [providerFailure('billing')]
		let harness: ReturnType<typeof makeDeps> | undefined
		const caller: LlmCaller = {
			async call(request) {
				if (harness !== undefined) harness.deps.operatorPauseQueue.request(pause)
				return await base.call(request)
			},
		}
		harness = makeDeps(caller)

		const outcome = await runRole(harness.deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		expect(outcome.kind).toBe('suspended')
		expect(harness.events.some((event) => event.type === 'run_paused')).toBe(false)
	})

	test('a park mark wins over a queued pause request at the safe point', async () => {
		const guild = buildGuild({ main: { systemPrompt: 'p', tools: ['finish'] } }, 'main')
		const llm = new FakeLlm()
		const harness = makeDeps(llm)
		harness.deps.operatorPauseQueue.request(pause)
		harness.parkTracker.parkedQuestion = 'Which database?'

		const outcome = await runRole(harness.deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		expect(outcome.kind).toBe('card')
		expect(llm.calls.length).toBe(0)
		expect(harness.events.some((event) => event.type === 'run_paused')).toBe(false)
	})

	test('a pause requested during a handler interlude waits until the handler resolves, then pauses the target', async () => {
		const guild = buildGuild({
			main: { systemPrompt: 'p', tools: ['finish'] },
			handler: { systemPrompt: 'h', tools: ['finish'] },
		}, 'main', { executor: { ...baseExecutor, inquiryHandlerRole: 'handler' } })
		const base = new FakeLlm()
		base.responses = [success([finishCall({ status: 'success', summary: 'handler answered' })])]
		let harness: ReturnType<typeof makeDeps> | undefined
		const caller: LlmCaller = {
			async call(request) {
				const result = await base.call(request)
				if (base.calls.length === 1 && harness !== undefined) harness.deps.operatorPauseQueue.request(pause)
				return result
			},
		}
		harness = makeDeps(caller)
		harness.deps.interruptQueue.submit({ kind: 'inquiry', message: 'what is happening?' })

		const outcome = await runRole(harness.deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		expect(outcome.kind).toBe('operator_paused')
		expect(base.calls.length).toBe(1)
		expect(harness.events.some((event) => event.type === 'run_paused' && payloadField(event, 'role') === 'handler')).toBe(false)
		const pausedEvent = defined(harness.events.find((event) => event.type === 'run_paused'), 'run_paused event')
		expect(payloadField(pausedEvent, 'role')).toBe('main')
		expect(harness.checkpoints[harness.checkpoints.length - 1]?.pendingInterlude).toBeUndefined()
	})

})

describe('runRole — provider failure suspensions', () => {
	test('an HTTP 402 at the entry role classifies as a billing suspension', async () => {
		const guild = buildGuild({ main: { systemPrompt: 'p', tools: ['finish'] } }, 'main')
		const wire = new FakeWire()
		wire.responses = [{ kind: 'http_error', status: 402, errorBody: '{"error":"Insufficient credit"}', headers: {} }]
		const caller = createLlmCaller(baseModel, undefined, { llmFetch: wire.llmFetch, sleep: () => Promise.resolve(), scheduleTimeout: () => () => undefined, random: () => 1, now: () => 0 })
		const { deps, events } = makeDeps(caller)

		const outcome = await runRole(deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		expect(outcome.kind).toBe('suspended')
		if (outcome.kind !== 'suspended') throw new Error('expected a suspension')
		expect(outcome.suspension.category).toBe('billing')
		const failureEvent = defined(events.find((event) => event.type === 'provider_failure'), 'provider_failure event')
		expect(payloadField(failureEvent, 'roleId')).toBe('main-0-1')
		expect(events.some((event) => event.type === 'role_finished')).toBe(false)
	})

	const echoManifest: ToolManifest = { name: 'echo', description: 'Echoes its arguments.', parameters: { type: 'object', properties: {} } }

	function echoCall(id: string): ToolCall {
		return { id, type: 'function', function: { name: 'echo', arguments: '{}' } }
	}

	test('a provider failure at the entry role suspends without a card, role_finished, or tool result', async () => {
		const guild = buildGuild({ main: { systemPrompt: 'p', tools: ['finish'] } }, 'main')
		const llm = new FakeLlm()
		llm.responses = [providerFailure('billing')]
		const { deps, events } = makeDeps(llm)

		const outcome = await runRole(deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		expect(outcome.kind).toBe('suspended')
		if (outcome.kind !== 'suspended') throw new Error('expected a suspension')
		expect(outcome.suspension.category).toBe('billing')
		expect(outcome.suspension.resumePolicy).toBe('operator')
		expect(events.some((event) => event.type === 'role_finished')).toBe(false)
		expect(events.some((event) => event.type === 'llm_unavailable')).toBe(false)
		expect(events.some((event) => event.type === 'tool_result')).toBe(false)
		const failureEvent = defined(events.find((event) => event.type === 'provider_failure'), 'provider_failure event')
		expect(payloadField(failureEvent, 'message')).toBe('The model provider failed')
		expect(payloadField(failureEvent, 'detail')).toBeUndefined()
	})

	test('a provider failure in a delegated child suspends without delivering a card to the parent', async () => {
		const guild = withTool(buildGuild({ parent: { systemPrompt: 'p', tools: ['agent', 'finish'] }, child: { systemPrompt: 'c', tools: ['finish'] } }, 'parent'), echoManifest)
		const llm = new FakeLlm()
		llm.responses = [success([agentCall('child', 'sub')]), providerFailure('billing')]
		const { deps, events } = makeDeps(llm)

		const outcome = await runRole(deps, { loadedGuild: guild, depth: 0, roleName: 'parent', task: 'delegate' })

		expect(outcome.kind).toBe('suspended')
		expect(events.some((event) => event.type === 'tool_result' && payloadField(event, 'tool') === 'agent')).toBe(false)
		expect(events.some((event) => event.type === 'role_finished')).toBe(false)
		expect(events.some((event) => event.type === 'provider_failure')).toBe(true)
	})

	test('a provider failure in a continue_agent child suspends without a parent card', async () => {
		const guild = continueAgentGuild()
		const llm = new FakeLlm()
		llm.responses = [
			success([agentCall('child', 'first')]),
			success([finishCall({ status: 'success', summary: 'child done' })]),
			success([continueAgentCall('child', 'again')]),
			providerFailure('transient'),
		]
		const { deps, events } = makeDeps(llm)

		const outcome = await runRole(deps, { loadedGuild: guild, depth: 0, roleName: 'parent', task: 'delegate' })

		expect(outcome.kind).toBe('suspended')
		expect(events.some((event) => event.type === 'tool_result' && payloadField(event, 'tool') === 'continue_agent')).toBe(false)
		expect(events.some((event) => event.type === 'role_finished' && payloadField(event, 'role') === 'parent')).toBe(false)
	})

	test('a provider failure in a loop-check handler suspends with a durable pending interlude that replays on resume', async () => {
		const guild = withTool(
			buildGuild(
				{ main: { systemPrompt: 'p', tools: ['echo', 'finish'] }, handler: { systemPrompt: 'h', tools: ['finish'] } },
				'main',
				{ executor: { ...baseExecutor, interruptTriggers: { handlerRole: 'handler', everyToolCalls: 1, everyTokens: 1_000_000 } } },
			),
			echoManifest,
		)
		const llm = new FakeLlm()
		llm.responses = [success([echoCall('e1'), echoCall('e2')]), providerFailure('billing')]
		const { deps, events, checkpoints } = makeDeps(llm)
		const depsWithEcho: EngineDependencies = { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { echo: echoHandler }) }

		const outcome = await runRole(depsWithEcho, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		expect(outcome.kind).toBe('suspended')
		const pendingCheckpoint = defined(checkpoints.filter((checkpoint) => checkpoint.pendingInterlude !== undefined).at(-1), 'checkpoint with a pending interlude')
		const pending = pendingCheckpoint
		expect(pending.registryCounter).toBeGreaterThan(1)
		expect(pending.pendingInterlude?.trigger).toBe('loop_check')
		expect(pending.pendingInterlude?.targetRoleId).toBe('main-0-1')

		llm.responses = [success([finishCall({ status: 'success', summary: 'handler done' })]), success([finishCall({ status: 'success', summary: 'main done' })])]
		const resumedHarness = makeDeps(llm, pending.registryCounter)
		const resumedDeps = { ...resumedHarness.deps, readRunLogEvents: () => events, toolPlatform: withExtraHandlers(resumedHarness.deps.toolPlatform, { echo: echoHandler }) }
		const resumed = await resumeRoleStackCard(runRole, resumedDeps, guild, pending)
		expect(resumed).toEqual({ status: 'success', summary: 'main done' })
		expect(resumedHarness.events.filter((event) => event.type === 'interrupt').length).toBe(1)
		const oldHandlerStart = defined(events.find((event) => event.type === 'role_start' && payloadField(event, 'role') === 'handler'), 'first handler role_start')
		const oldHandlerId = payloadField(oldHandlerStart, 'roleId')
		if (typeof oldHandlerId !== 'string') throw new Error('expected the first handler role id')
		const newHandlerStart = defined(resumedHarness.events.find((event) => event.type === 'role_start' && payloadField(event, 'role') === 'handler'), 'replayed handler role_start')
		const newHandlerId = payloadField(newHandlerStart, 'roleId')
		if (typeof newHandlerId !== 'string') throw new Error('expected the replayed handler role id')
		expect(newHandlerId).not.toBe(oldHandlerId)
		expect(resumedHarness.events.some((event) => event.type === 'role_finished' && payloadField(event, 'roleId') === newHandlerId)).toBe(true)
	})

	test('a crash before the clearing write replays the pending interlude', async () => {
		const guild = withTool(
			buildGuild(
				{ main: { systemPrompt: 'p', tools: ['echo', 'finish'] }, handler: { systemPrompt: 'h', tools: ['finish'] } },
				'main',
				{ executor: { ...baseExecutor, interruptTriggers: { handlerRole: 'handler', everyToolCalls: 1, everyTokens: 1_000_000 } } },
			),
			echoManifest,
		)
		const llm = new FakeLlm()
		llm.responses = [success([echoCall('e1'), echoCall('e2')]), providerFailure('billing')]
		const { deps, events, checkpoints } = makeDeps(llm)
		const depsWithEcho: EngineDependencies = { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { echo: echoHandler }) }
		await runRole(depsWithEcho, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })
		const checkpoint = defined(checkpoints.filter((entry) => entry.pendingInterlude !== undefined).at(-1), 'pending checkpoint')

		llm.responses = [success([finishCall({ status: 'success', summary: 'handler replayed' })]), success([finishCall({ status: 'success', summary: 'main done after crash' })])]
		const resumedHarness = makeDeps(llm, checkpoint.registryCounter)
		const resumedDeps = { ...resumedHarness.deps, readRunLogEvents: () => events, toolPlatform: withExtraHandlers(resumedHarness.deps.toolPlatform, { echo: echoHandler }) }
		const resumed = await resumeRoleStackCard(runRole, resumedDeps, guild, checkpoint)

		expect(resumed).toEqual({ status: 'success', summary: 'main done after crash' })
		expect(resumedHarness.events.filter((event) => event.type === 'interrupt').length).toBe(1)
	})

	test('the successful replay checkpoint clears the pending interlude and persists the trigger state', async () => {
		const guild = withTool(
			buildGuild(
				{ main: { systemPrompt: 'p', tools: ['echo', 'finish'] }, handler: { systemPrompt: 'h', tools: ['finish'] } },
				'main',
				{ executor: { ...baseExecutor, interruptTriggers: { handlerRole: 'handler', everyToolCalls: 1, everyTokens: 1_000_000 } } },
			),
			echoManifest,
		)
		const llm = new FakeLlm()
		llm.responses = [success([echoCall('e1'), echoCall('e2')]), providerFailure('billing')]
		const { deps, events, checkpoints } = makeDeps(llm)
		const depsWithEcho: EngineDependencies = { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { echo: echoHandler }) }
		await runRole(depsWithEcho, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })
		const suspendedCheckpoint = defined(checkpoints.filter((entry) => entry.pendingInterlude !== undefined).at(-1), 'pending checkpoint')

		llm.responses = [success([finishCall({ status: 'success', summary: 'handler replayed' })]), success([finishCall({ status: 'success', summary: 'main done' })])]
		const resumedHarness = makeDeps(llm, suspendedCheckpoint.registryCounter)
		const resumedDeps = { ...resumedHarness.deps, readRunLogEvents: () => events, toolPlatform: withExtraHandlers(resumedHarness.deps.toolPlatform, { echo: echoHandler }) }
		await resumeRoleStackCard(runRole, resumedDeps, guild, suspendedCheckpoint)
		const cleared = defined(resumedHarness.checkpoints.filter((entry) => entry.pendingInterlude === undefined).at(-1), 'cleared checkpoint')
		expect(cleared.pendingInterlude).toBeUndefined()
		expect(cleared.frames[0]?.roleState.loopCheckToolCallWatermark).toBe(2)

		const againHarness = makeDeps(llm, cleared.registryCounter)
		const againDeps = { ...againHarness.deps, readRunLogEvents: () => resumedHarness.events, toolPlatform: withExtraHandlers(againHarness.deps.toolPlatform, { echo: echoHandler }) }
		const again = await resumeRoleStackCard(runRole, againDeps, guild, cleared)
		expect(again).toEqual({ status: 'success', summary: 'main done' })
		expect(againHarness.events.filter((event) => event.type === 'interrupt').length).toBe(0)
	})

	test('a model-output empty completion still becomes an ordinary error card', async () => {
		const guild = buildGuild({ main: { systemPrompt: 'p', tools: ['finish'] } }, 'main')
		const llm = new FakeLlm()
		llm.responses = [{ kind: 'llm_unavailable', message: 'empty response (no content, no tool calls)' }]
		const { deps } = makeDeps(llm)

		const outcome = await runRole(deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		expect(outcome.kind).toBe('card')
		if (outcome.kind !== 'card') throw new Error('expected a card')
		expect(outcome.card.status).toBe('error')
		expect(outcome.card.error?.kind).toBe('llm_unavailable')
	})

	test('an inquiry handler suspension preserves operator requests queued behind it', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['echo', 'finish'] }, handler: { systemPrompt: 'h', tools: ['finish'] } },
			'main',
			{ executor: { ...baseExecutor, inquiryHandlerRole: 'handler' } },
		)
		const llm = new FakeLlm()
		llm.responses = [providerFailure('billing')]
		const { deps, events, checkpoints } = makeDeps(llm)
		const depsWithEcho: EngineDependencies = { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { echo: echoHandler }) }
		deps.interruptQueue.submit({ kind: 'inquiry', message: 'what changed?' })
		deps.interruptQueue.submit({ kind: 'notice', message: 'queued behind the handler' })
		await runRole(depsWithEcho, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })
		const pending = defined(checkpoints.filter((entry) => entry.pendingInterlude !== undefined).at(-1)?.pendingInterlude, 'pending interlude')
		expect(pending.pendingOperatorRequests).toEqual([{ kind: 'notice', message: 'queued behind the handler' }])

		llm.responses = [success([finishCall({ status: 'success', summary: 'the answer' })]), success([echoCall('e1')]), success([finishCall({ status: 'success', summary: 'main done' })])]
		const resumedHarness = makeDeps(llm)
		const resumedDeps = { ...resumedHarness.deps, readRunLogEvents: () => events, toolPlatform: withExtraHandlers(resumedHarness.deps.toolPlatform, { echo: echoHandler }) }
		await resumeRoleStackCard(runRole, resumedDeps, guild, defined(checkpoints.filter((entry) => entry.pendingInterlude !== undefined).at(-1), 'pending checkpoint'))
		expect(resumedHarness.events.some((event) => event.type === 'operator_notice' && payloadField(event, 'message') === 'queued behind the handler')).toBe(true)
	})

	test('a nested context handler inside a handler keeps the outer pending interlude', async () => {
		const guild = withTool(
			buildGuild(
				{
					main: { systemPrompt: 'p', tools: ['echo', 'finish'] },
					handler: { systemPrompt: 'h', tools: ['echo', 'finish'] },
					context: { systemPrompt: 'c', tools: ['finish'] },
				},
				'main',
				{ executor: { ...baseExecutor, contextHandlerRole: 'context', interruptTriggers: { handlerRole: 'handler', everyToolCalls: 1, everyTokens: 1_000_000 } } },
			),
			echoManifest,
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([echoCall('e1'), echoCall('e2')]),
			success([echoCall('h1')]),
			{ kind: 'context_budget_exceeded', promptTokens: 32_000, contextWindow: 32_768 },
			providerFailure('billing'),
		]
		const { deps, events, checkpoints } = makeDeps(llm)
		const depsWithEcho: EngineDependencies = { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { echo: echoHandler }) }

		const outcome = await runRole(depsWithEcho, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		expect(outcome.kind).toBe('suspended')
		expect(events.some((event) => event.type === 'role_start' && payloadField(event, 'role') === 'context')).toBe(true)
		const pending = defined(checkpoints.filter((entry) => entry.pendingInterlude !== undefined).at(-1)?.pendingInterlude, 'outer pending interlude')
		expect(pending.trigger).toBe('loop_check')
	})

	test('an inquiry handler suspension replays the inquiry on resume', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] }, handler: { systemPrompt: 'h', tools: ['finish'] } },
			'main',
			{ executor: { ...baseExecutor, inquiryHandlerRole: 'handler' } },
		)
		const llm = new FakeLlm()
		llm.responses = [providerFailure('billing')]
		const { deps, events, checkpoints } = makeDeps(llm)
		deps.interruptQueue.submit({ kind: 'inquiry', message: 'what changed?' })
		const outcome = await runRole(deps, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })
		expect(outcome.kind).toBe('suspended')
		const checkpoint = defined(checkpoints.filter((entry) => entry.pendingInterlude !== undefined).at(-1), 'pending checkpoint')
		expect(checkpoint.pendingInterlude?.trigger).toBe('inquiry')

		llm.responses = [success([finishCall({ status: 'success', summary: 'the answer' })]), success([finishCall({ status: 'success', summary: 'main done' })])]
		const resumedHarness = makeDeps(llm)
		const resumedDeps = { ...resumedHarness.deps, readRunLogEvents: () => events }
		const resumed = await resumeRoleStackCard(runRole, resumedDeps, guild, checkpoint)
		expect(resumed).toEqual({ status: 'success', summary: 'main done' })
		expect(resumedHarness.events.filter((event) => event.type === 'interrupt').length).toBe(1)
	})

	test('a context-pressure handler suspension replays on resume', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['echo', 'finish'] }, context: { systemPrompt: 'c', tools: ['finish'] } },
			'main',
			{ executor: { ...baseExecutor, contextHandlerRole: 'context', contextPressureThreshold: 0.0001 } },
		)
		const llm = new FakeLlm()
		llm.responses = [success([echoCall('e1')], { promptTokens: 100 }), providerFailure('billing')]
		const { deps, events, checkpoints } = makeDeps(llm)
		const depsWithEcho: EngineDependencies = { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { echo: echoHandler }) }
		const outcome = await runRole(depsWithEcho, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })
		expect(outcome.kind).toBe('suspended')
		const checkpoint = defined(checkpoints.filter((entry) => entry.pendingInterlude !== undefined).at(-1), 'pending checkpoint')
		expect(checkpoint.pendingInterlude?.trigger).toBe('context_pressure')

		llm.responses = [success([finishCall({ status: 'success', summary: 'compacted' })]), success([finishCall({ status: 'success', summary: 'main done' })])]
		const resumedHarness = makeDeps(llm)
		const resumedDeps = { ...resumedHarness.deps, readRunLogEvents: () => events, toolPlatform: withExtraHandlers(resumedHarness.deps.toolPlatform, { echo: echoHandler }) }
		const resumed = await resumeRoleStackCard(runRole, resumedDeps, guild, checkpoint)
		expect(resumed).toEqual({ status: 'success', summary: 'main done' })
	})

	test('a context-budget handler suspension replays on resume', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['echo', 'finish'] }, context: { systemPrompt: 'c', tools: ['finish'] } },
			'main',
			{ executor: { ...baseExecutor, contextHandlerRole: 'context' } },
		)
		const llm = new FakeLlm()
		llm.responses = [
			success([echoCall('e1')]),
			{ kind: 'context_budget_exceeded', promptTokens: 32_000, contextWindow: 32_768 },
			providerFailure('billing'),
		]
		const { deps, events, checkpoints } = makeDeps(llm)
		const depsWithEcho: EngineDependencies = { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { echo: echoHandler }) }
		const outcome = await runRole(depsWithEcho, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })
		expect(outcome.kind).toBe('suspended')
		const checkpoint = defined(checkpoints.filter((entry) => entry.pendingInterlude !== undefined).at(-1), 'pending checkpoint')
		expect(checkpoint.pendingInterlude?.trigger).toBe('context_budget_exceeded')

		llm.responses = [success([finishCall({ status: 'success', summary: 'compacted' })]), success([finishCall({ status: 'success', summary: 'main done' })])]
		const resumedHarness = makeDeps(llm)
		const resumedDeps = { ...resumedHarness.deps, readRunLogEvents: () => events, toolPlatform: withExtraHandlers(resumedHarness.deps.toolPlatform, { echo: echoHandler }) }
		const resumed = await resumeRoleStackCard(runRole, resumedDeps, guild, checkpoint)
		expect(resumed).toEqual({ status: 'success', summary: 'main done' })
	})

	test('a child suspension resumes the child with the same messages and records the agent result once', async () => {
		const guild = withTool(buildGuild({ parent: { systemPrompt: 'p', tools: ['agent', 'finish'] }, child: { systemPrompt: 'c', tools: ['finish'] } }, 'parent'), echoManifest)
		const llm = new FakeLlm()
		llm.responses = [success([agentCall('child', 'sub')]), providerFailure('billing')]
		const { deps, events, checkpoints } = makeDeps(llm)
		const outcome = await runRole(deps, { loadedGuild: guild, depth: 0, roleName: 'parent', task: 'delegate' })
		expect(outcome.kind).toBe('suspended')
		const childMessages = llm.calls[1]?.messages.map((message) => message.content)
		const checkpoint = defined(checkpoints[checkpoints.length - 1], 'suspension checkpoint')
		expect(checkpoint.frames).toHaveLength(2)

		llm.responses = [success([finishCall({ status: 'success', summary: 'child done' })]), success([finishCall({ status: 'success', summary: 'parent done' })])]
		const resumedHarness = makeDeps(llm)
		const resumedDeps = { ...resumedHarness.deps, readRunLogEvents: () => events }
		const resumed = await resumeRoleStackCard(runRole, resumedDeps, guild, checkpoint)
		expect(resumed).toEqual({ status: 'success', summary: 'parent done' })
		expect(llm.calls[2]?.messages.map((message) => message.content)).toEqual(childMessages)
		expect(resumedHarness.events.filter((event) => event.type === 'tool_result' && payloadField(event, 'tool') === 'agent')).toHaveLength(1)
	})

	test('a dropped inquiry clears the pending interlude so a later resume cannot replay it', async () => {
		const initialGuild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['finish'] }, handler: { systemPrompt: 'h', tools: ['finish'] } },
			'main',
			{ executor: { ...baseExecutor, inquiryHandlerRole: 'handler' } },
		)
		const llm = new FakeLlm()
		llm.responses = [providerFailure('billing')]
		const { deps, events, checkpoints } = makeDeps(llm)
		deps.interruptQueue.submit({ kind: 'inquiry', message: 'what changed?' })
		await runRole(deps, { loadedGuild: initialGuild, depth: 0, roleName: 'main', task: 'do it' })
		const checkpoint = defined(checkpoints.filter((entry) => entry.pendingInterlude !== undefined).at(-1), 'pending checkpoint')

		const resumeGuild = buildGuild({ main: { systemPrompt: 'p', tools: ['finish'] } }, 'main')
		llm.responses = [success([finishCall({ status: 'success', summary: 'main done' })])]
		const resumedHarness = makeDeps(llm, checkpoint.registryCounter)
		const resumedDeps = { ...resumedHarness.deps, readRunLogEvents: () => events }
		const resumed = await resumeRoleStackCard(runRole, resumedDeps, resumeGuild, checkpoint)

		expect(resumed).toEqual({ status: 'success', summary: 'main done' })
		expect(resumedHarness.events.some((event) => event.type === 'inquiry_dropped')).toBe(true)
		expect(resumedHarness.checkpoints.at(-1)?.pendingInterlude).toBeUndefined()
	})

	test('operator requests arriving while the handler runs are captured at suspension write time', async () => {
		const guild = withTool(
			buildGuild(
				{ main: { systemPrompt: 'p', tools: ['echo', 'finish'] }, handler: { systemPrompt: 'h', tools: ['finish'] } },
				'main',
				{ executor: { ...baseExecutor, interruptTriggers: { handlerRole: 'handler', everyToolCalls: 1, everyTokens: 1_000_000 } } },
			),
			echoManifest,
		)
		const baseLlm = new FakeLlm()
		baseLlm.responses = [success([echoCall('e1'), echoCall('e2')]), providerFailure('billing')]
		let interruptQueue: ReturnType<typeof createInterruptQueue> | undefined
		const caller: LlmCaller = {
			async call(request) {
				const result = await baseLlm.call(request)
				if (baseLlm.calls.length === 2) interruptQueue?.submit({ kind: 'notice', message: 'arrived during the handler' })
				return result
			},
		}
		const { deps, checkpoints } = makeDeps(caller)
		interruptQueue = deps.interruptQueue
		const depsWithEcho: EngineDependencies = { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { echo: echoHandler }) }

		await runRole(depsWithEcho, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })

		const pending = defined(checkpoints.filter((entry) => entry.pendingInterlude !== undefined).at(-1)?.pendingInterlude, 'pending interlude')
		expect(pending.pendingOperatorRequests).toEqual([{ kind: 'notice', message: 'arrived during the handler' }])
	})

	test('a restored context interlude resolves before draining newly queued operator requests', async () => {
		const guild = buildGuild(
			{ main: { systemPrompt: 'p', tools: ['echo', 'finish'] }, context: { systemPrompt: 'c', tools: ['finish'] } },
			'main',
			{ executor: { ...baseExecutor, contextHandlerRole: 'context', contextPressureThreshold: 0.0001 } },
		)
		const llm = new FakeLlm()
		llm.responses = [success([echoCall('e1')], { promptTokens: 100 }), providerFailure('billing')]
		const { deps, events, checkpoints } = makeDeps(llm)
		const depsWithEcho: EngineDependencies = { ...deps, toolPlatform: withExtraHandlers(deps.toolPlatform, { echo: echoHandler }) }
		await runRole(depsWithEcho, { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it' })
		const checkpoint = defined(checkpoints.filter((entry) => entry.pendingInterlude !== undefined).at(-1), 'pending checkpoint')

		llm.responses = [success([finishCall({ status: 'success', summary: 'compacted' })]), success([echoCall('e2')]), success([finishCall({ status: 'success', summary: 'main done' })])]
		const resumedHarness = makeDeps(llm, checkpoint.registryCounter)
		const resumedDeps = { ...resumedHarness.deps, readRunLogEvents: () => events, toolPlatform: withExtraHandlers(resumedHarness.deps.toolPlatform, { echo: echoHandler }) }
		resumedDeps.interruptQueue.submit({ kind: 'notice', message: 'queued during replay' })
		await resumeRoleStackCard(runRole, resumedDeps, guild, checkpoint)

		const handlerStart = resumedHarness.events.findIndex((event) => event.type === 'role_start' && payloadField(event, 'role') === 'context')
		const notice = resumedHarness.events.findIndex((event) => event.type === 'operator_notice')
		expect(handlerStart).toBeGreaterThanOrEqual(0)
		expect(notice).toBeGreaterThan(handlerStart)
	})

})
