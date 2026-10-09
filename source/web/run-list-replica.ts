import { createServerReplica } from './static/ts/entity-diff/index.js'
import type { ServerResponse } from './static/ts/entity-diff/index.js'
import { runListDefinitions } from './static/ts/run-list-collections.js'
import type { RunListCollections, RunListReplicaState } from './static/ts/run-list-collections.js'

export interface RunListReplicaOptions {
	epoch: string
	historyLimit: number
}

export type RunListEnvelopeFor = (state: RunListReplicaState, have: string | null) => ServerResponse<RunListCollections>

export interface RunListReplica {
	envelopeFor: RunListEnvelopeFor
}

// The single process-local server replica behind the run-list endpoint's entity-diff envelope. Unlike the per-run flow replicas the run list is one global collection, so one replica serves every request; its bounded history lets a client that fell behind a few polls receive a delta rather than a full snapshot, and its epoch (unique per process) forces a pre-restart `have` to resync by snapshot.
export function createRunListReplica(options: RunListReplicaOptions): RunListReplica {
	const replica = createServerReplica(runListDefinitions, { epoch: options.epoch, historyLimit: options.historyLimit })
	return {
		envelopeFor(state, have) {
			replica.update(state)
			return replica.respond(have)
		},
	}
}
