// Log-window contract: fold conversation deltas and select, paginate, or per-instance filter log events for the window endpoint.
//
// Inputs are never mutated: the fold returns a fresh event with a new payload and message array, and every selector returns events by reference in log order.
// Pagination reports the requested offset and limit with the full total; an offset past the end yields an empty page, and an empty log yields an empty page. Per-instance filtering keeps each event's log-wide index and preserves the log's relative order; an empty instance id yields an empty list.
// foldLlmCallSent throws only when the index is outside the event list. An event that is not a delta-carrying llm_call returns unchanged, and filtering an id that names nothing yields an empty list rather than an error.
export { foldLlmCallSent, filterLogEventsForInstance, paginateLogEvents } from './log-window.js'
export type { IndexedLogEvent, PaginatedLog } from './log-window.js'
