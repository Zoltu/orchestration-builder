import * as stateAlgebra from './state.js'
import type { CollectionDefinitions, EntitySchemaConstraint, ReplicaState, ServerResponse, Snapshot, VersionToken } from './types.js'
import type { HistoryEntry, SnapshotCollections } from './state.js'

export interface ServerReplicaOptions {
	historyLimit: number
	epoch: string
}

export interface ServerReplica<Schema extends EntitySchemaConstraint<Schema>> {
	update(state: ReplicaState<Schema>): VersionToken
	respond(have: VersionToken | null): ServerResponse<Schema>
	snapshot(): Snapshot<Schema>
	version(): VersionToken
}

export function createServerReplica<Schema extends EntitySchemaConstraint<Schema>>(
	definitions: CollectionDefinitions<Schema>,
	options: ServerReplicaOptions,
): ServerReplica<Schema> {
	// A NaN or negative limit would make `history.length > limit` always false and silently keep unbounded history, so reject anything that is not a non-negative integer. `historyLimit: 0` is valid and means no delta is ever retained, so every non-unchanged request is answered with a snapshot.
	if (!Number.isInteger(options.historyLimit) || options.historyLimit < 0) throw new Error(`entity-diff: historyLimit must be a non-negative integer, received ${String(options.historyLimit)}`)
	// The epoch is folded into every revision so a restarted server, whose counter restarts at zero, cannot hand a client a delta whose base collides with the client's pre-restart revision.
	if (options.epoch === '') throw new Error('entity-diff: epoch must be a non-empty string')
	const hasher = stateAlgebra.createEntityHasher()
	const history: HistoryEntry<Schema>[] = []
	let current: SnapshotCollections<Schema> = stateAlgebra.buildCollections(definitions, hasher, stateAlgebra.emptyState(definitions))
	let counter = 0
	let revision = `${options.epoch}:${counter}`
	let cachedContent: { revision: VersionToken; contentHash: VersionToken } | null = null

	// The aggregate content hash is only ever needed to build a snapshot, so it is computed on first request for a revision and reused for every later snapshot request at that revision.
	function currentContentHash(): VersionToken {
		if (cachedContent !== null && cachedContent.revision === revision) return cachedContent.contentHash
		const contentHash = stateAlgebra.contentVersion(definitions, current)
		cachedContent = { revision, contentHash }
		return contentHash
	}

	return {
		update(state) {
			const next = stateAlgebra.buildCollections(definitions, hasher, state)
			const { touched } = stateAlgebra.diffCollections(definitions, current, next)
			if (Object.keys(touched).length === 0) return revision
			const base = revision
			counter += 1
			revision = `${options.epoch}:${counter}`
			history.push({ base, next: revision, touched })
			while (history.length > options.historyLimit) history.shift()
			current = next
			return revision
		},
		respond(have) {
			return stateAlgebra.respond(definitions, current, revision, history, have, currentContentHash)
		},
		snapshot() {
			return { kind: 'snapshot', version: revision, contentHash: currentContentHash(), collections: stateAlgebra.materializeState(current) }
		},
		version() {
			return revision
		},
	}
}
