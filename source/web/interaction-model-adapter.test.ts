import { describe, expect, test } from 'bun:test'
import type { LogEvent, RunMeta } from '../executor/types.js'
import type { RunSnapshot } from './render.js'
import { deriveInteractionModel } from './interaction-model-adapter.js'
import { activeParticipant, activeStack, callChainOf, fateOf, observesOf, stacksOf, terminatesOf } from './static/interaction-model.js'

// The helpers arrive typed from the module's JSDoc; the adapter's InteractionModel is
// structurally the same shape, so its output is directly callable as a helper argument.
type InteractionModel = ReturnType<typeof deriveInteractionModel>

function event(timestamp: string, type: string, payload: unknown): LogEvent {
	return { timestamp, type, payload }
}

function meta(status: RunMeta['status']): RunMeta {
	return { runId: 'r', guildPath: 'g', benchmarkPath: 'b', task: 'the task', status, startTime: '2026-01-01T00:00:00.000Z' }
}

function snapshot(events: LogEvent[], runMeta: RunMeta | null): RunSnapshot {
	return { meta: runMeta, logEvents: events }
}

// Asserts the model satisfies its own read helpers without throwing and with declared types —
// the single invariant both views read must hold for every model the adapter produces.
function assertHelpersSensible(model: InteractionModel): void {
	const stack = activeStack(model)
	expect(stack === null || typeof stack === 'string').toBe(true)
	expect(Array.isArray(stacksOf(model))).toBe(true)
	expect(Array.isArray(observesOf(model))).toBe(true)
	expect(Array.isArray(terminatesOf(model))).toBe(true)
	expect(activeParticipant(model) === null || typeof activeParticipant(model) === 'string').toBe(true)
	if (stack !== null) {
		expect(Array.isArray(callChainOf(model, stack))).toBe(true)
		expect(['active', 'resuming', 'rewinding', 'terminating', 'terminated']).toContain(fateOf(model, stack))
	}
}

const NOW = '2026-01-01T00:01:00.000Z'

describe('deriveInteractionModel — single-role completion', () => {
	test('produces a human→role call and a role→human return, terminal and settled', () => {
		const events = [
			event('2026-01-01T00:00:00.000Z', 'role_start', { role: 'orchestrator', depth: 0, task: 'do the thing' }),
			event('2026-01-01T00:00:05.000Z', 'role_finished', { role: 'orchestrator', depth: 0, status: 'success', summary: 'done' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('success')), NOW)
		expect(model.status).toBe('success')
		expect(model.participants.map((p) => p.role)).toEqual(['human', 'orchestrator'])
		expect(model.participants.map((p) => p.kind)).toEqual(['human', 'role'])
		expect(model.operations).toHaveLength(2)
		const call = model.operations[0]!
		const ret = model.operations[1]!
		expect(call.kind).toBe('call')
		expect(call.source).toBe('human:root')
		expect(call.destination).toBe(model.participants[1]!.id)
		expect(call.details).toBe('do the thing')
		expect(ret.kind).toBe('return')
		expect(ret.source).toBe(model.participants[1]!.id)
		expect(ret.destination).toBe('human:root')
		expect(ret.outcome).toBe('success')
		expect(ret.details).toBe('done')
		// A terminal run has nothing in flight; the human is the active participant and no row renders.
		expect(call.lifecycle).toBe('settled')
		expect(ret.lifecycle).toBe('settled')
		expect(activeStack(model)).toBe('main')
		expect(activeParticipant(model)).toBe('human:root')
		expect(stacksOf(model)).toEqual([])
		assertHelpersSensible(model)
	})
})

describe('deriveInteractionModel — delegation chain', () => {
	test('nests the child call under the parent and unwinds the returns on finish', () => {
		const events = [
			event('t0', 'role_start', { role: 'orchestrator', depth: 0, task: 'the task' }),
			event('t1', 'llm_call', { role: 'orchestrator', usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 } }),
			event('t2', 'role_start', { role: 'coder', depth: 1, parent: 'orchestrator', task: 'code it' }),
			event('t3', 'llm_call', { role: 'coder', usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } }),
			event('t4', 'role_finished', { role: 'coder', depth: 1, status: 'success', summary: 'coded', parent: 'orchestrator' }),
			event('t5', 'llm_call', { role: 'orchestrator', usage: { promptTokens: 80, completionTokens: 10, totalTokens: 90 } }),
			event('t6', 'role_finished', { role: 'orchestrator', depth: 0, status: 'success', summary: 'wrapped up' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('success')), NOW)
		expect(model.participants.map((p) => `${p.role}:${p.kind}`)).toEqual(['human:human', 'orchestrator:role', 'coder:role'])
		expect(model.operations).toHaveLength(4)
		const callYou = model.operations[0]!
		const callCoder = model.operations[1]!
		const retCoder = model.operations[2]!
		const retYou = model.operations[3]!
		expect(callYou.kind).toBe('call')
		expect(callYou.source).toBe('human:root')
		expect(callYou.destination).toBe(model.participants[1]!.id)
		expect(callCoder.source).toBe(model.participants[1]!.id)
		expect(callCoder.destination).toBe(model.participants[2]!.id)
		expect(callCoder.details).toBe('code it')
		expect(retCoder.source).toBe(model.participants[2]!.id)
		expect(retCoder.destination).toBe(model.participants[1]!.id)
		expect(retYou.destination).toBe('human:root')
		// The parent call accumulated both orchestrator llm_calls (60 + 90); the coder call only its own (120).
		expect(callYou.metrics?.tokens).toBe(150)
		expect(callCoder.metrics?.tokens).toBe(120)
		assertHelpersSensible(model)
	})
})

