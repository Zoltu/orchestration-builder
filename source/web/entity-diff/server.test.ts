import { describe, expect, test } from 'bun:test'
import { applyDelta, createEntityHasher, createServerReplica } from '../static/ts/entity-diff/index.js'
import type { ReplicaState } from '../static/ts/entity-diff/index.js'
import { definitions, makeState, stateVersion } from './test-schema.js'
import type { AppSchema, Task, User } from './test-schema.js'

function user(id: string, name: string): User {
	return { id, name, team: 'team-a' }
}

function task(id: string, title: string): Task {
	return { id, title, done: false }
}

describe('createServerReplica', () => {
	test('reports a stable version when an update does not change content', () => {
		const server = createServerReplica(definitions, { historyLimit: 4 })
		const first = server.update(makeState([user('u1', 'Ann')], []))
		const second = server.update(makeState([user('u1', 'Ann')], []))
		expect(second).toBe(first)
		expect(server.version()).toBe(first)
		expect(server.respond(first).kind).toBe('unchanged')
	})

	test('returns a delta for a retained base and a snapshot once the base is evicted', () => {
		const server = createServerReplica(definitions, { historyLimit: 1 })
		const empty = server.version()
		const versionA = server.update(makeState([user('u1', 'Ann')], []))
		const versionB = server.update(makeState([user('u1', 'Anne')], []))
		const versionC = server.update(makeState([user('u1', 'Anne')], [task('t1', 'one')]))
		expect(server.respond(versionC).kind).toBe('unchanged')
		expect(server.respond(versionB).kind).toBe('delta')
		// Only the most recent transition survives with historyLimit 1, so the older bases fall back to a snapshot.
		expect(server.respond(versionA).kind).toBe('snapshot')
		expect(server.respond(empty).kind).toBe('snapshot')
	})

	test('every retained base yields a delta that converges to the current version', () => {
		const server = createServerReplica(definitions, { historyLimit: 8 })
		const states: ReplicaState<AppSchema>[] = [makeState([], [])]
		const versions: string[] = [server.version()]
		const steps: ReplicaState<AppSchema>[] = [
			makeState([user('u1', 'Ann')], []),
			makeState([user('u1', 'Ann'), user('u2', 'Bob')], []),
			makeState([user('u2', 'Bob')], [task('t1', 'one')]),
			makeState([user('u2', 'Bobby')], [task('t1', 'one'), task('t2', 'two')]),
		]
		for (const step of steps) {
			versions.push(server.update(step))
			states.push(step)
		}
		for (let index = 0; index < versions.length - 1; index++) {
			const base = versions[index]
			const baseState = states[index]
			if (base === undefined || baseState === undefined) continue
			const response = server.respond(base)
			if (response.kind !== 'delta') throw new Error(`expected a delta for retained base ${base}`)
			const reaction = applyDelta(definitions, createEntityHasher(), baseState, base, response, true)
			expect(reaction.kind).toBe('applied')
			expect(stateVersion(reaction.state)).toBe(server.version())
		}
	})

	test('snapshot() returns the current version and full collections', () => {
		const server = createServerReplica(definitions, { historyLimit: 4 })
		const version = server.update(makeState([user('u1', 'Ann')], [task('t1', 'one')]))
		const snapshot = server.snapshot()
		expect(snapshot.kind).toBe('snapshot')
		expect(snapshot.version).toBe(version)
		expect(snapshot.collections.users.map((entity) => entity.id)).toEqual(['u1'])
		expect(snapshot.collections.tasks.map((entity) => entity.id)).toEqual(['t1'])
	})

	test('starts from an empty state that is valid for every client version', () => {
		const server = createServerReplica(definitions, { historyLimit: 4 })
		const empty = server.snapshot()
		expect(empty.collections.users).toEqual([])
		expect(empty.collections.tasks).toEqual([])
		expect(server.respond(null).kind).toBe('snapshot')
		expect(server.respond(server.version()).kind).toBe('unchanged')
	})

	test('throws when historyLimit is not a non-negative integer', () => {
		expect(() => createServerReplica(definitions, { historyLimit: Number.NaN })).toThrow()
		expect(() => createServerReplica(definitions, { historyLimit: -1 })).toThrow()
		expect(() => createServerReplica(definitions, { historyLimit: 1.5 })).toThrow()
		expect(() => createServerReplica(definitions, { historyLimit: Number.POSITIVE_INFINITY })).toThrow()
	})

	test('historyLimit 0 answers every non-unchanged request with a snapshot', () => {
		const server = createServerReplica(definitions, { historyLimit: 0 })
		const empty = server.version()
		const versionA = server.update(makeState([user('u1', 'Ann')], []))
		expect(server.respond(versionA).kind).toBe('unchanged')
		expect(server.respond(empty).kind).toBe('snapshot')
		expect(server.respond(null).kind).toBe('snapshot')
	})

	test('a repeated no-op update does not churn history', () => {
		const server = createServerReplica(definitions, { historyLimit: 1 })
		const versionA = server.update(makeState([user('u1', 'Ann')], []))
		const stateB = makeState([user('u1', 'Anne')], [])
		const versionB = server.update(stateB)
		for (let index = 0; index < 10; index++) server.update(stateB)
		expect(server.version()).toBe(versionB)
		// The A->B transition is still the sole history entry, so a client at A gets a delta; a no-op update that pushed history would have evicted it and forced a snapshot.
		expect(server.respond(versionA).kind).toBe('delta')
	})
})
