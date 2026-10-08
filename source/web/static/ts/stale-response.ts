// Whether a fetched per-run response belongs to the run the client currently has selected — the staleness guard the run-view and flow-model ingress actions apply before touching state.
// A response identifies itself either through its body's runId (the run view) or through the run id curried into its action at fetch time (the flow model, whose payload carries no id).
// An unidentified response (a null runId — the run-view frame from the instant after submit, before the run's meta is readable) counts as not belonging: it cannot prove it is not a late frame for a previously selected run, and the poll simply tries again.
export function responseBelongsToSelection(responseRunId: string | null, selectedRunId: string | null): boolean {
	return responseRunId !== null && responseRunId === selectedRunId
}
