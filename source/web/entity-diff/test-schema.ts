import { buildCollections, contentVersion, createEntityHasher, defineCollection, isPlainObject } from '../static/ts/entity-diff/index.js'
import type { CollectionDefinitions, EntityBase, ReadonlyReplicaState, ReplicaState } from '../static/ts/entity-diff/index.js'

// An interface-declared schema, not a type alias: interfaces have no implicit index signature, so it only compiles against the self-referential mapped constraint the module uses.
export interface User extends EntityBase {
	name: string
	team: string
}

export interface Task extends EntityBase {
	title: string
	done: boolean
}

export interface AppSchema {
	users: User
	tasks: Task
}

function isUser(value: unknown): value is User {
	if (!isPlainObject(value)) return false
	if (typeof value.id !== 'string') return false
	if (typeof value.name !== 'string') return false
	if (typeof value.team !== 'string') return false
	return true
}

function isTask(value: unknown): value is Task {
	if (!isPlainObject(value)) return false
	if (typeof value.id !== 'string') return false
	if (typeof value.title !== 'string') return false
	if (typeof value.done !== 'boolean') return false
	return true
}

// The default collections omit `versionOf`, so every change is detected through the full content hash. Tests that exercise the cheap path build their own definitions.
export const userCollection = defineCollection<User>(isUser)

export const taskCollection = defineCollection<Task>(isTask)

export const definitions: CollectionDefinitions<AppSchema> = {
	users: userCollection,
	tasks: taskCollection,
}

export const versionedDefinitions: CollectionDefinitions<AppSchema> = {
	users: defineCollection<User>(isUser, (entity) => `${entity.name}|${entity.team}`),
	tasks: defineCollection<Task>(isTask, (entity) => `${entity.title}|${String(entity.done)}`),
}

export function makeState(users: User[], tasks: Task[]): ReplicaState<AppSchema> {
	return { users, tasks }
}

// The aggregate content hash of a state: the analogue of the old content-addressed wire version, used by tests to assert that a client's held state matches a server's content.
export function stateContentHash(definitionsToUse: CollectionDefinitions<AppSchema>, state: ReadonlyReplicaState<AppSchema>): string {
	return contentVersion(definitionsToUse, buildCollections(definitionsToUse, createEntityHasher(), state))
}

// mulberry32: a tiny deterministic PRNG so convergence tests are reproducible without clocks or Math.random.
export function createRandom(seed: number): () => number {
	let state = seed >>> 0
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let value = state
		value = Math.imul(value ^ (value >>> 15), value | 1)
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296
	}
}
