import { describe, expect, test } from 'bun:test'
import type { LogEvent, RunMeta } from '../executor/types.js'
import type { RunSnapshot } from './render.js'
import { deriveInteractionModel, deriveInteractionOperationDetail } from './interaction-model-adapter.js'
import { activeParticipant, activeStack, callChainOf, fateOf, observesOf, stacksOf, terminatesOf } from './static/ts/interaction-model.js'
import { defined, present } from './test-fixtures.js'

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

// Resolves one operation's on-demand details, failing the test when the id names no operation.
function detailOf(events: LogEvent[], runMeta: RunMeta | null, operationId: string): string | null {
	const detail = deriveInteractionOperationDetail(snapshot(events, runMeta), NOW, operationId)
	expect(detail).not.toBeNull()
	return detail === null ? null : detail.details
}

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
		const call = defined(model.operations[0], 'model.operations[0]')
		const ret = defined(model.operations[1], 'model.operations[1]')
		expect(call.kind).toBe('call')
		expect(call.source).toBe('human:root')
		expect(call.destination).toBe(defined(model.participants[1], 'model.participants[1]').id)
		expect(ret.kind).toBe('return')
		expect(ret.source).toBe(defined(model.participants[1], 'model.participants[1]').id)
		expect(ret.destination).toBe('human:root')
		expect(ret.outcome).toBe('success')
		// A terminal run has nothing in flight; the human is the active participant and no row renders.
		expect(call.lifecycle).toBe('settled')
		expect(ret.lifecycle).toBe('settled')
		expect(activeStack(model)).toBe('main')
		expect(activeParticipant(model)).toBe('human:root')
		expect(stacksOf(model)).toEqual([])
		assertHelpersSensible(model)
	})

	test('the polled model carries no details; the on-demand path resolves the call task and the finish summary', () => {
		const events = [
			event('2026-01-01T00:00:00.000Z', 'role_start', { role: 'orchestrator', depth: 0, task: 'do the thing' }),
			event('2026-01-01T00:00:05.000Z', 'role_finished', { role: 'orchestrator', depth: 0, status: 'success', summary: 'done' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('success')), NOW)
		for (const operation of model.operations) {
			expect(operation).not.toHaveProperty('details')
		}
		expect(detailOf(events, meta('success'), 'op-1')).toBe('do the thing')
		expect(detailOf(events, meta('success'), 'op-2')).toBe('done')
	})
})

