import { canonicalSerialize } from './canonical.js'
import { isServerResponse } from './protocol.js'
import { sha256Hex } from './sha256.js'
import { collectionNames } from './types.js'
import type {
	CollectionDefinitions,
	CollectionDiff,
	CollectionDiffs,
	Delta,
	EntityBase,
	EntitySchemaConstraint,
	ReadonlyReplicaState,
	ReplicaState,
	ServerResponse,
	Snapshot,
	VersionToken,
} from './types.js'

export interface EntityHasher {
	hash(entity: EntityBase): VersionToken
}

export function hashEntity(entity: EntityBase): VersionToken {
	return sha256Hex(canonicalSerialize(entity))
}

// The WeakMap caches by object identity so repeated snapshots of an unchanged state skip re-hashing. It holds weak references, so evicting the entity frees the cache entry too.
//
// IMMUTABILITY CONTRACT: the cache is correct only if an entity's hash depends solely on its identity, which holds only while entities are never mutated in place. Treat every entity and every state object/array the module hands back as immutable: to change an entity, build a new object and put it in a new array; never edit a field of an object that was already snapshotted. An in-place mutation keeps the same object identity, so the cache returns the old hash and the version silently stays stale. This is the caller's responsibility and the module cannot detect it.
export function createEntityHasher(): EntityHasher {
	const cache = new WeakMap<EntityBase, VersionToken>()
	return {
		hash(entity) {
			const cached = cache.get(entity)
			if (cached !== undefined) return cached
			const computed = hashEntity(entity)
			cache.set(entity, computed)
			return computed
		},
	}
}

export interface EntityRecord<Entity extends EntityBase> {
	entity: Entity
	hash: VersionToken
}

export type SnapshotCollections<Schema extends EntitySchemaConstraint<Schema>> = { [K in keyof Schema]: Map<string, EntityRecord<Schema[K]>> }

export interface StateSnapshot<Schema extends EntitySchemaConstraint<Schema>> {
	version: VersionToken
	collections: SnapshotCollections<Schema>
}

export type TouchedCollections<Schema extends EntitySchemaConstraint<Schema>> = { [K in keyof Schema]?: Map<string, VersionToken | null> }

export interface HistoryEntry<Schema extends EntitySchemaConstraint<Schema>> {
	base: VersionToken
	next: VersionToken
	touched: TouchedCollections<Schema>
}

export type ClientReaction<Schema extends EntitySchemaConstraint<Schema>> =
	| { kind: 'unchanged' | 'applied' | 'snapshot'; state: ReplicaState<Schema>; version: VersionToken }
	| { kind: 'needsSnapshot' | 'invalid'; state: ReplicaState<Schema>; version: VersionToken | null; reason?: string }

function snapshotNames<Schema extends EntitySchemaConstraint<Schema>>(collections: SnapshotCollections<Schema>): (keyof Schema & string)[] {
	return Object.keys(collections).filter((key): key is keyof Schema & string => Object.prototype.hasOwnProperty.call(collections, key))
}

function collectionRecords<Entity extends EntityBase>(hasher: EntityHasher, entities: readonly Entity[]): Map<string, EntityRecord<Entity>> {
	const records = new Map<string, EntityRecord<Entity>>()
	for (const entity of entities) {
		if (typeof entity.id !== 'string') throw new Error('entity-diff: an entity is missing a string id')
		if (records.has(entity.id)) throw new Error(`entity-diff: duplicate entity id "${entity.id}"`)
		records.set(entity.id, { entity, hash: hasher.hash(entity) })
	}
	return records
}

function collectionVersion<Entity extends EntityBase>(records: Map<string, EntityRecord<Entity>>): VersionToken {
	const pairs: [string, VersionToken][] = []
	for (const [id, record] of records) pairs.push([id, record.hash])
	pairs.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
	return sha256Hex(canonicalSerialize(pairs))
}

function entitiesOf<Entity extends EntityBase>(records: Map<string, EntityRecord<Entity>>): Entity[] {
	const entities: Entity[] = []
	for (const record of records.values()) entities.push(record.entity)
	return entities
}

// An empty state is the server's and client's starting point; every declared collection must be present because snapshotState treats a missing one as a programming error.
export function emptyState<Schema extends EntitySchemaConstraint<Schema>>(definitions: CollectionDefinitions<Schema>): ReplicaState<Schema> {
	const state: ReplicaState<Schema> = Object.create(null)
	for (const name of collectionNames(definitions)) {
		state[name] = []
	}
	return state
}

