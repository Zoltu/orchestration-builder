// Run-scoped streaming-delta publishing, mirroring the InterruptChannel pattern (source/executor/interrupts.ts): the channel is the service-level singleton, `bindRun` selects the one active run at a time, and publishes outside a run binding are silent no-ops. The engine's LLM call site publishes each streamed text delta through this channel; subscriber registration (the web stage) fans the deltas out to clients. Publishing is synchronous and best-effort: it is a tap on the streaming hot path, never an authority a run waits on.

export type DeltaField = 'reasoning' | 'content'

// The engine-shaped delta: which role instance produced it, and which turn-text field it extends. `reset` marks the start of a retried attempt whose text re-emits from zero, so a client accumulation must clear before appending.
export interface RoleDelta {
	roleId: string
	role: string
	field: DeltaField
	text: string
	reset?: boolean
}

// A published delta stamped with the bound run's id, so a subscriber can route by run without holding run state of its own.
export interface RunDelta extends RoleDelta {
	runId: string
}

export type DeltaSubscriber = (delta: RunDelta) => void

export interface DeltaChannel {
	bindRun(runId: string | null): void
	publish(delta: RoleDelta): void
	subscribe(subscriber: DeltaSubscriber): () => void
}

export function createDeltaChannel(): DeltaChannel {
	let boundRunId: string | null = null
	const subscribers = new Set<DeltaSubscriber>()
	return {
		bindRun(runId) {
			boundRunId = runId
		},
		publish(delta) {
			if (boundRunId === null) return
			if (subscribers.size === 0) return
			const stamped: RunDelta = { ...delta, runId: boundRunId }
			for (const subscriber of subscribers) {
				// A subscriber is externally registered code invoked mid-stream; one that throws must neither kill the run nor starve the remaining subscribers, so each notification is contained and the failure is dropped — the channel is best-effort by contract.
				try {
					subscriber(stamped)
				} catch {
					// The failure is dropped: publish never throws.
				}
			}
		},
		subscribe(subscriber) {
			subscribers.add(subscriber)
			return () => {
				subscribers.delete(subscriber)
			}
		},
	}
}