describe('deriveInteractionModel — instance-per-invocation retry', () => {
	test('two coder invocations are two distinct participants sharing the role name', () => {
		const events = [
			event('t0', 'role_start', { role: 'orchestrator', depth: 0, task: 'try twice' }),
			event('t1', 'role_start', { role: 'coder', depth: 1, parent: 'orchestrator', task: 'first attempt' }),
			event('t2', 'role_finished', { role: 'coder', depth: 1, status: 'error', summary: 'broke', parent: 'orchestrator' }),
			event('t3', 'role_start', { role: 'coder', depth: 1, parent: 'orchestrator', task: 'second attempt' }),
			event('t4', 'role_finished', { role: 'coder', depth: 1, status: 'success', summary: 'fixed', parent: 'orchestrator' }),
			event('t5', 'role_finished', { role: 'orchestrator', depth: 0, status: 'success', summary: 'done' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('success')), NOW)
		const coders = model.participants.filter((p) => p.role === 'coder')
		expect(coders).toHaveLength(2)
		expect(coders[0]!.id).not.toBe(coders[1]!.id)
		// The first coder return carries the error outcome; the second carries success.
		const returns = model.operations.filter((o) => o.kind === 'return' && o.source.startsWith('role:coder:'))
		expect(returns).toHaveLength(2)
		expect(returns[0]!.outcome).toBe('error')
		expect(returns[1]!.outcome).toBe('success')
		assertHelpersSensible(model)
	})
})

describe('deriveInteractionModel — in-flight tool node', () => {
	test('a tool_call with no result yet leaves the tool call in flight on the active path', () => {
		const events = [
			event('t0', 'role_start', { role: 'coder', depth: 0, task: 'read something' }),
			event('t1', 'tool_call', { role: 'coder', tool: 'read_file', arguments: '{"path":"README.md"}' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')), NOW)
		expect(model.participants.map((p) => `${p.role}:${p.kind}`)).toEqual(['human:human', 'coder:role', 'read_file:tool'])
		expect(model.operations).toHaveLength(2)
		const roleCall = model.operations[0]!
		const toolCall = model.operations[1]!
		// The role call settled by delegation when the tool call landed; the tool call is the active in-flight node.
		expect(roleCall.lifecycle).toBe('settled')
		expect(toolCall.lifecycle).toBe('in_flight')
		expect(toolCall.details).toContain('"path": "README.md"')
		expect(activeParticipant(model)).toBe(toolCall.destination)
		expect(callChainOf(model, 'main').map((o) => o.kind)).toEqual(['call', 'call'])
		assertHelpersSensible(model)
	})
})

describe('deriveInteractionModel — lingering return leg', () => {
	test('a role_finished whose caller has not yet acted leaves the return in flight', () => {
		const events = [
			event('t0', 'role_start', { role: 'orchestrator', depth: 0, task: 'delegate' }),
			event('t1', 'role_start', { role: 'coder', depth: 1, parent: 'orchestrator', task: 'work' }),
			event('t2', 'role_finished', { role: 'coder', depth: 1, status: 'success', summary: 'done', parent: 'orchestrator' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')), NOW)
		expect(model.operations).toHaveLength(3)
		const coderReturn = model.operations[2]!
		expect(coderReturn.kind).toBe('return')
		// No caller action followed: the return lingers in flight, the orchestrator is the active participant.
		expect(coderReturn.lifecycle).toBe('in_flight')
		expect(coderReturn.settledAt).toBeNull()
		expect(activeParticipant(model)).toBe(coderReturn.destination)
		// The coder call dropped out of the open chain; the orchestrator call remains.
		expect(callChainOf(model, 'main')).toHaveLength(1)
		expect(stacksOf(model)).toEqual(['main'])
		assertHelpersSensible(model)
	})

	test('a later llm_call from the caller settles the lingering return leg', () => {
		const events = [
			event('t0', 'role_start', { role: 'orchestrator', depth: 0, task: 'delegate' }),
			event('t1', 'role_start', { role: 'coder', depth: 1, parent: 'orchestrator', task: 'work' }),
			event('t2', 'role_finished', { role: 'coder', depth: 1, status: 'success', summary: 'done', parent: 'orchestrator' }),
			event('t3', 'llm_call', { role: 'orchestrator', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')), NOW)
		const coderReturn = model.operations[2]!
		expect(coderReturn.lifecycle).toBe('settled')
		expect(coderReturn.settledAt).toBe('t3')
		// The orchestrator resumed thinking: the active participant is the orchestrator, not a lingering return.
		expect(activeParticipant(model)).toBe(model.participants[1]!.id)
		assertHelpersSensible(model)
	})
})

describe('deriveInteractionModel — ask_human question', () => {
	test('an ask_human targets a distinct child human and a human_answer returns it', () => {
		const events = [
			event('t0', 'role_start', { role: 'orchestrator', depth: 0, task: 'decide' }),
			event('t1', 'ask_human', { id: 'q1', question: 'Which framework?', context: 'src/index.ts' }),
			event('t2', 'human_answer', { id: 'q1', answer: 'react' }),
			event('t3', 'role_finished', { role: 'orchestrator', depth: 0, status: 'success', summary: 'picked react' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('success')), NOW)
		const humans = model.participants.filter((p) => p.kind === 'human')
		expect(humans).toHaveLength(2)
		expect(humans[0]!.id).toBe('human:root')
		expect(humans[1]!.id).not.toBe('human:root')
		expect(model.operations).toHaveLength(4)
		const callAsk = model.operations[1]!
		const retAnswer = model.operations[2]!
		expect(callAsk.kind).toBe('call')
		expect(callAsk.source).toBe(model.participants[1]!.id)
		expect(callAsk.destination).toBe(humans[1]!.id)
		expect(callAsk.details).toBe('Which framework?\n\n*Context: src/index.ts*')
		expect(retAnswer.kind).toBe('return')
		expect(retAnswer.source).toBe(humans[1]!.id)
		expect(retAnswer.details).toBe('react')
		assertHelpersSensible(model)
	})

	test('a pending ask_human with no answer leaves the question call in flight under needs_clarification', () => {
		const events = [
			event('t0', 'role_start', { role: 'orchestrator', depth: 0, task: 'decide' }),
			event('t1', 'ask_human', { id: 'q1', question: 'Which framework?' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('needs_clarification')), NOW)
		expect(model.status).toBe('needs_clarification')
		const callAsk = model.operations[1]!
		expect(callAsk.lifecycle).toBe('in_flight')
		expect(activeParticipant(model)).toBe(callAsk.destination)
		assertHelpersSensible(model)
	})
})

describe('deriveInteractionModel — per-invocation metrics', () => {
	test('tokens accumulate from llm_call usage and elapsedSeconds spans start to return', () => {
		const events = [
			event('2026-01-01T00:00:00.000Z', 'role_start', { role: 'coder', depth: 0, task: 'work' }),
			event('2026-01-01T00:00:01.000Z', 'llm_call', { role: 'coder', usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedPromptTokens: 40 } }),
			event('2026-01-01T00:00:06.000Z', 'role_finished', { role: 'coder', depth: 0, status: 'success' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('success')), NOW)
		const call = model.operations[0]!
		expect(call.metrics?.tokens).toBe(120)
		expect(call.metrics?.cachedPromptTokens).toBe(40)
		expect(call.metrics?.elapsedSeconds).toBe(6)
		assertHelpersSensible(model)
	})

	test('an in-flight call counts elapsed up to now when no return has landed', () => {
		const events = [
			event('2026-01-01T00:00:00.000Z', 'role_start', { role: 'coder', depth: 0, task: 'work' }),
			event('2026-01-01T00:00:01.000Z', 'llm_call', { role: 'coder', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')), '2026-01-01T00:00:31.000Z')
		const call = model.operations[0]!
		expect(call.lifecycle).toBe('in_flight')
		expect(call.metrics?.tokens).toBe(15)
		expect(call.metrics?.elapsedSeconds).toBe(31)
		assertHelpersSensible(model)
	})
})

describe('deriveInteractionModel — root human and graceful absence', () => {
	test('the root human is always present even for an empty or unreadable run', () => {
		const model = deriveInteractionModel(snapshot([], null), NOW)
		expect(model.status).toBe('unknown')
		expect(model.participants).toEqual([{ id: 'human:root', role: 'human', kind: 'human' }])
		expect(model.operations).toEqual([])
		expect(activeStack(model)).toBeNull()
		expect(stacksOf(model)).toEqual([])
		assertHelpersSensible(model)
	})

	test('a run with no interrupt events produces a single stack and no interrupt participant', () => {
		const events = [
			event('t0', 'role_start', { role: 'orchestrator', depth: 0, task: 'work' }),
			event('t1', 'role_finished', { role: 'orchestrator', depth: 0, status: 'success' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('success')), NOW)
		expect(model.participants.every((p) => p.kind !== 'interrupt')).toBe(true)
		expect(model.operations.every((o) => o.stack === 'main')).toBe(true)
		expect(terminatesOf(model)).toEqual([])
		expect(observesOf(model)).toEqual([])
		assertHelpersSensible(model)
	})
})
