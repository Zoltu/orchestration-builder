import { describe, expect, test } from 'bun:test'
import { applyFlowFrame, createFlowFeedResponder, discardFlowRevision, emptyFlowFeedState, flowFeedRevision } from './index.js'
import type { InteractionModel, Operation, OperationMetrics, Participant, StackRecord } from '../interaction-model.js'

function frameKind(value: unknown): string | null {
	if (typeof value !== 'object' || value === null) return null
	if (!('kind' in value)) return null
	return typeof value.kind === 'string' ? value.kind : null
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

function emptyCollections(): Record<string, unknown> {
	return { participants: [], operations: [], stacks: [], runStatus: [] }
}

function snapshotFrame(collections: Record<string, unknown>): Record<string, unknown> {
	return { kind: 'snapshot', version: 'e:9', contentHash: 'not-a-real-hash', collections }
}

describe('flow feed round-trip', () => {
	test('a first snapshot reconstructs the model, then unchanged keeps the same state and model references', () => {
		const responder = createFlowFeedResponder({ epoch: 'e', historyLimit: 8, maxRuns: 4 })
		const model = handModel()
		const first = applyFlowFrame(emptyFlowFeedState(), responder('run-a', model, null))
		expect(first.outcome).toBe('snapshot')
		expect(first.model).toEqual(model)
		const revision = flowFeedRevision(first.state)
		expect(typeof revision).toBe('string')
		if (first.model === null || revision === null) throw new Error('expected a model and revision after a snapshot')

		const unchanged = applyFlowFrame(first.state, responder('run-a', model, revision))
		expect(unchanged.outcome).toBe('unchanged')
		expect(unchanged.state).toBe(first.state)
		expect(unchanged.model).toBe(first.model)
	})

	test('discarding the revision keeps the held replica but makes the next poll ask for a snapshot', () => {
		const responder = createFlowFeedResponder({ epoch: 'e', historyLimit: 8, maxRuns: 4 })
		const model = handModel()
		const first = applyFlowFrame(emptyFlowFeedState(), responder('run-a', model, null))
		const revision = flowFeedRevision(first.state)
		if (revision === null) throw new Error('expected a revision after a snapshot')
		const discarded = discardFlowRevision(first.state)
		expect(flowFeedRevision(discarded)).toBeNull()
		const resumed = applyFlowFrame(discarded, responder('run-a', model, flowFeedRevision(discarded)))
		expect(resumed.outcome).toBe('snapshot')
		expect(resumed.model).toEqual(model)
	})

	test('a changed model arrives as a delta and applies to the next model', () => {
		const responder = createFlowFeedResponder({ epoch: 'e', historyLimit: 8, maxRuns: 4 })
		const before = handModel()
		const first = applyFlowFrame(emptyFlowFeedState(), responder('run-a', before, null))
		const revision = flowFeedRevision(first.state)
		if (revision === null) throw new Error('expected a revision after a snapshot')
		const after: InteractionModel = { ...before, status: 'running' }
		const frame = responder('run-a', after, revision)
		expect(frameKind(frame)).toBe('delta')
		const applied = applyFlowFrame(first.state, frame)
		expect(applied.outcome).toBe('applied')
		expect(applied.model).toEqual(after)
		expect(flowFeedRevision(applied.state)).not.toBe(revision)
	})

	test('a fresh snapshot reconstructs the same model as the delta path', () => {
		const responder = createFlowFeedResponder({ epoch: 'e', historyLimit: 8, maxRuns: 4 })
		const model = handModel()
		const first = applyFlowFrame(emptyFlowFeedState(), responder('run-a', model, null))
		const revision = flowFeedRevision(first.state)
		if (revision === null) throw new Error('expected a revision after a snapshot')
		const changed: InteractionModel = { ...model, operations: [...model.operations, operation('op-3')] }
		const applied = applyFlowFrame(first.state, responder('run-a', changed, revision))
		if (applied.model === null) throw new Error('expected the delta to produce a model')
		const fresh = applyFlowFrame(emptyFlowFeedState(), responder('run-a', changed, null))
		expect(fresh.outcome).toBe('snapshot')
		expect(fresh.model).toEqual(applied.model)
	})

	test('a stale delta base and an unchanged frame at an unknown revision both report needsSnapshot', () => {
		const responder = createFlowFeedResponder({ epoch: 'e', historyLimit: 8, maxRuns: 4 })
		const first = applyFlowFrame(emptyFlowFeedState(), responder('run-a', handModel(), null))
		const stale = applyFlowFrame(first.state, { kind: 'delta', base: 'unknown', next: 'e:2', collections: {} })
		expect(stale.outcome).toBe('needsSnapshot')
		expect(stale.state).toBe(first.state)
		expect(stale.model).toBeNull()
		const unknownUnchanged = applyFlowFrame(first.state, { kind: 'unchanged', version: 'unknown' })
		expect(unknownUnchanged.outcome).toBe('needsSnapshot')
		expect(unknownUnchanged.state).toBe(first.state)
		expect(unknownUnchanged.model).toBeNull()
	})

	test('an invalid frame leaves the held state untouched', () => {
		const responder = createFlowFeedResponder({ epoch: 'e', historyLimit: 8, maxRuns: 4 })
		const first = applyFlowFrame(emptyFlowFeedState(), responder('run-a', handModel(), null))
		const invalid = applyFlowFrame(first.state, { kind: 'nonsense' })
		expect(invalid.outcome).toBe('invalid')
		expect(invalid.state).toBe(first.state)
		expect(invalid.model).toBeNull()
	})

	test('an empty model round-trips to an empty model with unknown status', () => {
		const responder = createFlowFeedResponder({ epoch: 'e', historyLimit: 8, maxRuns: 4 })
		const empty: InteractionModel = { participants: [], operations: [], status: 'unknown', stacks: [] }
		const result = applyFlowFrame(emptyFlowFeedState(), responder('run-a', empty, null))
		expect(result.outcome).toBe('snapshot')
		expect(result.model).toEqual(empty)
	})

	test('a delta that removes the run-status singleton reconstructs status unknown', () => {
		const responder = createFlowFeedResponder({ epoch: 'e', historyLimit: 8, maxRuns: 4 })
		const first = applyFlowFrame(emptyFlowFeedState(), responder('run-a', handModel(), null))
		const revision = flowFeedRevision(first.state)
		if (revision === null) throw new Error('expected a revision after a snapshot')
		const frame = { kind: 'delta', base: revision, next: 'e:removed-run-status', collections: { runStatus: { added: [], changed: [], removed: ['run-status'] } } }
		const applied = applyFlowFrame(first.state, frame)
		expect(applied.outcome).toBe('applied')
		if (applied.model === null) throw new Error('expected the delta to produce a model')
		expect(applied.model.status).toBe('unknown')
	})
})

describe('flow feed append-only order preservation', () => {
	test('operations, participants, and stacks keep the server order through a delta round-trip', () => {
		const responder = createFlowFeedResponder({ epoch: 'e', historyLimit: 8, maxRuns: 4 })
		const beforeStacks: StackRecord[] = [stack('main', 'human:root')]
		const before: InteractionModel = {
			participants: [participant('human:root', 'human', 'human'), participant('role:coder:1', 'coder', 'role', 'coder-1-1')],
			operations: [operation('op-1', { destination: 'role:coder:1' })],
			stacks: beforeStacks,
			status: 'running',
		}
		const first = applyFlowFrame(emptyFlowFeedState(), responder('run-a', before, null))
		const revision = flowFeedRevision(first.state)
		if (revision === null) throw new Error('expected a revision after a snapshot')
		const afterStacks: StackRecord[] = [...beforeStacks, stack('interrupt-1-stack', 'interrupt:1')]
		const after: InteractionModel = {
			participants: [...before.participants, participant('tool:read:1', 'read', 'tool'), participant('role:planner:2', 'planner', 'role', 'planner-2-1')],
			operations: [
				...before.operations,
				operation('op-2', { source: 'role:coder:1', destination: 'tool:read:1' }),
				operation('op-3', { kind: 'return', source: 'tool:read:1', destination: 'role:coder:1', settledAt: '2026-01-01T00:00:02.000Z', lifecycle: 'settled', outcome: 'success' }),
				operation('op-4', { source: 'role:coder:1', destination: 'role:planner:2' }),
			],
			stacks: afterStacks,
			status: 'success',
		}
		const frame = responder('run-a', after, revision)
		expect(frameKind(frame)).toBe('delta')
		const applied = applyFlowFrame(first.state, frame)
		expect(applied.outcome).toBe('applied')
		if (applied.model === null) throw new Error('expected the delta to produce a model')
		expect(applied.model.operations.map((entity) => entity.id)).toEqual(after.operations.map((entity) => entity.id))
		expect(applied.model.participants.map((entity) => entity.id)).toEqual(after.participants.map((entity) => entity.id))
		if (applied.model.stacks === undefined) throw new Error('expected the delta model to carry stacks')
		expect(applied.model.stacks.map((entity) => entity.id)).toEqual(afterStacks.map((entity) => entity.id))
	})
})

describe('flow feed change detection', () => {
	test('every mutable participant, stack, run-status, operation, and metrics field changes the frame', () => {
		const responder = createFlowFeedResponder({ epoch: 'e', historyLimit: 128, maxRuns: 4 })
		const base = handModel()
		const first = applyFlowFrame(emptyFlowFeedState(), responder('run-a', base, null))
		const revision = flowFeedRevision(first.state)
		if (revision === null) throw new Error('expected a revision after a snapshot')
		const baseParticipants = base.participants
		const baseOperations = base.operations
		const baseOperation = baseOperations[0]
		const baseMetrics = metrics({ tokens: 10, promptTokens: 7, completionTokens: 3, cachedPromptTokens: 2, lastPromptTokens: 7, elapsedSeconds: 5 })
		if (baseOperation === undefined) throw new Error('expected a base operation')
		const variants: [string, InteractionModel][] = [
			['participant role', { ...base, participants: [participant('human:root', 'human', 'human'), participant('role:coder:1', 'planner', 'role', 'coder-1-1'), ...baseParticipants.slice(2)] }],
			['participant kind', { ...base, participants: [baseParticipants[0] ?? participant('human:root', 'human', 'human'), participant('role:coder:1', 'coder', 'tool', 'coder-1-1'), ...baseParticipants.slice(2)] }],
			['participant roleId', { ...base, participants: [baseParticipants[0] ?? participant('human:root', 'human', 'human'), participant('role:coder:1', 'coder', 'role', 'coder-1-2'), ...baseParticipants.slice(2)] }],
			['stack root', { ...base, stacks: [stack('main', 'interrupt:1')] }],
			['run status', { ...base, status: 'running' }],
			['operation kind', { ...base, operations: [operation('op-1', { kind: 'return', metrics: baseMetrics }), ...baseOperations.slice(1)] }],
			['operation stack', { ...base, operations: [operation('op-1', { stack: 'interrupt-1-stack', metrics: baseMetrics }), ...baseOperations.slice(1)] }],
			['operation source', { ...base, operations: [operation('op-1', { source: 'role:planner:2', metrics: baseMetrics }), ...baseOperations.slice(1)] }],
			['operation destination', { ...base, operations: [operation('op-1', { destination: 'human:root', metrics: baseMetrics }), ...baseOperations.slice(1)] }],
			['operation startedAt', { ...base, operations: [operation('op-1', { startedAt: '2026-01-01T00:00:01.000Z', metrics: baseMetrics }), ...baseOperations.slice(1)] }],
			['operation settledAt', { ...base, operations: [operation('op-1', { settledAt: '2026-01-01T00:00:05.000Z', metrics: baseMetrics }), ...baseOperations.slice(1)] }],
			['operation lifecycle', { ...base, operations: [operation('op-1', { lifecycle: 'settled', metrics: baseMetrics }), ...baseOperations.slice(1)] }],
			['operation outcome', { ...base, operations: [operation('op-1', { outcome: 'success', metrics: baseMetrics }), ...baseOperations.slice(1)] }],
			['operation metrics to null', { ...base, operations: [operation('op-1', { metrics: null }), ...baseOperations.slice(1)] }],
			['metrics tokens', { ...base, operations: [operation('op-1', { metrics: metrics({ ...baseMetrics, tokens: 11 }) }), ...baseOperations.slice(1)] }],
			['metrics promptTokens', { ...base, operations: [operation('op-1', { metrics: metrics({ ...baseMetrics, promptTokens: 8 }) }), ...baseOperations.slice(1)] }],
			['metrics completionTokens', { ...base, operations: [operation('op-1', { metrics: metrics({ ...baseMetrics, completionTokens: 4 }) }), ...baseOperations.slice(1)] }],
			['metrics cachedPromptTokens', { ...base, operations: [operation('op-1', { metrics: metrics({ ...baseMetrics, cachedPromptTokens: 3 }) }), ...baseOperations.slice(1)] }],
			['metrics lastPromptTokens', { ...base, operations: [operation('op-1', { metrics: metrics({ ...baseMetrics, lastPromptTokens: 8 }) }), ...baseOperations.slice(1)] }],
			['metrics elapsedSeconds', { ...base, operations: [operation('op-1', { metrics: metrics({ ...baseMetrics, elapsedSeconds: 6 }) }), ...baseOperations.slice(1)] }],
			['a null counter against a reported zero', { ...base, operations: [operation('op-1', { metrics: metrics({ ...baseMetrics, tokens: 0 }) }), ...baseOperations.slice(1)] }],
		]
		for (const [name, variant] of variants) {
			expect(frameKind(responder('run-a', variant, revision)), name).toBe('delta')
		}
	})
})

describe('flow feed validation', () => {
	test('rejects malformed entities in a snapshot', () => {
		const malformed: [string, Record<string, unknown>][] = [
			['participant null', snapshotFrame({ ...emptyCollections(), participants: [null] })],
			['participant kind', snapshotFrame({ ...emptyCollections(), participants: [{ id: 'p', role: 'coder', kind: 'nonsense' }] })],
			['participant missing kind', snapshotFrame({ ...emptyCollections(), participants: [{ id: 'p', role: 'coder' }] })],
			['participant roleId', snapshotFrame({ ...emptyCollections(), participants: [{ id: 'p', role: 'coder', kind: 'role', roleId: 3 }] })],
			['operation lifecycle', snapshotFrame({ ...emptyCollections(), operations: [{ ...operation('op-1'), lifecycle: 'bogus' }] })],
			['operation settledAt', snapshotFrame({ ...emptyCollections(), operations: [{ ...operation('op-1'), settledAt: 7 }] })],
			['operation outcome', snapshotFrame({ ...emptyCollections(), operations: [{ ...operation('op-1'), outcome: 'bogus' }] })],
			['operation metrics', snapshotFrame({ ...emptyCollections(), operations: [{ ...operation('op-1'), metrics: { tokens: 'many', promptTokens: null, completionTokens: null, cachedPromptTokens: null, lastPromptTokens: null, elapsedSeconds: null } }] })],
			['operation metrics missing a counter', snapshotFrame({ ...emptyCollections(), operations: [{ ...operation('op-1'), metrics: { tokens: 1, promptTokens: null, completionTokens: null, cachedPromptTokens: null, lastPromptTokens: null } }] })],
			['stack root', snapshotFrame({ ...emptyCollections(), stacks: [{ id: 'main' }] })],
			['run status id', snapshotFrame({ ...emptyCollections(), runStatus: [{ id: 'other', status: 'running' }] })],
			['run status value', snapshotFrame({ ...emptyCollections(), runStatus: [{ id: 'run-status', status: 'bogus' }] })],
		]
		for (const [name, frame] of malformed) {
			const result = applyFlowFrame(emptyFlowFeedState(), frame)
			expect(result.outcome, name).toBe('invalid')
			expect(result.model, name).toBeNull()
		}
	})

	test('rejects a snapshot whose content hash does not match its contents', () => {
		const result = applyFlowFrame(emptyFlowFeedState(), snapshotFrame(emptyCollections()))
		expect(result.outcome).toBe('invalid')
		expect(result.model).toBeNull()
	})
})

describe('flow feed responder LRU and epochs', () => {
	test('a run evicted by the LRU bound is rebuilt from a snapshot for a stale revision', () => {
		const responder = createFlowFeedResponder({ epoch: 'e', historyLimit: 8, maxRuns: 1 })
		const first = applyFlowFrame(emptyFlowFeedState(), responder('run-a', handModel(), null))
		const firstRevision = flowFeedRevision(first.state)
		if (firstRevision === null) throw new Error('expected a revision after a snapshot')

		responder('run-b', handModel(), null)

		const rebuilt = applyFlowFrame(first.state, responder('run-a', handModel(), firstRevision))
		expect(rebuilt.outcome).toBe('snapshot')
		expect(flowFeedRevision(rebuilt.state)).not.toBe(firstRevision)
	})

	test('a run within the LRU bound stays cached, so its retained revision yields a delta', () => {
		const responder = createFlowFeedResponder({ epoch: 'e', historyLimit: 8, maxRuns: 2 })
		const first = applyFlowFrame(emptyFlowFeedState(), responder('run-a', handModel(), null))
		const revision = flowFeedRevision(first.state)
		if (revision === null) throw new Error('expected a revision after a snapshot')
		responder('run-b', handModel(), null)
		const changed: InteractionModel = { ...handModel(), status: 'running' }
		expect(frameKind(responder('run-a', changed, revision))).toBe('delta')
	})

	test('touching a run refreshes its LRU position, so the true least-recently-used run is evicted instead', () => {
		const responder = createFlowFeedResponder({ epoch: 'e', historyLimit: 8, maxRuns: 2 })
		const a = applyFlowFrame(emptyFlowFeedState(), responder('run-a', handModel(), null))
		const aRevision = flowFeedRevision(a.state)
		const b = applyFlowFrame(emptyFlowFeedState(), responder('run-b', handModel(), null))
		const bRevision = flowFeedRevision(b.state)
		if (aRevision === null || bRevision === null) throw new Error('expected revisions after snapshots')
		responder('run-a', handModel(), aRevision)
		responder('run-c', handModel(), null)

		const changed: InteractionModel = { ...handModel(), status: 'running' }
		expect(frameKind(responder('run-a', changed, aRevision))).toBe('delta')
		expect(frameKind(responder('run-b', handModel(), bRevision))).toBe('snapshot')
	})

	test('runs are isolated: one run never accepts another run\'s revision', () => {
		const responder = createFlowFeedResponder({ epoch: 'e', historyLimit: 8, maxRuns: 4 })
		const a = applyFlowFrame(emptyFlowFeedState(), responder('run-a', handModel(), null))
		const aRevision = flowFeedRevision(a.state)
		if (aRevision === null) throw new Error('expected a revision after a snapshot')
		expect(frameKind(responder('run-b', handModel(), aRevision))).toBe('snapshot')
	})

	test('responders with different epochs never share a revision', () => {
		const firstResponder = createFlowFeedResponder({ epoch: 'epoch-a', historyLimit: 8, maxRuns: 4 })
		const secondResponder = createFlowFeedResponder({ epoch: 'epoch-b', historyLimit: 8, maxRuns: 4 })
		const first = applyFlowFrame(emptyFlowFeedState(), firstResponder('run', handModel(), null))
		const second = applyFlowFrame(emptyFlowFeedState(), secondResponder('run', handModel(), null))
		const firstRevision = flowFeedRevision(first.state)
		const secondRevision = flowFeedRevision(second.state)
		expect(firstRevision).not.toBe(secondRevision)
		if (firstRevision === null) throw new Error('expected a revision after a snapshot')
		expect(frameKind(secondResponder('run', handModel(), firstRevision))).toBe('snapshot')
	})

	test('rejects a maxRuns that is not a positive integer', () => {
		expect(() => createFlowFeedResponder({ epoch: 'e', historyLimit: 8, maxRuns: 0 })).toThrow()
		expect(() => createFlowFeedResponder({ epoch: 'e', historyLimit: 8, maxRuns: 1.5 })).toThrow()
	})
})
