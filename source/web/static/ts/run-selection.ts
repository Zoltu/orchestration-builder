// Decides what selecting the already-selected run should do: re-arm a resumed run, refresh a stale view, or just show the held view.
// The decision reads only the summary, held status, and held view status, so it stays independent of application state and effects.

import { isTerminalStatus } from './interaction-model.js'
import type { RunStatus } from './interaction-model.js'

export type SameRunViewPlan = 'reactivate' | 'refresh' | 'show'

export interface SameRunViewInput {
	summaryStatus: RunStatus
	currentStatus: RunStatus | null
	heldViewStatus: RunStatus | null
}

export function planSameRunView(input: SameRunViewInput): SameRunViewPlan {
	if (!isTerminalStatus(input.summaryStatus)) return 'reactivate'
	if (input.currentStatus === null || input.currentStatus !== input.summaryStatus) return 'refresh'
	if (input.heldViewStatus === null || input.heldViewStatus !== input.summaryStatus) return 'refresh'
	return 'show'
}
