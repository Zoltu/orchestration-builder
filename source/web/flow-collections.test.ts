import { describe, expect, test } from 'bun:test'
import { applyDelta, buildCollections, contentVersion, createEntityHasher, diffCollections } from './static/ts/entity-diff/index.js'
import type { CollectionDefinition, Delta, EntityBase, Snapshot } from './static/ts/entity-diff/index.js'
import { applyFlowEnvelope, emptyFlowReplicaState, flowDefinitions, flowModelFromReplicaState, RUN_STATUS_ENTITY_ID } from './static/ts/flow-collections.js'
import type { FlowCollections, FlowReplicaState, RunStatusEntity } from './static/ts/flow-collections.js'
import type { InteractionModel, Operation, OperationMetrics, Participant, StackRecord } from './static/ts/interaction-model.js'

function versionOf<Entity extends EntityBase>(definition: CollectionDefinition<Entity>): (entity: Entity) => string {
	const compute = definition.versionOf
	if (compute === undefined) throw new Error('expected the collection to declare a versionOf')
	return compute
}

function participant(id: string, role: string, kind: Participant['kind'], roleId?: string): Participant {
	return roleId === undefined ? { id, role, kind } : { id, role, kind, roleId }
}

function metrics(overrides: Partial<OperationMetrics> = {}): OperationMetrics {
	return { tokens: null, promptTokens: null, completionTokens: null, cachedPromptTokens: null, lastPromptTokens: null, elapsedSeconds: null, ...overrides }
}

function operation(id: string, overrides: Partial<Operation> = {}): Operation {
	return {
		id,
		kind: 'call',
		stack: 'main',
		source: 'human:root',
		destination: 'role:coder:1',
		startedAt: '2026-01-01T00:00:00.000Z',
		settledAt: null,
		lifecycle: 'in_flight',
		outcome: null,
		metrics: null,
		...overrides,
	}
}

function stack(id: string, root: string): StackRecord {
	return { id, root }
}

function stateFromModel(model: InteractionModel): FlowReplicaState {
	return {
		participants: model.participants,
		operations: model.operations,
		stacks: model.stacks ?? [],
		runStatus: [{ id: RUN_STATUS_ENTITY_ID, status: model.status }],
	}
}

function handModel(): InteractionModel {
	const participants = [participant('human:root', 'human', 'human'), participant('role:coder:1', 'coder', 'role', 'coder-1-1')]
	const operations = [
		operation('op-1', { destination: 'role:coder:1' }),
		operation('op-2', {
			kind: 'return',
			source: 'role:coder:1',
			destination: 'human:root',
			settledAt: '2026-01-01T00:00:05.000Z',
			lifecycle: 'settled',
			outcome: 'success',
			metrics: metrics({ tokens: 10, promptTokens: 7, completionTokens: 3, cachedPromptTokens: null, lastPromptTokens: 7, elapsedSeconds: 5 }),
		}),
	]
	const stacks = [stack('main', 'human:root')]
	return { participants, operations, status: 'success', stacks }
}

describe('flowModelFromReplicaState', () => {
	test('reconstructs a hand-built model from its replica state', () => {
		const model = handModel()
		const state = stateFromModel(model)
		buildCollections(flowDefinitions, createEntityHasher(), state)
		expect(flowModelFromReplicaState(state)).toEqual(model)
	})

	test('falls back to unknown when the runStatus singleton is absent', () => {
		const model = flowModelFromReplicaState(emptyFlowReplicaState())
		expect(model.status).toBe('unknown')
		expect(model.participants).toEqual([])
		expect(model.operations).toEqual([])
		expect(model.stacks).toEqual([])
	})

	test('emptyFlowReplicaState is accepted by buildCollections', () => {
		const state = emptyFlowReplicaState()
		const collections = buildCollections(flowDefinitions, createEntityHasher(), state)
		expect(collections.participants.size).toBe(0)
		expect(collections.operations.size).toBe(0)
		expect(collections.stacks.size).toBe(0)
		expect(collections.runStatus.size).toBe(0)
	})
})

