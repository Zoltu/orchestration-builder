// flow-feed ships and applies entity-diff frames of the flow model, hiding the collections, validators, per-entity version rules, run-status singleton, hasher lifetime, and server replica LRU behind one small contract.
//
// STATE IS OPAQUE; ITS CONTENTS ARE IMMUTABLE. `FlowFeedState` is created only by `emptyFlowFeedState` and replaced with the state each `applyFlowFrame` returns. Callers treat every returned state and its contents (the model and its arrays) as immutable: replace objects, never mutate them in place.
//
// AN UNCHANGED FRAME RETURNS THE SAME REFERENCES. `applyFlowFrame` returns the held state and model by reference for an `unchanged` outcome, so identity-keyed view memoization survives a steady poll. Applied and snapshot frames return a fresh state and model.
//
// NEEDS-SNAPSHOT IS A TYPED OUTCOME. `needsSnapshot` is never thrown: the held state stays in place and the host re-fetches without a revision. `invalid` likewise leaves the held state untouched.
//
// THE RESPONDER OWNS SERVER STATE. `createFlowFeedResponder` owns the per-run replica LRU and its per-instance epoch policy; its signature takes a run id, the domain model, and an opaque revision string, never a replica state, collection definition, or wire response type.
//
// THE MODULE IS RUNTIME-PURE. It uses web-standard globals only — no Bun, Node built-ins, DOM, or Buffer — so the same source runs in Bun and the browser. Its inputs are treated as immutable by the module and its callers; entity-diff treats collections as unordered, so callers that need a display order impose their own domain sort.
export { applyFlowFrame, emptyFlowFeedState, flowFeedRevision } from './feed.js'
export type { FlowFeedState, FlowFrameResult } from './feed.js'

export { createFlowFeedResponder } from './responder.js'
export type { FlowFeedResponder, FlowFeedResponderOptions } from './responder.js'
