import { describe, expect, test } from 'bun:test'
import { buildCollections, createClientReplica, createEntityHasher, createServerReplica, defineCollection, isServerResponse } from '../static/ts/entity-diff/index.js'
import type { ClientReplica, ClientState, CollectionDefinitions, ReplicaState, ServerReplica, ServerResponse, Snapshot, SyncRequest } from '../static/ts/entity-diff/index.js'
import { createRandom, definitions, makeState, stateContentHash, taskCollection, userCollection } from './test-schema.js'
import type { AppSchema, Task, User } from './test-schema.js'

// The default collections hash full content, so a version token is content-addressed and unique per body. These draw each entity's version from a tiny set, so a version can repeatedly return to a value it held earlier — the composition case the content-hash fallback cannot produce.
const cyclingDefinitions: CollectionDefinitions<AppSchema> = {
	users: defineCollection<User>(userCollection.isEntity, (entity) => entity.name),
	tasks: defineCollection<Task>(taskCollection.isEntity, (entity) => entity.title),
}

interface Adversary {
	fetchResponse: (request: SyncRequest) => Promise<unknown>
	stop: () => void
}

// Every corruption below must fail the protocol guard, so a tampered payload is rejected at ingress and the client resyncs rather than holding it.
function corrupt(definitionsToUse: CollectionDefinitions<AppSchema>, base: ServerResponse<AppSchema>, random: () => number): unknown {
	let candidate: unknown
	if (base.kind === 'unchanged') {
		candidate = { kind: 'unchanged' }
	} else if (base.kind === 'delta') {
		const users = base.collections.users
		const entity = users?.changed[0] ?? users?.added[0]
		const choice = Math.floor(random() * 4)
		if (choice === 0) candidate = { ...base, next: 42 }
		else if (choice === 1 && entity !== undefined) candidate = { ...base, collections: { ...base.collections, users: { added: [], changed: [{ ...entity, name: 42 }], removed: [] } } }
		else if (choice === 2) candidate = { ...base, collections: { ...base.collections, ghosts: { added: [], changed: [], removed: [] } } }
		else candidate = { ...base, kind: 'not-a-kind' }
	} else {
		const users = base.collections.users
		const first = users[0]
		const choice = Math.floor(random() * 4)
		if (choice === 0) candidate = { kind: 'snapshot', version: base.version }
		else if (choice === 1) candidate = { ...base, version: 42 }
		else if (choice === 2) candidate = { ...base, collections: { ...base.collections, ghosts: [] } }
		else if (first !== undefined) candidate = { ...base, collections: { ...base.collections, users: [...users, first] } }
		else candidate = { ...base, collections: { ...base.collections, tasks: 'not-an-array' } }
	}
	if (isServerResponse(definitionsToUse, candidate)) throw new Error('adversary produced a corruption the protocol guard accepts')
	return candidate
}

// A delta with valid shape but tampered content and a base the client cannot hold: the base precondition is the only remaining integrity check, so it must force a resync rather than be applied.
function forgeDelta(base: ServerResponse<AppSchema>): unknown | null {
	if (base.kind !== 'delta') return null
	const users = base.collections.users
	const entity = users?.changed[0] ?? users?.added[0]
	if (entity === undefined) return { ...base, base: 'forged:0' }
	return { ...base, base: 'forged:0', collections: { ...base.collections, users: { added: [], changed: [{ ...entity, name: 'forged' }], removed: [] } } }
}

function createAdversary(random: () => number, server: ServerReplica<AppSchema>, snapshots: Snapshot<AppSchema>[], definitionsToUse: CollectionDefinitions<AppSchema>): Adversary {
	let adversarial = true
	let previous: unknown = null
	return {
		async fetchResponse(request) {
			if (!adversarial) return server.respond(request.have)
			const base = server.respond(request.have)
			const roll = random()
			let response: unknown
			if (roll < 0.35) {
				response = base
			} else if (roll < 0.55) {
				// A stale response from an earlier revision: still a valid snapshot, so the client may legitimately land behind and catch up later.
				const index = snapshots.length === 1 ? 0 : Math.floor(random() * (snapshots.length - 1))
				response = snapshots[index] ?? base
			} else if (roll < 0.7) {
				response = previous ?? base
			} else if (roll < 0.85) {
				response = corrupt(definitionsToUse, base, random)
			} else {
				response = forgeDelta(base) ?? corrupt(definitionsToUse, base, random)
			}
			previous = response
			return response
		},
		stop() {
			adversarial = false
		},
	}
}

function assertConsistent(seed: number, step: number, client: ClientReplica<AppSchema>, result: ClientState<AppSchema>, contentByRevision: Map<string, string>, definitionsToUse: CollectionDefinitions<AppSchema>): void {
	if (result.version === null) return
	const expected = contentByRevision.get(result.version)
	if (expected === undefined) throw new Error(`convergence failed at seed ${seed} step ${step}: client reports unknown revision ${result.version}`)
	if (stateContentHash(definitionsToUse, result.state) !== expected) throw new Error(`convergence failed at seed ${seed} step ${step}: returned state does not match its reported revision`)
	const held = client.state()
	if (stateContentHash(definitionsToUse, held) !== expected) throw new Error(`convergence failed at seed ${seed} step ${step}: client holds a state that does not match its reported revision`)
}