describe('flowDefinitions versionOf', () => {
	test('participant version changes with role, kind, or roleId and is stable otherwise', () => {
		const version = versionOf(flowDefinitions.participants)
		const base = participant('role:coder:1', 'coder', 'role', 'coder-1-1')
		const baseVersion = version(base)
		expect(version({ ...base })).toBe(baseVersion)
		expect(version({ ...base, role: 'planner' })).not.toBe(baseVersion)
		expect(version({ ...base, kind: 'tool' })).not.toBe(baseVersion)
		expect(version({ ...base, roleId: 'coder-1-2' })).not.toBe(baseVersion)
		const withoutRoleId = participant('role:coder:1', 'coder', 'role')
		expect(version(withoutRoleId)).toBe(version({ id: 'role:coder:1', role: 'coder', kind: 'role' }))
	})

	test('stack version changes with root and is stable otherwise', () => {
		const version = versionOf(flowDefinitions.stacks)
		const base = stack('main', 'human:root')
		const baseVersion = version(base)
		expect(version({ ...base })).toBe(baseVersion)
		expect(version({ ...base, root: 'interrupt:1' })).not.toBe(baseVersion)
	})

	test('runStatus version changes with status and is stable otherwise', () => {
		const version = versionOf(flowDefinitions.runStatus)
		const base: RunStatusEntity = { id: RUN_STATUS_ENTITY_ID, status: 'running' }
		const baseVersion = version(base)
		expect(version({ ...base })).toBe(baseVersion)
		expect(version({ ...base, status: 'success' })).not.toBe(baseVersion)
	})

	test('operation version changes for every mutable field', () => {
		const version = versionOf(flowDefinitions.operations)
		const baseMetrics = metrics({ tokens: 10, promptTokens: 7, completionTokens: 3, cachedPromptTokens: 2, lastPromptTokens: 7, elapsedSeconds: 5 })
		const base = operation('op-1', { metrics: baseMetrics })
		const baseVersion = version(base)
		expect(version({ ...base })).toBe(baseVersion)
		expect(version(operation('op-1', { metrics: { ...baseMetrics } }))).toBe(baseVersion)
		const fieldVariants: [string, Operation][] = [
			['kind', { ...base, kind: 'return' }],
			['stack', { ...base, stack: 'interrupt-1-stack' }],
			['source', { ...base, source: 'role:planner:2' }],
			['destination', { ...base, destination: 'human:root' }],
			['startedAt', { ...base, startedAt: '2026-01-01T00:00:01.000Z' }],
			['settledAt', { ...base, settledAt: '2026-01-01T00:00:05.000Z' }],
			['lifecycle', { ...base, lifecycle: 'settled' }],
			['outcome', { ...base, outcome: 'success' }],
			['metrics null', { ...base, metrics: null }],
		]
		for (const [name, variant] of fieldVariants) {
			expect(version(variant), name).not.toBe(baseVersion)
		}
	})

	test('operation version changes for every metrics counter', () => {
		const version = versionOf(flowDefinitions.operations)
		const baseMetrics = metrics({ tokens: 10, promptTokens: 7, completionTokens: 3, cachedPromptTokens: 2, lastPromptTokens: 7, elapsedSeconds: 5 })
		const baseVersion = version(operation('op-1', { metrics: baseMetrics }))
		const counterVariants: [string, OperationMetrics][] = [
			['tokens', { ...baseMetrics, tokens: 11 }],
			['promptTokens', { ...baseMetrics, promptTokens: 8 }],
			['completionTokens', { ...baseMetrics, completionTokens: 4 }],
			['cachedPromptTokens', { ...baseMetrics, cachedPromptTokens: 3 }],
			['lastPromptTokens', { ...baseMetrics, lastPromptTokens: 8 }],
			['elapsedSeconds', { ...baseMetrics, elapsedSeconds: 6 }],
			['a null counter against a reported zero', { ...baseMetrics, tokens: 0 }],
		]
		for (const [name, changedMetrics] of counterVariants) {
			expect(version(operation('op-1', { metrics: changedMetrics })), name).not.toBe(baseVersion)
		}
	})
})

