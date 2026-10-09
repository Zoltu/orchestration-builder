import { describe, expect, test } from 'bun:test'
import {
	applyDelta,
	applySnapshot,
	buildCollections,
	contentVersion,
	createEntityHasher,
	defineCollection,
	diffCollections,
	hashEntity,
	reduceServerResponse,
	respond,
} from '../static/ts/entity-diff/index.js'
import type { CollectionDefinitions, Delta, EntityBase, EntityHasher, HistoryEntry, ReplicaState, ServerResponse, Snapshot, SnapshotCollections, VersionToken } from '../static/ts/entity-diff/index.js'
import { createRandom, definitions, makeState, stateContentHash, taskCollection, userCollection, versionedDefinitions } from './test-schema.js'
import type { AppSchema, Task, User } from './test-schema.js'

function collectionsOf(state: ReplicaState<AppSchema>): SnapshotCollections<AppSchema> {
	return buildCollections(definitions, createEntityHasher(), state)
}

function contentHashOf(state: ReplicaState<AppSchema>): string {
	return stateContentHash(definitions, state)
}

function historyStep(base: VersionToken, next: VersionToken, previous: SnapshotCollections<AppSchema>, nextCollections: SnapshotCollections<AppSchema>): HistoryEntry<AppSchema> {
	const { touched } = diffCollections(definitions, previous, nextCollections)
	return { base, next, touched }
}

function respondFrom(current: SnapshotCollections<AppSchema>, revision: VersionToken, history: readonly HistoryEntry<AppSchema>[], have: VersionToken | null): ServerResponse<AppSchema> {
	return respond(definitions, current, revision, history, have, () => 'snapshot-content')
}

function user(id: string, name: string, team = 'team-a'): User {
	return { id, name, team }
}

function task(id: string, title: string, done = false): Task {
	return { id, title, done }
}

describe('buildCollections and contentVersion', () => {
	test('contentVersion is independent of entity array order', () => {
		const first = contentHashOf(makeState([user('u1', 'Ann'), user('u2', 'Bob')], [task('t1', 'one')]))
		const second = contentHashOf(makeState([user('u2', 'Bob'), user('u1', 'Ann')], [task('t1', 'one')]))
		expect(first).toBe(second)
	})

	test('contentVersion changes when an entity changes', () => {
		const before = contentHashOf(makeState([user('u1', 'Ann')], []))
		const after = contentHashOf(makeState([user('u1', 'Anne')], []))
		expect(after).not.toBe(before)
	})

	test('contentVersion changes when a collection changes membership', () => {
		const before = contentHashOf(makeState([], []))
		const after = contentHashOf(makeState([], [task('t1', 'one')]))
		expect(after).not.toBe(before)
	})

	test('buildCollections throws on a duplicate id', () => {
		const state = makeState([user('u1', 'Ann'), user('u1', 'Bob')], [])
		expect(() => buildCollections(definitions, createEntityHasher(), state)).toThrow()
	})

	test('buildCollections throws when a declared collection is missing', () => {
		const broken: ReplicaState<AppSchema> = Object.create(null)
		broken.users = []
		expect(() => buildCollections(definitions, createEntityHasher(), broken)).toThrow()
	})
})

// A test double that counts real hash computations while caching by identity, so it can observe whether a build preserves entity identity across calls and whether the versionOf path avoids the hasher entirely.
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
	test('does not re-hash an entity whose identity is preserved across two builds', () => {
		const { hasher, computations } = createCountingHasher()
		const shared = user('u1', 'Ann')
		const first = buildCollections(definitions, hasher, makeState([shared], []))
		const second = buildCollections(definitions, hasher, makeState([shared], []))
		expect(computations()).toBe(1)
		expect(contentVersion(definitions, second)).toBe(contentVersion(definitions, first))
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
		buildCollections(definitions, hasher, makeState([tracked], []))
		const readsAfterFirst = nameReads
		expect(readsAfterFirst).toBeGreaterThan(0)
		buildCollections(definitions, hasher, makeState([tracked], []))
		expect(nameReads).toBe(readsAfterFirst)
	})

	test('a new object with identical content hashes to the same version', () => {
		const hasher = createEntityHasher()
		expect(hasher.hash(user('u1', 'Ann'))).toBe(hasher.hash(user('u1', 'Ann')))
	})
})

