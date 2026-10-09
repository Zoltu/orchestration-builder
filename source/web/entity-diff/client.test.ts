import { describe, expect, test } from 'bun:test'
import { createClientReplica, createServerReplica } from '../static/ts/entity-diff/index.js'
import type { ClientReplica, ServerReplica, SyncRequest } from '../static/ts/entity-diff/index.js'
import { definitions, makeState, stateContentHash } from './test-schema.js'
import type { AppSchema, Task, User } from './test-schema.js'

function user(id: string, name: string): User {
	return { id, name, team: 'team-a' }
}

function task(id: string, title: string): Task {
	return { id, title, done: false }
}

interface Harness {
	server: ServerReplica<AppSchema>
	client: ClientReplica<AppSchema>
	calls: SyncRequest[]
	setResponder: (next: (request: SyncRequest) => unknown) => void
}

function createHarness(): Harness {
	const server = createServerReplica(definitions, { historyLimit: 16, epoch: 'e' })
	const calls: SyncRequest[] = []
	let responder: (request: SyncRequest) => unknown = (request) => server.respond(request.have)
	const client = createClientReplica(definitions, {
		fetchResponse: async (request) => {
			calls.push(request)
			return responder(request)
		},
	})
	return {
		server,
		client,
		calls,
		setResponder(next) {
			responder = next
		},
	}
}

