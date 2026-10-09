import { describe, expect, test } from 'bun:test'
import {
	applyDelta,
	applySnapshot,
	createEntityHasher,
	diffSnapshots,
	hashEntity,
	reduceServerResponse,
	respond,
	snapshotState,
} from '../static/ts/entity-diff/index.js'
import type { Delta, EntityBase, EntityHasher, HistoryEntry, ReplicaState, Snapshot, StateSnapshot, VersionToken } from '../static/ts/entity-diff/index.js'
import { createRandom, definitions, makeState, stateVersion } from './test-schema.js'
import type { AppSchema, Task, User } from './test-schema.js'

function snapshotOf(state: ReplicaState<AppSchema>): StateSnapshot<AppSchema> {
	return snapshotState(definitions, createEntityHasher(), state)
}

function historyStep(previous: StateSnapshot<AppSchema>, next: StateSnapshot<AppSchema>): HistoryEntry<AppSchema> {
	const { touched } = diffSnapshots(definitions, previous, next)
	return { base: previous.version, next: next.version, touched }
}

function user(id: string, name: string, team = 'team-a'): User {
	return { id, name, team }
}

function task(id: string, title: string, done = false): Task {
	return { id, title, done }
}

describe('snapshotState', () => {
	test('is independent of entity array order', () => {
		const first = snapshotOf(makeState([user('u1', 'Ann'), user('u2', 'Bob')], [task('t1', 'one')]))
		const second = snapshotOf(makeState([user('u2', 'Bob'), user('u1', 'Ann')], [task('t1', 'one')]))
		expect(first.version).toBe(second.version)
	})

	test('changes when an entity changes', () => {
		const before = snapshotOf(makeState([user('u1', 'Ann')], []))
		const after = snapshotOf(makeState([user('u1', 'Anne')], []))
		expect(after.version).not.toBe(before.version)
	})

	test('changes when a collection changes membership', () => {
		const before = snapshotOf(makeState([], []))
		const after = snapshotOf(makeState([], [task('t1', 'one')]))
		expect(after.version).not.toBe(before.version)
	})

	test('throws on a duplicate id', () => {
		const state = makeState([user('u1', 'Ann'), user('u1', 'Bob')], [])
		expect(() => snapshotState(definitions, createEntityHasher(), state)).toThrow()
	})

	test('throws when a declared collection is missing', () => {
		const broken: ReplicaState<AppSchema> = Object.create(null)
		broken.users = []
		expect(() => snapshotState(definitions, createEntityHasher(), broken)).toThrow()
	})
})

// A test double that counts real hash computations while caching by identity, so it can observe whether snapshotState preserves entity identity across calls.
function createCountingHasher(): { hasher: EntityHasher; computations: () => number } {
	const cache = new WeakMap<EntityBase, VersionToken>()
	let computations = 0
	return {
		hasher: {
			hash(entity) {
				const cached = cache.get(entity)
				if (cached !== undefined) return cached
				computations += 1
				const version = hashEntity(entity)
				cache.set(entity, version)
				return version
			},
		},
		computations: () => computations,
	}
}

describe('entity hashing and the immutability contract', () => {
	test('does not re-hash an entity whose identity is preserved across two snapshots', () => {
		const { hasher, computations } = createCountingHasher()
		const shared = user('u1', 'Ann')
		const first = snapshotState(definitions, hasher, makeState([shared], []))
		const second = snapshotState(definitions, hasher, makeState([shared], []))
		expect(computations()).toBe(1)
		expect(second.version).toBe(first.version)
	})

	test('the identity cache in createEntityHasher skips re-serializing a repeated entity', () => {
		const hasher = createEntityHasher()
		let nameReads = 0
		const tracked: User = {
			id: 'u1',
			get name() {
				nameReads += 1
				return 'Ann'
			},
			team: 'team-a',
		}
		snapshotState(definitions, hasher, makeState([tracked], []))
		const readsAfterFirst = nameReads
		expect(readsAfterFirst).toBeGreaterThan(0)
		snapshotState(definitions, hasher, makeState([tracked], []))
		expect(nameReads).toBe(readsAfterFirst)
	})

	test('a new object with identical content hashes to the same version', () => {
		const hasher = createEntityHasher()
		expect(hasher.hash(user('u1', 'Ann'))).toBe(hasher.hash(user('u1', 'Ann')))
	})
})

