import { describe, expect, test } from 'bun:test'
import { applyDelta, createClientReplica, createServerReplica, defineCollection } from '../static/ts/entity-diff/index.js'
import type { CollectionDefinitions, ReplicaState } from '../static/ts/entity-diff/index.js'
import { definitions, makeState, stateContentHash, taskCollection, userCollection } from './test-schema.js'
import type { AppSchema, Task, User } from './test-schema.js'

function user(id: string, name: string): User {
	return { id, name, team: 'team-a' }
}

function task(id: string, title: string): Task {
	return { id, title, done: false }
}

describe('createServerReplica', () => {
	test('reports a stable revision when an update does not change content', () => {
		const server = createServerReplica(definitions, { historyLimit: 4, epoch: 'e' })
		const first = server.update(makeState([user('u1', 'Ann')], []))
		const second = server.update(makeState([user('u1', 'Ann')], []))
		expect(second).toBe(first)
		expect(server.version()).toBe(first)
		expect(server.respond(first).kind).toBe('unchanged')
	})

	test('bumps the revision whenever content changes', () => {
		const server = createServerReplica(definitions, { historyLimit: 4, epoch: 'e' })
		const empty = server.version()
		const first = server.update(makeState([user('u1', 'Ann')], []))
		const second = server.update(makeState([user('u1', 'Anne')], []))
		expect(first).not.toBe(empty)
		expect(second).not.toBe(first)
	})

	test('returns a delta for a retained base and a snapshot once the base is evicted', () => {
		const server = createServerReplica(definitions, { historyLimit: 1, epoch: 'e' })
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

	test('every retained base yields a delta that converges to the current content', () => {
		const server = createServerReplica(definitions, { historyLimit: 8, epoch: 'e' })
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
			const reaction = applyDelta(definitions, baseState, base, response)
			expect(reaction.kind).toBe('applied')
			expect(stateContentHash(definitions, reaction.state)).toBe(server.snapshot().contentHash)
		}
	})

	test('snapshot() returns the current revision, its content hash, and full collections', () => {
		const server = createServerReplica(definitions, { historyLimit: 4, epoch: 'e' })
		const version = server.update(makeState([user('u1', 'Ann')], [task('t1', 'one')]))
		const snapshot = server.snapshot()
		expect(snapshot.kind).toBe('snapshot')
		expect(snapshot.version).toBe(version)
		expect(snapshot.contentHash).toBe(stateContentHash(definitions, makeState([user('u1', 'Ann')], [task('t1', 'one')])))
		expect(snapshot.collections.users.map((entity) => entity.id)).toEqual(['u1'])
		expect(snapshot.collections.tasks.map((entity) => entity.id)).toEqual(['t1'])
	})

	test('starts from an empty state that is valid for every client revision', () => {
		const server = createServerReplica(definitions, { historyLimit: 4, epoch: 'e' })
		const empty = server.snapshot()
		expect(empty.collections.users).toEqual([])
		expect(empty.collections.tasks).toEqual([])
		expect(server.respond(null).kind).toBe('snapshot')
		expect(server.respond(server.version()).kind).toBe('unchanged')
	})

	test('throws when historyLimit is not a non-negative integer', () => {
		expect(() => createServerReplica(definitions, { historyLimit: Number.NaN, epoch: 'e' })).toThrow()
		expect(() => createServerReplica(definitions, { historyLimit: -1, epoch: 'e' })).toThrow()
		expect(() => createServerReplica(definitions, { historyLimit: 1.5, epoch: 'e' })).toThrow()
		expect(() => createServerReplica(definitions, { historyLimit: Number.POSITIVE_INFINITY, epoch: 'e' })).toThrow()
	})

	test('throws when the epoch is empty', () => {
		expect(() => createServerReplica(definitions, { historyLimit: 4, epoch: '' })).toThrow()
	})

	test('historyLimit 0 answers every non-unchanged request with a snapshot', () => {
		const server = createServerReplica(definitions, { historyLimit: 0, epoch: 'e' })
		const empty = server.version()
		const versionA = server.update(makeState([user('u1', 'Ann')], []))
		expect(server.respond(versionA).kind).toBe('unchanged')
		expect(server.respond(empty).kind).toBe('snapshot')
		expect(server.respond(null).kind).toBe('snapshot')
	})

	test('a repeated no-op update does not churn history', () => {
		const server = createServerReplica(definitions, { historyLimit: 1, epoch: 'e' })
		const versionA = server.update(makeState([user('u1', 'Ann')], []))
		const stateB = makeState([user('u1', 'Anne')], [])
		const versionB = server.update(stateB)
		for (let index = 0; index < 10; index++) server.update(stateB)
		expect(server.version()).toBe(versionB)
		// The A->B transition is still the sole history entry, so a client at A gets a delta; a no-op update that pushed history would have evicted it and forced a snapshot.
		expect(server.respond(versionA).kind).toBe('delta')
	})

	test('two replicas with different epochs never share a revision, so each answers the other with a snapshot', () => {
		const serverA = createServerReplica(definitions, { historyLimit: 4, epoch: 'epoch-a' })
		const serverB = createServerReplica(definitions, { historyLimit: 4, epoch: 'epoch-b' })
		const state = makeState([user('u1', 'Ann')], [])
		const versionA = serverA.update(state)
		const versionB = serverB.update(state)
		expect(versionA).not.toBe(versionB)
		expect(serverA.respond(versionB).kind).toBe('snapshot')
		expect(serverB.respond(versionA).kind).toBe('snapshot')
	})

	test('a client synced to one epoch resyncs by snapshot when it moves to another', async () => {
		const serverA = createServerReplica(definitions, { historyLimit: 4, epoch: 'epoch-a' })
		const serverB = createServerReplica(definitions, { historyLimit: 4, epoch: 'epoch-b' })
		const state = makeState([user('u1', 'Ann')], [])
		let server = serverA
		const client = createClientReplica(definitions, { fetchResponse: async (request) => server.respond(request.have) })
		serverA.update(state)
		const first = await client.sync()
		expect(first.outcome).toBe('snapshot')
		expect(first.version).toBe(serverA.version())
		server = serverB
		serverB.update(state)
		const second = await client.sync()
		expect(second.outcome).toBe('snapshot')
		expect(second.version).toBe(serverB.version())
		expect(stateContentHash(definitions, second.state)).toBe(serverB.snapshot().contentHash)
	})

	test('update never serializes entity bodies when versionOf is provided', () => {
		let nameReads = 0
		const tracked: User = {
			id: 'u1',
			get name() {
				nameReads += 1
				return 'Ann'
			},
			team: 'team-a',
		}
		const definitionsWithVersionOf: CollectionDefinitions<AppSchema> = {
			users: defineCollection<User>(userCollection.isEntity, (entity) => entity.team),
			tasks: taskCollection,
		}
		const server = createServerReplica(definitionsWithVersionOf, { historyLimit: 4, epoch: 'e' })
		server.update(makeState([tracked], []))
		expect(nameReads).toBe(0)
	})

	test('snapshot does not rebuild entity versions and reuses the cached content hash', () => {
		let versionOfCalls = 0
		const definitionsWithCountingVersionOf: CollectionDefinitions<AppSchema> = {
			users: defineCollection<User>(userCollection.isEntity, (entity) => {
				versionOfCalls += 1
				return entity.name
			}),
			tasks: defineCollection<Task>(taskCollection.isEntity, (entity) => {
				versionOfCalls += 1
				return entity.title
			}),
		}
		const server = createServerReplica(definitionsWithCountingVersionOf, { historyLimit: 4, epoch: 'e' })
		server.update(makeState([user('u1', 'Ann')], [task('t1', 'one')]))
		const afterUpdate = versionOfCalls
		expect(afterUpdate).toBe(2)
		const first = server.snapshot()
		const second = server.snapshot()
		expect(versionOfCalls).toBe(afterUpdate)
		expect(second.contentHash).toBe(first.contentHash)
	})
})
