// entity-diff ships and applies entity-level diffs of keyed state. It is browser-pure and generic over a schema whose entity types extend `{ id: string }`.
//
// COLLECTIONS ARE UNORDERED. A version is a content hash over id/hash pairs sorted by id, so it is independent of array order, and `applyDelta` rebuilds each collection through a Map, which may materialize a different order than the server held. This is an integration requirement, not a module guarantee: an app that needs a stable display order MUST sort by its own domain key (id, timestamp, name) after every apply.
//
// IMMUTABILITY IS REQUIRED. Entities and the state/arrays returned by the client are handed back by reference and must be treated as immutable: replace objects and arrays, never mutate them in place. The entity-hash cache keys on object identity, so an in-place mutation leaves a stale hash and a stale version that the module cannot detect.
//
// `verifyDeltas` (default off) recomputes each delta's version at O(total) cost and detects a corrupted transport; it is not a defense against a malicious server, because a self-consistent forgery passes.
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
	snapshotState,
	diffSnapshots,
	respond,
	applyDelta,
	applySnapshot,
	reduceServerResponse,
} from './state.js'
export type {
	EntityHasher,
	EntityRecord,
	SnapshotCollections,
	StateSnapshot,
	TouchedCollections,
	HistoryEntry,
	ClientReaction,
} from './state.js'

export { isServerResponse } from './protocol.js'

export { createServerReplica } from './server.js'
export type { ServerReplicaOptions, ServerReplica } from './server.js'

export { createClientReplica, createFetchResponse } from './client.js'
export type { ClientReplicaDependencies, ClientReplicaOptions, ClientState, ClientReplica } from './client.js'
