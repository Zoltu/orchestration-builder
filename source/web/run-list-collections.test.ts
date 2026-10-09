import { describe, expect, test } from 'bun:test'
import { buildCollections, contentVersion, createEntityHasher, diffCollections } from './static/ts/entity-diff/index.js'
import type { CollectionDefinition, Delta, EntityBase, Snapshot } from './static/ts/entity-diff/index.js'
import { applyRunListEnvelope, emptyRunListReplicaState, runListDefinitions, runSummariesFromReplicaState } from './static/ts/run-list-collections.js'
import type { RunListCollections, RunListReplicaState, RunSummaryEntity } from './static/ts/run-list-collections.js'

function versionOf<Entity extends EntityBase>(definition: CollectionDefinition<Entity>): (entity: Entity) => string {
	const compute = definition.versionOf
	if (compute === undefined) throw new Error('expected the collection to declare a versionOf')
	return compute
}

function summary(id: string, overrides: Partial<RunSummaryEntity> = {}): RunSummaryEntity {
	return {
		id,
		status: 'success',
		task: `task for ${id}`,
		effort: 'standard',
		startTime: '2026-01-01T00:00:00.000Z',
		endTime: '2026-01-01T00:01:00.000Z',
		result: null,
		error: null,
		summary: null,
		...overrides,
	}
}

describe('run-list collection guards', () => {
	test('accepts a well-formed entity and one carrying a result card and run-level error', () => {
		expect(runListDefinitions.runs.isEntity(summary('run-1'))).toBe(true)
		expect(runListDefinitions.runs.isEntity(summary('run-1', {
			result: { status: 'error', summary: 'failed', artifacts: ['out.txt'], error: { kind: 'llm_unavailable', message: 'down', details: { code: 500 } }, detail: 'raw' },
			error: { kind: 'llm_unavailable', message: 'down' },
		}))).toBe(true)
	})

	test('rejects malformed entities', () => {
		expect(runListDefinitions.runs.isEntity(null)).toBe(false)
		expect(runListDefinitions.runs.isEntity({ ...summary('run-1'), id: '' })).toBe(false)
		expect(runListDefinitions.runs.isEntity({ ...summary('run-1'), status: 'bogus' })).toBe(false)
		expect(runListDefinitions.runs.isEntity({ ...summary('run-1'), task: 7 })).toBe(false)
		expect(runListDefinitions.runs.isEntity({ ...summary('run-1'), endTime: 7 })).toBe(false)
		expect(runListDefinitions.runs.isEntity({ ...summary('run-1'), summary: 7 })).toBe(false)
		expect(runListDefinitions.runs.isEntity({ ...summary('run-1'), result: { status: 'bogus', summary: 'x' } })).toBe(false)
		expect(runListDefinitions.runs.isEntity({ ...summary('run-1'), result: { status: 'success' } })).toBe(false)
		expect(runListDefinitions.runs.isEntity({ ...summary('run-1'), result: { status: 'success', summary: 'x', artifacts: [1] } })).toBe(false)
		expect(runListDefinitions.runs.isEntity({ ...summary('run-1'), error: { kind: 'x' } })).toBe(false)
	})
})

describe('runSummary versionOf', () => {
	test('is stable for identical content and changes for every mutable field', () => {
		const version = versionOf(runListDefinitions.runs)
		const base = summary('run-1', { result: { status: 'success', summary: 'done' } })
		const baseVersion = version(base)
		expect(version({ ...base })).toBe(baseVersion)
		expect(version({ ...base, result: { status: 'success', summary: 'done' } })).toBe(baseVersion)
		const variants: [string, RunSummaryEntity][] = [
			['status', { ...base, status: 'error' }],
			['task', { ...base, task: 'another task' }],
			['effort', { ...base, effort: 'quick' }],
			['startTime', { ...base, startTime: '2026-01-01T00:00:01.000Z' }],
			['endTime', { ...base, endTime: '2026-01-01T00:02:00.000Z' }],
			['result', { ...base, result: { status: 'success', summary: 'changed' } }],
			['result to null', { ...base, result: null }],
			['error', { ...base, error: { kind: 'llm_unavailable', message: 'down' } }],
			['summary', { ...base, summary: 'a generated summary' }],
		]
		for (const [name, variant] of variants) {
			expect(version(variant), name).not.toBe(baseVersion)
		}
	})

	test('free-text separators cannot shift field boundaries into a collision', () => {
		const version = versionOf(runListDefinitions.runs)
		const left = summary('run-1', { task: 'x|quick', effort: null })
		const right = summary('run-1', { task: 'x', effort: 'quick' })
		expect(version(left)).not.toBe(version(right))
	})
})

