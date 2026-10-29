// Task-thread module contract.
//
// Server composition uses createTaskThreadReader for the side-effect-free GET response.
// createTaskThreadSummarizer peeks at or triggers summary generation.
// The core reader exists so the summarizer can derive the same thread without depending on the summary layer.
// All derivation, parsing, model, and summary helpers stay private to this module.
// Only the reader, summarizer, and the two response types the web layer names cross the boundary.
//
// The reader is side-effect-free: it uses the summarizer only to peek at artifact/in-flight state.
// Summary generation starts only from the summarizer request path, which the HTTP POST route owns.
//
// Every ask_human that reached the human is included as a human-facing question even when a child or recovery role emitted it, because the human answered it.
// Every other child/handler conversation remains excluded.
export { createTaskThreadCoreReader, createTaskThreadReader } from './reader.js'
export { createTaskThreadSummarizer } from './summarizer.js'
export type { TaskThreadSummarySnapshot } from './summarizer.js'
export type { TaskThreadResponse } from './model.js'
