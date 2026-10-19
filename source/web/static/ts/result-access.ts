// Pure decisions for the result modal and the run-view recovery path: which payload to render, whether opening or retrying starts a fetch, and whether a 304 must refetch unconditionally.

import { isTerminalStatus } from './interaction-model.js'
import { deriveTerminalResult } from './result-modal.js'
import { responseBelongsToSelection } from './stale-response.js'

export type ResultSource<View, Summary> =
	| { kind: 'view'; value: View }
	| { kind: 'summary'; value: Summary }

export interface ResultLoadState {
	runId: string
	phase: 'loading' | 'failed'
}

// The best payload for the selected run. When both sources match, agreeing statuses prefer the richer view while disagreeing statuses prefer the freshly polled summary — a run resumed in place can leave a terminal view beside a running summary, or the reverse. A lone source is returned as-is.
export function selectResultSource<View extends { runId: string | null; status: string }, Summary extends { runId: string; status: string }>(
	runId: string | null,
	view: View | null,
	summaries: Summary[],
): ResultSource<View, Summary> | null {
	if (runId === null || runId === '') return null
	const matchingView = view !== null && view.runId === runId ? view : null
	const matchingSummary = summaries.find((entry) => entry.runId === runId)
	if (matchingView !== null && matchingSummary !== undefined) {
		return matchingView.status === matchingSummary.status
			? { kind: 'view', value: matchingView }
			: { kind: 'summary', value: matchingSummary }
	}
	if (matchingView !== null) return { kind: 'view', value: matchingView }
	if (matchingSummary !== undefined) return { kind: 'summary', value: matchingSummary }
	return null
}

// Continue is offered for a finished outcome only; a needs_clarification run is paused and awaits an answer rather than being continued as a new task.
export function resultOffersContinue(status: string): boolean {
	return isTerminalStatus(status) && status !== 'needs_clarification'
}

// The run-view response may be stored only when both the request's curried run id and the body's own run id identify the currently selected run.
export function acceptedResultView(requestedRunId: string, selectedRunId: string | null, bodyRunId: string | null): boolean {
	return responseBelongsToSelection(requestedRunId, selectedRunId) && responseBelongsToSelection(bodyRunId, selectedRunId)
}

export type ResultOpenPlan =
	| { kind: 'immediate'; resultLoad: ResultLoadState | null; backgroundFetch: boolean }
	| { kind: 'fetch'; resultLoad: ResultLoadState }
	| { kind: 'keep-loading'; resultLoad: ResultLoadState }

// What opening the result modal should do: render a terminal descriptor at once, keep an already-running load (repeated CTA clicks dedupe), or start one unconditional fetch with a loading state. An immediate error summary also starts a background fetch for its richer view, because only the run view carries the resumable flag; that fetch never blocks the summary card.
export function planResultOpen<View extends { runId: string | null; status: string }, Summary extends { runId: string; status: string }>(
	runId: string | null,
	view: View | null,
	summaries: Summary[],
	resultLoad: ResultLoadState | null,
): ResultOpenPlan | null {
	if (runId === null || runId === '') return null
	const source = selectResultSource(runId, view, summaries)
	if (source !== null && deriveTerminalResult(source.value) !== undefined) {
		const needsBackgroundFetch = source.kind === 'summary' && source.value.status === 'error'
		if (!needsBackgroundFetch) return { kind: 'immediate', resultLoad: null, backgroundFetch: false }
		if (resultLoad !== null && resultLoad.runId === runId && resultLoad.phase === 'loading') return { kind: 'immediate', resultLoad, backgroundFetch: false }
		return { kind: 'immediate', resultLoad: { runId, phase: 'loading' }, backgroundFetch: true }
	}
	if (resultLoad !== null && resultLoad.runId === runId && resultLoad.phase === 'loading') return { kind: 'keep-loading', resultLoad }
	return { kind: 'fetch', resultLoad: { runId, phase: 'loading' } }
}

export type ResultRetryPlan =
	| { kind: 'fetch'; resultLoad: ResultLoadState }
	| { kind: 'noop' }

// What Retry should do: a failed (or absent) load starts one fetch, while the same run already loading is a no-op so repeated clicks collapse into one request.
export function planResultRetry(runId: string | null, resultLoad: ResultLoadState | null): ResultRetryPlan {
	if (runId === null || runId === '') return { kind: 'noop' }
	if (resultLoad !== null && resultLoad.runId === runId && resultLoad.phase === 'loading') return { kind: 'noop' }
	return { kind: 'fetch', resultLoad: { runId, phase: 'loading' } }
}

// A held view is stale for the selection when there is no view yet or it belongs to another run; a 304 for such a view must trigger an unconditional refetch.
function needsRunViewRefetch(selectedRunId: string | null, viewRunId: string | null | undefined): boolean {
	if (selectedRunId === null || selectedRunId === '') return false
	return typeof viewRunId !== 'string' || viewRunId !== selectedRunId
}

// Drops a stored validator so the next request is unconditional; used whenever the held payload behind that URL is cleared, because a replayable ETag would otherwise revalidate to a 304 with no body.
export function withoutVersion(versions: Record<string, string>, url: string): Record<string, string> {
	if (!(url in versions)) return versions
	const remaining: Record<string, string> = {}
	for (const [key, value] of Object.entries(versions)) {
		if (key !== url) remaining[key] = value
	}
	return remaining
}

export interface RunViewRecoveryPlan {
	url: string
	versions: Record<string, string>
}

// The 304-recovery plan: when the validator outlived a cleared or mismatched view, drop that URL's ETag and request it unconditionally; otherwise there is nothing to recover.
export function planRunViewRecovery(
	selectedRunId: string | null,
	heldViewRunId: string | null | undefined,
	url: string,
	versions: Record<string, string>,
): RunViewRecoveryPlan | null {
	if (!needsRunViewRefetch(selectedRunId, heldViewRunId)) return null
	return { url, versions: withoutVersion(versions, url) }
}