// A mapped type over a generic schema cannot be built with an object literal without an assertion, so the accumulator starts as a prototype-less object; the prototype is also the safe choice because the keys come from the schema.
//
// COLLECTIONS ARE UNORDERED: the version is a content hash over id/hash pairs sorted by id, so it is independent of array order. An app that needs a stable display order MUST sort by its own domain key (an id, a timestamp, a name); the module makes no ordering guarantee.
export function snapshotState<Schema extends EntitySchemaConstraint<Schema>>(
	definitions: CollectionDefinitions<Schema>,
	hasher: EntityHasher,
	state: ReadonlyReplicaState<Schema>,
): StateSnapshot<Schema> {
	const collections: SnapshotCollections<Schema> = Object.create(null)
	const versions: [string, VersionToken][] = []
	for (const name of collectionNames(definitions)) {
		const entities = state[name]
		if (!Array.isArray(entities)) throw new Error(`entity-diff: state is missing the "${name}" collection`)
		const records = collectionRecords(hasher, entities)
		collections[name] = records
		versions.push([name, collectionVersion(records)])
	}
	versions.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
	return { version: sha256Hex(canonicalSerialize(versions)), collections }
}

export function materializeState<Schema extends EntitySchemaConstraint<Schema>>(current: StateSnapshot<Schema>): ReplicaState<Schema> {
	const state: ReplicaState<Schema> = Object.create(null)
	for (const name of snapshotNames(current.collections)) {
		state[name] = entitiesOf(current.collections[name])
	}
	return state
}

interface CollectionDelta<Entity extends EntityBase> {
	added: Entity[]
	changed: Entity[]
	removed: string[]
	touched: Map<string, VersionToken | null>
}

function diffCollection<Entity extends EntityBase>(
	previousRecords: Map<string, EntityRecord<Entity>>,
	nextRecords: Map<string, EntityRecord<Entity>>,
): CollectionDelta<Entity> {
	const added: Entity[] = []
	const changed: Entity[] = []
	const removed: string[] = []
	const touched = new Map<string, VersionToken | null>()
	for (const [id, record] of nextRecords) {
		const before = previousRecords.get(id)
		if (before === undefined) {
			added.push(record.entity)
			touched.set(id, null)
			continue
		}
		if (before.hash !== record.hash) {
			changed.push(record.entity)
			touched.set(id, before.hash)
		}
	}
	for (const [id, record] of previousRecords) {
		if (nextRecords.has(id)) continue
		removed.push(id)
		touched.set(id, record.hash)
	}
	return { added, changed, removed, touched }
}

export function diffSnapshots<Schema extends EntitySchemaConstraint<Schema>>(
	definitions: CollectionDefinitions<Schema>,
	previous: StateSnapshot<Schema>,
	next: StateSnapshot<Schema>,
): { touched: TouchedCollections<Schema>; delta: Delta<Schema> } {
	const touched: TouchedCollections<Schema> = {}
	const collections: CollectionDiffs<Schema> = {}
	for (const name of collectionNames(definitions)) {
		const diff = diffCollection(previous.collections[name], next.collections[name])
		if (diff.added.length === 0 && diff.changed.length === 0 && diff.removed.length === 0) continue
		collections[name] = { added: diff.added, changed: diff.changed, removed: diff.removed }
		touched[name] = diff.touched
	}
	return { touched, delta: { kind: 'delta', base: previous.version, next: next.version, collections } }
}

function applyCollectionDelta<Entity extends EntityBase>(
	entities: readonly Entity[],
	diff: CollectionDiff<Entity> | undefined,
): Entity[] {
	const index = new Map<string, Entity>()
	for (const entity of entities) index.set(entity.id, entity)
	if (diff === undefined) return Array.from(index.values())
	for (const id of diff.removed) index.delete(id)
	for (const entity of diff.added) index.set(entity.id, entity)
	for (const entity of diff.changed) index.set(entity.id, entity)
	return Array.from(index.values())
}

// A helper rather than a spread at the call site: spreading a union of arrays widens the element type, so TypeScript cannot match the result back to the schema's per-collection array type.
function copyEntities<Entity extends EntityBase>(entities: readonly Entity[]): Entity[] {
	return [...entities]
}

function composeCollection<Entity extends EntityBase>(
	currentRecords: Map<string, EntityRecord<Entity>>,
	touched: Map<string, VersionToken | null>,
): CollectionDiff<Entity> {
	const added: Entity[] = []
	const changed: Entity[] = []
	const removed: string[] = []
	for (const [id, beforeHash] of touched) {
		const record = currentRecords.get(id)
		if (record === undefined) {
			if (beforeHash !== null) removed.push(id)
			continue
		}
		if (beforeHash === null) {
			added.push(record.entity)
			continue
		}
		if (beforeHash !== record.hash) changed.push(record.entity)
	}
	return { added, changed, removed }
}

