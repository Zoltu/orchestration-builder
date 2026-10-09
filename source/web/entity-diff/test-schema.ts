import { createEntityHasher, defineCollection, isPlainObject, snapshotState } from '../static/ts/entity-diff/index.js'
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

export const userCollection = defineCollection<User>((value): value is User => {
	if (!isPlainObject(value)) return false
	if (typeof value.id !== 'string') return false
	if (typeof value.name !== 'string') return false
	if (typeof value.team !== 'string') return false
	return true
})

export const taskCollection = defineCollection<Task>((value): value is Task => {
	if (!isPlainObject(value)) return false
	if (typeof value.id !== 'string') return false
	if (typeof value.title !== 'string') return false
	if (typeof value.done !== 'boolean') return false
	return true
})

export const definitions: CollectionDefinitions<AppSchema> = {
	users: userCollection,
	tasks: taskCollection,
}

export function makeState(users: User[], tasks: Task[]): ReplicaState<AppSchema> {
	return { users, tasks }
}

export function stateVersion(state: ReadonlyReplicaState<AppSchema>): string {
	return snapshotState(definitions, createEntityHasher(), state).version
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