describe('flow collection guards', () => {
	test('accept well-formed entities', () => {
		expect(flowDefinitions.participants.isEntity(participant('human:root', 'human', 'human'))).toBe(true)
		expect(flowDefinitions.operations.isEntity(operation('op-1'))).toBe(true)
		expect(flowDefinitions.stacks.isEntity(stack('main', 'human:root'))).toBe(true)
		expect(flowDefinitions.runStatus.isEntity({ id: RUN_STATUS_ENTITY_ID, status: 'running' })).toBe(true)
	})

	test('reject malformed entities', () => {
		expect(flowDefinitions.participants.isEntity({ id: 'p', role: 'coder', kind: 'nonsense' })).toBe(false)
		expect(flowDefinitions.participants.isEntity({ id: 'p', role: 'coder' })).toBe(false)
		expect(flowDefinitions.participants.isEntity({ id: 'p', role: 'coder', kind: 'role', roleId: 3 })).toBe(false)
		expect(flowDefinitions.participants.isEntity(null)).toBe(false)

		expect(flowDefinitions.operations.isEntity({ ...operation('op-1'), lifecycle: 'bogus' })).toBe(false)
		expect(flowDefinitions.operations.isEntity({ ...operation('op-1'), settledAt: 7 })).toBe(false)
		expect(flowDefinitions.operations.isEntity({ ...operation('op-1'), outcome: 'bogus' })).toBe(false)
		expect(flowDefinitions.operations.isEntity({ ...operation('op-1'), metrics: { tokens: 'many', promptTokens: null, completionTokens: null, cachedPromptTokens: null, lastPromptTokens: null, elapsedSeconds: null } })).toBe(false)
		expect(flowDefinitions.operations.isEntity({ ...operation('op-1'), metrics: { tokens: 1, promptTokens: null, completionTokens: null, cachedPromptTokens: null, lastPromptTokens: null } })).toBe(false)

		expect(flowDefinitions.stacks.isEntity({ id: 'main' })).toBe(false)

		expect(flowDefinitions.runStatus.isEntity({ id: 'other', status: 'running' })).toBe(false)
		expect(flowDefinitions.runStatus.isEntity({ id: RUN_STATUS_ENTITY_ID, status: 'bogus' })).toBe(false)
	})
})

describe('append-only order preservation', () => {
	test('operations, participants, and stacks keep the server order through a delta round-trip', () => {
		const before: FlowReplicaState = {
			participants: [participant('human:root', 'human', 'human'), participant('role:coder:1', 'coder', 'role', 'coder-1-1')],
			operations: [operation('op-1', { destination: 'role:coder:1' })],
			stacks: [stack('main', 'human:root')],
			runStatus: [{ id: RUN_STATUS_ENTITY_ID, status: 'running' }],
		}
		const hasher = createEntityHasher()
		const beforeCollections = buildCollections(flowDefinitions, hasher, before)
		const after: FlowReplicaState = {
			participants: [...before.participants, participant('tool:read:1', 'read', 'tool'), participant('role:planner:2', 'planner', 'role', 'planner-2-1')],
			operations: [
				...before.operations,
				operation('op-2', { source: 'role:coder:1', destination: 'tool:read:1' }),
				operation('op-3', { kind: 'return', source: 'tool:read:1', destination: 'role:coder:1', settledAt: '2026-01-01T00:00:02.000Z', lifecycle: 'settled', outcome: 'success' }),
				operation('op-4', { source: 'role:coder:1', destination: 'role:planner:2' }),
			],
			stacks: [...before.stacks, stack('interrupt-1-stack', 'interrupt:1')],
			runStatus: [{ id: RUN_STATUS_ENTITY_ID, status: 'success' }],
		}
		const afterCollections = buildCollections(flowDefinitions, hasher, after)
		const { collections } = diffCollections(flowDefinitions, beforeCollections, afterCollections)
		const delta: Delta<FlowCollections> = { kind: 'delta', base: 'e:1', next: 'e:2', collections }
		const reaction = applyDelta(flowDefinitions, before, 'e:1', delta)
		expect(reaction.kind).toBe('applied')
		if (reaction.kind !== 'applied') throw new Error('expected the delta to apply')
		expect(reaction.state.operations.map((entity) => entity.id)).toEqual(after.operations.map((entity) => entity.id))
		expect(reaction.state.participants.map((entity) => entity.id)).toEqual(after.participants.map((entity) => entity.id))
		expect(reaction.state.stacks.map((entity) => entity.id)).toEqual(after.stacks.map((entity) => entity.id))
		expect(reaction.state.runStatus.map((entity) => entity.id)).toEqual(after.runStatus.map((entity) => entity.id))
		expect(reaction.state).toEqual(after)
	})
})