// The delta is computed from the tip of the chain: the first history entry that touched an id (from the requested base forward) supplies the id's before-hash, and that before-hash is compared against the current state to drop ids whose net effect cancels out.
export function respond<Schema extends EntitySchemaConstraint<Schema>>(
	current: StateSnapshot<Schema>,
	history: readonly HistoryEntry<Schema>[],
	have: VersionToken | null,
): ServerResponse<Schema> {
	if (have !== null && have === current.version) return { kind: 'unchanged', version: current.version }
	if (have === null) return { kind: 'snapshot', version: current.version, collections: materializeState(current) }
	let startIndex = -1
	for (let index = history.length - 1; index >= 0; index--) {
		const entry = history[index]
		if (entry === undefined) continue
		if (entry.base === have) {
			startIndex = index
			break
		}
	}
	if (startIndex === -1) return { kind: 'snapshot', version: current.version, collections: materializeState(current) }
	const collections: CollectionDiffs<Schema> = {}
	for (const name of snapshotNames(current.collections)) {
		const merged = new Map<string, VersionToken | null>()
		for (let index = startIndex; index < history.length; index++) {
			const entry = history[index]
			if (entry === undefined) continue
			const touched = entry.touched[name]
			if (touched === undefined) continue
			for (const [id, beforeHash] of touched) {
				if (!merged.has(id)) merged.set(id, beforeHash)
			}
		}
		if (merged.size === 0) continue
		const diff = composeCollection(current.collections[name], merged)
		if (diff.added.length === 0 && diff.changed.length === 0 && diff.removed.length === 0) continue
		collections[name] = diff
	}
	return { kind: 'delta', base: have, next: current.version, collections }
}

export function applyDelta<Schema extends EntitySchemaConstraint<Schema>>(
	definitions: CollectionDefinitions<Schema>,
	hasher: EntityHasher,
	state: ReplicaState<Schema>,
	version: VersionToken | null,
	delta: Delta<Schema>,
	verify: boolean,
): ClientReaction<Schema> {
	if (version === null || version !== delta.base) {
		return { kind: 'needsSnapshot', state, version, reason: 'delta base does not match the client version' }
	}
	const materialized: ReplicaState<Schema> = Object.create(null)
	for (const name of collectionNames(definitions)) {
		const entities = state[name]
		if (!Array.isArray(entities)) throw new Error(`entity-diff: state is missing the "${name}" collection`)
		materialized[name] = applyCollectionDelta(entities, delta.collections[name])
	}
	// Trusting delta.next is what keeps the default apply O(changed): recomputing the whole version would re-hash every entity and make apply O(total), defeating the point of a delta. Callers that cannot trust the transport set verify, which pays the O(total) re-hash in exchange for detecting a corrupted or forged delta. verify detects corruption, not a malicious server: a self-consistent forgery (tampered entities paired with a next that hashes to the forged result) passes verification, because verification only checks that the contents match the claimed version, not that the server was honest.
	if (!verify) return { kind: 'applied', state: materialized, version: delta.next }
	const computed = snapshotState(definitions, hasher, materialized)
	if (computed.version !== delta.next) {
		return { kind: 'needsSnapshot', state, version, reason: 'delta verification failed' }
	}
	return { kind: 'applied', state: materialized, version: delta.next }
}

export function applySnapshot<Schema extends EntitySchemaConstraint<Schema>>(
	definitions: CollectionDefinitions<Schema>,
	hasher: EntityHasher,
	state: ReplicaState<Schema>,
	version: VersionToken | null,
	snapshot: Snapshot<Schema>,
): ClientReaction<Schema> {
	const materialized: ReplicaState<Schema> = Object.create(null)
	for (const name of collectionNames(definitions)) {
		const entities = snapshot.collections[name]
		if (!Array.isArray(entities)) throw new Error(`entity-diff: snapshot is missing the "${name}" collection`)
		materialized[name] = copyEntities(entities)
	}
	const computed = snapshotState(definitions, hasher, materialized)
	if (computed.version !== snapshot.version) {
		return { kind: 'invalid', state, version, reason: 'snapshot version does not match its contents' }
	}
	return { kind: 'snapshot', state: materialized, version: snapshot.version }
}

export function reduceServerResponse<Schema extends EntitySchemaConstraint<Schema>>(
	definitions: CollectionDefinitions<Schema>,
	hasher: EntityHasher,
	state: ReplicaState<Schema>,
	version: VersionToken | null,
	raw: unknown,
	verifyDeltas: boolean,
): ClientReaction<Schema> {
	if (!isServerResponse(definitions, raw)) return { kind: 'invalid', state, version, reason: 'server response failed validation' }
	if (raw.kind === 'unchanged') {
		if (version !== null && raw.version === version) return { kind: 'unchanged', state, version }
		return { kind: 'needsSnapshot', state, version, reason: 'server reported unchanged at an unknown version' }
	}
	if (raw.kind === 'delta') return applyDelta(definitions, hasher, state, version, raw, verifyDeltas)
	return applySnapshot(definitions, hasher, state, version, raw)
}
