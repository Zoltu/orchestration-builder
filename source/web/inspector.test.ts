import { describe, expect, test } from 'bun:test'
import { resolveInspectorScope } from './static/inspector.js'
import { activeStack } from './static/interaction-model.js'

// The model type arrives typed from interaction-model.js's JSDoc (the convention the sibling view tests follow), so the inline fixtures are contextually checked without a cast.
type InteractionModel = Parameters<typeof activeStack>[0]

function participant(id: string, role: string, kind: 'human' | 'interrupt' | 'role' | 'tool', roleId?: string) {
	return roleId === undefined ? { id, role, kind } : { id, role, kind, roleId }
}

function operation(id: string, kind: 'call' | 'return' | 'observe' | 'terminate', source: string, destination: string) {
	return { id, kind, stack: 'main', source, destination, startedAt: 't0', settledAt: null, lifecycle: 'in_flight' as const, outcome: null, metrics: null }
}

// The delegation story the click-through serves: human → orchestrator → coder, a tool leg, an ask_human answerer, and a second coder instance for the most-recent-instance rule.
function model(): InteractionModel {
	return {
		participants: [
			participant('you', 'human', 'human'),
			participant('role:orchestrator:1', 'orchestrator', 'role', 'orchestrator-0-1'),
			participant('tool:read_file:1', 'read_file', 'tool'),
			participant('role:coder:1', 'coder', 'role', 'coder-1-2'),
			participant('human:answerer:1', 'human', 'human'),
			participant('role:coder:2', 'coder', 'role', 'coder-1-9'),
		],
		operations: [
			operation('op1', 'call', 'you', 'role:orchestrator:1'),
			operation('op2', 'call', 'role:orchestrator:1', 'tool:read_file:1'),
			operation('op3', 'return', 'tool:read_file:1', 'role:orchestrator:1'),
			operation('op4', 'call', 'role:orchestrator:1', 'role:coder:1'),
			operation('op5', 'call', 'role:coder:1', 'human:answerer:1'),
			operation('op6', 'return', 'human:answerer:1', 'role:coder:1'),
			operation('op7', 'call', 'role:orchestrator:1', 'role:coder:2'),
		],
		status: 'running',
	}
}

describe('resolveInspectorScope — participant targets', () => {
	test('an agent node scopes to its executor instance id', () => {
		expect(resolveInspectorScope(model(), { kind: 'participant', id: 'role:coder:1' })).toBe('coder-1-2')
		expect(resolveInspectorScope(model(), { kind: 'participant', id: 'role:orchestrator:1' })).toBe('orchestrator-0-1')
	})

	test('a pseudo-role or tool node is not a drill-in', () => {
		expect(resolveInspectorScope(model(), { kind: 'participant', id: 'you' })).toBeNull()
		expect(resolveInspectorScope(model(), { kind: 'participant', id: 'human:answerer:1' })).toBeNull()
		expect(resolveInspectorScope(model(), { kind: 'participant', id: 'tool:read_file:1' })).toBeNull()
	})

	test('an agent node without an instance id falls back to the role name — the identity turn entries use on logs without per-instance ids', () => {
		const legacy: InteractionModel = {
			participants: [participant('you', 'human', 'human'), participant('role:coder:1', 'coder', 'role')],
			operations: [operation('op1', 'call', 'you', 'role:coder:1')],
			status: 'running',
		}
		expect(resolveInspectorScope(legacy, { kind: 'participant', id: 'role:coder:1' })).toBe('coder')
	})

	test('a participant id the model no longer carries resolves to no scope', () => {
		expect(resolveInspectorScope(model(), { kind: 'participant', id: 'role:coder:99' })).toBeNull()
	})
})

describe('resolveInspectorScope — role targets', () => {
	test('a top-bar slot scopes to the role\u2019s most recent instance', () => {
		expect(resolveInspectorScope(model(), { kind: 'role', id: 'coder' })).toBe('coder-1-9')
		expect(resolveInspectorScope(model(), { kind: 'role', id: 'orchestrator' })).toBe('orchestrator-0-1')
	})

	test('a slot with no agent participants of that name (a tool slot) is not a drill-in', () => {
		expect(resolveInspectorScope(model(), { kind: 'role', id: 'read_file' })).toBeNull()
		expect(resolveInspectorScope(model(), { kind: 'role', id: 'human' })).toBeNull()
		expect(resolveInspectorScope(model(), { kind: 'role', id: 'no-such-role' })).toBeNull()
	})
})

describe('resolveInspectorScope — operation targets', () => {
	test('a call scopes to its destination instance — the worker the call summons', () => {
		expect(resolveInspectorScope(model(), { kind: 'operation', id: 'op4' })).toBe('coder-1-2')
		expect(resolveInspectorScope(model(), { kind: 'operation', id: 'op1' })).toBe('orchestrator-0-1')
	})

	test('a return scopes to its source instance — the agent that returned', () => {
		const withAgentReturn: InteractionModel = {
			...model(),
			operations: [
				...model().operations,
				operation('op8', 'return', 'role:coder:2', 'role:orchestrator:1'),
			],
		}
		expect(resolveInspectorScope(withAgentReturn, { kind: 'operation', id: 'op8' })).toBe('coder-1-9')
	})

	test('a call to a tool is not a drill-in', () => {
		expect(resolveInspectorScope(model(), { kind: 'operation', id: 'op2' })).toBeNull()
	})

	test('an observe or terminate scopes to the agent it references when one exists', () => {
		const withCrossStackOps: InteractionModel = {
			participants: model().participants,
			operations: [
				...model().operations,
				operation('op8', 'observe', 'tool:read_file:1', 'role:coder:2'),
			],
			status: 'running',
		}
		expect(resolveInspectorScope(withCrossStackOps, { kind: 'operation', id: 'op8' })).toBe('coder-1-9')
	})

	test('an operation id the model no longer carries resolves to no scope', () => {
		expect(resolveInspectorScope(model(), { kind: 'operation', id: 'op-missing' })).toBeNull()
	})
})

describe('resolveInspectorScope — malformed targets', () => {
	test('a malformed model or target reads as no scope rather than throwing', () => {
		expect(resolveInspectorScope(null, { kind: 'participant', id: 'role:coder:1' })).toBeNull()
		expect(resolveInspectorScope(undefined, { kind: 'participant', id: 'role:coder:1' })).toBeNull()
		expect(resolveInspectorScope(model(), null)).toBeNull()
		expect(resolveInspectorScope(model(), {})).toBeNull()
		expect(resolveInspectorScope(model(), { kind: 'other', id: 'x' })).toBeNull()
	})
})
