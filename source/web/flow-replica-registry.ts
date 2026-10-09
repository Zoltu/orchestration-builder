import { createServerReplica } from './static/ts/entity-diff/index.js'
import type { ServerReplica, ServerResponse } from './static/ts/entity-diff/index.js'
import { flowDefinitions } from './static/ts/flow-collections.js'
import type { FlowCollections, FlowReplicaState } from './static/ts/flow-collections.js'

export interface FlowReplicaRegistryOptions {
	epoch: string
	historyLimit: number
	maxRuns: number
}

export type FlowEnvelopeFor = (runId: string, state: FlowReplicaState, have: string | null) => ServerResponse<FlowCollections>

export interface FlowReplicaRegistry {
	envelopeFor: FlowEnvelopeFor
}

// A bounded, process-local store of the per-run server replicas behind the flow endpoint's entity-diff envelope. Each run gets its own replica so its delta history is isolated; the least-recently-used run is evicted past maxRuns, and an evicted run rebuilt on its next request starts from a fresh revision.
export function createFlowReplicaRegistry(options: FlowReplicaRegistryOptions): FlowReplicaRegistry {
	if (!Number.isInteger(options.maxRuns) || options.maxRuns < 1) throw new Error(`flow-replica-registry: maxRuns must be a positive integer, received ${String(options.maxRuns)}`)
	const replicas = new Map<string, ServerReplica<FlowCollections>>()
	let instanceSequence = 0

	function createReplica(): ServerReplica<FlowCollections> {
		instanceSequence += 1
		// Each replica instance gets its own epoch. The revision counter restarts at zero when an evicted run is rebuilt, so a shared epoch would let a stale `have` from the evicted instance equal the rebuilt instance's first revision and read as `unchanged`, silently serving the client the state it held before eviction. Folding a monotonic instance sequence into the epoch makes every revision any replica instance ever issues unique within the process, so a stale `have` can only fall back to a snapshot.
		return createServerReplica(flowDefinitions, { epoch: `${options.epoch}:${instanceSequence}`, historyLimit: options.historyLimit })
	}

	function getOrCreateReplica(runId: string): ServerReplica<FlowCollections> {
		const existing = replicas.get(runId)
		if (existing !== undefined) {
			// Map iteration order is insertion order, so deleting and re-inserting marks this run most-recently-used and leaves the first key the least-recently-used.
			replicas.delete(runId)
			replicas.set(runId, existing)
			return existing
		}
		const replica = createReplica()
		replicas.set(runId, replica)
		while (replicas.size > options.maxRuns) {
			const leastRecentlyUsed = replicas.keys().next()
			if (leastRecentlyUsed.done === true) break
			replicas.delete(leastRecentlyUsed.value)
		}
		return replica
	}

	return {
		envelopeFor(runId, state, have) {
			const replica = getOrCreateReplica(runId)
			replica.update(state)
			return replica.respond(have)
		},
	}
}
