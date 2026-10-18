// The turn inspector's browser-only session: it owns the log windows (unscoped tail and per-instance scoped sequences), the fetch decisions that page them, turn pairing, the instance/ancestry derivations, the stitched transcript, and the bounded wire-detail cache. The renderer receives one derived `InspectorView` and builds vnodes; it never sees the raw window payloads or the offset math.
//
// The host performs every fetch: a request method returns the URL and the identity (run, scope, response kind, and session generation) a landing needs, and the caller passes that exact request back with the response. A response for another run or a generation reset by close/reopen is ignored, so a stale poll frame cannot land in a newer session. Live streaming is host state; a window landing returns the partial as the pairing leaves it.
//
// The view is a read-only snapshot: `view()`, `wireDetail()`, and the arrays they expose may share references with the session's cache, so callers must never mutate them. `wireDetailCacheLimit` bounds that cache and defaults to 100 entries.
export { createInspectorSession } from './session.js'
export { livePartialMatchesRole } from '../live-partial.js'
export type {
	FetchRequest,
	InspectorSession,
	InspectorSessionOptions,
	InspectorView,
	LogResponseKind,
	ReceiveResult,
	ScopeResult,
	WireFetchRequest,
} from './session.js'

export type { ChainCrumb, InstanceRecord } from './instances.js'
export type { TranscriptMessage, TranscriptOutcome, TranscriptResponse, TranscriptToolCall, TranscriptTurn } from './transcript.js'
export type { TurnUsage } from './turns.js'
export type { WireDetailSection, WireDetailState } from './wire-details.js'
