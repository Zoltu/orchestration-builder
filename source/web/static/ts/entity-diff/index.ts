// entity-diff ships and applies entity-level diffs of keyed state. It is browser-pure and generic over a schema whose entity types extend `{ id: string }`.
//
// COLLECTIONS ARE UNORDERED. The aggregate content hash is over per-entity versions sorted by id, so it is independent of array order, and `applyDelta` rebuilds each collection through a Map, which may materialize a different order than the server held. This is an integration requirement, not a module guarantee: an app that needs a stable display order MUST sort by its own domain key (id, timestamp, name) after every apply.
//
// IMMUTABILITY IS REQUIRED. Entities and the state/arrays returned by the client are handed back by reference and must be treated as immutable: replace objects and arrays, never mutate them in place. The entity-hash cache keys on object identity, so an in-place mutation leaves a stale hash and a stale version that the module cannot detect.
//
// THE WIRE VERSION IS A REVISION, NOT A HASH. The server stamps each change with an opaque `"${epoch}:${counter}"` token owned by its process; the epoch keeps a restarted server's revisions from colliding with a client's pre-restart revision. `update` compares per-entity versions supplied by `defineCollection`'s optional `versionOf`, so it never hashes entity bodies. Deltas are trusted on their base precondition alone (O(changed)); only snapshots carry a `contentHash` and are content-verified, because a snapshot replaces the whole state.
export { defineCollection } from './types.js'
export type {
	VersionToken,
	EntityBase,
	CollectionDefinition,
	EntitySchema,
	EntitySchemaConstraint,
	ReplicaState,
	ReadonlyReplicaState,
	CollectionDefinitions,
	CollectionDiff,
	CollectionDiffs,
	Unchanged,
	Delta,
	Snapshot,
	ServerResponse,
	SyncRequest,
} from './types.js'

export { canonicalSerialize, isPlainObject } from './canonical.js'

export { sha256Hex } from './sha256.js'

export {
	hashEntity,
	createEntityHasher,
	buildCollections,
	contentVersion,
	diffCollections,
	respond,
	applyDelta,
	applySnapshot,
	reduceServerResponse,
} from './state.js'
export type {
	EntityHasher,
	EntityRecord,
	SnapshotCollections,
	TouchedCollections,
	HistoryEntry,
	ClientReaction,
} from './state.js'

export { isServerResponse } from './protocol.js'

export { createServerReplica } from './server.js'
export type { ServerReplicaOptions, ServerReplica } from './server.js'

export { createClientReplica, createFetchResponse } from './client.js'
export type { ClientReplicaDependencies, ClientState, ClientReplica } from './client.js'
