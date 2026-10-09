import { canonicalSerialize } from './canonical.js'
import { isServerResponse } from './protocol.js'
import { sha256Hex } from './sha256.js'
import { collectionNames } from './types.js'
import type {
	CollectionDefinition,
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
	version: string
}

export type SnapshotCollections<Schema extends EntitySchemaConstraint<Schema>> = { [K in keyof Schema]: Map<string, EntityRecord<Schema[K]>> }

export type TouchedCollections<Schema extends EntitySchemaConstraint<Schema>> = { [K in keyof Schema]?: Map<string, string | null> }

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

// The per-entity version is the caller's cheap `versionOf` when supplied; otherwise it is the full content hash. `buildCollections` is the only place this choice is made, so a collection with `versionOf` never reaches the hasher.
function entityVersion<Entity extends EntityBase>(definition: CollectionDefinition<Entity>, hasher: EntityHasher, entity: Entity): string {
	if (definition.versionOf !== undefined) return definition.versionOf(entity)
	return hasher.hash(entity)
}

// An empty state is the server's and client's starting point; every declared collection must be present because buildCollections treats a missing one as a programming error.
export function emptyState<Schema extends EntitySchemaConstraint<Schema>>(definitions: CollectionDefinitions<Schema>): ReplicaState<Schema> {
	const state: ReplicaState<Schema> = Object.create(null)
	for (const name of collectionNames(definitions)) {
		state[name] = []
	}
	return state
}

// Building the collection maps is O(total) cheap comparisons when every collection supplies `versionOf`; it is O(total * content) only when a collection falls back to hashing. It never computes the aggregate content hash, which is what keeps `update` cheap.
export function buildCollections<Schema extends EntitySchemaConstraint<Schema>>(
	definitions: CollectionDefinitions<Schema>,
	hasher: EntityHasher,
	state: ReadonlyReplicaState<Schema>,
): SnapshotCollections<Schema> {
	const collections: SnapshotCollections<Schema> = Object.create(null)
	for (const name of collectionNames(definitions)) {
		const entities = state[name]
		if (!Array.isArray(entities)) throw new Error(`entity-diff: state is missing the "${name}" collection`)
		const records = new Map<string, EntityRecord<Schema[typeof name]>>()
		for (const entity of entities) {
			if (typeof entity.id !== 'string') throw new Error('entity-diff: an entity is missing a string id')
			if (records.has(entity.id)) throw new Error(`entity-diff: duplicate entity id "${entity.id}"`)
			records.set(entity.id, { entity, version: entityVersion(definitions[name], hasher, entity) })
		}
		collections[name] = records
	}
	return collections
}

function entitiesOf<Entity extends EntityBase>(records: Map<string, EntityRecord<Entity>>): Entity[] {
	const entities: Entity[] = []
	for (const record of records.values()) entities.push(record.entity)
	return entities
}

export function materializeState<Schema extends EntitySchemaConstraint<Schema>>(collections: SnapshotCollections<Schema>): ReplicaState<Schema> {
	const state: ReplicaState<Schema> = Object.create(null)
	for (const name of snapshotNames(collections)) {
		state[name] = entitiesOf(collections[name])
	}
	return state
}

// The aggregate content hash is O(total) and exists only so a snapshot's contents can be verified against the hash the server reported; deltas never pay it. It hashes the per-entity versions the collections already carry (sorted by id per collection, then combined across collections sorted by name), so it does not re-serialize entity bodies. Because it hashes versions rather than bodies, snapshot verification strength is bounded by `versionOf`: the content-hash fallback verifies full content, but a lossy `versionOf` (two different bodies with the same version string) weakens it to verifying only those version strings.
export function contentVersion<Schema extends EntitySchemaConstraint<Schema>>(
	definitions: CollectionDefinitions<Schema>,
	collections: SnapshotCollections<Schema>,
): VersionToken {
	const versions: [string, VersionToken][] = []
	for (const name of collectionNames(definitions)) {
		const records = collections[name]
		const pairs: [string, string][] = []
		for (const [id, record] of records) pairs.push([id, record.version])
		pairs.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
		versions.push([name, sha256Hex(canonicalSerialize(pairs))])
	}
	versions.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
	return sha256Hex(canonicalSerialize(versions))
}

interface CollectionDelta<Entity extends EntityBase> {
	added: Entity[]
	changed: Entity[]
	removed: string[]
	touched: Map<string, string | null>
}

function diffCollection<Entity extends EntityBase>(
	previousRecords: Map<string, EntityRecord<Entity>>,
	nextRecords: Map<string, EntityRecord<Entity>>,
): CollectionDelta<Entity> {
	const added: Entity[] = []
	const changed: Entity[] = []
	const removed: string[] = []
	const touched = new Map<string, string | null>()
	for (const [id, record] of nextRecords) {
		const before = previousRecords.get(id)
		if (before === undefined) {
			added.push(record.entity)
			touched.set(id, null)
			continue
		}
		if (before.version !== record.version) {
			changed.push(record.entity)
			touched.set(id, before.version)
		}
	}
	for (const [id, record] of previousRecords) {
		if (nextRecords.has(id)) continue
		removed.push(id)
		touched.set(id, record.version)
	}
	return { added, changed, removed, touched }
}