describe('createClientReplica', () => {
	test('takes a snapshot on the first sync, then applies deltas', async () => {
		const { server, client } = createHarness()
		server.update(makeState([user('u1', 'Ann')], []))
		const first = await client.sync()
		expect(first.outcome).toBe('snapshot')
		expect(first.version).toBe(server.version())
		server.update(makeState([user('u1', 'Anne')], [task('t1', 'one')]))
		const second = await client.sync()
		expect(second.outcome).toBe('delta')
		expect(second.version).toBe(server.version())
		expect(second.state.users.map((entity) => entity.name)).toEqual(['Anne'])
		expect(second.state.tasks.map((entity) => entity.id)).toEqual(['t1'])
	})

	test('reports unchanged when the server has not moved', async () => {
		const { server, client } = createHarness()
		server.update(makeState([user('u1', 'Ann')], []))
		await client.sync()
		const again = await client.sync()
		expect(again.outcome).toBe('unchanged')
		expect(again.version).toBe(server.version())
	})

	test('resyncs with a snapshot when handed a stale delta', async () => {
		const { server, client, setResponder } = createHarness()
		const versionA = server.update(makeState([user('u1', 'Ann')], []))
		await client.sync()
		const versionB = server.update(makeState([user('u1', 'Anne')], []))
		server.update(makeState([user('u1', 'Anne')], [task('t1', 'one')]))
		expect(versionA).not.toBe(versionB)
		setResponder((request) => (request.have === null ? server.respond(null) : server.respond(versionB)))
		const result = await client.sync()
		expect(result.outcome).toBe('snapshot')
		expect(result.version).toBe(server.version())
	})

	test('resyncs when handed a duplicate of an already-applied delta', async () => {
		const { server, client, setResponder } = createHarness()
		const versionA = server.update(makeState([user('u1', 'Ann')], []))
		await client.sync()
		const versionB = server.update(makeState([user('u1', 'Anne')], []))
		await client.sync()
		// The client is now at versionB; replaying the delta that took it from versionA to versionB is stale, because its base no longer matches the client version.
		setResponder((request) => (request.have === null ? server.respond(null) : server.respond(versionA)))
		const result = await client.sync()
		expect(result.outcome).toBe('snapshot')
		expect(result.version).toBe(server.version())
		expect(versionB).not.toBe(versionA)
	})

	test('catches up after an out-of-order older snapshot, then a delta', async () => {
		const { server, client, setResponder } = createHarness()
		server.update(makeState([user('u1', 'Ann')], []))
		await client.sync()
		const versionB = server.update(makeState([user('u1', 'Anne')], []))
		const snapshotAtB = server.snapshot()
		server.update(makeState([user('u1', 'Anne')], [task('t1', 'one')]))
		// The transport delivers a still-valid snapshot from an older server revision; the client accepts it and lands behind, then a later delta carries it to the tip.
		setResponder(() => snapshotAtB)
		const behind = await client.sync()
		expect(behind.outcome).toBe('snapshot')
		expect(behind.version).toBe(versionB)
		setResponder((request) => server.respond(request.have))
		const caughtUp = await client.sync()
		expect(caughtUp.outcome).toBe('delta')
		expect(caughtUp.version).toBe(server.version())
	})

	test('recovers from a corrupt response via one snapshot retry', async () => {
		const { server, client, setResponder } = createHarness()
		server.update(makeState([user('u1', 'Ann')], []))
		setResponder((request) => (request.have === null ? server.respond(null) : { kind: 'delta' }))
		const result = await client.sync()
		expect(result.outcome).toBe('snapshot')
		expect(result.version).toBe(server.version())
	})

	test('accepts a forged delta whose base matches, because the base precondition is the only check', async () => {
		const { server, client, setResponder } = createHarness()
		const versionA = server.update(makeState([user('u1', 'Ann')], []))
		await client.sync()
		const versionB = server.update(makeState([user('u1', 'Anne')], []))
		// The delta's shape and base are valid, so the client trusts it and reports its next revision with the tampered content.
		setResponder((request) => {
			if (request.have === null) return server.respond(null)
			return {
				kind: 'delta',
				base: versionA,
				next: versionB,
				collections: { users: { added: [], changed: [user('u1', 'Forged')], removed: [] } },
			}
		})
		const result = await client.sync()
		expect(result.outcome).toBe('delta')
		expect(result.version).toBe(versionB)
		expect(result.state.users.map((entity) => entity.name)).toEqual(['Forged'])
	})

	test('resyncs via a snapshot when a forged delta base does not match', async () => {
		const { server, client, setResponder } = createHarness()
		server.update(makeState([user('u1', 'Ann')], []))
		await client.sync()
		server.update(makeState([user('u1', 'Anne')], []))
		setResponder((request) => {
			if (request.have === null) return server.respond(null)
			return { kind: 'delta', base: 'forged-base', next: server.version(), collections: {} }
		})
		const result = await client.sync()
		expect(result.outcome).toBe('snapshot')
		expect(result.version).toBe(server.version())
		expect(stateContentHash(definitions, result.state)).toBe(server.snapshot().contentHash)
	})

	test('surfaces invalid when both the response and the snapshot retry are unusable', async () => {
		const { client, setResponder } = createHarness()
		setResponder(() => ({}))
		const result = await client.sync()
		expect(result.outcome).toBe('invalid')
		expect(result.version).toBeNull()
	})

	test('recovers from a snapshot whose content hash does not match its contents', async () => {
		const { server, client, setResponder } = createHarness()
		server.update(makeState([user('u1', 'Ann')], []))
		await client.sync()
		setResponder((request) => {
			if (request.have === null) return server.respond(null)
			const snapshot = server.snapshot()
			return { kind: 'snapshot', version: snapshot.version, contentHash: 'tampered', collections: snapshot.collections }
		})
		const result = await client.sync()
		expect(result.outcome).toBe('snapshot')
		expect(result.version).toBe(server.version())
	})

	test('recovers from a response naming an unknown collection', async () => {
		const { server, client, setResponder } = createHarness()
		server.update(makeState([user('u1', 'Ann')], []))
		setResponder((request) => {
			if (request.have === null) return server.respond(null)
			const snapshot = server.snapshot()
			return { kind: 'snapshot', version: snapshot.version, contentHash: snapshot.contentHash, collections: { ...snapshot.collections, ghosts: [] } }
		})
		const result = await client.sync()
		expect(result.outcome).toBe('snapshot')
		expect(result.version).toBe(server.version())
	})

	test('single-flight collapses concurrent syncs into one request', async () => {
		const { server, client, calls } = createHarness()
		server.update(makeState([user('u1', 'Ann')], []))
		const first = client.sync()
		const second = client.sync()
		const [firstResult, secondResult] = await Promise.all([first, second])
		expect(calls).toHaveLength(1)
		expect(firstResult).toBe(secondResult)
		expect(firstResult.version).toBe(server.version())
	})
})
