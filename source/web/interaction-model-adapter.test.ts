import { describe, expect, test } from 'bun:test'
import type { LogEvent, RunMeta } from '../executor/types.js'
import type { RunSnapshot } from '../run-log/index.js'
import { deriveInteractionModel, deriveInteractionOperationDetail } from './interaction-model-adapter.js'
import { activeParticipant, activeStack, callChainOf, fateOf, observesOf, openInvocationsOf, stacksOf, terminatesOf } from './static/ts/interaction-model.js'
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

// Resolves one operation's on-demand details, failing the test when the id names no operation.
function detailOf(events: LogEvent[], runMeta: RunMeta | null, operationId: string): string | null {
	const detail = deriveInteractionOperationDetail(snapshot(events, runMeta), operationId)
	expect(detail).not.toBeNull()
	return detail === null ? null : detail.details
}

describe('deriveInteractionModel — single-role completion', () => {
	test('produces a human→role call and a role→human return, terminal and settled', () => {
		const events = [
			event('2026-01-01T00:00:00.000Z', 'role_start', { role: 'orchestrator', depth: 0, task: 'do the thing' }),
			event('2026-01-01T00:00:05.000Z', 'role_finished', { role: 'orchestrator', depth: 0, status: 'success', summary: 'done' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('success')))
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
		const model = deriveInteractionModel(snapshot(events, meta('success')))
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
		const model = deriveInteractionModel(snapshot(events, meta('running')))
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
		const model = deriveInteractionModel(snapshot(events, meta('running')))
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
		const model = deriveInteractionModel(snapshot(events, meta('success')))
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
		const model = deriveInteractionModel(snapshot(events, meta('success')))
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
		const model = deriveInteractionModel(snapshot(events, meta('running')))
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
		const model = deriveInteractionModel(snapshot(events, meta('running')))
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
		const model = deriveInteractionModel(snapshot(events, meta('running')))
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
		const model = deriveInteractionModel(snapshot(events, meta('success')))
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
		const model = deriveInteractionModel(snapshot(events, meta('needs_clarification')))
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
		const model = deriveInteractionModel(snapshot(events, meta('success')))
		const call = defined(model.operations[0], 'model.operations[0]')
		expect(call.metrics?.tokens).toBe(120)
		expect(call.metrics?.promptTokens).toBe(100)
		expect(call.metrics?.completionTokens).toBe(20)
		expect(call.metrics?.cachedPromptTokens).toBe(40)
		expect(call.metrics?.lastPromptTokens).toBe(100)
		expect(call.metrics?.elapsedSeconds).toBe(6)
		assertHelpersSensible(model)
	})

	test('lastPromptTokens assigns the last turn’s prompt size while the bill counters sum — the current-context-window contract', () => {
		const events = [
			event('2026-01-01T00:00:00.000Z', 'role_start', { role: 'coder', depth: 0, task: 'work' }),
			event('2026-01-01T00:00:01.000Z', 'llm_call', { role: 'coder', usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedPromptTokens: 40 } }),
			event('2026-01-01T00:00:02.000Z', 'llm_call', { role: 'coder', usage: { promptTokens: 200, completionTokens: 10, totalTokens: 210, cachedPromptTokens: 0 } }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')))
		const call = defined(model.operations[0], 'model.operations[0]')
		// Assignment semantics: the invocation's current context window size is the LAST turn's 200, never the 300 prompt sum.
		expect(call.metrics?.lastPromptTokens).toBe(200)
		// The spend counters keep accumulating: 330 total, 300 prompt, 30 completion.
		expect(call.metrics?.tokens).toBe(330)
		expect(call.metrics?.promptTokens).toBe(300)
		expect(call.metrics?.completionTokens).toBe(30)
		// The cached subset still sums its reported figures — 40 from the first turn plus the second turn's reported 0.
		expect(call.metrics?.cachedPromptTokens).toBe(40)
		assertHelpersSensible(model)
	})

	test('llm_retry usage folds into the same call op as its llm_call — retry spend is real spend', () => {
		const events = [
			event('2026-01-01T00:00:00.000Z', 'role_start', { role: 'coder', depth: 0, task: 'work' }),
			// The retry event immediately precedes its call's llm_call (source/executor/engine.ts) and matches the same role.
			event('2026-01-01T00:00:01.000Z', 'llm_retry', { role: 'coder', roleId: 'coder-0-1', discardedAttempts: 2, usage: { promptTokens: 90, completionTokens: 10, totalTokens: 100 } }),
			event('2026-01-01T00:00:02.000Z', 'llm_call', { role: 'coder', usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedPromptTokens: 40 } }),
			event('2026-01-01T00:00:06.000Z', 'role_finished', { role: 'coder', depth: 0, status: 'success' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('success')))
		const call = defined(model.operations[0], 'model.operations[0]')
		// 220 = the discarded attempts' 100 + the final attempt's 120; the breakdown sums across both.
		expect(call.metrics?.tokens).toBe(220)
		expect(call.metrics?.promptTokens).toBe(190)
		expect(call.metrics?.completionTokens).toBe(30)
		expect(call.metrics?.cachedPromptTokens).toBe(40)
		// The discarded attempt's 90-token prompt is superseded: the context figure reads the final attempt's 100.
		expect(call.metrics?.lastPromptTokens).toBe(100)
		assertHelpersSensible(model)
	})

	test('an llm_retry without usage folds nothing, and a summarizer_llm_call touches neither participants nor operations', () => {
		const events = [
			event('2026-01-01T00:00:00.000Z', 'role_start', { role: 'coder', depth: 0, task: 'work' }),
			event('2026-01-01T00:00:01.000Z', 'llm_retry', { role: 'coder', roleId: 'coder-0-1', discardedAttempts: 1 }),
			event('2026-01-01T00:00:02.000Z', 'llm_call', { role: 'coder', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }),
			// The summarizer is not a role turn: its spend is run-wide only (source/run-log/derive/budget.ts deriveBudgets), so it creates no participant and no operation here.
			event('2026-01-01T00:00:03.000Z', 'summarizer_llm_call', { usage: { promptTokens: 500, completionTokens: 30, totalTokens: 530 } }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')))
		expect(model.operations).toHaveLength(1)
		expect(model.participants.map((p) => p.role)).toEqual(['human', 'coder'])
		const call = defined(model.operations[0], 'model.operations[0]')
		expect(call.metrics?.tokens).toBe(15)
		assertHelpersSensible(model)
	})

	test('a tool call never receives usage, so its token counters stay null and its open elapsed is null', () => {
		const events = [
			event('2026-01-01T00:00:00.000Z', 'role_start', { role: 'coder', depth: 0, task: 'work' }),
			event('2026-01-01T00:00:01.000Z', 'tool_call', { role: 'coder', tool: 'read_file', arguments: '{"path":"README.md"}' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')))
		const toolCall = defined(model.operations[1], 'model.operations[1]')
		expect(toolCall.kind).toBe('call')
		expect(toolCall.metrics?.tokens).toBeNull()
		expect(toolCall.metrics?.promptTokens).toBeNull()
		expect(toolCall.metrics?.completionTokens).toBeNull()
		expect(toolCall.metrics?.cachedPromptTokens).toBeNull()
		expect(toolCall.metrics?.lastPromptTokens).toBeNull()
		// No return has landed, so there is no stored end to span to; the elapsed is null and the client fills it from its own clock.
		expect(toolCall.metrics?.elapsedSeconds).toBeNull()
		assertHelpersSensible(model)
	})

	test('an agent call whose llm_call omitted usage carries null token counters — endpoint silence is never a fabricated zero', () => {
		const events = [
			event('2026-01-01T00:00:00.000Z', 'role_start', { role: 'coder', depth: 0, task: 'work' }),
			event('2026-01-01T00:00:01.000Z', 'llm_call', { role: 'coder' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')))
		const call = defined(model.operations[0], 'model.operations[0]')
		expect(call.metrics?.tokens).toBeNull()
		expect(call.metrics?.promptTokens).toBeNull()
		expect(call.metrics?.completionTokens).toBeNull()
		expect(call.metrics?.cachedPromptTokens).toBeNull()
		expect(call.metrics?.lastPromptTokens).toBeNull()
		// The call is still open (no return), so its elapsed is null in the clock-independent payload.
		expect(call.metrics?.elapsedSeconds).toBeNull()
		assertHelpersSensible(model)
	})

	test('a reported zero stays numeric — a {0, 0} usage folds in as numbers, not null', () => {
		const events = [
			event('2026-01-01T00:00:00.000Z', 'role_start', { role: 'coder', depth: 0, task: 'work' }),
			event('2026-01-01T00:00:01.000Z', 'llm_call', { role: 'coder', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')))
		const call = defined(model.operations[0], 'model.operations[0]')
		expect(call.metrics?.tokens).toBe(0)
		expect(call.metrics?.promptTokens).toBe(0)
		expect(call.metrics?.completionTokens).toBe(0)
		// A reported zero is the context window size the endpoint measured, so it folds in as a numeric zero too.
		expect(call.metrics?.lastPromptTokens).toBe(0)
		// The usage object did not report a cached share, so the cached subset stays null even though the other counters turned numeric.
		expect(call.metrics?.cachedPromptTokens).toBeNull()
		assertHelpersSensible(model)
	})

	test('cachedPromptTokens stays null until a usage that reports it folds in, then accumulates only reported figures', () => {
		const events = [
			event('2026-01-01T00:00:00.000Z', 'role_start', { role: 'coder', depth: 0, task: 'work' }),
			// First turn reports no cached share; second turn reports one. The null must survive the first fold.
			event('2026-01-01T00:00:01.000Z', 'llm_call', { role: 'coder', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }),
			event('2026-01-01T00:00:02.000Z', 'llm_call', { role: 'coder', usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30, cachedPromptTokens: 7 } }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')))
		const call = defined(model.operations[0], 'model.operations[0]')
		expect(call.metrics?.tokens).toBe(45)
		expect(call.metrics?.promptTokens).toBe(30)
		expect(call.metrics?.completionTokens).toBe(15)
		expect(call.metrics?.cachedPromptTokens).toBe(7)
		assertHelpersSensible(model)
	})

	test('an in-flight call reports null elapsed — its live span is the client’s to compute', () => {
		const events = [
			event('2026-01-01T00:00:00.000Z', 'role_start', { role: 'coder', depth: 0, task: 'work' }),
			event('2026-01-01T00:00:01.000Z', 'llm_call', { role: 'coder', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')))
		const call = defined(model.operations[0], 'model.operations[0]')
		expect(call.lifecycle).toBe('in_flight')
		expect(call.metrics?.tokens).toBe(15)
		expect(call.metrics?.elapsedSeconds).toBeNull()
		assertHelpersSensible(model)
	})
})

describe('deriveInteractionModel — root human and graceful absence', () => {
	test('the root human is always present even for an empty or unreadable run', () => {
		const model = deriveInteractionModel(snapshot([], null))
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
		const model = deriveInteractionModel(snapshot(events, meta('success')))
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
		const frame0 = deriveInteractionModel(snapshot(events.slice(0, 1), meta('running')))
		const frame1 = deriveInteractionModel(snapshot(events.slice(0, 2), meta('running')))
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
		const frame7 = deriveInteractionModel(snapshot(events.slice(0, 8), meta('running')))
		expect(frame7.operations.filter((o) => o.kind === 'return' && o.lifecycle === 'in_flight').length).toBe(1)
		// Frame 8 (coder llm_call_start): the coder's call transit settles, but the write_file return must still linger — llm_call_start settles only the call transit, not the lingering return.
		const frame8 = deriveInteractionModel(snapshot(events.slice(0, 9), meta('running')))
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
		const frame9 = deriveInteractionModel(snapshot(events.slice(0, 10), meta('running')))
		expect(frame9.operations.filter((o) => o.kind === 'return' && o.lifecycle === 'in_flight').length).toBe(0)
	})

	test('a call with only role_start + llm_call (no llm_call_start) stays in transit', () => {
		const events = [
			event('t0', 'role_start', { role: 'coder', depth: 0, task: 'work' }),
			event('t1', 'llm_call', { role: 'coder', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')))
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
		const model = deriveInteractionModel(snapshot(events, meta('success')))
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
		const model = deriveInteractionModel(snapshot(events, meta('running')))
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
		const model = deriveInteractionModel(snapshot(events, meta('running')))
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
		const model = deriveInteractionModel(snapshot(events, meta('running')))
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
		const model = deriveInteractionModel(snapshot(events, meta('running')))
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
		const resolved = deriveInteractionModel(snapshot(events, meta('running')))
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
		const resumed = deriveInteractionModel(snapshot([...events, event('t5', 'tool_call', { role: 'coder', tool: 'read_file', arguments: '{}' })], meta('running')))
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
		const model = deriveInteractionModel(snapshot(events, meta('running')))
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
		const model = deriveInteractionModel(snapshot(events, meta('running')))
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
		const model = deriveInteractionModel(snapshot(inquiryRunEvents(), meta('running')))
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
		const model = deriveInteractionModel(snapshot(events, meta('running')))
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
		const model = deriveInteractionModel(snapshot(events, meta('running')))
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
		const model = deriveInteractionModel(snapshot(events, meta('running')))
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
		const model = deriveInteractionModel(snapshot(events, meta('running')))
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
		expect(deriveInteractionOperationDetail(snapshot(events, meta('running')), 'op-9')).toBeNull()
	})

	test('an operation without detail material resolves to details null, not an error', () => {
		const events = [
			event('t0', 'role_start', { role: 'coder', depth: 0 }),
		]
		const detail = deriveInteractionOperationDetail(snapshot(events, meta('running')), 'op-1')
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
		const detail = deriveInteractionOperationDetail(snapshot(events, meta('running')), 'op-2')
		expect(present(detail, 'detail').details).toContain('"path": "README.md"')
		const model = deriveInteractionModel(snapshot(events, meta('running')))
		for (const operation of model.operations) {
			expect(operation).not.toHaveProperty('details')
		}
	})
})

describe('deriveInteractionModel — clock independence', () => {
	// The payload must be a pure function of stored data so an ETag over it can detect change: for the same snapshot, two derivations at different wall-clock moments are deeply equal.
	test('two derivations of the same snapshot are deeply equal', () => {
		const events = [
			event('2026-01-01T00:00:00.000Z', 'role_start', { role: 'orchestrator', depth: 0, task: 'the task' }),
			event('2026-01-01T00:00:01.000Z', 'llm_call_start', { role: 'orchestrator' }),
			event('2026-01-01T00:00:02.000Z', 'llm_call', { role: 'orchestrator', usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 } }),
			event('2026-01-01T00:00:03.000Z', 'role_start', { role: 'coder', depth: 1, parent: 'orchestrator', task: 'code' }),
			event('2026-01-01T00:00:04.000Z', 'tool_call', { role: 'coder', tool: 'read_file', arguments: '{}' }),
		]
		const first = deriveInteractionModel(snapshot(events, meta('running')))
		const second = deriveInteractionModel(snapshot(events, meta('running')))
		expect(second).toEqual(first)
	})

	test('an open call reports null elapsed while a returned call reports its deterministic start-to-return span', () => {
		const events = [
			event('2026-01-01T00:00:00.000Z', 'role_start', { role: 'coder', depth: 0, task: 'work' }),
			event('2026-01-01T00:00:01.000Z', 'llm_call_start', { role: 'coder' }),
			event('2026-01-01T00:00:03.000Z', 'role_start', { role: 'critic', depth: 1, parent: 'coder', task: 'review' }),
			event('2026-01-01T00:00:04.000Z', 'role_finished', { role: 'critic', depth: 1, status: 'success', summary: 'ok', parent: 'coder' }),
			event('2026-01-01T00:00:09.000Z', 'role_finished', { role: 'coder', depth: 0, status: 'success', summary: 'done' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('success')))
		// The critic call returns at 00:00:04 (started 00:00:03), a 1s span; the coder call returns at 00:00:09 (started 00:00:00), a 9s span.
		const criticCall = defined(model.operations.find((operation) => operation.kind === 'call' && operation.destination === defined(model.participants.find((participant) => participant.role === 'critic'), 'critic').id), 'criticCall')
		const coderCall = defined(model.operations.find((operation) => operation.kind === 'call' && operation.destination === defined(model.participants.find((participant) => participant.role === 'coder'), 'coder').id), 'coderCall')
		expect(criticCall.metrics?.elapsedSeconds).toBe(1)
		expect(coderCall.metrics?.elapsedSeconds).toBe(9)

		// The same prefix without the coder's finish leaves the coder call open: its elapsed is null, not a clock-derived figure.
		const open = deriveInteractionModel(snapshot(events.slice(0, 4), meta('running')))
		const openCoderCall = defined(open.operations.find((operation) => operation.kind === 'call' && operation.destination === defined(open.participants.find((participant) => participant.role === 'coder'), 'coder').id), 'openCoderCall')
		expect(openCoderCall.metrics?.elapsedSeconds).toBeNull()
	})

	test('a terminal run freezes a never-returned call at the stored end, while a running run leaves it null', () => {
		const events = [
			event('2026-01-01T00:00:00.000Z', 'role_start', { role: 'coder', depth: 0, task: 'work' }),
			event('2026-01-01T00:00:01.000Z', 'tool_call', { role: 'coder', tool: 'read_file', arguments: '{}' }),
		]
		const terminalMeta: RunMeta = { ...meta('success'), endTime: '2026-01-01T00:00:10.000Z' }
		const first = deriveInteractionModel(snapshot(events, terminalMeta))
		const second = deriveInteractionModel(snapshot(events, terminalMeta))
		const toolCall = defined(first.operations.find((operation) => operation.kind === 'call' && operation.destination.startsWith('tool:')), 'toolCall')
		// The tool call never returned; on a terminal run its span runs start → meta.endTime, so it is non-null and identical across derivations (the client's clock no longer advances a finished run).
		expect(toolCall.metrics?.elapsedSeconds).toBe(9)
		const toolCallAgain = defined(second.operations.find((operation) => operation.kind === 'call' && operation.destination.startsWith('tool:')), 'toolCallAgain')
		expect(toolCallAgain.metrics?.elapsedSeconds).toBe(toolCall.metrics?.elapsedSeconds)
		// The same open call on a running run carries null so the browser ticks it live.
		const running = deriveInteractionModel(snapshot(events, meta('running')))
		const runningToolCall = defined(running.operations.find((operation) => operation.kind === 'call' && operation.destination.startsWith('tool:')), 'runningToolCall')
		expect(runningToolCall.metrics?.elapsedSeconds).toBeNull()
	})

	test('needs_clarification is terminal for elapsed: an open ask_human call freezes at the stored end while staying in flight', () => {
		const events = [
			event('2026-01-01T00:00:00.000Z', 'role_start', { role: 'orchestrator', depth: 0, task: 'decide' }),
			event('2026-01-01T00:00:02.000Z', 'ask_human', { id: 'q1', question: 'Which framework?' }),
		]
		const clarificationMeta: RunMeta = { ...meta('needs_clarification'), endTime: '2026-01-01T00:00:12.000Z' }
		const model = deriveInteractionModel(snapshot(events, clarificationMeta))
		const askCall = defined(model.operations.find((operation) => operation.kind === 'call' && operation.destination.startsWith('human:answerer')), 'askCall')
		// The run is terminal for the client's polling set, so the question's elapsed is frozen at the stored end even though the call stays in flight awaiting an answer.
		expect(askCall.lifecycle).toBe('in_flight')
		expect(askCall.metrics?.elapsedSeconds).toBe(10)
	})
})

describe('deriveInteractionModel — identity-keyed invocation lifecycle', () => {
	function roleStart(timestamp: string, role: string, callId: string, parentCallId?: string): LogEvent {
		const payload: Record<string, unknown> = { role, callId, roleId: callId.replace(/^role:/, ''), task: `${role} task` }
		if (parentCallId !== undefined) payload['parentCallId'] = parentCallId
		return event(timestamp, 'role_start', payload)
	}

	test('explicit ids parent a child role under its caller role invocation', () => {
		const events = [
			roleStart('t0', 'orchestrator', 'role:orchestrator-0-1'),
			roleStart('t1', 'coder', 'role:coder-1-2', 'role:orchestrator-0-1'),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')))
		const orchestratorCall = defined(model.operations.find((operation) => operation.callId === 'role:orchestrator-0-1' && operation.kind === 'call'), 'orchestratorCall')
		const coderCall = defined(model.operations.find((operation) => operation.callId === 'role:coder-1-2' && operation.kind === 'call'), 'coderCall')
		expect(orchestratorCall.source).toBe('human:root')
		expect(orchestratorCall.parentCallId).toBeUndefined()
		expect(coderCall.source).toBe('role:orchestrator-0-1')
		expect(coderCall.parentCallId).toBe('role:orchestrator-0-1')
		expect(coderCall.stack).toBe('main')
		expect(callChainOf(model, 'main').map((operation) => operation.callId)).toEqual(['role:orchestrator-0-1', 'role:coder-1-2'])
		assertHelpersSensible(model)
	})

	test('sibling tool calls keep their own parent and the active path excludes the earlier sibling', () => {
		const events = [
			roleStart('t0', 'coder', 'role:coder-0-1'),
			event('t1', 'tool_call', { role: 'coder', tool: 'read_file', callId: 'tool:tc-1', parentCallId: 'role:coder-0-1', arguments: '{}' }),
			event('t2', 'tool_call', { role: 'coder', tool: 'search_text', callId: 'tool:tc-2', parentCallId: 'role:coder-0-1', arguments: '{}' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')))
		const toolCalls = model.operations.filter((operation) => operation.kind === 'call' && operation.callId !== 'role:coder-0-1')
		expect(toolCalls).toHaveLength(2)
		for (const call of toolCalls) {
			expect(call.parentCallId).toBe('role:coder-0-1')
			expect(call.source).toBe('role:coder-0-1')
		}
		expect(openInvocationsOf(model, 'main').map((operation) => operation.callId)).toEqual(['role:coder-0-1', 'tool:tc-1', 'tool:tc-2'])
		expect(callChainOf(model, 'main').map((operation) => operation.callId)).toEqual(['role:coder-0-1', 'tool:tc-2'])
		expect(activeParticipant(model)).toBe('tool:tc-2')
		assertHelpersSensible(model)
	})

	test('a start with no terminal stays open', () => {
		const events = [
			roleStart('t0', 'coder', 'role:coder-0-1'),
			event('t1', 'tool_call', { role: 'coder', tool: 'read_file', callId: 'tool:tc-1', parentCallId: 'role:coder-0-1', arguments: '{}' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')))
		const toolCall = defined(model.operations.find((operation) => operation.callId === 'tool:tc-1'), 'toolCall')
		expect(toolCall.lifecycle).toBe('in_flight')
		expect(openInvocationsOf(model, 'main')).toHaveLength(2)
		assertHelpersSensible(model)
	})

	test('a duplicate terminal is ignored — the first terminal wins', () => {
		const events = [
			roleStart('t0', 'coder', 'role:coder-0-1'),
			event('t1', 'tool_call', { role: 'coder', tool: 'read_file', callId: 'tool:tc-1', parentCallId: 'role:coder-0-1', arguments: '{}' }),
			event('t2', 'tool_result', { role: 'coder', tool: 'read_file', callId: 'tool:tc-1', kind: 'success', result: { ok: true } }),
			event('t3', 'tool_result', { role: 'coder', tool: 'read_file', callId: 'tool:tc-1', kind: 'error', result: { ok: false } }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')))
		const returns = model.operations.filter((operation) => operation.kind === 'return' && operation.callId === 'tool:tc-1')
		expect(returns).toHaveLength(1)
		expect(defined(returns[0], 'returns[0]').startedAt).toBe('t2')
		expect(defined(returns[0], 'returns[0]').outcome).toBe('success')
		expect(openInvocationsOf(model, 'main').map((operation) => operation.callId)).toEqual(['role:coder-0-1'])
		assertHelpersSensible(model)
	})

	test('a terminal with no start materializes a closed call+return with no guessed parent', () => {
		const events = [
			roleStart('t0', 'coder', 'role:coder-0-1'),
			event('t1', 'tool_result', { role: 'coder', tool: 'read_file', callId: 'tool:orphan', kind: 'error' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')))
		const materialized = model.operations.filter((operation) => operation.callId === 'tool:orphan')
		expect(materialized.map((operation) => operation.kind)).toEqual(['call', 'return'])
		expect(defined(materialized[0], 'materialized call').parentCallId).toBeUndefined()
		expect(defined(materialized[0], 'materialized call').source).toBe('human:root')
		expect(defined(materialized[0], 'materialized call').startedAt).toBe('t1')
		expect(defined(materialized[1], 'materialized return').startedAt).toBe('t1')
		expect(defined(materialized[1], 'materialized return').outcome).toBe('error')
		assertHelpersSensible(model)
	})

	test('a duplicate start for the same callId keeps the first participant and call', () => {
		const events = [
			roleStart('t0', 'coder', 'role:coder-0-1'),
			roleStart('t1', 'coder', 'role:coder-0-1'),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')))
		expect(model.participants.filter((participant) => participant.id === 'role:coder-0-1')).toHaveLength(1)
		expect(model.operations.filter((operation) => operation.callId === 'role:coder-0-1')).toHaveLength(1)
		expect(defined(model.operations[0], 'model.operations[0]').startedAt).toBe('t0')
		assertHelpersSensible(model)
	})

	test('an interrupt stack uses the interrupt callId as the handler parent and pops on the handler terminal', () => {
		const events = [
			roleStart('t0', 'orchestrator', 'role:orchestrator-0-1'),
			event('t1', 'interrupt', { trigger: 'loop_check', handler: 'loop_detector', target: 'orchestrator-0-1', callId: 'interrupt:abc', parentCallId: 'role:orchestrator-0-1' }),
			roleStart('t2', 'loop_detector', 'role:loop-1-1', 'interrupt:abc'),
			event('t3', 'role_finished', { role: 'loop_detector', callId: 'role:loop-1-1', status: 'success', summary: 'clear' }),
			event('t4', 'interrupt_resolved', { trigger: 'loop_check', handler: 'loop_detector', target: 'orchestrator-0-1', callId: 'interrupt:abc' }),
			event('t5', 'role_finished', { role: 'orchestrator', callId: 'role:orchestrator-0-1', status: 'success', summary: 'done' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('success')))
		const handlerCall = defined(model.operations.find((operation) => operation.callId === 'role:loop-1-1' && operation.kind === 'call'), 'handlerCall')
		expect(handlerCall.source).toBe('interrupt:abc')
		expect(handlerCall.parentCallId).toBe('interrupt:abc')
		expect(handlerCall.stack).toBe('interrupt-1-stack')
		expect(model.stacks?.[1]?.root).toBe('interrupt:abc')
		expect(stacksOf(model)).toEqual([])
		assertHelpersSensible(model)
	})

	test('a standard-level tool_result without a result body still closes by callId', () => {
		const events = [
			roleStart('t0', 'coder', 'role:coder-0-1'),
			event('t1', 'tool_call', { role: 'coder', tool: 'read_file', callId: 'tool:tc-1', parentCallId: 'role:coder-0-1', arguments: '{}' }),
			event('t2', 'tool_result', { role: 'coder', tool: 'read_file', callId: 'tool:tc-1', kind: 'success' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')))
		const ret = defined(model.operations.find((operation) => operation.kind === 'return' && operation.callId === 'tool:tc-1'), 'ret')
		expect(ret.outcome).toBe('success')
		expect(detailOf(events, meta('running'), ret.id)).toBeNull()
		expect(openInvocationsOf(model, 'main').map((operation) => operation.callId)).toEqual(['role:coder-0-1'])
		assertHelpersSensible(model)
	})

	test('ask_human and human_answer pair by the question callId', () => {
		const events = [
			roleStart('t0', 'orchestrator', 'role:orchestrator-0-1'),
			event('t1', 'ask_human', { id: 'q1', question: 'Which framework?', callId: 'tool:q1', parentCallId: 'role:orchestrator-0-1' }),
			event('t2', 'human_answer', { id: 'q1', answer: 'react', callId: 'tool:q1' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')))
		const ask = defined(model.operations.find((operation) => operation.callId === 'tool:q1' && operation.kind === 'call'), 'ask')
		const answer = defined(model.operations.find((operation) => operation.callId === 'tool:q1' && operation.kind === 'return'), 'answer')
		expect(ask.parentCallId).toBe('role:orchestrator-0-1')
		expect(answer.source).toBe(ask.destination)
		expect(detailOf(events, meta('running'), answer.id)).toBe('react')
		assertHelpersSensible(model)
	})

	test('a mixed log degrades old events to stable ids without guessing the new parent', () => {
		const events = [
			event('t0', 'role_start', { role: 'orchestrator', roleId: 'orchestrator-0-1', depth: 0, task: 'old prefix' }),
			event('t1', 'tool_call', { role: 'orchestrator', tool: 'read_file', arguments: '{}' }),
			roleStart('t2', 'coder', 'role:coder-1-2', 'role:orchestrator-0-1'),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')))
		const legacyRoleCall = defined(model.operations.find((operation) => operation.kind === 'call' && operation.callId === 'role:orchestrator-0-1'), 'legacyRoleCall')
		const legacyToolCall = defined(model.operations.find((operation) => operation.kind === 'call' && operation.destination.startsWith('tool:')), 'legacyToolCall')
		const coderCall = defined(model.operations.find((operation) => operation.callId === 'role:coder-1-2' && operation.kind === 'call'), 'coderCall')
		expect(legacyToolCall.parentCallId).toBe('role:orchestrator-0-1')
		expect(legacyToolCall.source).toBe(legacyRoleCall.destination)
		expect(coderCall.parentCallId).toBe('role:orchestrator-0-1')
		expect(coderCall.source).toBe('role:orchestrator-0-1')
		assertHelpersSensible(model)
	})
})

describe('deriveInteractionModel — id-keyed metrics, terminals, and mixed-log adoption', () => {
	function idRoleStart(timestamp: string, role: string, roleId: string, parentCallId?: string): LogEvent {
		const payload: Record<string, unknown> = { role, roleId, callId: `role:${roleId}`, task: `${role} task` }
		if (parentCallId !== undefined) payload['parentCallId'] = parentCallId
		return event(timestamp, 'role_start', payload)
	}

	test('retry spend and lastPromptTokens fold into the id-keyed role invocation, not a sibling tool', () => {
		const events = [
			idRoleStart('t0', 'coder', 'coder-0-1'),
			event('t1', 'llm_retry', { role: 'coder', roleId: 'coder-0-1', discardedAttempts: 1, usage: { promptTokens: 90, completionTokens: 10, totalTokens: 100 } }),
			event('t2', 'llm_call', { role: 'coder', roleId: 'coder-0-1', usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedPromptTokens: 40 } }),
			event('t3', 'llm_call', { role: 'coder', roleId: 'coder-0-1', usage: { promptTokens: 200, completionTokens: 10, totalTokens: 210 } }),
			event('t4', 'tool_call', { role: 'coder', tool: 'read_file', callId: 'tool:tc-1', parentCallId: 'role:coder-0-1', arguments: '{}' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')))
		const roleCall = defined(model.operations.find((operation) => operation.callId === 'role:coder-0-1' && operation.kind === 'call'), 'roleCall')
		const toolCall = defined(model.operations.find((operation) => operation.callId === 'tool:tc-1' && operation.kind === 'call'), 'toolCall')
		expect(roleCall.metrics?.tokens).toBe(430)
		expect(roleCall.metrics?.promptTokens).toBe(390)
		expect(roleCall.metrics?.completionTokens).toBe(40)
		expect(roleCall.metrics?.cachedPromptTokens).toBe(40)
		expect(roleCall.metrics?.lastPromptTokens).toBe(200)
		expect(toolCall.metrics?.tokens).toBeNull()
		assertHelpersSensible(model)
	})

	test('a duplicate role_finished is ignored after the first terminal', () => {
		const events = [
			idRoleStart('t0', 'coder', 'coder-0-1'),
			event('t1', 'role_finished', { role: 'coder', roleId: 'coder-0-1', callId: 'role:coder-0-1', status: 'success', summary: 'done' }),
			event('t2', 'role_finished', { role: 'coder', roleId: 'coder-0-1', callId: 'role:coder-0-1', status: 'error', summary: 'duplicate' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('success')))
		const returns = model.operations.filter((operation) => operation.kind === 'return' && operation.callId === 'role:coder-0-1')
		expect(returns).toHaveLength(1)
		expect(defined(returns[0], 'returns[0]').startedAt).toBe('t1')
		expect(defined(returns[0], 'returns[0]').outcome).toBe('success')
		expect(model.participants.filter((participant) => participant.role === 'coder')).toHaveLength(1)
		assertHelpersSensible(model)
	})

	test('a role terminal with no start materializes a closed pair without a parent', () => {
		const events = [
			idRoleStart('t0', 'orchestrator', 'orchestrator-0-1'),
			event('t1', 'role_finished', { role: 'ghost', roleId: 'ghost-9-9', callId: 'role:ghost-9-9', status: 'error', summary: 'lost' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')))
		const ghost = model.operations.filter((operation) => operation.callId === 'role:ghost-9-9')
		expect(ghost.map((operation) => operation.kind)).toEqual(['call', 'return'])
		expect(defined(ghost[0], 'ghost call').parentCallId).toBeUndefined()
		expect(defined(ghost[0], 'ghost call').source).toBe('human:root')
		expect(defined(ghost[1], 'ghost return').outcome).toBe('error')
		assertHelpersSensible(model)
	})

	test('id-keyed observe and terminate select the paused target by roleId, not just role name', () => {
		const events = [
			idRoleStart('t0', 'orchestrator', 'orchestrator-0-1'),
			idRoleStart('t1', 'coder', 'coder-1-1', 'role:orchestrator-0-1'),
			idRoleStart('t2', 'coder', 'coder-1-2', 'role:orchestrator-0-1'),
			event('t3', 'interrupt', { trigger: 'loop_check', handler: 'loop_detector', target: 'coder-1-1', callId: 'interrupt:abc', parentCallId: 'role:coder-1-1' }),
			idRoleStart('t4', 'loop_detector', 'loop-1-1', 'interrupt:abc'),
			event('t5', 'observe', { role: 'coder', roleId: 'coder-1-1', details: 'peek one' }),
			event('t6', 'tool_call', { role: 'loop_detector', tool: 'rewind_stack', callId: 'tool:rewind-1', parentCallId: 'role:loop-1-1', arguments: '{}' }),
			event('t7', 'terminate', { role: 'coder', roleId: 'coder-1-1', details: 'revert one' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')))
		const observe = defined(observesOf(model)[0], 'observe')
		expect(observe.destination).toBe('role:coder-1-1')
		const terminate = defined(terminatesOf(model)[0], 'terminate')
		expect(terminate.destination).toBe('role:coder-1-1')
		const mainChain = callChainOf(model, 'main').map((operation) => operation.callId)
		expect(mainChain).not.toContain('role:coder-1-1')
		expect(mainChain).toContain('role:coder-1-2')
		assertHelpersSensible(model)
	})

	test('two unclosed legacy tools parent to the open role, and a keyed terminal adopts the synthesized role start', () => {
		const events = [
			idRoleStart('t0', 'orchestrator', 'orchestrator-0-1'),
			event('t1', 'role_start', { role: 'coder', roleId: 'coder-0-1', depth: 1, task: 'old prefix' }),
			event('t2', 'tool_call', { role: 'coder', tool: 'read_file', arguments: '{}' }),
			event('t3', 'tool_call', { role: 'coder', tool: 'search_text', arguments: '{}' }),
			event('t4', 'role_finished', { role: 'coder', roleId: 'coder-0-1', callId: 'role:new-writer-id', status: 'success', summary: 'done' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')))
		const coderCalls = model.operations.filter((operation) => operation.kind === 'call' && operation.destination === 'role:coder-0-1')
		expect(coderCalls).toHaveLength(1)
		expect(model.participants.filter((participant) => participant.role === 'coder')).toHaveLength(1)
		const tools = model.operations.filter((operation) => operation.kind === 'call' && operation.destination.startsWith('tool:'))
		expect(tools).toHaveLength(2)
		for (const tool of tools) {
			expect(tool.parentCallId).toBe('role:coder-0-1')
			expect(tool.source).toBe('role:coder-0-1')
		}
		expect(defined(tools[0], 'tools[0]').parentCallId).not.toBe(defined(tools[1], 'tools[1]').callId)
		const coderReturn = model.operations.find((operation) => operation.kind === 'return' && operation.callId === 'role:coder-0-1')
		expect(coderReturn).toBeDefined()
		assertHelpersSensible(model)
	})
})

describe('deriveInteractionModel — interrupt-frame materialization', () => {
	test('a terminal-without-start on a fresh interrupt stack materializes and pops the empty frame', () => {
		const events = [
			event('t0', 'role_start', { role: 'orchestrator', roleId: 'orchestrator-0-1', callId: 'role:orchestrator-0-1', task: 'task' }),
			event('t1', 'interrupt', { trigger: 'loop_check', handler: 'loop_detector', target: 'orchestrator-0-1', callId: 'interrupt:abc', parentCallId: 'role:orchestrator-0-1' }),
			event('t2', 'role_finished', { role: 'loop_detector', roleId: 'loop-1-1', callId: 'role:loop-1-1', status: 'success', summary: 'done' }),
			event('t3', 'tool_call', { role: 'orchestrator', tool: 'read_file', callId: 'tool:tc-1', parentCallId: 'role:orchestrator-0-1', arguments: '{}' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')))
		const ghost = model.operations.filter((operation) => operation.callId === 'role:loop-1-1')
		expect(ghost.map((operation) => operation.kind)).toEqual(['call', 'return'])
		expect(defined(ghost[0], 'ghost call').stack).toBe('interrupt-1-stack')
		expect(stacksOf(model)).toEqual(['main'])
		assertHelpersSensible(model)
	})
})

describe('deriveInteractionModel — resolved interrupt records, pause markers, and id hygiene', () => {
	function startRole(timestamp: string, role: string, roleId: string, parentCallId?: string): LogEvent {
		const payload: Record<string, unknown> = { role, roleId, callId: `role:${roleId}`, task: `${role} task` }
		if (parentCallId !== undefined) payload['parentCallId'] = parentCallId
		return event(timestamp, 'role_start', payload)
	}

	test('interrupt + role_not_found + interrupt_resolved leaves no ghost stack record', () => {
		const events = [
			startRole('t0', 'orchestrator', 'orchestrator-0-1'),
			event('t1', 'interrupt', { trigger: 'loop_check', handler: 'loop_detector', target: 'orchestrator-0-1', callId: 'interrupt:one', parentCallId: 'role:orchestrator-0-1' }),
			event('t2', 'role_not_found', { role: 'loop_detector', roleId: 'loop-1-1' }),
			event('t3', 'interrupt_resolved', { trigger: 'loop_check', handler: 'loop_detector', target: 'orchestrator-0-1', callId: 'interrupt:one', action: 'failed' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')))
		expect(model.stacks?.map((record) => record.id)).toEqual(['main'])
		expect(activeStack(model)).toBe('main')
		expect(activeParticipant(model)).toBe('role:orchestrator-0-1')
		expect(stacksOf(model)).toEqual(['main'])
	})

	test('interrupt + interrupt_resolved alone leaves no ghost stack record', () => {
		const events = [
			startRole('t0', 'orchestrator', 'orchestrator-0-1'),
			event('t1', 'interrupt', { trigger: 'loop_check', handler: 'loop_detector', target: 'orchestrator-0-1', callId: 'interrupt:one', parentCallId: 'role:orchestrator-0-1' }),
			event('t2', 'interrupt_resolved', { trigger: 'loop_check', handler: 'loop_detector', target: 'orchestrator-0-1', callId: 'interrupt:one', action: 'continue' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')))
		expect(model.stacks?.map((record) => record.id)).toEqual(['main'])
		expect(stacksOf(model)).toEqual(['main'])
		expect(activeParticipant(model)).toBe('role:orchestrator-0-1')
	})

	test('nested interrupt_resolved without callId prefers the target match instead of popping the last frame', () => {
		const events = [
			startRole('t0', 'orchestrator', 'orchestrator-0-1'),
			event('t1', 'interrupt', { trigger: 'loop_check', handler: 'outer_handler', target: 'orchestrator-0-1', callId: 'interrupt:one', parentCallId: 'role:orchestrator-0-1' }),
			event('t2', 'interrupt', { trigger: 'loop_check', handler: 'inner_handler', target: 'other-0-1', callId: 'interrupt:two', parentCallId: 'role:orchestrator-0-1' }),
			event('t3', 'interrupt_resolved', { trigger: 'loop_check', handler: 'outer_handler', target: 'orchestrator-0-1', action: 'continue' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')))
		// The target names the outer interrupt, which is not the current top frame: selecting it must not pop the inner frame.
		expect(activeStack(model)).toBe('interrupt-2-stack')
		expect(activeParticipant(model)).toBe('interrupt:two')
		expect(model.stacks?.map((record) => record.id)).toEqual(['main', 'interrupt-2-stack'])
	})

	test('a paused role_finished is a pause marker, and a later finish is the terminal', () => {
		const events = [
			startRole('t0', 'coder', 'coder-0-1'),
			event('t1', 'role_finished', { role: 'coder', roleId: 'coder-0-1', callId: 'role:coder-0-1', status: 'success', summary: 'paused', paused: true }),
			startRole('t2', 'coder', 'coder-0-1'),
			event('t3', 'role_finished', { role: 'coder', roleId: 'coder-0-1', callId: 'role:coder-0-1', status: 'success', summary: 'done' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('success')))
		const returns = model.operations.filter((operation) => operation.kind === 'return' && operation.callId === 'role:coder-0-1')
		expect(returns).toHaveLength(1)
		expect(defined(returns[0], 'returns[0]').startedAt).toBe('t3')
		expect(model.participants.filter((participant) => participant.id === 'role:coder-0-1')).toHaveLength(1)
	})

	test('a late llm_call does not fold into a closed role invocation', () => {
		const events = [
			startRole('t0', 'coder', 'coder-0-1'),
			event('t1', 'llm_call', { role: 'coder', roleId: 'coder-0-1', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }),
			event('t2', 'role_finished', { role: 'coder', roleId: 'coder-0-1', callId: 'role:coder-0-1', status: 'success', summary: 'done' }),
			event('t3', 'llm_call', { role: 'coder', roleId: 'coder-0-1', usage: { promptTokens: 900, completionTokens: 100, totalTokens: 1000 } }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('success')))
		const call = defined(model.operations.find((operation) => operation.kind === 'call' && operation.callId === 'role:coder-0-1'), 'call')
		expect(call.metrics?.tokens).toBe(15)
	})

	test('an empty callId or parentCallId is treated as absent', () => {
		const events = [
			startRole('t0', 'orchestrator', 'orchestrator-0-1'),
			event('t1', 'role_start', { role: 'coder', roleId: 'coder-0-1', callId: '', parentCallId: '', task: 'old style' }),
		]
		const model = deriveInteractionModel(snapshot(events, meta('running')))
		const coderCall = defined(model.operations.find((operation) => operation.kind === 'call' && operation.destination === 'role:coder-0-1'), 'coderCall')
		expect(coderCall.callId).toBe('role:coder-0-1')
		expect(coderCall.parentCallId).toBe('role:orchestrator-0-1')
		expect(model.participants.every((participant) => participant.id !== '')).toBe(true)
	})
})