describe('versionOf', () => {
	test('buildCollections never invokes the hasher when versionOf is provided', () => {
		const { hasher, computations } = createCountingHasher()
		buildCollections(versionedDefinitions, hasher, makeState([user('u1', 'Ann')], [task('t1', 'one')]))
		expect(computations()).toBe(0)
	})

	test('versionOf is called exactly once per entity per build', () => {
		let calls = 0
		const definitionsWithCountingVersionOf: CollectionDefinitions<AppSchema> = {
			users: defineCollection<User>(userCollection.isEntity, (entity) => {
				calls += 1
				return entity.name
			}),
			tasks: defineCollection<Task>(taskCollection.isEntity, (entity) => {
				calls += 1
				return entity.title
			}),
		}
		buildCollections(definitionsWithCountingVersionOf, createEntityHasher(), makeState([user('u1', 'Ann'), user('u2', 'Bob')], [task('t1', 'one')]))
		expect(calls).toBe(3)
	})

	test('a changed versionOf value is reported as changed', () => {
		const previous = buildCollections(versionedDefinitions, createEntityHasher(), makeState([user('u1', 'Ann')], []))
		const next = buildCollections(versionedDefinitions, createEntityHasher(), makeState([user('u1', 'Anne')], []))
		const { collections } = diffCollections(versionedDefinitions, previous, next)
		expect(collections.users?.changed.map((entity) => entity.id)).toEqual(['u1'])
	})

	test('a stable versionOf value is not reported as touched even for a new object', () => {
		const previous = buildCollections(versionedDefinitions, createEntityHasher(), makeState([user('u1', 'Ann')], []))
		const next = buildCollections(versionedDefinitions, createEntityHasher(), makeState([user('u1', 'Ann')], []))
		const { touched } = diffCollections(versionedDefinitions, previous, next)
		expect(touched.users).toBeUndefined()
	})

	test('without versionOf a content change is still detected through the content hash', () => {
		const previous = buildCollections(definitions, createEntityHasher(), makeState([user('u1', 'Ann')], []))
		const next = buildCollections(definitions, createEntityHasher(), makeState([user('u1', 'Anne')], []))
		const { collections } = diffCollections(definitions, previous, next)
		expect(collections.users?.changed.map((entity) => entity.id)).toEqual(['u1'])
	})
})

describe('diffCollections', () => {
	test('reports added, changed, removed, and the before-version of each touched id', () => {
		const previous = collectionsOf(makeState([user('u1', 'Ann'), user('u2', 'Bob')], [task('t1', 'one')]))
		const next = collectionsOf(makeState([user('u1', 'Anne'), user('u3', 'Cara')], [task('t1', 'one')]))
		const { touched, collections } = diffCollections(definitions, previous, next)
		expect(collections.users?.added.map((entity) => entity.id)).toEqual(['u3'])
		expect(collections.users?.changed.map((entity) => entity.id)).toEqual(['u1'])
		expect(collections.users?.removed).toEqual(['u2'])
		expect(collections.tasks).toBeUndefined()
		const touchedUsers = touched.users
		expect(touchedUsers).toBeDefined()
		if (touchedUsers === undefined) throw new Error('expected touched users')
		expect(touchedUsers.get('u1')).toBe(hashEntity(user('u1', 'Ann')))
		expect(touchedUsers.get('u2')).toBe(hashEntity(user('u2', 'Bob')))
		expect(touchedUsers.get('u3')).toBeNull()
		expect(touched.tasks).toBeUndefined()
	})

	test('reports an empty touched map for an unchanged state', () => {
		const previous = collectionsOf(makeState([user('u1', 'Ann')], []))
		const next = collectionsOf(makeState([user('u1', 'Ann')], []))
		const { touched } = diffCollections(definitions, previous, next)
		expect(touched.users).toBeUndefined()
	})
})