export function diffCollections<Schema extends EntitySchemaConstraint<Schema>>(
	definitions: CollectionDefinitions<Schema>,
	previous: SnapshotCollections<Schema>,
	next: SnapshotCollections<Schema>,
): { touched: TouchedCollections<Schema>; collections: CollectionDiffs<Schema> } {
	const touched: TouchedCollections<Schema> = {}
	const collections: CollectionDiffs<Schema> = {}
	for (const name of collectionNames(definitions)) {
		const diff = diffCollection(previous[name], next[name])
		if (diff.added.length === 0 && diff.changed.length === 0 && diff.removed.length === 0) continue
		collections[name] = { added: diff.added, changed: diff.changed, removed: diff.removed }
		touched[name] = diff.touched
	}
	return { touched, collections }
}

function composeCollection<Entity extends EntityBase>(
	currentRecords: Map<string, EntityRecord<Entity>>,
	touched: Map<string, string | null>,
): CollectionDiff<Entity> {
	const added: Entity[] = []
	const changed: Entity[] = []
	const removed: string[] = []
	for (const [id, beforeVersion] of touched) {
		const record = currentRecords.get(id)
		if (record === undefined) {
			if (beforeVersion !== null) removed.push(id)
			continue
		}
		if (beforeVersion === null) {
			added.push(record.entity)
			continue
		}
		if (beforeVersion !== record.version) changed.push(record.entity)
	}
	return { added, changed, removed }
}

function snapshotResponse<Schema extends EntitySchemaConstraint<Schema>>(
	current: SnapshotCollections<Schema>,
	revision: VersionToken,
	contentHash: () => VersionToken,
): Snapshot<Schema> {
	return { kind: 'snapshot', version: revision, contentHash: contentHash(), collections: materializeState(current) }
}

// The delta is computed from the tip of the chain: the first history entry that touched an id (from the requested base forward) supplies the id's before-version, and that before-version is compared against the current state to drop ids whose net effect cancels out. `contentHash` is a thunk so the O(total) aggregate hash is paid only on the snapshot paths, and the server can cache it per revision.
export function respond<Schema extends EntitySchemaConstraint<Schema>>(
	definitions: CollectionDefinitions<Schema>,
	current: SnapshotCollections<Schema>,
	revision: VersionToken,
	history: readonly HistoryEntry<Schema>[],
	have: VersionToken | null,
	contentHash: () => VersionToken,
): ServerResponse<Schema> {
	if (have !== null && have === revision) return { kind: 'unchanged', version: revision }
	if (have === null) return snapshotResponse(current, revision, contentHash)
	let startIndex = -1
	for (let index = history.length - 1; index >= 0; index--) {
		const entry = history[index]
		if (entry === undefined) continue
		if (entry.base === have) {
			startIndex = index
			break
		}
	}
	if (startIndex === -1) return snapshotResponse(current, revision, contentHash)
	const collections: CollectionDiffs<Schema> = {}
	for (const name of collectionNames(definitions)) {
		const merged = new Map<string, string | null>()
		for (let index = startIndex; index < history.length; index++) {
			const entry = history[index]
			if (entry === undefined) continue
			const touched = entry.touched[name]
			if (touched === undefined) continue
			for (const [id, beforeVersion] of touched) {
				if (!merged.has(id)) merged.set(id, beforeVersion)
			}
		}
		if (merged.size === 0) continue
		const diff = composeCollection(current[name], merged)
		if (diff.added.length === 0 && diff.changed.length === 0 && diff.removed.length === 0) continue
		collections[name] = diff
	}
	return { kind: 'delta', base: have, next: revision, collections }
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

// The base precondition is the delta's only integrity check: trusting `delta.next` keeps apply O(changed), and there is deliberately no content re-hash here. The base is a revision token, not a content check, so a forged or corrupt delta whose base matches the client can set `next` to the server's true current revision while carrying wrong content; the server then answers `unchanged` and the client stays silently stale until a snapshot is otherwise forced or those entities change again. That is the accepted tradeoff of trusting the base precondition.
export function applyDelta<Schema extends EntitySchemaConstraint<Schema>>(
	definitions: CollectionDefinitions<Schema>,
	state: ReplicaState<Schema>,
	version: VersionToken | null,
	delta: Delta<Schema>,
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
	const computed = contentVersion(definitions, buildCollections(definitions, hasher, materialized))
	if (computed !== snapshot.contentHash) {
		return { kind: 'invalid', state, version, reason: 'snapshot content hash does not match its contents' }
	}
	return { kind: 'snapshot', state: materialized, version: snapshot.version }
}

export function reduceServerResponse<Schema extends EntitySchemaConstraint<Schema>>(
	definitions: CollectionDefinitions<Schema>,
	hasher: EntityHasher,
	state: ReplicaState<Schema>,
	version: VersionToken | null,
	raw: unknown,
): ClientReaction<Schema> {
	if (!isServerResponse(definitions, raw)) return { kind: 'invalid', state, version, reason: 'server response failed validation' }
	if (raw.kind === 'unchanged') {
		if (version !== null && raw.version === version) return { kind: 'unchanged', state, version }
		return { kind: 'needsSnapshot', state, version, reason: 'server reported unchanged at an unknown version' }
	}
	if (raw.kind === 'delta') return applyDelta(definitions, state, version, raw)
	return applySnapshot(definitions, hasher, state, version, raw)
}
