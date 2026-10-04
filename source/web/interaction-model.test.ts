import { describe, expect, test } from 'bun:test'
import {
	activeParticipant,
	activeStack,
	callChainOf,
	fateOf,
	isPaused,
	observesOf,
	rolesOnlyModel,
	rolesOnlyParticipants,
	stacksOf,
} from './static/interaction-model.js'

// The helpers arrive typed from the module's JSDoc. Pulling the model type off activeStack's parameter lets the inline literals below be contextually checked against the JSDoc shape without a cast.
type InteractionModel = Parameters<typeof activeStack>[0]

describe('InteractionModel helpers', () => {
	test('the active stack is the stack of the latest operation and the active participant is its destination', () => {
		const model: InteractionModel = {
			participants: [
				{ id: 'you', role: 'human', kind: 'human' },
				{ id: 'orch', role: 'orchestrator', kind: 'role' },
			],
			operations: [
				{ id: 'op1', kind: 'call', stack: 'root', source: 'you', destination: 'orch', startedAt: 't0', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
			],
			status: 'running',
		}
		expect(activeStack(model)).toBe('root')
		expect(activeParticipant(model)).toBe('orch')
	})

	test('an observe on the active stack does not steal activity', () => {
		const model: InteractionModel = {
			participants: [
				{ id: 'you', role: 'human', kind: 'human' },
				{ id: 'orch', role: 'orchestrator', kind: 'role' },
				{ id: 'tool', role: 'read_file', kind: 'tool' },
			],
			operations: [
				{ id: 'op1', kind: 'call', stack: 'root', source: 'you', destination: 'orch', startedAt: 't0', settledAt: 't1', lifecycle: 'settled', outcome: 'success', metrics: null },
				{ id: 'op2', kind: 'observe', stack: 'root', source: 'orch', destination: 'tool', startedAt: 't2', settledAt: 't2', lifecycle: 'settled', outcome: null, metrics: null },
			],
			status: 'running',
		}
		// op2 is the latest operation and so owns the active stack, but because it is an observe the active participant stays the destination of the latest call/return, not the observe's destination.
		expect(activeStack(model)).toBe('root')
		expect(activeParticipant(model)).toBe('orch')
		expect(observesOf(model)).toHaveLength(1)
		expect(observesOf(model)[0]?.id).toBe('op2')
	})

	test('an interrupt spawns a new active stack and pauses the root with its in-flight call left in flight', () => {
		const model: InteractionModel = {
			participants: [
				{ id: 'you', role: 'human', kind: 'human' },
				{ id: 'orch', role: 'orchestrator', kind: 'role' },
				{ id: 'int', role: 'interrupt', kind: 'interrupt' },
			],
			operations: [
				{ id: 'op1', kind: 'call', stack: 'root', source: 'you', destination: 'orch', startedAt: 't0', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
				{ id: 'op2', kind: 'call', stack: 'int-stack', source: 'int', destination: 'orch', startedAt: 't1', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
			],
			status: 'running',
		}
		expect(activeStack(model)).toBe('int-stack')
		expect(activeParticipant(model)).toBe('orch')
		// The root call is still in flight (lifecycle unchanged); the model does not flip it on pause. The root is paused because it is not the active stack and still carries an open call.
		expect(isPaused(model, 'root')).toBe(true)
		expect(isPaused(model, 'int-stack')).toBe(false)
		expect(callChainOf(model, 'root')).toHaveLength(1)
		expect(callChainOf(model, 'root')[0]?.id).toBe('op1')
		// Oldest open stack first, active stack last.
		expect(stacksOf(model)).toEqual(['root', 'int-stack'])
	})

	test('a paused stack keeps its in-flight operation in flight and reads as resuming', () => {
		const model: InteractionModel = {
			participants: [
				{ id: 'you', role: 'human', kind: 'human' },
				{ id: 'orch', role: 'orchestrator', kind: 'role' },
				{ id: 'coder', role: 'coder', kind: 'role' },
				{ id: 'int', role: 'interrupt', kind: 'interrupt' },
			],
			operations: [
				{ id: 'op1', kind: 'call', stack: 'root', source: 'you', destination: 'orch', startedAt: 't0', settledAt: 't1', lifecycle: 'settled', outcome: 'success', metrics: null },
				{ id: 'op2', kind: 'call', stack: 'root', source: 'orch', destination: 'coder', startedAt: 't2', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
				{ id: 'op3', kind: 'call', stack: 'int-stack', source: 'int', destination: 'orch', startedAt: 't3', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
			],
			status: 'running',
		}
		const rootChain = callChainOf(model, 'root')
		// op1 stays in the open chain until a return operation closes it; the nesting you->orch->coder is the full open chain, and the innermost call (op2) is the one in flight.
		expect(rootChain).toHaveLength(2)
		expect(rootChain[1]?.id).toBe('op2')
		expect(rootChain[1]?.lifecycle).toBe('in_flight')
		expect(rootChain[1]?.settledAt).toBeNull()
		// op2 is genuinely in flight; the model leaves it that way, and isPaused is the rule the view reads to freeze its line.
		expect(isPaused(model, 'root')).toBe(true)
		expect(fateOf(model, 'root')).toBe('resuming')
	})

	test('fateOf returns active for the active stack and resuming for a freshly paused stack', () => {
		const model: InteractionModel = {
			participants: [
				{ id: 'you', role: 'human', kind: 'human' },
				{ id: 'orch', role: 'orchestrator', kind: 'role' },
				{ id: 'int', role: 'interrupt', kind: 'interrupt' },
			],
			operations: [
				{ id: 'op1', kind: 'call', stack: 'root', source: 'you', destination: 'orch', startedAt: 't0', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
				{ id: 'op2', kind: 'call', stack: 'int-stack', source: 'int', destination: 'orch', startedAt: 't1', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
			],
			status: 'running',
		}
		expect(fateOf(model, 'int-stack')).toBe('active')
		expect(fateOf(model, 'root')).toBe('resuming')
	})

	test('a fully closed non-active stack reads as terminated', () => {
		const model: InteractionModel = {
			participants: [
				{ id: 'you', role: 'human', kind: 'human' },
				{ id: 'orch', role: 'orchestrator', kind: 'role' },
				{ id: 'coder', role: 'coder', kind: 'role' },
				{ id: 'int', role: 'interrupt', kind: 'interrupt' },
			],
			operations: [
				{ id: 'op1', kind: 'call', stack: 'root', source: 'you', destination: 'orch', startedAt: 't0', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
				{ id: 'op2', kind: 'call', stack: 'int-stack', source: 'int', destination: 'orch', startedAt: 't1', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
				{ id: 'op3', kind: 'return', stack: 'int-stack', source: 'orch', destination: 'int', startedAt: 't2', settledAt: 't3', lifecycle: 'settled', outcome: 'success', metrics: null },
				{ id: 'op4', kind: 'call', stack: 'root', source: 'orch', destination: 'coder', startedAt: 't4', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
			],
			status: 'running',
		}
		// The interrupt stack is fully closed (its call has a matching return) and is not the active stack, so its fate is terminated.
		expect(activeStack(model)).toBe('root')
		expect(fateOf(model, 'int-stack')).toBe('terminated')
		expect(fateOf(model, 'root')).toBe('active')
	})

	test('a terminal run leaves the human as the active participant with no open calls', () => {
		const model: InteractionModel = {
			participants: [
				{ id: 'you', role: 'human', kind: 'human' },
				{ id: 'orch', role: 'orchestrator', kind: 'role' },
			],
			operations: [
				{ id: 'op1', kind: 'call', stack: 'root', source: 'you', destination: 'orch', startedAt: 't0', settledAt: 't1', lifecycle: 'settled', outcome: 'success', metrics: null },
				{ id: 'op2', kind: 'return', stack: 'root', source: 'orch', destination: 'you', startedAt: 't2', settledAt: 't3', lifecycle: 'settled', outcome: 'success', metrics: null },
			],
			status: 'success',
		}
		expect(activeStack(model)).toBe('root')
		expect(activeParticipant(model)).toBe('you')
		expect(stacksOf(model)).toEqual([])
		expect(callChainOf(model, 'root')).toEqual([])
	})

	test('a paused stack whose resumed phase closes calls with terminated returns is terminating', () => {
		const model: InteractionModel = {
			participants: [
				{ id: 'you', role: 'human', kind: 'human' },
				{ id: 'orch', role: 'orchestrator', kind: 'role' },
				{ id: 'coder', role: 'coder', kind: 'role' },
				{ id: 'tool', role: 'read_file', kind: 'tool' },
				{ id: 'int', role: 'interrupt', kind: 'interrupt' },
				{ id: 'int2', role: 'interrupt', kind: 'interrupt' },
			],
			operations: [
				{ id: 'op1', kind: 'call', stack: 'root', source: 'you', destination: 'orch', startedAt: 't0', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
				{ id: 'op2', kind: 'call', stack: 'root', source: 'orch', destination: 'coder', startedAt: 't1', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
				{ id: 'op3', kind: 'call', stack: 'root', source: 'coder', destination: 'tool', startedAt: 't2', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
				{ id: 'op4', kind: 'call', stack: 'int-stack', source: 'int', destination: 'orch', startedAt: 't3', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
				// The interrupt resolves; the root becomes active again and tears down its innermost call with a terminated return.
				{ id: 'op5', kind: 'return', stack: 'int-stack', source: 'orch', destination: 'int', startedAt: 't4', settledAt: 't5', lifecycle: 'settled', outcome: 'success', metrics: null },
				{ id: 'op6', kind: 'return', stack: 'root', source: 'tool', destination: 'coder', startedAt: 't6', settledAt: 't7', lifecycle: 'settled', outcome: 'terminated', metrics: null },
				// A second interrupt preempts mid-teardown, leaving the root paused with a terminated return (but no fresh call) in its current phase.
				{ id: 'op7', kind: 'call', stack: 'int2-stack', source: 'int2', destination: 'orch', startedAt: 't8', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
			],
			status: 'running',
		}
		expect(activeStack(model)).toBe('int2-stack')
		expect(fateOf(model, 'root')).toBe('terminating')
		expect(callChainOf(model, 'root')).toHaveLength(2)
	})

	test('a paused stack whose resumed phase terminates calls then issues a fresh call from an ancestor is rewinding', () => {
		const model: InteractionModel = {
			participants: [
				{ id: 'you', role: 'human', kind: 'human' },
				{ id: 'orch', role: 'orchestrator', kind: 'role' },
				{ id: 'coder', role: 'coder', kind: 'role' },
				{ id: 'int', role: 'interrupt', kind: 'interrupt' },
				{ id: 'int2', role: 'interrupt', kind: 'interrupt' },
			],
			operations: [
				{ id: 'op1', kind: 'call', stack: 'root', source: 'you', destination: 'orch', startedAt: 't0', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
				{ id: 'op2', kind: 'call', stack: 'root', source: 'orch', destination: 'coder', startedAt: 't1', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
				{ id: 'op3', kind: 'call', stack: 'int-stack', source: 'int', destination: 'orch', startedAt: 't2', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
				// The interrupt resolves; the root tears down the coder call with a terminated return, then restarts orchestrator from the You ancestor — a rewind.
				{ id: 'op4', kind: 'return', stack: 'int-stack', source: 'orch', destination: 'int', startedAt: 't3', settledAt: 't4', lifecycle: 'settled', outcome: 'success', metrics: null },
				{ id: 'op5', kind: 'return', stack: 'root', source: 'coder', destination: 'orch', startedAt: 't5', settledAt: 't6', lifecycle: 'settled', outcome: 'terminated', metrics: null },
				{ id: 'op6', kind: 'call', stack: 'root', source: 'you', destination: 'orch', startedAt: 't7', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
				// A second interrupt preempts mid-rewind, leaving the root paused with both a terminated return and a fresh call in its current phase.
				{ id: 'op7', kind: 'call', stack: 'int2-stack', source: 'int2', destination: 'orch', startedAt: 't8', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
			],
			status: 'running',
		}
		expect(activeStack(model)).toBe('int2-stack')
		expect(fateOf(model, 'root')).toBe('rewinding')
		expect(stacksOf(model)).toEqual(['root', 'int2-stack'])
	})

	test('a paused stack whose rewind completed and then resumed normal nested work reads as resuming, not rewinding', () => {
		const model: InteractionModel = {
			participants: [
				{ id: 'you', role: 'human', kind: 'human' },
				{ id: 'orch', role: 'orchestrator', kind: 'role' },
				{ id: 'coder', role: 'coder', kind: 'role' },
				{ id: 'coder2', role: 'coder', kind: 'role' },
				{ id: 'readFile', role: 'read_file', kind: 'tool' },
				{ id: 'int', role: 'interrupt', kind: 'interrupt' },
				{ id: 'int2', role: 'interrupt', kind: 'interrupt' },
			],
			operations: [
				{ id: 'op1', kind: 'call', stack: 'root', source: 'you', destination: 'orch', startedAt: 't0', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
				{ id: 'op2', kind: 'call', stack: 'root', source: 'orch', destination: 'coder', startedAt: 't1', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
				{ id: 'op3', kind: 'call', stack: 'int-stack', source: 'int', destination: 'orch', startedAt: 't2', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
				// The interrupt resolves; the root tears down the coder call with a terminated return, then restarts from the ancestor — a rewind.
				{ id: 'op4', kind: 'return', stack: 'int-stack', source: 'orch', destination: 'int', startedAt: 't3', settledAt: 't4', lifecycle: 'settled', outcome: 'success', metrics: null },
				{ id: 'op5', kind: 'return', stack: 'root', source: 'coder', destination: 'orch', startedAt: 't5', settledAt: 't6', lifecycle: 'settled', outcome: 'terminated', metrics: null },
				{ id: 'op6', kind: 'call', stack: 'root', source: 'you', destination: 'orch', startedAt: 't7', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
				// The rewind's restart (op6) is followed by normal nested work: a fresh coder-2 call and a tool call beneath it. The rewind is complete.
				{ id: 'op7', kind: 'call', stack: 'root', source: 'orch', destination: 'coder2', startedAt: 't8', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
				{ id: 'op8', kind: 'call', stack: 'root', source: 'coder2', destination: 'readFile', startedAt: 't9', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
				// A second interrupt re-preempts mid-normal-operation. The root's current phase carries the rewind's terminated return, the restart call, and the normal nested calls — the mixed-phase case.
				{ id: 'op9', kind: 'call', stack: 'int2-stack', source: 'int2', destination: 'orch', startedAt: 't10', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
			],
			status: 'running',
		}
		expect(activeStack(model)).toBe('int2-stack')
		// The root is paused and its phase contains both a terminated return and a fresh call, but the fresh call is followed by normal nested work, so the rewind is complete and the stack reads 'resuming' rather than 'rewinding'.
		expect(fateOf(model, 'root')).toBe('resuming')
	})

	test('a freshly preempted stack is active on arrival and its root is the active participant', () => {
		// The interrupt has landed but its first call has not: the fresh stack carries no operations yet, so only the stack records name it. It is the active stack (the preemption is the latest activity), its root is the current worker, and the preempted root stack is paused with its in-flight call frozen.
		const model: InteractionModel = {
			participants: [
				{ id: 'you', role: 'human', kind: 'human' },
				{ id: 'orch', role: 'orchestrator', kind: 'role' },
				{ id: 'coder', role: 'coder', kind: 'role' },
				{ id: 'int', role: 'interrupt', kind: 'interrupt' },
			],
			operations: [
				{ id: 'op1', kind: 'call', stack: 'root', source: 'you', destination: 'orch', startedAt: 't0', settledAt: 't1', lifecycle: 'settled', outcome: null, metrics: null },
				{ id: 'op2', kind: 'call', stack: 'root', source: 'orch', destination: 'coder', startedAt: 't1', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
			],
			status: 'running',
			stacks: [
				{ id: 'root', root: 'you' },
				{ id: 'int-stack', root: 'int' },
			],
		}
		expect(activeStack(model)).toBe('int-stack')
		expect(activeParticipant(model)).toBe('int')
		expect(stacksOf(model)).toEqual(['root', 'int-stack'])
		expect(isPaused(model, 'root')).toBe(true)
		expect(isPaused(model, 'int-stack')).toBe(false)
		expect(fateOf(model, 'int-stack')).toBe('active')
		expect(fateOf(model, 'root')).toBe('resuming')
	})

	test('a resolved stack yields activity to the preempted stack with open work while its final return lingers', () => {
		// The loop detector's return closes the interrupt stack's root call: the interrupt stack is resolved, so activity falls back to the root stack whose innermost open call (the coder) is the current worker. The resolved stack's final return stays in flight (its leg keeps rendering) until the next operation settles it, but its stack no longer holds activity.
		const model: InteractionModel = {
			participants: [
				{ id: 'you', role: 'human', kind: 'human' },
				{ id: 'orch', role: 'orchestrator', kind: 'role' },
				{ id: 'coder', role: 'coder', kind: 'role' },
				{ id: 'int', role: 'interrupt', kind: 'interrupt' },
				{ id: 'det', role: 'loop_detector', kind: 'role' },
			],
			operations: [
				{ id: 'op1', kind: 'call', stack: 'root', source: 'you', destination: 'orch', startedAt: 't0', settledAt: 't1', lifecycle: 'settled', outcome: null, metrics: null },
				{ id: 'op2', kind: 'call', stack: 'root', source: 'orch', destination: 'coder', startedAt: 't1', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
				{ id: 'op3', kind: 'call', stack: 'int-stack', source: 'int', destination: 'det', startedAt: 't2', settledAt: 't3', lifecycle: 'settled', outcome: null, metrics: null },
				{ id: 'op4', kind: 'return', stack: 'int-stack', source: 'det', destination: 'int', startedAt: 't3', settledAt: null, lifecycle: 'in_flight', outcome: 'success', metrics: null },
			],
			status: 'running',
			stacks: [
				{ id: 'root', root: 'you' },
				{ id: 'int-stack', root: 'int' },
			],
		}
		expect(activeStack(model)).toBe('root')
		expect(activeParticipant(model)).toBe('coder')
		// The resolved stack still renders a row (its final return is in flight), staying below the root stack — rows never reorder as activity moves.
		expect(stacksOf(model)).toEqual(['root', 'int-stack'])
		expect(isPaused(model, 'int-stack')).toBe(false)
		expect(fateOf(model, 'int-stack')).toBe('terminated')
		expect(callChainOf(model, 'root')).toHaveLength(2)
	})

	test('the resolution fallback reads the innermost open call, not a terminate-killed latest call', () => {
		// The root stack's latest operation is the coder call that a terminate killed; the live open call is the orchestrator's. When the interrupt stack resolves, the orchestrator (not the terminated coder) is the active participant.
		const model: InteractionModel = {
			participants: [
				{ id: 'you', role: 'human', kind: 'human' },
				{ id: 'orch', role: 'orchestrator', kind: 'role' },
				{ id: 'coder', role: 'coder', kind: 'role' },
				{ id: 'int', role: 'interrupt', kind: 'interrupt' },
				{ id: 'det', role: 'loop_detector', kind: 'role' },
				{ id: 'rewind', role: 'rewind_stack', kind: 'tool' },
			],
			operations: [
				{ id: 'op1', kind: 'call', stack: 'root', source: 'you', destination: 'orch', startedAt: 't0', settledAt: 't1', lifecycle: 'settled', outcome: null, metrics: null },
				{ id: 'op2', kind: 'call', stack: 'root', source: 'orch', destination: 'coder', startedAt: 't1', settledAt: 't4', lifecycle: 'settled', outcome: null, metrics: null },
				{ id: 'op3', kind: 'call', stack: 'int-stack', source: 'int', destination: 'det', startedAt: 't2', settledAt: 't3', lifecycle: 'settled', outcome: null, metrics: null },
				{ id: 'op4', kind: 'terminate', stack: 'int-stack', source: 'rewind', destination: 'coder', startedAt: 't4', settledAt: 't4', lifecycle: 'settled', outcome: null, metrics: null },
				{ id: 'op5', kind: 'return', stack: 'int-stack', source: 'det', destination: 'int', startedAt: 't5', settledAt: null, lifecycle: 'in_flight', outcome: 'success', metrics: null },
			],
			status: 'running',
			stacks: [
				{ id: 'root', root: 'you' },
				{ id: 'int-stack', root: 'int' },
			],
		}
		expect(activeStack(model)).toBe('root')
		expect(activeParticipant(model)).toBe('orch')
		expect(stacksOf(model)).toEqual(['root', 'int-stack'])
	})

	test('an observe crosses from the active stack into a paused stack and never enters a call chain', () => {
		const model: InteractionModel = {
			participants: [
				{ id: 'you', role: 'human', kind: 'human' },
				{ id: 'orch', role: 'orchestrator', kind: 'role' },
				{ id: 'coder', role: 'coder', kind: 'role' },
				{ id: 'int', role: 'interrupt', kind: 'interrupt' },
				{ id: 'orch2', role: 'orchestrator', kind: 'role' },
			],
			operations: [
				{ id: 'op1', kind: 'call', stack: 'root', source: 'you', destination: 'orch', startedAt: 't0', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
				{ id: 'op2', kind: 'call', stack: 'root', source: 'orch', destination: 'coder', startedAt: 't1', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
				{ id: 'op3', kind: 'call', stack: 'int-stack', source: 'int', destination: 'orch2', startedAt: 't2', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
				// op4's source (orch2) is in the active int-stack; its destination (coder) is in the paused root. The observe is logged on the active stack.
				{ id: 'op4', kind: 'observe', stack: 'int-stack', source: 'orch2', destination: 'coder', startedAt: 't3', settledAt: 't3', lifecycle: 'settled', outcome: null, metrics: null },
			],
			status: 'running',
		}
		expect(activeStack(model)).toBe('int-stack')
		expect(activeParticipant(model)).toBe('orch2')
		expect(observesOf(model)).toHaveLength(1)
		expect(observesOf(model)[0]?.id).toBe('op4')
		// The root's call chain holds its two open calls; the observe never appears in it.
		expect(callChainOf(model, 'root')).toHaveLength(2)
		expect(callChainOf(model, 'root').some((operation) => operation.kind === 'observe')).toBe(false)
		expect(isPaused(model, 'root')).toBe(true)
	})
})

describe('InteractionModel derivation memoization', () => {
	// The memoization contract is invisibility: every helper answers identically, computed once per model. These tests pin the one observable edge — repeated helper calls hand back the same derived object, and distinct models never share one — through the public helpers rather than the private memo.
	function twoCallModel(): InteractionModel {
		return {
			participants: [
				{ id: 'you', role: 'human', kind: 'human' },
				{ id: 'orch', role: 'orchestrator', kind: 'role' },
				{ id: 'coder', role: 'coder', kind: 'role' },
			],
			operations: [
				{ id: 'op1', kind: 'call', stack: 'root', source: 'you', destination: 'orch', startedAt: 't0', settledAt: 't1', lifecycle: 'settled', outcome: null, metrics: null },
				{ id: 'op2', kind: 'call', stack: 'root', source: 'orch', destination: 'coder', startedAt: 't1', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
			],
			status: 'running',
		}
	}

	test('repeated helper calls on one model return reference-equal derived results', () => {
		const model = twoCallModel()
		// Warm the derivation through a different helper first, so the pinned identity holds across helpers rather than within one call site.
		expect(activeStack(model)).toBe('root')
		expect(stacksOf(model)).toBe(stacksOf(model))
	})

	test('distinct models with identical content get distinct derived results', () => {
		const first = twoCallModel()
		const second = twoCallModel()
		expect(stacksOf(first)).toEqual(stacksOf(second))
		expect(stacksOf(first)).not.toBe(stacksOf(second))
	})
})

describe('rolesOnlyParticipants', () => {
	test('keeps role and human participants and drops tools and the interrupt pseudo-role, preserving order', () => {
		const filtered = rolesOnlyParticipants([
			{ id: 'you', role: 'human', kind: 'human' },
			{ id: 'orch', role: 'orchestrator', kind: 'role' },
			{ id: 'read', role: 'read_file', kind: 'tool' },
			{ id: 'int', role: 'interrupt', kind: 'interrupt' },
			{ id: 'coder', role: 'coder', kind: 'role' },
			{ id: 'asker', role: 'human', kind: 'human' },
		])
		expect(filtered).toEqual([
			{ id: 'you', role: 'human', kind: 'human' },
			{ id: 'orch', role: 'orchestrator', kind: 'role' },
			{ id: 'coder', role: 'coder', kind: 'role' },
			{ id: 'asker', role: 'human', kind: 'human' },
		])
	})

	test('an empty list filters to empty', () => {
		expect(rolesOnlyParticipants([])).toEqual([])
	})
})

describe('rolesOnlyModel', () => {
	// A model shaped like the adapter's output: a delegation chain, a tool leg, an observe, an ask_human exchange, and an interrupt preemption with a synthetic root — every operation kind and participant kind the filter rules decide over.
	function fullModel(): InteractionModel {
		return {
			participants: [
				{ id: 'you', role: 'human', kind: 'human' },
				{ id: 'orch', role: 'orchestrator', kind: 'role', roleId: 'orchestrator-0-1' },
				{ id: 'read', role: 'read_file', kind: 'tool' },
				{ id: 'coder', role: 'coder', kind: 'role', roleId: 'coder-1-2' },
				{ id: 'answerer', role: 'human', kind: 'human' },
				{ id: 'int', role: 'interrupt', kind: 'interrupt' },
				{ id: 'detector', role: 'loop_detector', kind: 'role', roleId: 'loop_detector-1-3' },
			],
			operations: [
				{ id: 'op1', kind: 'call', stack: 'main', source: 'you', destination: 'orch', startedAt: 't0', settledAt: 't1', lifecycle: 'settled', outcome: null, metrics: null },
				{ id: 'op2', kind: 'call', stack: 'main', source: 'orch', destination: 'read', startedAt: 't1', settledAt: 't2', lifecycle: 'settled', outcome: null, metrics: null },
				{ id: 'op3', kind: 'return', stack: 'main', source: 'read', destination: 'orch', startedAt: 't2', settledAt: 't3', lifecycle: 'settled', outcome: 'success', metrics: null },
				{ id: 'op4', kind: 'call', stack: 'main', source: 'orch', destination: 'coder', startedAt: 't3', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
				{ id: 'op5', kind: 'observe', stack: 'main', source: 'read', destination: 'coder', startedAt: 't4', settledAt: 't4', lifecycle: 'settled', outcome: null, metrics: null },
				{ id: 'op6', kind: 'call', stack: 'main', source: 'coder', destination: 'answerer', startedAt: 't5', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
				{ id: 'op7', kind: 'return', stack: 'main', source: 'answerer', destination: 'coder', startedAt: 't6', settledAt: 't7', lifecycle: 'settled', outcome: 'success', metrics: null },
				{ id: 'op8', kind: 'call', stack: 'int-1-stack', source: 'int', destination: 'detector', startedAt: 't7', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
				{ id: 'op9', kind: 'terminate', stack: 'int-1-stack', source: 'read', destination: 'coder', startedAt: 't8', settledAt: 't8', lifecycle: 'settled', outcome: null, metrics: null },
			],
			status: 'running',
			stacks: [
				{ id: 'main', root: 'you' },
				{ id: 'int-1-stack', root: 'int' },
			],
		}
	}

	test('keeps the agent/human call chains and drops tool legs, observes, and terminates', () => {
		const filtered = rolesOnlyModel(fullModel())
		// Kept: the human→orchestrator call, the orchestrator→coder delegation, and the coder↔human ask_human exchange. Dropped with the tool column: the tool call/return legs (op2, op3), the tool-sourced observe (op5) and terminate (op9). The interrupt-rooted preemption call (op8) drops with the interrupt pseudo-role.
		expect(filtered.operations.map((operation) => operation.id)).toEqual(['op1', 'op4', 'op6', 'op7'])
	})

	test('collapses participants to agent roles plus the human, preserving order and the roleId field', () => {
		const filtered = rolesOnlyModel(fullModel())
		expect(filtered.participants).toEqual([
			{ id: 'you', role: 'human', kind: 'human' },
			{ id: 'orch', role: 'orchestrator', kind: 'role', roleId: 'orchestrator-0-1' },
			{ id: 'coder', role: 'coder', kind: 'role', roleId: 'coder-1-2' },
			{ id: 'answerer', role: 'human', kind: 'human' },
			{ id: 'detector', role: 'loop_detector', kind: 'role', roleId: 'loop_detector-1-3' },
		])
	})

	test('drops stack records whose root no longer survives and passes the status through', () => {
		const filtered = rolesOnlyModel(fullModel())
		// The synthetic-interrupt stack's root is dropped, so its record drops; the main stack (rooted at the human) survives.
		expect(filtered.stacks).toEqual([{ id: 'main', root: 'you' }])
		expect(filtered.status).toBe('running')
	})

	test('a hand-authored model without stack records filters without inventing them', () => {
		const model = fullModel()
		delete model.stacks
		const filtered = rolesOnlyModel(model)
		expect(filtered.stacks).toBeUndefined()
		expect(filtered.operations.map((operation) => operation.id)).toEqual(['op1', 'op4', 'op6', 'op7'])
	})

	test('an all-tool-traffic model filters to no operations while the human column stays', () => {
		const model: InteractionModel = {
			participants: [
				{ id: 'you', role: 'human', kind: 'human' },
				{ id: 'read', role: 'read_file', kind: 'tool' },
			],
			operations: [
				{ id: 'op1', kind: 'observe', stack: 'main', source: 'read', destination: 'you', startedAt: 't0', settledAt: 't0', lifecycle: 'settled', outcome: null, metrics: null },
			],
			status: 'running',
		}
		const filtered = rolesOnlyModel(model)
		expect(filtered.operations).toEqual([])
		expect(filtered.participants.map((participant) => participant.role)).toEqual(['human'])
	})

	test('an empty model filters to an empty model', () => {
		const model: InteractionModel = { participants: [], operations: [], status: 'unknown' }
		const filtered = rolesOnlyModel(model)
		expect(filtered.participants).toEqual([])
		expect(filtered.operations).toEqual([])
		expect(filtered.status).toBe('unknown')
	})

	test('filtering is idempotent — filtering a filtered model is a deep identity', () => {
		const once = rolesOnlyModel(fullModel())
		const twice = rolesOnlyModel(once)
		expect(twice).toEqual(once)
	})

	test('the filter never mutates the model it reads', () => {
		const model = fullModel()
		rolesOnlyModel(model)
		expect(model.operations).toHaveLength(9)
		expect(model.participants).toHaveLength(7)
		expect(model.stacks).toHaveLength(2)
	})
})
