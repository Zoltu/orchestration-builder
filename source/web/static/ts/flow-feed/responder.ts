import { createServerReplica } from '../entity-diff/index.js'
import type { ServerReplica } from '../entity-diff/index.js'
import type { InteractionModel } from '../interaction-model.js'
import { flowDefinitions, flowReplicaStateFromModel } from './replica.js'
import type { FlowCollections } from './replica.js'

export interface FlowFeedResponderOptions {
	epoch: string
	historyLimit: number
	maxRuns: number
}

export type FlowFeedResponder = (runId: string, model: InteractionModel, have: string | null) => unknown

// A bounded, process-local store of the per-run server replicas behind the flow feed. Each run gets its own replica so its delta history is isolated; the least-recently-used run is evicted past maxRuns, and an evicted run rebuilt on its next request starts from a fresh revision.
export function createFlowFeedResponder(options: FlowFeedResponderOptions): FlowFeedResponder {
	if (!Number.isInteger(options.maxRuns) || options.maxRuns < 1) throw new Error(`flow-feed: maxRuns must be a positive integer, received ${String(options.maxRuns)}`)
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

	return (runId, model, have) => {
		const replica = getOrCreateReplica(runId)
		replica.update(flowReplicaStateFromModel(model))
		return replica.respond(have)
	}
}
