import { createServerReplica } from '../entity-diff/index.js'
import { runListDefinitions, runListReplicaStateFromSummaries } from './replica.js'
import type { HealthView, RunSummary } from './replica.js'

interface RunListFeedResponderOptions {
	epoch: string
	historyLimit: number
}

// The health singleton rides the same run-list frame, so the banner costs no additional poll. The revision is still the only revalidation token.
export type RunListFeedResponder = (summaries: readonly RunSummary[], health: HealthView, have: string | null) => unknown

// The single process-local server replica behind the run-list feed. Unlike the per-run flow replicas the run list is one global collection, so one replica serves every request; its bounded history lets a client that fell behind a few polls receive a delta rather than a full snapshot, and its epoch (unique per process) forces a pre-restart `have` to resync by snapshot.
export function createRunListFeedResponder(options: RunListFeedResponderOptions): RunListFeedResponder {
	const replica = createServerReplica(runListDefinitions, { epoch: options.epoch, historyLimit: options.historyLimit })
	return (summaries, health, have) => {
		replica.update(runListReplicaStateFromSummaries(summaries, health))
		return replica.respond(have)
	}
}