describe('runSummariesFromReplicaState', () => {
	test('reconstructs the summaries newest-first by run id', () => {
		const state: RunListReplicaState = { runs: [summary('run-20260101-000000'), summary('run-20260103-000000'), summary('run-20260102-000000')] }
		expect(runSummariesFromReplicaState(state).map((entry) => entry.runId)).toEqual(['run-20260103-000000', 'run-20260102-000000', 'run-20260101-000000'])
	})

	test('renames the entity id back to runId and preserves every field', () => {
		const entity = summary('run-1', { status: 'error', result: { status: 'error', summary: 'failed' }, error: { kind: 'llm_unavailable', message: 'down' }, summary: 'a summary' })
		expect(runSummariesFromReplicaState({ runs: [entity] })).toEqual([
			{
				runId: 'run-1',
				status: 'error',
				task: 'task for run-1',
				effort: 'standard',
				startTime: '2026-01-01T00:00:00.000Z',
				endTime: '2026-01-01T00:01:00.000Z',
				result: { status: 'error', summary: 'failed' },
				error: { kind: 'llm_unavailable', message: 'down' },
				summary: 'a summary',
			},
		])
	})

	test('an empty replica state reconstructs to an empty list', () => {
		expect(runSummariesFromReplicaState(emptyRunListReplicaState())).toEqual([])
	})
})

describe('applyRunListEnvelope', () => {
	test('reports unchanged at the held version and reconstructs the summaries from the untouched state', () => {
		const state: RunListReplicaState = { runs: [summary('run-1')] }
		const result = applyRunListEnvelope(state, 'e:1', { kind: 'unchanged', version: 'e:1' }, createEntityHasher())
		expect(result.outcome).toBe('unchanged')
		expect(result.version).toBe('e:1')
		expect(result.state).toBe(state)
		expect(result.summaries?.map((entry) => entry.runId)).toEqual(['run-1'])
	})

	test('applies a delta from the held base and reconstructs the next summaries', () => {
		const before: RunListReplicaState = { runs: [summary('run-1')] }
		const after: RunListReplicaState = { runs: [summary('run-2'), summary('run-1', { status: 'error' })] }
		const hasher = createEntityHasher()
		const { collections } = diffCollections(runListDefinitions, buildCollections(runListDefinitions, hasher, before), buildCollections(runListDefinitions, hasher, after))
		const delta: Delta<RunListCollections> = { kind: 'delta', base: 'e:1', next: 'e:2', collections }
		const result = applyRunListEnvelope(before, 'e:1', delta, hasher)
		expect(result.outcome).toBe('applied')
		expect(result.version).toBe('e:2')
		expect(result.summaries?.map((entry) => entry.runId)).toEqual(['run-2', 'run-1'])
		expect(result.summaries?.[1]?.status).toBe('error')
	})

	test('accepts a content-verified snapshot and reconstructs its summaries', () => {
		const target: RunListReplicaState = { runs: [summary('run-2'), summary('run-1')] }
		const collections = buildCollections(runListDefinitions, createEntityHasher(), target)
		const snapshot: Snapshot<RunListCollections> = { kind: 'snapshot', version: 'e:9', contentHash: contentVersion(runListDefinitions, collections), collections: target }
		const result = applyRunListEnvelope(emptyRunListReplicaState(), null, snapshot, createEntityHasher())
		expect(result.outcome).toBe('snapshot')
		expect(result.version).toBe('e:9')
		expect(result.summaries?.map((entry) => entry.runId)).toEqual(['run-2', 'run-1'])
	})

	test('rejects a snapshot whose content hash does not match its contents', () => {
		const state: RunListReplicaState = { runs: [summary('run-1')] }
		const target: RunListReplicaState = { runs: [summary('run-2')] }
		const snapshot: Snapshot<RunListCollections> = { kind: 'snapshot', version: 'e:9', contentHash: 'not-the-real-hash', collections: target }
		const result = applyRunListEnvelope(state, 'e:1', snapshot, createEntityHasher())
		expect(result.outcome).toBe('invalid')
		expect(result.state).toBe(state)
		expect(result.version).toBe('e:1')
		expect(result.summaries).toBeNull()
	})

	test('reports needsSnapshot when a delta base does not match the held version', () => {
		const state: RunListReplicaState = { runs: [summary('run-1')] }
		const delta: Delta<RunListCollections> = { kind: 'delta', base: 'e:1', next: 'e:2', collections: {} }
		const result = applyRunListEnvelope(state, 'e:9', delta, createEntityHasher())
		expect(result.outcome).toBe('needsSnapshot')
		expect(result.state).toBe(state)
		expect(result.summaries).toBeNull()
	})

	test('reports invalid for a response that fails the protocol guard', () => {
		const state: RunListReplicaState = { runs: [summary('run-1')] }
		const result = applyRunListEnvelope(state, 'e:1', { kind: 'nonsense' }, createEntityHasher())
		expect(result.outcome).toBe('invalid')
		expect(result.state).toBe(state)
		expect(result.summaries).toBeNull()
	})
})
