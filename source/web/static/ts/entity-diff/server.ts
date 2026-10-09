import * as stateAlgebra from './state.js'
import type { CollectionDefinitions, EntitySchemaConstraint, ReplicaState, ServerResponse, Snapshot, VersionToken } from './types.js'
import type { HistoryEntry, StateSnapshot } from './state.js'

export interface ServerReplicaOptions {
	historyLimit: number
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
	const hasher = stateAlgebra.createEntityHasher()
	const history: HistoryEntry<Schema>[] = []
	let current: StateSnapshot<Schema> = stateAlgebra.snapshotState(definitions, hasher, stateAlgebra.emptyState(definitions))
	return {
		update(state) {
			const next = stateAlgebra.snapshotState(definitions, hasher, state)
			if (next.version === current.version) return current.version
			const { touched } = stateAlgebra.diffSnapshots(definitions, current, next)
			history.push({ base: current.version, next: next.version, touched })
			while (history.length > options.historyLimit) history.shift()
			current = next
			return current.version
		},
		respond(have) {
			return stateAlgebra.respond(current, history, have)
		},
		snapshot() {
			return { kind: 'snapshot', version: current.version, collections: stateAlgebra.materializeState(current) }
		},
		version() {
			return current.version
		},
	}
}