describe('applyFlowEnvelope', () => {
	test('reports unchanged at the held version and reconstructs the model from the untouched state', () => {
		const model = handModel()
		const state = stateFromModel(model)
		const result = applyFlowEnvelope(state, 'e:1', { kind: 'unchanged', version: 'e:1' }, createEntityHasher())
		expect(result.outcome).toBe('unchanged')
		expect(result.version).toBe('e:1')
		expect(result.state).toBe(state)
		expect(result.model).toEqual(model)
	})

	test('applies a delta from the held base and reconstructs the next model', () => {
		const beforeModel = handModel()
		const afterModel: InteractionModel = { ...beforeModel, status: 'running' }
		const before = stateFromModel(beforeModel)
		const after = stateFromModel(afterModel)
		const hasher = createEntityHasher()
		const { collections } = diffCollections(flowDefinitions, buildCollections(flowDefinitions, hasher, before), buildCollections(flowDefinitions, hasher, after))
		const delta: Delta<FlowCollections> = { kind: 'delta', base: 'e:1', next: 'e:2', collections }
		const result = applyFlowEnvelope(before, 'e:1', delta, hasher)
		expect(result.outcome).toBe('applied')
		expect(result.version).toBe('e:2')
		expect(result.model).toEqual(afterModel)
	})

	test('accepts a content-verified snapshot and reconstructs its model', () => {
		const targetModel = handModel()
		const target = stateFromModel(targetModel)
		const collections = buildCollections(flowDefinitions, createEntityHasher(), target)
		const snapshot: Snapshot<FlowCollections> = { kind: 'snapshot', version: 'e:9', contentHash: contentVersion(flowDefinitions, collections), collections: target }
		const result = applyFlowEnvelope(emptyFlowReplicaState(), null, snapshot, createEntityHasher())
		expect(result.outcome).toBe('snapshot')
		expect(result.version).toBe('e:9')
		expect(result.model).toEqual(targetModel)
	})

	test('rejects a snapshot whose content hash does not match its contents', () => {
		const state = stateFromModel(handModel())
		const target = stateFromModel(handModel())
		const snapshot: Snapshot<FlowCollections> = { kind: 'snapshot', version: 'e:9', contentHash: 'not-the-real-hash', collections: target }
		const result = applyFlowEnvelope(state, 'e:1', snapshot, createEntityHasher())
		expect(result.outcome).toBe('invalid')
		expect(result.state).toBe(state)
		expect(result.version).toBe('e:1')
		expect(result.model).toBeNull()
	})

	test('reports needsSnapshot when a delta base does not match the held version', () => {
		const state = stateFromModel(handModel())
		const delta: Delta<FlowCollections> = { kind: 'delta', base: 'e:1', next: 'e:2', collections: {} }
		const result = applyFlowEnvelope(state, 'e:9', delta, createEntityHasher())
		expect(result.outcome).toBe('needsSnapshot')
		expect(result.state).toBe(state)
		expect(result.version).toBe('e:9')
		expect(result.model).toBeNull()
	})

	test('reports needsSnapshot for an unchanged response at a version the client does not hold', () => {
		const state = stateFromModel(handModel())
		const result = applyFlowEnvelope(state, 'e:1', { kind: 'unchanged', version: 'e:99' }, createEntityHasher())
		expect(result.outcome).toBe('needsSnapshot')
		expect(result.model).toBeNull()
	})

	test('reports invalid for a response that fails the protocol guard', () => {
		const state = stateFromModel(handModel())
		const result = applyFlowEnvelope(state, 'e:1', { kind: 'nonsense' }, createEntityHasher())
		expect(result.outcome).toBe('invalid')
		expect(result.state).toBe(state)
		expect(result.model).toBeNull()
	})
})