function nextState(random: () => number, users: User[], tasks: Task[], nextId: number): { users: User[]; tasks: Task[]; nextId: number } {
	const roll = random()
	let nextUsers = users
	let nextTasks = tasks
	if (roll < 0.3 && users.length < 8) {
		nextUsers = [...users, { id: `u${nextId}`, name: `name-${Math.floor(random() * 5)}`, team: `team-${Math.floor(random() * 3)}` }]
		nextId += 1
	} else if (roll < 0.5 && users.length > 0) {
		const index = Math.floor(random() * users.length)
		nextUsers = users.filter((_, position) => position !== index)
	} else if (roll < 0.7 && users.length > 0) {
		const index = Math.floor(random() * users.length)
		const existing = users[index]
		if (existing !== undefined) nextUsers = users.map((entity, position) => (position === index ? { ...entity, name: `name-${Math.floor(random() * 5)}` } : entity))
	} else if (roll < 0.85 && tasks.length < 8) {
		nextTasks = [...tasks, { id: `t${nextId}`, title: `title-${Math.floor(random() * 5)}`, done: random() < 0.5 }]
		nextId += 1
	} else if (tasks.length > 0) {
		const index = Math.floor(random() * tasks.length)
		nextTasks = tasks.filter((_, position) => position !== index)
	}
	return { users: nextUsers, tasks: nextTasks, nextId }
}

interface EntityVersionHistory {
	lastVersion: string
	seenVersions: Set<string>
}

// Reports whether any entity's version changed and then returned to a value it held earlier. An unchanged version between steps is not a return, so the history only records a recurrence when a version actually moves back.
function observeVersionRecurrence(definitionsToUse: CollectionDefinitions<AppSchema>, state: ReplicaState<AppSchema>, history: Map<string, EntityVersionHistory>): boolean {
	const collections = buildCollections(definitionsToUse, createEntityHasher(), state)
	let recurred = false
	for (const name of ['users', 'tasks'] as const) {
		for (const [id, record] of collections[name]) {
			const previous = history.get(id)
			if (previous === undefined) {
				history.set(id, { lastVersion: record.version, seenVersions: new Set([record.version]) })
				continue
			}
			if (record.version === previous.lastVersion) continue
			if (previous.seenVersions.has(record.version)) recurred = true
			previous.seenVersions.add(record.version)
			previous.lastVersion = record.version
		}
	}
	return recurred
}

async function runConvergence(definitionsToUse: CollectionDefinitions<AppSchema>): Promise<boolean> {
	let sawRecurrence = false
	for (let seed = 1; seed <= 20; seed++) {
		const random = createRandom(seed)
		const server = createServerReplica(definitionsToUse, { historyLimit: 1 + Math.floor(random() * 3), epoch: 'e' })
		const contentByRevision = new Map<string, string>()
		const initial = server.snapshot()
		contentByRevision.set(initial.version, initial.contentHash)
		const snapshots: Snapshot<AppSchema>[] = [initial]
		const adversary = createAdversary(random, server, snapshots, definitionsToUse)
		const client = createClientReplica(definitionsToUse, { fetchResponse: adversary.fetchResponse })
		const versionHistory = new Map<string, EntityVersionHistory>()
		let users: User[] = []
		let tasks: Task[] = []
		let nextId = 0
		for (let step = 0; step < 60; step++) {
			const evolved = nextState(random, users, tasks, nextId)
			users = evolved.users
			tasks = evolved.tasks
			nextId = evolved.nextId
			if (observeVersionRecurrence(definitionsToUse, makeState(users, tasks), versionHistory)) sawRecurrence = true
			server.update(makeState(users, tasks))
			const snapshot = server.snapshot()
			contentByRevision.set(snapshot.version, snapshot.contentHash)
			snapshots.push(snapshot)
			if (random() < 0.25) continue
			const result = await client.sync()
			assertConsistent(seed, step, client, result, contentByRevision, definitionsToUse)
		}
		adversary.stop()
		let result = await client.sync()
		for (let attempt = 0; attempt < 5 && result.version !== server.version(); attempt++) result = await client.sync()
		if (result.version !== server.version()) throw new Error(`convergence failed at seed ${seed}: client never reached the server revision after the adversary stopped`)
		if (stateContentHash(definitionsToUse, client.state()) !== server.snapshot().contentHash) throw new Error(`convergence failed at seed ${seed}: converged state does not match the server`)
	}
	return sawRecurrence
}

describe('convergence under an adversarial transport', () => {
	test('converges with stale, duplicate, corrupt, and forged responses', async () => {
		await runConvergence(definitions)
	})

	test('converges when versionOf values cycle back to a prior value', async () => {
		const sawRecurrence = await runConvergence(cyclingDefinitions)
		expect(sawRecurrence).toBe(true)
	})
})
