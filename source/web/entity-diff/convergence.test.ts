import { describe, test } from 'bun:test'
import { createClientReplica, createServerReplica, isServerResponse } from '../static/ts/entity-diff/index.js'
import type { ClientReplica, ClientState, ServerReplica, ServerResponse, Snapshot, SyncRequest } from '../static/ts/entity-diff/index.js'
import { createRandom, definitions, makeState, stateVersion } from './test-schema.js'
import type { AppSchema, Task, User } from './test-schema.js'

interface Adversary {
	fetchResponse: (request: SyncRequest) => Promise<unknown>
	stop: () => void
}

// Every corruption below must fail the protocol guard, otherwise a tampered-but-guard-passing delta would be accepted in verifyDeltas:false mode and the client would hold a wrong state. The one exception is forgeDelta, which is deliberately self-consistent and only enabled for the verifyDeltas client, where the O(total) recomputation catches it.
function corrupt(base: ServerResponse<AppSchema>, random: () => number): unknown {
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
	if (isServerResponse(definitions, candidate)) throw new Error('adversary produced a corruption the protocol guard accepts')
	return candidate
}

// A delta whose shape is valid and whose next is the real target version, but whose entity content is tampered. Only verifyDeltas can reject it.
function forgeDelta(base: ServerResponse<AppSchema>): unknown | null {
	if (base.kind !== 'delta') return null
	const users = base.collections.users
	const entity = users?.changed[0]
	if (entity === undefined) return null
	return { ...base, collections: { ...base.collections, users: { added: users?.added ?? [], changed: [{ ...entity, name: 'forged' }], removed: users?.removed ?? [] } } }
}

function createAdversary(random: () => number, server: ServerReplica<AppSchema>, snapshots: Snapshot<AppSchema>[], allowForgery: boolean): Adversary {
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
				// A stale response from an earlier version: still a valid snapshot, so the client may legitimately land behind and catch up later.
				const index = snapshots.length === 1 ? 0 : Math.floor(random() * (snapshots.length - 1))
				response = snapshots[index] ?? base
			} else if (roll < 0.7) {
				response = previous ?? base
			} else if (roll < 0.85) {
				response = corrupt(base, random)
			} else if (allowForgery) {
				response = forgeDelta(base) ?? corrupt(base, random)
			} else {
				response = corrupt(base, random)
			}
			previous = response
			return response
		},
		stop() {
			adversarial = false
		},
	}
}

function assertConsistent(seed: number, step: number, label: string, client: ClientReplica<AppSchema>, result: ClientState<AppSchema>, knownVersions: Set<string>): void {
	if (result.version === null) return
	if (!knownVersions.has(result.version)) throw new Error(`convergence failed at seed ${seed} step ${step} (${label}): client reports unknown version ${result.version}`)
	if (stateVersion(result.state) !== result.version) throw new Error(`convergence failed at seed ${seed} step ${step} (${label}): returned state does not hash to its reported version`)
	const held = client.state()
	if (stateVersion(held) !== result.version) throw new Error(`convergence failed at seed ${seed} step ${step} (${label}): client holds a state that does not hash to its reported version`)
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

async function runConvergence(verifyDeltas: boolean): Promise<void> {
	const label = verifyDeltas ? 'verifyDeltas:true' : 'verifyDeltas:false'
	for (let seed = 1; seed <= 20; seed++) {
		const random = createRandom(seed)
		const server = createServerReplica(definitions, { historyLimit: 1 + Math.floor(random() * 3) })
		const knownVersions = new Set<string>([server.version()])
		const snapshots: Snapshot<AppSchema>[] = [server.snapshot()]
		const adversary = createAdversary(random, server, snapshots, verifyDeltas)
		const client = createClientReplica(definitions, { fetchResponse: adversary.fetchResponse }, { verifyDeltas })
		let users: User[] = []
		let tasks: Task[] = []
		let nextId = 0
		for (let step = 0; step < 60; step++) {
			const evolved = nextState(random, users, tasks, nextId)
			users = evolved.users
			tasks = evolved.tasks
			nextId = evolved.nextId
			server.update(makeState(users, tasks))
			knownVersions.add(server.version())
			snapshots.push(server.snapshot())
			if (random() < 0.25) continue
			const result = await client.sync()
			assertConsistent(seed, step, label, client, result, knownVersions)
		}
		adversary.stop()
		let result = await client.sync()
		for (let attempt = 0; attempt < 5 && result.version !== server.version(); attempt++) result = await client.sync()
		if (result.version !== server.version()) throw new Error(`convergence failed at seed ${seed} (${label}): client never reached the server version after the adversary stopped`)
		if (stateVersion(client.state()) !== server.version()) throw new Error(`convergence failed at seed ${seed} (${label}): converged state does not match the server`)
	}
}

describe('convergence under an adversarial transport', () => {
	test('converges with verifyDeltas false', async () => {
		await runConvergence(false)
	})

	test('converges with verifyDeltas true', async () => {
		await runConvergence(true)
	})
})