describe('diffSnapshots', () => {
	test('reports added, changed, removed, and the before-hash of each touched id', () => {
		const previous = snapshotOf(makeState([user('u1', 'Ann'), user('u2', 'Bob')], [task('t1', 'one')]))
		const next = snapshotOf(makeState([user('u1', 'Anne'), user('u3', 'Cara')], [task('t1', 'one')]))
		const { touched, delta } = diffSnapshots(definitions, previous, next)
		expect(delta.collections.users?.added.map((entity) => entity.id)).toEqual(['u3'])
		expect(delta.collections.users?.changed.map((entity) => entity.id)).toEqual(['u1'])
		expect(delta.collections.users?.removed).toEqual(['u2'])
		expect(delta.collections.tasks).toBeUndefined()
		const touchedUsers = touched.users
		expect(touchedUsers).toBeDefined()
		if (touchedUsers === undefined) throw new Error('expected touched users')
		expect(touchedUsers.get('u1')).toBe(hashEntity(user('u1', 'Ann')))
		expect(touchedUsers.get('u2')).toBe(hashEntity(user('u2', 'Bob')))
		expect(touchedUsers.get('u3')).toBeNull()
		expect(touched.tasks).toBeUndefined()
	})

	test('reports an empty touched map for an unchanged state', () => {
		const previous = snapshotOf(makeState([user('u1', 'Ann')], []))
		const next = snapshotOf(makeState([user('u1', 'Ann')], []))
		const { touched } = diffSnapshots(definitions, previous, next)
		expect(touched.users).toBeUndefined()
	})
})

describe('applyDelta', () => {
	test('applies a delta whose base matches the client version', () => {
		const previousState = makeState([user('u1', 'Ann')], [])
		const nextState = makeState([user('u1', 'Anne'), user('u2', 'Bob')], [task('t1', 'one')])
		const previous = snapshotOf(previousState)
		const next = snapshotOf(nextState)
		const { delta } = diffSnapshots(definitions, previous, next)
		const reaction = applyDelta(definitions, createEntityHasher(), previousState, previous.version, delta, false)
		expect(reaction.kind).toBe('applied')
		expect(reaction.version).toBe(next.version)
		expect(stateVersion(reaction.state)).toBe(next.version)
	})

	test('resyncs without touching state when the base does not match', () => {
		const previousState = makeState([user('u1', 'Ann')], [])
		const next = snapshotOf(makeState([user('u1', 'Anne')], []))
		const previous = snapshotOf(previousState)
		const { delta } = diffSnapshots(definitions, previous, next)
		const reaction = applyDelta(definitions, createEntityHasher(), previousState, 'some-other-version', delta, false)
		expect(reaction.kind).toBe('needsSnapshot')
		expect(reaction.state).toBe(previousState)
	})

	test('resyncs without touching state when the client has no version', () => {
		const previousState = makeState([user('u1', 'Ann')], [])
		const next = snapshotOf(makeState([user('u1', 'Anne')], []))
		const previous = snapshotOf(previousState)
		const { delta } = diffSnapshots(definitions, previous, next)
		const reaction = applyDelta(definitions, createEntityHasher(), previousState, null, delta, false)
		expect(reaction.kind).toBe('needsSnapshot')
		expect(reaction.state).toBe(previousState)
	})

	test('trusts delta.next when verify is false', () => {
		const previousState = makeState([user('u1', 'Ann')], [])
		const previous = snapshotOf(previousState)
		const next = snapshotOf(makeState([user('u1', 'Anne')], []))
		const { delta } = diffSnapshots(definitions, previous, next)
		const forged: Delta<AppSchema> = { ...delta, next: 'forged-version' }
		const reaction = applyDelta(definitions, createEntityHasher(), previousState, previous.version, forged, false)
		expect(reaction.kind).toBe('applied')
		expect(reaction.version).toBe('forged-version')
	})

	test('rejects a forged delta.next when verify is true, leaving state untouched', () => {
		const previousState = makeState([user('u1', 'Ann')], [])
		const previous = snapshotOf(previousState)
		const next = snapshotOf(makeState([user('u1', 'Anne')], []))
		const { delta } = diffSnapshots(definitions, previous, next)
		const forged: Delta<AppSchema> = { ...delta, next: 'forged-version' }
		const reaction = applyDelta(definitions, createEntityHasher(), previousState, previous.version, forged, true)
		expect(reaction.kind).toBe('needsSnapshot')
		expect(reaction.state).toBe(previousState)
	})

	test('rejects a corrupted entity when verify is true, leaving state untouched', () => {
		const previousState = makeState([user('u1', 'Ann')], [])
		const previous = snapshotOf(previousState)
		const next = snapshotOf(makeState([user('u1', 'Anne')], []))
		const { delta } = diffSnapshots(definitions, previous, next)
		const corrupted: Delta<AppSchema> = {
			...delta,
			collections: {
				users: { added: [], changed: [user('u1', 'Corrupted')], removed: [] },
			},
		}
		const reaction = applyDelta(definitions, createEntityHasher(), previousState, previous.version, corrupted, true)
		expect(reaction.kind).toBe('needsSnapshot')
		expect(reaction.state).toBe(previousState)
	})

	test('seeded round-trip: applying a delta from a previous snapshot reproduces the next snapshot', () => {
		const random = createRandom(20260101)
		for (let round = 0; round < 50; round++) {
			const previousState = randomState(random)
			const nextState = randomState(random)
			const previous = snapshotOf(previousState)
			const next = snapshotOf(nextState)
			const { delta } = diffSnapshots(definitions, previous, next)
			const reaction = applyDelta(definitions, createEntityHasher(), previousState, previous.version, delta, true)
			expect(reaction.kind).toBe('applied')
			expect(stateVersion(reaction.state)).toBe(next.version)
		}
	})
})

