// The service-wide "state feeding the favicon changed" pulse, mirroring the DeltaChannel pattern (source/executor/stream-channel.ts) without the run binding or payload: subscribers only need to know that a fresh fetch is worthwhile, so no run id, task, question, result, provider detail, or credential rides the signal. Publishing is synchronous and best-effort — a subscriber is externally registered code, and one that throws must neither break publication nor starve the remaining subscribers.

export type StateInvalidationSubscriber = () => void

export interface StateInvalidationChannel {
	publish(): void
	subscribe(subscriber: StateInvalidationSubscriber): () => void
}

export function createStateInvalidationChannel(): StateInvalidationChannel {
	const subscribers = new Set<StateInvalidationSubscriber>()
	return {
		publish() {
			for (const subscriber of subscribers) {
				// The failure is dropped: publish never throws.
				try {
					subscriber()
				} catch {
					// A throwing subscriber must not prevent delivery to the others.
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