describe('deriveInteractionModel — participant instance ids', () => {
	test('a role_start carrying a roleId stamps the participant with the executor instance id', () => {
		const events = [
			event('t0', 'role_start', { role: 'orchestrator', roleId: 'orchestrator-0-1', depth: 0, task: 'the task' }),
			event('t1', 'role_start', { role: 'coder', roleId: 'coder-1-2', depth: 1, parent: 'orchestrator', parentRoleId: 'orchestrator-0-1', task: 'code it' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')), NOW)
		const orchestrator = defined(model.participants[1], 'model.participants[1]')
		const coder = defined(model.participants[2], 'model.participants[2]')
		expect(orchestrator.roleId).toBe('orchestrator-0-1')
		expect(coder.roleId).toBe('coder-1-2')
		// The flow node key keeps its own minted scheme; the instance id rides alongside it.
		expect(orchestrator.id).toBe('role:orchestrator:1')
		assertHelpersSensible(model)
	})

	test('a role_start without a roleId (old logs) leaves the field off the participant', () => {
		const events = [
			event('t0', 'role_start', { role: 'orchestrator', depth: 0, task: 'do the thing' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')), NOW)
		const orchestrator = defined(model.participants[1], 'model.participants[1]')
		expect(orchestrator).not.toHaveProperty('roleId')
		// Pseudo-roles and tools carry no instance ids either — the human root has none.
		expect(defined(model.participants[0], 'model.participants[0]')).not.toHaveProperty('roleId')
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
		const callYou = defined(model.operations[0], 'model.operations[0]')
		const callCoder = defined(model.operations[1], 'model.operations[1]')
		const retCoder = defined(model.operations[2], 'model.operations[2]')
		const retYou = defined(model.operations[3], 'model.operations[3]')
		expect(callYou.kind).toBe('call')
		expect(callYou.source).toBe('human:root')
		expect(callYou.destination).toBe(defined(model.participants[1], 'model.participants[1]').id)
		expect(callCoder.source).toBe(defined(model.participants[1], 'model.participants[1]').id)
		expect(callCoder.destination).toBe(defined(model.participants[2], 'model.participants[2]').id)
		expect(retCoder.source).toBe(defined(model.participants[2], 'model.participants[2]').id)
		expect(retCoder.destination).toBe(defined(model.participants[1], 'model.participants[1]').id)
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
		expect(defined(coders[0], 'coders[0]').id).not.toBe(defined(coders[1], 'coders[1]').id)
		// The first coder return carries the error outcome; the second carries success.
		const returns = model.operations.filter((o) => o.kind === 'return' && o.source.startsWith('role:coder:'))
		expect(returns).toHaveLength(2)
		expect(defined(returns[0], 'returns[0]').outcome).toBe('error')
		expect(defined(returns[1], 'returns[1]').outcome).toBe('success')
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
		const roleCall = defined(model.operations[0], 'model.operations[0]')
		const toolCall = defined(model.operations[1], 'model.operations[1]')
		// The role call settled by delegation when the tool call landed; the tool call is the active in-flight node.
		expect(roleCall.lifecycle).toBe('settled')
		expect(toolCall.lifecycle).toBe('in_flight')
		// The tool call's on-demand details pretty-print the raw arguments string.
		expect(detailOf(events, meta('running'), 'op-2')).toContain('"path": "README.md"')
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
		const coderReturn = defined(model.operations[2], 'model.operations[2]')
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
		const coderReturn = defined(model.operations[2], 'model.operations[2]')
		expect(coderReturn.lifecycle).toBe('settled')
		expect(coderReturn.settledAt).toBe('t3')
		// The orchestrator resumed thinking: the active participant is the orchestrator, not a lingering return.
		expect(activeParticipant(model)).toBe(defined(model.participants[1], 'model.participants[1]').id)
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
		expect(defined(humans[0], 'humans[0]').id).toBe('human:root')
		expect(defined(humans[1], 'humans[1]').id).not.toBe('human:root')
		expect(model.operations).toHaveLength(4)
		const callAsk = defined(model.operations[1], 'model.operations[1]')
		const retAnswer = defined(model.operations[2], 'model.operations[2]')
		expect(callAsk.kind).toBe('call')
		expect(callAsk.source).toBe(defined(model.participants[1], 'model.participants[1]').id)
		expect(callAsk.destination).toBe(defined(humans[1], 'humans[1]').id)
		expect(retAnswer.kind).toBe('return')
		expect(retAnswer.source).toBe(defined(humans[1], 'humans[1]').id)
		expect(detailOf(events, meta('success'), 'op-2')).toBe('Which framework?\n\n*Context: src/index.ts*')
		expect(detailOf(events, meta('success'), 'op-3')).toBe('react')
		assertHelpersSensible(model)
	})

	test('a pending ask_human with no answer leaves the question call in flight under needs_clarification', () => {
		const events = [
			event('t0', 'role_start', { role: 'orchestrator', depth: 0, task: 'decide' }),
			event('t1', 'ask_human', { id: 'q1', question: 'Which framework?' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('needs_clarification')), NOW)
		expect(model.status).toBe('needs_clarification')
		const callAsk = defined(model.operations[1], 'model.operations[1]')
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
		const call = defined(model.operations[0], 'model.operations[0]')
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
		const call = defined(model.operations[0], 'model.operations[0]')
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

describe('deriveInteractionModel — llm_call_start transit/working distinction', () => {
	test('the call transit phase settles on llm_call_start — the callee began working', () => {
		const events = [
			event('t0', 'role_start', { role: 'coder', depth: 0, task: 'work' }),
			event('t1', 'llm_call_start', { role: 'coder' }),
			event('t2', 'llm_call', { role: 'coder', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }),
		]
		const frame0 = deriveInteractionModel(snapshot(events.slice(0, 1), meta('running')), NOW)
		const frame1 = deriveInteractionModel(snapshot(events.slice(0, 2), meta('running')), NOW)
		expect(defined(frame0.operations[0], 'frame0.operations[0]').lifecycle).toBe('in_flight')
		expect(defined(frame1.operations[0], 'frame1.operations[0]').lifecycle).toBe('settled')
		expect(defined(frame1.operations[0], 'frame1.operations[0]').settledAt).toBe('t1')
	})

	test('the lingering tool return survives the callee llm_call_start (regression guard)', () => {
		const events = [
			event('t0', 'role_start', { role: 'orchestrator', depth: 0, task: 'write' }),
			event('t1', 'llm_call_start', { role: 'orchestrator' }),
			event('t2', 'llm_call', { role: 'orchestrator', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }),
			event('t3', 'role_start', { role: 'coder', depth: 1, parent: 'orchestrator', task: 'write file' }),
			event('t4', 'llm_call_start', { role: 'coder' }),
			event('t5', 'llm_call', { role: 'coder', usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 } }),
			event('t6', 'tool_call', { role: 'coder', tool: 'write_file', arguments: '{}' }),
			event('t7', 'tool_result', { role: 'coder', tool: 'write_file', kind: 'success', result: { kind: 'success', data: {} } }),
			event('t8', 'llm_call_start', { role: 'coder' }),
		]
		const frame7 = deriveInteractionModel(snapshot(events.slice(0, 8), meta('running')), NOW)
		expect(frame7.operations.filter((o) => o.kind === 'return' && o.lifecycle === 'in_flight').length).toBe(1)
		// Frame 8 (coder llm_call_start): the coder's call transit settles, but the write_file return must still linger — llm_call_start settles only the call transit, not the lingering return.
		const frame8 = deriveInteractionModel(snapshot(events.slice(0, 9), meta('running')), NOW)
		expect(frame8.operations.filter((o) => o.kind === 'return' && o.lifecycle === 'in_flight').length).toBe(1)
	})

	test('the lingering return settles on llm_call completion (the caller resumed), not on llm_call_start', () => {
		const events = [
			event('t0', 'role_start', { role: 'orchestrator', depth: 0, task: 'write' }),
			event('t1', 'llm_call_start', { role: 'orchestrator' }),
			event('t2', 'llm_call', { role: 'orchestrator', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }),
			event('t3', 'role_start', { role: 'coder', depth: 1, parent: 'orchestrator', task: 'write file' }),
			event('t4', 'llm_call_start', { role: 'coder' }),
			event('t5', 'llm_call', { role: 'coder', usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 } }),
			event('t6', 'tool_call', { role: 'coder', tool: 'write_file', arguments: '{}' }),
			event('t7', 'tool_result', { role: 'coder', tool: 'write_file', kind: 'success', result: { kind: 'success', data: {} } }),
			event('t8', 'llm_call_start', { role: 'coder' }),
			event('t9', 'llm_call', { role: 'coder', usage: { promptTokens: 15, completionTokens: 8, totalTokens: 23 } }),
		]
		const frame9 = deriveInteractionModel(snapshot(events.slice(0, 10), meta('running')), NOW)
		expect(frame9.operations.filter((o) => o.kind === 'return' && o.lifecycle === 'in_flight').length).toBe(0)
	})

	test('a call with only role_start + llm_call (no llm_call_start) stays in transit', () => {
		const events = [
			event('t0', 'role_start', { role: 'coder', depth: 0, task: 'work' }),
			event('t1', 'llm_call', { role: 'coder', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')), NOW)
		expect(defined(model.operations[0], 'model.operations[0]').lifecycle).toBe('in_flight')
	})
})

describe('deriveInteractionModel — interrupts, observes, and terminates', () => {
	test('an interrupt spawns its own stack rooted at an interrupt participant, then resolves back to main', () => {
		const events = [
			event('t0', 'role_start', { role: 'orchestrator', depth: 0, task: 'the task' }),
			event('t1', 'llm_call', { role: 'orchestrator', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }),
			event('t2', 'interrupt', {}),
			event('t3', 'role_start', { role: 'loop_detector', depth: 1, task: 'detect the loop' }),
			event('t4', 'llm_call', { role: 'loop_detector', usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } }),
			event('t5', 'role_finished', { role: 'loop_detector', status: 'success', summary: 'no loop' }),
			event('t6', 'role_finished', { role: 'orchestrator', status: 'success', summary: 'done' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('success')), NOW)
		// An interrupt participant exists and the loop_detector call is on the interrupt stack, not main.
		const interrupt = defined(model.participants.find((p) => p.kind === 'interrupt'), 'interrupt')
		expect(interrupt).toBeDefined()
		const detectorCall = defined(model.operations.find((o) => o.kind === 'call' && o.destination === defined(model.participants.find((p) => p.role === 'loop_detector'), 'loop_detector participant').id), 'detectorCall')
		expect(detectorCall).toBeDefined()
		expect(detectorCall.stack).not.toBe('main')
		expect(detectorCall.source).toBe(interrupt.id)
		// After the interrupt resolves, the orchestrator's return is on the main stack.
		const orchestratorReturn = defined(model.operations.find((o) => o.kind === 'return' && o.source === defined(model.participants.find((p) => p.role === 'orchestrator'), 'orchestrator participant').id), 'orchestratorReturn')
		expect(orchestratorReturn).toBeDefined()
		expect(orchestratorReturn.stack).toBe('main')
		// No stack is left paused once everything resolved.
		expect(stacksOf(model)).toEqual([])
		assertHelpersSensible(model)
	})

	test('an interrupt stack runs role/llm/tool calls on its own stack, leaving the main stack paused and frozen', () => {
		const events = [
			event('t0', 'role_start', { role: 'orchestrator', depth: 0, task: 'the task' }),
			event('t1', 'role_start', { role: 'coder', depth: 1, parent: 'orchestrator', task: 'code' }),
			event('t2', 'interrupt', {}),
			event('t3', 'role_start', { role: 'loop_detector', depth: 1, task: 'detect' }),
			event('t4', 'tool_call', { role: 'loop_detector', tool: 'read_message_window', arguments: '{}' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')), NOW)
		// The interrupt stack is active (the latest operations are on it); the main stack is paused with the coder call still open.
		expect(activeStack(model)).not.toBe('main')
		const mainChain = callChainOf(model, 'main')
		expect(mainChain.map((o) => o.kind)).toEqual(['call', 'call'])
		// The paused coder call stays in flight (its lines freeze) while the interrupt runs.
		const coderCall = defined(model.operations.find((o) => o.kind === 'call' && o.destination === defined(model.participants.find((p) => p.role === 'coder'), 'coder participant').id), 'coderCall')
		expect(coderCall.lifecycle).toBe('in_flight')
		assertHelpersSensible(model)
	})

	test('an observe references a paused-stack node from the active tool, without affecting activity', () => {
		const events = [
			event('t0', 'role_start', { role: 'orchestrator', depth: 0, task: 'the task' }),
			event('t1', 'role_start', { role: 'coder', depth: 1, parent: 'orchestrator', task: 'code' }),
			event('t2', 'interrupt', {}),
			event('t3', 'role_start', { role: 'loop_detector', depth: 1, task: 'detect' }),
			event('t4', 'tool_call', { role: 'loop_detector', tool: 'read_message_window', arguments: '{}' }),
			event('t5', 'observe', { role: 'coder', details: 'peek at the looping coder' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')), NOW)
		const observe = defined(observesOf(model)[0], 'observe')
		expect(observe).toBeDefined()
		const readTool = defined(model.participants.find((p) => p.role === 'read_message_window'), 'read_message_window participant')
		const coder = defined(model.participants.find((p) => p.role === 'coder'), 'coder participant')
		expect(observe.source).toBe(readTool.id)
		expect(observe.destination).toBe(coder.id)
		expect(observe.lifecycle).toBe('settled')
		expect(detailOf(events, meta('running'), 'op-5')).toBe('peek at the looping coder')
		// The observe did not change the open call chains on either stack.
		expect(callChainOf(model, 'main').length).toBe(2)
		assertHelpersSensible(model)
	})

	test('a terminate closes the targeted paused-stack call immediately and emits a terminate op', () => {
		const events = [
			event('t0', 'role_start', { role: 'orchestrator', depth: 0, task: 'the task' }),
			event('t1', 'role_start', { role: 'coder', depth: 1, parent: 'orchestrator', task: 'code' }),
			event('t2', 'interrupt', {}),
			event('t3', 'role_start', { role: 'loop_detector', depth: 1, task: 'detect' }),
			event('t4', 'tool_call', { role: 'loop_detector', tool: 'rewind_stack', arguments: '{}' }),
			event('t5', 'terminate', { role: 'coder', details: 'revert the looping coder' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')), NOW)
		const terminate = defined(terminatesOf(model)[0], 'terminate')
		expect(terminate).toBeDefined()
		const rewindTool = defined(model.participants.find((p) => p.role === 'rewind_stack'), 'rewind_stack participant')
		const coder = defined(model.participants.find((p) => p.role === 'coder'), 'coder participant')
		expect(terminate.source).toBe(rewindTool.id)
		expect(terminate.destination).toBe(coder.id)
		// The terminated coder call is closed and removed from the main stack's open chain.
		expect(callChainOf(model, 'main').length).toBe(1)
		expect(callChainOf(model, 'main').map((o) => o.destination)).not.toContain(coder.id)
		const coderCall = model.operations.find((o) => o.kind === 'call' && o.destination === coder.id)
		expect(defined(coderCall, 'coderCall').lifecycle).toBe('settled')
		assertHelpersSensible(model)
	})

	test('a freshly preempted stack is active on arrival with its root as the active participant', () => {
		const events = [
			event('t0', 'role_start', { role: 'orchestrator', depth: 0, task: 'the task' }),
			event('t1', 'role_start', { role: 'coder', depth: 1, parent: 'orchestrator', task: 'code' }),
			event('t2', 'interrupt', {}),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')), NOW)
		// The interrupt has landed but its first call has not: the fresh stack is active and its root is the current worker, while the main stack pauses with the coder call still open.
		expect(activeStack(model)).not.toBe('main')
		const interrupt = defined(model.participants.find((p) => p.kind === 'interrupt'), 'interrupt')
		expect(interrupt).toBeDefined()
		expect(activeParticipant(model)).toBe(interrupt.id)
		expect(stacksOf(model)).toEqual(['main', 'interrupt-1-stack'])
		expect(callChainOf(model, 'main')).toHaveLength(2)
		// The stack records name the fresh stack and its root before any operation lands on it.
		expect(model.stacks).toEqual([
			{ id: 'main', root: 'human:root' },
			{ id: 'interrupt-1-stack', root: interrupt.id },
		])
		assertHelpersSensible(model)
	})

	test('a resolved stack yields activity to the preempted stack while its final return lingers until the next operation', () => {
		const events = [
			event('t0', 'role_start', { role: 'orchestrator', depth: 0, task: 'the task' }),
			event('t1', 'role_start', { role: 'coder', depth: 1, parent: 'orchestrator', task: 'code' }),
			event('t2', 'interrupt', {}),
			event('t3', 'role_start', { role: 'loop_detector', depth: 1, task: 'detect' }),
			event('t4', 'role_finished', { role: 'loop_detector', status: 'success', summary: 'no loop' }),
		]
		const resolved = deriveInteractionModel(snapshot(events, meta('running')), NOW)
		const interrupt = defined(resolved.participants.find((p) => p.kind === 'interrupt'), 'interrupt')
		const loopDetector = defined(resolved.participants.find((p) => p.role === 'loop_detector'), 'loop_detector participant')
		const coder = defined(resolved.participants.find((p) => p.role === 'coder'), 'coder participant')
		// The loop detector's return closed the interrupt stack's root call: the coder is the current worker again, and the resolved stack's return leg stays in flight (visible) rather than vanishing at once.
		expect(activeStack(resolved)).toBe('main')
		expect(activeParticipant(resolved)).toBe(coder.id)
		const leg = resolved.operations.filter((o) => o.lifecycle === 'in_flight' && o.kind === 'return')
		expect(leg.length).toBe(1)
		expect(defined(leg[0], 'leg[0]').kind).toBe('return')
		expect(defined(leg[0], 'leg[0]').source).toBe(loopDetector.id)
		expect(defined(leg[0], 'leg[0]').destination).toBe(interrupt.id)
		expect(stacksOf(resolved)).toEqual(['main', 'interrupt-1-stack'])

		// The preempted stack's next operation confirms the leg: it settles and the interrupt stack closes out.
		const resumed = deriveInteractionModel(snapshot([...events, event('t5', 'tool_call', { role: 'coder', tool: 'read_file', arguments: '{}' })], meta('running')), NOW)
		expect(resumed.operations.filter((o) => o.lifecycle === 'in_flight' && o.kind === 'return').length).toBe(0)
		expect(stacksOf(resumed)).toEqual(['main'])
		assertHelpersSensible(resumed)
	})

	test('a nested interrupt preempts an interrupt: three stacks coexist, then resolve innermost-first', () => {
		const events = [
			event('t0', 'role_start', { role: 'orchestrator', depth: 0, task: 'the task' }),
			event('t1', 'role_start', { role: 'coder', depth: 1, parent: 'orchestrator', task: 'code' }),
			event('t2', 'interrupt', {}),
			event('t3', 'role_start', { role: 'loop_detector', depth: 1, task: 'detect outer' }),
			event('t4', 'interrupt', {}),
			event('t5', 'role_start', { role: 'loop_detector', depth: 2, task: 'detect inner' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')), NOW)
		// Three stacks render rows: main (root), interrupt-1, interrupt-2.
		expect(stacksOf(model).length).toBe(3)
		const interrupts = model.participants.filter((p) => p.kind === 'interrupt')
		expect(interrupts.length).toBe(2)
		expect(defined(interrupts[0], 'interrupts[0]').id).not.toBe(defined(interrupts[1], 'interrupts[1]').id)
		// Each interrupt's loop_detector is on its own stack with its own participant.
		const detectors = model.participants.filter((p) => p.role === 'loop_detector')
		expect(detectors.length).toBe(2)
		assertHelpersSensible(model)
	})

	test('the main stack resumes after the interrupt resolves, keeping the interrupted call open', () => {
		const events = [
			event('t0', 'role_start', { role: 'orchestrator', depth: 0, task: 'the task' }),
			event('t1', 'role_start', { role: 'coder', depth: 1, parent: 'orchestrator', task: 'code' }),
			event('t2', 'interrupt', {}),
			event('t3', 'role_start', { role: 'loop_detector', depth: 1, task: 'detect' }),
			event('t4', 'role_finished', { role: 'loop_detector', status: 'success', summary: 'no loop' }),
			event('t5', 'tool_call', { role: 'coder', tool: 'read_file', arguments: '{}' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')), NOW)
		// The interrupt resolved; the coder's tool call is back on the active main stack.
		expect(activeStack(model)).toBe('main')
		const readFile = defined(model.participants.find((p) => p.role === 'read_file'), 'read_file participant')
		expect(readFile).toBeDefined()
		const toolCall = model.operations.find((o) => o.kind === 'call' && o.destination === readFile.id)
		expect(defined(toolCall, 'toolCall').stack).toBe('main')
		expect(defined(toolCall, 'toolCall').lifecycle).toBe('in_flight')
		assertHelpersSensible(model)
	})
})

describe('deriveInteractionModel — operator inquiry interrupt', () => {
	function inquiryRunEvents(): LogEvent[] {
		return [
			event('t0', 'role_start', { role: 'orchestrator', depth: 0, task: 'build the site' }),
			event('t1', 'role_start', { role: 'coder', depth: 1, parent: 'orchestrator', task: 'write the page' }),
			event('t2', 'interrupt', { trigger: 'inquiry', handler: 'inquiry_responder', target: 'coder-1-2', message: 'what is happening?' }),
		]
	}

	test('an inquiry interrupt pushes a new stack rooted at a fresh human asker', () => {
		const model = deriveInteractionModel(snapshot(inquiryRunEvents(), meta('running')), NOW)
		const asker = defined(model.participants.find((p) => p.kind === 'human' && p.id !== 'human:root'), 'asker')
		expect(asker).toBeDefined()
		expect(asker.id).toBe('human:asker:1')
		expect(asker.role).toBe('human')
		expect(model.participants.every((p) => p.kind !== 'interrupt')).toBe(true)
		expect(model.stacks).toEqual([
			{ id: 'main', root: 'human:root' },
			{ id: 'interrupt-1-stack', root: asker.id },
		])
		// The fresh stack is active on arrival; the main stack pauses with both calls still open.
		expect(activeStack(model)).toBe('interrupt-1-stack')
		expect(activeParticipant(model)).toBe(asker.id)
		expect(callChainOf(model, 'main')).toHaveLength(2)
		expect(stacksOf(model)).toEqual(['main', 'interrupt-1-stack'])
		assertHelpersSensible(model)
	})

	test('the handler role_start records a call from the asker carrying the question as details', () => {
		const events = [
			...inquiryRunEvents(),
			event('t3', 'role_start', { role: 'inquiry_responder', depth: 2, parent: 'coder', task: 'the generated briefing' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')), NOW)
		const responder = defined(model.participants.find((p) => p.role === 'inquiry_responder'), 'inquiry_responder participant')
		expect(responder).toBeDefined()
		const call = defined(model.operations.find((o) => o.kind === 'call' && o.destination === responder.id), 'call')
		expect(call).toBeDefined()
		expect(call.stack).toBe('interrupt-1-stack')
		expect(call.source).toBe('human:asker:1')
		// The tooltip on the You→responder call shows the question, not the generated briefing.
		expect(detailOf(events, meta('running'), 'op-3')).toBe('what is happening?')
		assertHelpersSensible(model)
	})

	test('an inquiry interrupt without a message falls back to the task text for the call details', () => {
		const events = [
			event('t0', 'role_start', { role: 'orchestrator', depth: 0, task: 'build the site' }),
			event('t1', 'interrupt', { trigger: 'inquiry', handler: 'inquiry_responder', target: 'orchestrator-0-1' }),
			event('t2', 'role_start', { role: 'inquiry_responder', depth: 1, parent: 'orchestrator', task: 'the generated briefing' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')), NOW)
		const responder = defined(model.participants.find((p) => p.role === 'inquiry_responder'), 'inquiry_responder participant')
		const call = defined(model.operations.find((o) => o.kind === 'call' && o.destination === responder.id), 'call')
		expect(detailOf(events, meta('running'), call.id)).toBe('the generated briefing')
		assertHelpersSensible(model)
	})

	test('the inquiry stack pauses the main stack and pops when the handler finishes', () => {
		const events = [
			...inquiryRunEvents(),
			event('t3', 'role_start', { role: 'inquiry_responder', depth: 2, parent: 'coder', task: 'the generated briefing' }),
			event('t4', 'role_finished', { role: 'inquiry_responder', depth: 2, status: 'success', summary: 'the coder is writing the page', parent: 'coder' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')), NOW)
		// The handler's return closed the inquiry stack's root call: the main stack is active again with the coder still open, and the resolved stack's final return lingers (visible) until the next operation confirms it.
		expect(activeStack(model)).toBe('main')
		expect(callChainOf(model, 'main')).toHaveLength(2)
		const leg = model.operations.filter((o) => o.lifecycle === 'in_flight' && o.kind === 'return')
		expect(leg).toHaveLength(1)
		expect(defined(leg[0], 'leg[0]').source).toBe(defined(model.participants.find((p) => p.role === 'inquiry_responder'), 'inquiry_responder participant').id)
		expect(defined(leg[0], 'leg[0]').destination).toBe('human:asker:1')
		expect(stacksOf(model)).toEqual(['main', 'interrupt-1-stack'])
		assertHelpersSensible(model)
	})

	test('a non-inquiry trigger still roots the new stack at a synthetic interrupt participant', () => {
		const events = [
			event('t0', 'role_start', { role: 'orchestrator', depth: 0, task: 'build the site' }),
			event('t1', 'interrupt', { trigger: 'loop_check', handler: 'loop_detector', target: 'orchestrator-0-1' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')), NOW)
		const interrupt = defined(model.participants.find((p) => p.kind === 'interrupt'), 'interrupt')
		expect(interrupt).toBeDefined()
		expect(interrupt.id).toBe('interrupt:1')
		expect(model.participants.filter((p) => p.kind === 'human')).toHaveLength(1)
		expect(model.stacks).toEqual([
			{ id: 'main', root: 'human:root' },
			{ id: 'interrupt-1-stack', root: interrupt.id },
		])
		assertHelpersSensible(model)
	})
})

describe('deriveInteractionOperationDetail', () => {
	test('returns null for an unknown operation id', () => {
		const events = [
			event('t0', 'role_start', { role: 'coder', depth: 0, task: 'work' }),
		]
		expect(deriveInteractionOperationDetail(snapshot(events, meta('running')), NOW, 'op-9')).toBeNull()
	})

	test('an operation without detail material resolves to details null, not an error', () => {
		const events = [
			event('t0', 'role_start', { role: 'coder', depth: 0 }),
		]
		const detail = deriveInteractionOperationDetail(snapshot(events, meta('running')), NOW, 'op-1')
		expect(detail).not.toBeNull()
		expect(present(detail, 'detail').details).toBeNull()
	})

	test('a tool result details pretty-print the full result payload', () => {
		const events = [
			event('t0', 'role_start', { role: 'coder', depth: 0, task: 'work' }),
			event('t1', 'tool_call', { role: 'coder', tool: 'read_file', arguments: '{"path":"README.md"}' }),
			event('t2', 'tool_result', { role: 'coder', tool: 'read_file', kind: 'success', result: { kind: 'success', data: { content: '# Project' } } }),
		]
		expect(detailOf(events, meta('running'), 'op-3')).toBe('```json\n{\n  "kind": "success",\n  "data": {\n    "content": "# Project"\n  }\n}\n```')
	})

	test('a terminate resolves its details text on demand', () => {
		const events = [
			event('t0', 'role_start', { role: 'orchestrator', depth: 0, task: 'the task' }),
			event('t1', 'role_start', { role: 'coder', depth: 1, parent: 'orchestrator', task: 'code' }),
			event('t2', 'interrupt', {}),
			event('t3', 'role_start', { role: 'loop_detector', depth: 1, task: 'detect' }),
			event('t4', 'tool_call', { role: 'loop_detector', tool: 'rewind_stack', arguments: '{}' }),
			event('t5', 'terminate', { role: 'coder', details: 'revert the looping coder' }),
		]
		expect(detailOf(events, meta('running'), 'op-5')).toBe('revert the looping coder')
	})

	test('a details request for one operation never depends on the poll path', () => {
		// The detail walk is the same derivation the flow endpoint runs; resolving one operation's
		// details must not disturb what the poll-path model reports (no details anywhere).
		const events = [
			event('t0', 'role_start', { role: 'coder', depth: 0, task: 'work' }),
			event('t1', 'tool_call', { role: 'coder', tool: 'read_file', arguments: '{"path":"README.md"}' }),
		]
		const detail = deriveInteractionOperationDetail(snapshot(events, meta('running')), NOW, 'op-2')
		expect(present(detail, 'detail').details).toContain('"path": "README.md"')
		const model = deriveInteractionModel(snapshot(events, meta('running')), NOW)
		for (const operation of model.operations) {
			expect(operation).not.toHaveProperty('details')
		}
	})
})