function randomState(random: () => number): ReplicaState<AppSchema> {
	const users: User[] = []
	const tasks: Task[] = []
	const userCount = Math.floor(random() * 5)
	for (let index = 0; index < userCount; index++) {
		users.push(user(`u${index}`, `name-${Math.floor(random() * 4)}`, `team-${Math.floor(random() * 3)}`))
	}
	const taskCount = Math.floor(random() * 5)
	for (let index = 0; index < taskCount; index++) {
		tasks.push(task(`t${index}`, `title-${Math.floor(random() * 4)}`, random() < 0.5))
	}
	return makeState(users, tasks)
}

describe('applySnapshot', () => {
	test('materializes a valid snapshot and reports its version', () => {
		const startState = makeState([user('u1', 'Ann')], [])
		const targetState = makeState([user('u2', 'Bob')], [task('t1', 'one')])
		const target = snapshotOf(targetState)
		const snapshot: Snapshot<AppSchema> = { kind: 'snapshot', version: target.version, collections: targetState }
		const reaction = applySnapshot(definitions, createEntityHasher(), startState, 'old', snapshot)
		expect(reaction.kind).toBe('snapshot')
		expect(reaction.version).toBe(target.version)
		expect(stateVersion(reaction.state)).toBe(target.version)
	})

	test('rejects a snapshot whose version does not match its contents, leaving state untouched', () => {
		const startState = makeState([user('u1', 'Ann')], [])
		const targetState = makeState([user('u2', 'Bob')], [])
		const snapshot: Snapshot<AppSchema> = { kind: 'snapshot', version: 'not-the-real-version', collections: targetState }
		const reaction = applySnapshot(definitions, createEntityHasher(), startState, 'old', snapshot)
		expect(reaction.kind).toBe('invalid')
		expect(reaction.state).toBe(startState)
	})
})

describe('reduceServerResponse', () => {
	test('treats unchanged at a version other than the client version as needing a snapshot', () => {
		const state = makeState([user('u1', 'Ann')], [])
		const reaction = reduceServerResponse(definitions, createEntityHasher(), state, 'client-version', { kind: 'unchanged', version: 'server-version' }, false)
		expect(reaction.kind).toBe('needsSnapshot')
		expect(reaction.state).toBe(state)
	})

	test('accepts unchanged when the version matches the client version', () => {
		const state = makeState([user('u1', 'Ann')], [])
		const reaction = reduceServerResponse(definitions, createEntityHasher(), state, 'same-version', { kind: 'unchanged', version: 'same-version' }, false)
		expect(reaction.kind).toBe('unchanged')
		expect(reaction.state).toBe(state)
	})

	test('reports invalid for a response that fails the protocol guard', () => {
		const state = makeState([user('u1', 'Ann')], [])
		const reaction = reduceServerResponse(definitions, createEntityHasher(), state, 'client-version', { kind: 'nonsense' }, false)
		expect(reaction.kind).toBe('invalid')
		expect(reaction.state).toBe(state)
	})
})

