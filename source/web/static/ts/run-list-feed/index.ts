// run-list-feed ships and applies entity-diff frames of the run list, hiding the run collection definition, per-entity version rule, hasher lifetime, server replica, and newest-first ordering behind one small contract.
//
// STATE IS OPAQUE; ITS CONTENTS ARE IMMUTABLE. `RunListFeedState` is created only by `emptyRunListFeedState` and replaced with the state each `applyRunListFrame` returns. Callers treat every returned state and its contents (the summaries and their arrays) as immutable: replace objects, never mutate them in place.
//
// AN UNCHANGED FRAME RETURNS THE SAME REFERENCES. `applyRunListFrame` returns the held state and summaries by reference for an `unchanged` outcome, so identity-keyed history memoization survives a steady poll. Applied and snapshot frames return a fresh state and summaries array, ordered newest-first by run id.
//
// NEEDS-SNAPSHOT IS A TYPED OUTCOME. `needsSnapshot` is never thrown: the held state stays in place and the host re-fetches without a revision. `invalid` likewise leaves the held state untouched.
//
// THE RESPONDER OWNS SERVER STATE. `createRunListFeedResponder` owns the single global replica and its epoch policy; its signature takes only the summaries and an opaque revision string, never a replica state, collection definition, or wire response type.
//
// THE MODULE IS RUNTIME-PURE. It uses web-standard globals only — no Bun, Node built-ins, DOM, or Buffer — so the same source runs in Bun and the browser. Its inputs are treated as immutable by the module and its callers; the server replica sorts summaries by run id so input order never matters.
export { applyRunListFrame, emptyRunListFeedState, runListFeedRevision } from './feed.js'
export type { RunListFeedState, RunListFrameResult } from './feed.js'

export { createRunListFeedResponder } from './responder.js'
export type { RunListFeedResponder } from './responder.js'

export type { RunResultCard, RunSummary, RunSummaryError } from './replica.js'