describe('applyDelta', () => {
	test('applies a delta whose base matches the client version', () => {
		const previousState = makeState([user('u1', 'Ann')], [])
		const nextState = makeState([user('u1', 'Anne'), user('u2', 'Bob')], [task('t1', 'one')])
		const { collections } = diffCollections(definitions, collectionsOf(previousState), collectionsOf(nextState))
		const delta: Delta<AppSchema> = { kind: 'delta', base: 'e:1', next: 'e:2', collections }
		const reaction = applyDelta(definitions, previousState, 'e:1', delta)
		expect(reaction.kind).toBe('applied')
		expect(reaction.version).toBe('e:2')
		expect(contentHashOf(reaction.state)).toBe(contentHashOf(nextState))
	})

	test('resyncs without touching state when the base does not match', () => {
		const previousState = makeState([user('u1', 'Ann')], [])
		const nextState = makeState([user('u1', 'Anne')], [])
		const { collections } = diffCollections(definitions, collectionsOf(previousState), collectionsOf(nextState))
		const delta: Delta<AppSchema> = { kind: 'delta', base: 'e:1', next: 'e:2', collections }
		const reaction = applyDelta(definitions, previousState, 'some-other-version', delta)
		expect(reaction.kind).toBe('needsSnapshot')
		expect(reaction.state).toBe(previousState)
	})

	test('resyncs without touching state when the client has no version', () => {
		const previousState = makeState([user('u1', 'Ann')], [])
		const nextState = makeState([user('u1', 'Anne')], [])
		const { collections } = diffCollections(definitions, collectionsOf(previousState), collectionsOf(nextState))
		const delta: Delta<AppSchema> = { kind: 'delta', base: 'e:1', next: 'e:2', collections }
		const reaction = applyDelta(definitions, previousState, null, delta)
		expect(reaction.kind).toBe('needsSnapshot')
		expect(reaction.state).toBe(previousState)
	})

	test('trusts delta.next because the base precondition is the only integrity check', () => {
		const previousState = makeState([user('u1', 'Ann')], [])
		const nextState = makeState([user('u1', 'Anne')], [])
		const { collections } = diffCollections(definitions, collectionsOf(previousState), collectionsOf(nextState))
		const delta: Delta<AppSchema> = { kind: 'delta', base: 'e:1', next: 'e:2', collections }
		const forged: Delta<AppSchema> = { ...delta, next: 'forged-version' }
		const reaction = applyDelta(definitions, previousState, 'e:1', forged)
		expect(reaction.kind).toBe('applied')
		expect(reaction.version).toBe('forged-version')
	})

	test('seeded round-trip: applying a delta from a previous state reproduces the next content', () => {
		const random = createRandom(20260101)
		for (let round = 0; round < 50; round++) {
			const previousState = randomState(random)
			const nextState = randomState(random)
			const { collections } = diffCollections(definitions, collectionsOf(previousState), collectionsOf(nextState))
			const delta: Delta<AppSchema> = { kind: 'delta', base: 'e:1', next: 'e:2', collections }
			const reaction = applyDelta(definitions, previousState, 'e:1', delta)
			expect(reaction.kind).toBe('applied')
			expect(contentHashOf(reaction.state)).toBe(contentHashOf(nextState))
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
		const target = collectionsOf(targetState)
		const snapshot: Snapshot<AppSchema> = { kind: 'snapshot', version: 'e:5', contentHash: contentVersion(definitions, target), collections: targetState }
		const reaction = applySnapshot(definitions, createEntityHasher(), startState, 'e:0', snapshot)
		expect(reaction.kind).toBe('snapshot')
		expect(reaction.version).toBe('e:5')
		expect(contentHashOf(reaction.state)).toBe(contentVersion(definitions, target))
	})

	test('rejects a snapshot whose contentHash does not match its contents, leaving state untouched', () => {
		const startState = makeState([user('u1', 'Ann')], [])
		const targetState = makeState([user('u2', 'Bob')], [])
		const snapshot: Snapshot<AppSchema> = { kind: 'snapshot', version: 'e:5', contentHash: 'not-the-real-hash', collections: targetState }
		const reaction = applySnapshot(definitions, createEntityHasher(), startState, 'e:0', snapshot)
		expect(reaction.kind).toBe('invalid')
		expect(reaction.state).toBe(startState)
	})
})

describe('reduceServerResponse', () => {
	test('treats unchanged at a version other than the client version as needing a snapshot', () => {
		const state = makeState([user('u1', 'Ann')], [])
		const reaction = reduceServerResponse(definitions, createEntityHasher(), state, 'client-version', { kind: 'unchanged', version: 'server-version' })
		expect(reaction.kind).toBe('needsSnapshot')
		expect(reaction.state).toBe(state)
	})

	test('accepts unchanged when the version matches the client version', () => {
		const state = makeState([user('u1', 'Ann')], [])
		const reaction = reduceServerResponse(definitions, createEntityHasher(), state, 'same-version', { kind: 'unchanged', version: 'same-version' })
		expect(reaction.kind).toBe('unchanged')
		expect(reaction.state).toBe(state)
	})

	test('reports invalid for a response that fails the protocol guard', () => {
		const state = makeState([user('u1', 'Ann')], [])
		const reaction = reduceServerResponse(definitions, createEntityHasher(), state, 'client-version', { kind: 'nonsense' })
		expect(reaction.kind).toBe('invalid')
		expect(reaction.state).toBe(state)
	})
})

describe('respond', () => {
	test('returns unchanged when the client already has the current revision', () => {
		const current = collectionsOf(makeState([user('u1', 'Ann')], []))
		const response = respondFrom(current, 'e:1', [], 'e:1')
		expect(response.kind).toBe('unchanged')
	})

	test('returns a snapshot when the client has no version', () => {
		const current = collectionsOf(makeState([user('u1', 'Ann')], []))
		const response = respondFrom(current, 'e:1', [], null)
		expect(response.kind).toBe('snapshot')
		if (response.kind !== 'snapshot') throw new Error('expected snapshot')
		expect(response.version).toBe('e:1')
		expect(response.contentHash).toBe('snapshot-content')
		expect(response.collections.users.map((entity) => entity.id)).toEqual(['u1'])
	})

	test('returns a snapshot for a version outside the history', () => {
		const current = collectionsOf(makeState([user('u1', 'Ann')], []))
		const response = respondFrom(current, 'e:1', [], 'unknown-version')
		expect(response.kind).toBe('snapshot')
	})

	test('drops an id added and then removed across the chain', () => {
		const empty = collectionsOf(makeState([], []))
		const added = collectionsOf(makeState([user('u1', 'Ann')], []))
		const replaced = collectionsOf(makeState([user('u2', 'Bob')], []))
		const history = [historyStep('e:0', 'e:1', empty, added), historyStep('e:1', 'e:2', added, replaced)]
		const response = respondFrom(replaced, 'e:2', history, 'e:0')
		expect(response.kind).toBe('delta')
		if (response.kind !== 'delta') throw new Error('expected delta')
		// u1 was added then removed, so it is dropped rather than emitted as removed; u2 is the only real addition.
		expect(response.collections.users?.added.map((entity) => entity.id)).toEqual(['u2'])
		expect(response.collections.users?.removed).toEqual([])
	})

	test('a chain that returns to the base revision composes to an empty delta', () => {
		const empty = collectionsOf(makeState([], []))
		const added = collectionsOf(makeState([user('u1', 'Ann')], []))
		const history = [historyStep('e:0', 'e:1', empty, added), historyStep('e:1', 'e:2', added, empty)]
		const response = respondFrom(empty, 'e:2', history, 'e:0')
		expect(response.kind).toBe('delta')
		if (response.kind !== 'delta') throw new Error('expected delta')
		expect(response.collections.users).toBeUndefined()
		const reaction = applyDelta(definitions, makeState([], []), 'e:0', response)
		expect(reaction.kind).toBe('applied')
		expect(contentHashOf(reaction.state)).toBe(contentHashOf(makeState([], [])))
	})

	test('drops an id removed and then re-added across the chain', () => {
		const start = collectionsOf(makeState([user('u1', 'Ann')], []))
		const removed = collectionsOf(makeState([], []))
		const readded = collectionsOf(makeState([user('u1', 'Ann'), user('u2', 'Bob')], []))
		const history = [historyStep('e:0', 'e:1', start, removed), historyStep('e:1', 'e:2', removed, readded)]
		const response = respondFrom(readded, 'e:2', history, 'e:0')
		expect(response.kind).toBe('delta')
		if (response.kind !== 'delta') throw new Error('expected delta')
		// u1's before-version matches its current version, so it is dropped; u2 is the only real addition.
		expect(response.collections.users?.added.map((entity) => entity.id)).toEqual(['u2'])
		expect(response.collections.users?.removed).toEqual([])
	})

	test('drops an entity changed and then reverted across the chain', () => {
		const original = user('u1', 'Ann')
		const start = collectionsOf(makeState([original], []))
		const changed = collectionsOf(makeState([user('u1', 'Bob')], []))
		const reverted = collectionsOf(makeState([original, user('u2', 'Cara')], []))
		const history = [historyStep('e:0', 'e:1', start, changed), historyStep('e:1', 'e:2', changed, reverted)]
		const response = respondFrom(reverted, 'e:2', history, 'e:0')
		expect(response.kind).toBe('delta')
		if (response.kind !== 'delta') throw new Error('expected delta')
		// u1 reverted to its base version, so it is dropped; u2 is the only real change.
		expect(response.collections.users?.added.map((entity) => entity.id)).toEqual(['u2'])
		expect(response.collections.users?.changed).toEqual([])
	})

	test('composes a real delta from the requested base to the tip', () => {
		const start = collectionsOf(makeState([], []))
		const first = collectionsOf(makeState([user('u1', 'Ann')], []))
		const second = collectionsOf(makeState([user('u1', 'Ann'), user('u2', 'Bob')], []))
		const history = [historyStep('e:0', 'e:1', start, first), historyStep('e:1', 'e:2', first, second)]
		const response = respondFrom(second, 'e:2', history, 'e:0')
		expect(response.kind).toBe('delta')
		if (response.kind !== 'delta') throw new Error('expected delta')
		expect(response.base).toBe('e:0')
		expect(response.next).toBe('e:2')
		expect(response.collections.users?.added.map((entity) => entity.id).sort()).toEqual(['u1', 'u2'])
	})

	test('composes only from the latest history entry whose base matches', () => {
		const start = collectionsOf(makeState([], []))
		const first = collectionsOf(makeState([user('u1', 'Ann')], []))
		const second = collectionsOf(makeState([user('u1', 'Ann'), user('u2', 'Bob')], []))
		const history = [historyStep('e:0', 'e:1', start, first), historyStep('e:1', 'e:2', first, second)]
		const response = respondFrom(second, 'e:2', history, 'e:1')
		expect(response.kind).toBe('delta')
		if (response.kind !== 'delta') throw new Error('expected delta')
		expect(response.collections.users?.added.map((entity) => entity.id)).toEqual(['u2'])
	})

	test('handles an id added, removed, and re-added across the chain', () => {
		const empty = collectionsOf(makeState([], []))
		const withU1 = collectionsOf(makeState([user('u1', 'Ann')], []))
		const withBoth = collectionsOf(makeState([user('u1', 'Ann'), user('u2', 'Bob')], []))
		const history = [historyStep('e:0', 'e:1', empty, withU1), historyStep('e:1', 'e:2', withU1, empty), historyStep('e:2', 'e:3', empty, withBoth)]
		const response = respondFrom(withBoth, 'e:3', history, 'e:0')
		expect(response.kind).toBe('delta')
		if (response.kind !== 'delta') throw new Error('expected delta')
		// u1's first-seen before-version is null (it was absent at the base), so its re-add is a real addition.
		expect(response.collections.users?.added.map((entity) => entity.id).sort()).toEqual(['u1', 'u2'])
	})

	test('never emits an id the chain did not touch', () => {
		const start = collectionsOf(makeState([user('u1', 'Ann'), user('u2', 'Bob')], []))
		const changed = collectionsOf(makeState([user('u1', 'Anne'), user('u2', 'Bob')], []))
		const history = [historyStep('e:0', 'e:1', start, changed)]
		const response = respondFrom(changed, 'e:1', history, 'e:0')
		expect(response.kind).toBe('delta')
		if (response.kind !== 'delta') throw new Error('expected delta')
		expect(response.collections.users?.changed.map((entity) => entity.id)).toEqual(['u1'])
	})
})