describe('respond', () => {
	test('returns unchanged when the client already has the current version', () => {
		const current = snapshotOf(makeState([user('u1', 'Ann')], []))
		const response = respond(current, [], current.version)
		expect(response.kind).toBe('unchanged')
	})

	test('returns a snapshot when the client has no version', () => {
		const current = snapshotOf(makeState([user('u1', 'Ann')], []))
		const response = respond(current, [], null)
		expect(response.kind).toBe('snapshot')
		if (response.kind !== 'snapshot') throw new Error('expected snapshot')
		expect(response.version).toBe(current.version)
		expect(response.collections.users.map((entity) => entity.id)).toEqual(['u1'])
	})

	test('returns a snapshot for a version outside the history', () => {
		const current = snapshotOf(makeState([user('u1', 'Ann')], []))
		const response = respond(current, [], 'unknown-version')
		expect(response.kind).toBe('snapshot')
	})

	test('drops an id added and then removed across the chain', () => {
		const empty = snapshotOf(makeState([], []))
		const added = snapshotOf(makeState([user('u1', 'Ann')], []))
		const replaced = snapshotOf(makeState([user('u2', 'Bob')], []))
		const history = [historyStep(empty, added), historyStep(added, replaced)]
		const response = respond(replaced, history, empty.version)
		expect(response.kind).toBe('delta')
		if (response.kind !== 'delta') throw new Error('expected delta')
		// u1 was added then removed, so it is dropped rather than emitted as removed; u2 is the only real addition.
		expect(response.collections.users?.added.map((entity) => entity.id)).toEqual(['u2'])
		expect(response.collections.users?.removed).toEqual([])
	})

	test('a chain that returns to the base version reads as unchanged', () => {
		const empty = snapshotOf(makeState([], []))
		const added = snapshotOf(makeState([user('u1', 'Ann')], []))
		const history = [historyStep(empty, added), historyStep(added, empty)]
		const response = respond(empty, history, empty.version)
		expect(response.kind).toBe('unchanged')
	})

	test('drops an id removed and then re-added across the chain', () => {
		const start = snapshotOf(makeState([user('u1', 'Ann')], []))
		const removed = snapshotOf(makeState([], []))
		const readded = snapshotOf(makeState([user('u1', 'Ann'), user('u2', 'Bob')], []))
		const history = [historyStep(start, removed), historyStep(removed, readded)]
		const response = respond(readded, history, start.version)
		expect(response.kind).toBe('delta')
		if (response.kind !== 'delta') throw new Error('expected delta')
		// u1's before-hash matches its current hash, so it is dropped; u2 is the only real addition.
		expect(response.collections.users?.added.map((entity) => entity.id)).toEqual(['u2'])
		expect(response.collections.users?.removed).toEqual([])
	})

	test('drops an entity changed and then reverted across the chain', () => {
		const original = user('u1', 'Ann')
		const start = snapshotOf(makeState([original], []))
		const changed = snapshotOf(makeState([user('u1', 'Bob')], []))
		const reverted = snapshotOf(makeState([original, user('u2', 'Cara')], []))
		const history = [historyStep(start, changed), historyStep(changed, reverted)]
		const response = respond(reverted, history, start.version)
		expect(response.kind).toBe('delta')
		if (response.kind !== 'delta') throw new Error('expected delta')
		// u1 reverted to its base hash, so it is dropped; u2 is the only real change.
		expect(response.collections.users?.added.map((entity) => entity.id)).toEqual(['u2'])
		expect(response.collections.users?.changed).toEqual([])
	})

	test('composes a real delta from the requested base to the tip', () => {
		const start = snapshotOf(makeState([], []))
		const first = snapshotOf(makeState([user('u1', 'Ann')], []))
		const second = snapshotOf(makeState([user('u1', 'Ann'), user('u2', 'Bob')], []))
		const history = [historyStep(start, first), historyStep(first, second)]
		const response = respond(second, history, start.version)
		expect(response.kind).toBe('delta')
		if (response.kind !== 'delta') throw new Error('expected delta')
		expect(response.base).toBe(start.version)
		expect(response.next).toBe(second.version)
		expect(response.collections.users?.added.map((entity) => entity.id).sort()).toEqual(['u1', 'u2'])
	})

	test('composes only from the latest history entry whose base matches', () => {
		const start = snapshotOf(makeState([], []))
		const first = snapshotOf(makeState([user('u1', 'Ann')], []))
		const second = snapshotOf(makeState([user('u1', 'Ann'), user('u2', 'Bob')], []))
		const history = [historyStep(start, first), historyStep(first, second)]
		const response = respond(second, history, first.version)
		expect(response.kind).toBe('delta')
		if (response.kind !== 'delta') throw new Error('expected delta')
		expect(response.collections.users?.added.map((entity) => entity.id)).toEqual(['u2'])
	})

	test('never emits an id the chain did not touch', () => {
		const start = snapshotOf(makeState([user('u1', 'Ann'), user('u2', 'Bob')], []))
		const changed = snapshotOf(makeState([user('u1', 'Anne'), user('u2', 'Bob')], []))
		const history = [historyStep(start, changed)]
		const response = respond(changed, history, start.version)
		expect(response.kind).toBe('delta')
		if (response.kind !== 'delta') throw new Error('expected delta')
		expect(response.collections.users?.changed.map((entity) => entity.id)).toEqual(['u1'])
	})
})
