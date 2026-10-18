import { createServerReplica } from '../entity-diff/index.js'
import { runListDefinitions, runListReplicaStateFromSummaries } from './replica.js'
import type { RunSummary } from './replica.js'

interface RunListFeedResponderOptions {
	epoch: string
	historyLimit: number
}

export type RunListFeedResponder = (summaries: readonly RunSummary[], have: string | null) => unknown

// The single process-local server replica behind the run-list feed. Unlike the per-run flow replicas the run list is one global collection, so one replica serves every request; its bounded history lets a client that fell behind a few polls receive a delta rather than a full snapshot, and its epoch (unique per process) forces a pre-restart `have` to resync by snapshot.
export function createRunListFeedResponder(options: RunListFeedResponderOptions): RunListFeedResponder {
	const replica = createServerReplica(runListDefinitions, { epoch: options.epoch, historyLimit: options.historyLimit })
	return (summaries, have) => {
		replica.update(runListReplicaStateFromSummaries(summaries))
		return replica.respond(have)
	}
}
