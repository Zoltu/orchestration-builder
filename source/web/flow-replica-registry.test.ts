import { describe, expect, test } from 'bun:test'
import { applyDelta } from './static/ts/entity-diff/index.js'
import { flowDefinitions, flowModelFromReplicaState, RUN_STATUS_ENTITY_ID } from './static/ts/flow-collections.js'
import type { FlowReplicaState } from './static/ts/flow-collections.js'
import type { Operation, Participant, RunStatus } from './static/ts/interaction-model.js'
import { createFlowReplicaRegistry } from './flow-replica-registry.js'

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

function flowState(operationIds: string[], status: RunStatus = 'running'): FlowReplicaState {
	const participants: Participant[] = [
		{ id: 'human:root', role: 'human', kind: 'human' },
		{ id: 'role:coder:1', role: 'coder', kind: 'role', roleId: 'coder-1-1' },
	]
	return {
		participants,
		operations: operationIds.map((id) => operation(id)),
		stacks: [{ id: 'main', root: 'human:root' }],
		runStatus: [{ id: RUN_STATUS_ENTITY_ID, status }],
	}
}

describe('createFlowReplicaRegistry', () => {
	test('snapshots on the first request, reports unchanged for the same revision, and deltas a change', () => {
		const registry = createFlowReplicaRegistry({ epoch: 'e', historyLimit: 8, maxRuns: 4 })
		const first = registry.envelopeFor('run-a', flowState(['op-1']), null)
		expect(first.kind).toBe('snapshot')
		if (first.kind !== 'snapshot') throw new Error('expected a snapshot')

		expect(registry.envelopeFor('run-a', flowState(['op-1']), first.version)).toEqual({ kind: 'unchanged', version: first.version })

		const changed = registry.envelopeFor('run-a', flowState(['op-1', 'op-2']), first.version)
		expect(changed.kind).toBe('delta')
		if (changed.kind !== 'delta') throw new Error('expected a delta')
		expect(changed.base).toBe(first.version)

		const reaction = applyDelta(flowDefinitions, first.collections, first.version, changed)
		expect(reaction.kind).toBe('applied')
		if (reaction.kind !== 'applied') throw new Error('expected the delta to apply')
		expect(flowModelFromReplicaState(reaction.state).operations.map((entity) => entity.id)).toEqual(['op-1', 'op-2'])
	})

	test('a run evicted by the LRU bound is rebuilt from a snapshot for a stale revision', () => {
		const registry = createFlowReplicaRegistry({ epoch: 'e', historyLimit: 8, maxRuns: 1 })
		const first = registry.envelopeFor('run-a', flowState(['op-1']), null)
		if (first.kind !== 'snapshot') throw new Error('expected a snapshot')

		// Requesting run-b evicts run-a.
		expect(registry.envelopeFor('run-b', flowState(['op-1']), null).kind).toBe('snapshot')

		// The rebuilt replica issues a fresh revision, so even the first revision run-a ever served is unknown and the client resyncs by snapshot rather than reading a stale `unchanged`.
		const rebuilt = registry.envelopeFor('run-a', flowState(['op-1', 'op-2']), first.version)
		expect(rebuilt.kind).toBe('snapshot')
		if (rebuilt.kind !== 'snapshot') throw new Error('expected a snapshot')
		expect(rebuilt.version).not.toBe(first.version)
	})

	test('a run within the LRU bound stays cached, so its retained revision yields a delta', () => {
		const registry = createFlowReplicaRegistry({ epoch: 'e', historyLimit: 8, maxRuns: 2 })
		const first = registry.envelopeFor('run-a', flowState(['op-1']), null)
		if (first.kind !== 'snapshot') throw new Error('expected a snapshot')
		registry.envelopeFor('run-b', flowState(['op-1']), null)
		expect(registry.envelopeFor('run-a', flowState(['op-1', 'op-2']), first.version).kind).toBe('delta')
	})

	test('touching a run refreshes its LRU position, so the true least-recently-used run is evicted instead', () => {
		const registry = createFlowReplicaRegistry({ epoch: 'e', historyLimit: 8, maxRuns: 2 })
		const a = registry.envelopeFor('run-a', flowState(['op-1']), null)
		if (a.kind !== 'snapshot') throw new Error('expected a snapshot')
		const b = registry.envelopeFor('run-b', flowState(['op-1']), null)
		if (b.kind !== 'snapshot') throw new Error('expected a snapshot')
		// Touch run-a so run-b becomes the least-recently-used run; without the delete+set refresh, insertion order stays a, b and run-a is evicted instead.
		registry.envelopeFor('run-a', flowState(['op-1']), a.version)
		registry.envelopeFor('run-c', flowState(['op-1']), null)

		// run-a still holds the revision it issued, so its retained base yields a delta...
		expect(registry.envelopeFor('run-a', flowState(['op-1', 'op-2']), a.version).kind).toBe('delta')
		// ...while run-b was evicted and rebuilt, so its stale revision yields a snapshot.
		expect(registry.envelopeFor('run-b', flowState(['op-1']), b.version).kind).toBe('snapshot')
	})

	test('runs are isolated: one run never accepts another run\'s revision', () => {
		const registry = createFlowReplicaRegistry({ epoch: 'e', historyLimit: 8, maxRuns: 4 })
		const a = registry.envelopeFor('run-a', flowState(['op-1']), null)
		if (a.kind !== 'snapshot') throw new Error('expected a snapshot')
		expect(registry.envelopeFor('run-b', flowState(['op-1']), a.version).kind).toBe('snapshot')
	})

	test('registries with different epochs never share a revision', () => {
		const firstRegistry = createFlowReplicaRegistry({ epoch: 'epoch-a', historyLimit: 8, maxRuns: 4 })
		const secondRegistry = createFlowReplicaRegistry({ epoch: 'epoch-b', historyLimit: 8, maxRuns: 4 })
		const first = firstRegistry.envelopeFor('run', flowState(['op-1']), null)
		const second = secondRegistry.envelopeFor('run', flowState(['op-1']), null)
		if (first.kind !== 'snapshot' || second.kind !== 'snapshot') throw new Error('expected snapshots')
		expect(first.version).not.toBe(second.version)
		expect(secondRegistry.envelopeFor('run', flowState(['op-1']), first.version).kind).toBe('snapshot')
	})

	test('rejects a maxRuns that is not a positive integer', () => {
		expect(() => createFlowReplicaRegistry({ epoch: 'e', historyLimit: 8, maxRuns: 0 })).toThrow()
		expect(() => createFlowReplicaRegistry({ epoch: 'e', historyLimit: 8, maxRuns: 1.5 })).toThrow()
	})
})
