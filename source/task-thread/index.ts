// Task-thread module contract.
//
// Server composition uses createTaskThreadReader for the GET response; a read may lazily rebuild and atomically rewrite the derived thread.jsonl when it is missing, torn, or stale.
// The journal store and its file factories cross the boundary so the composition root can wire the live append, ensure, and finalize paths.
// createTaskThreadSummarizer peeks at or triggers summary generation.
// The core reader exists so the summarizer can derive the same thread without depending on the summary layer.
// All derivation, parsing, model, and summary helpers stay private to this module.
// Only the readers, summarizer, journal store/file factories, and the response and page-request types the web layer names cross the boundary.
//
// Reads may materialize the derived journal; summary generation starts only from the summarizer request path, which the HTTP POST route owns.
//
// Every ask_human that reached the human is included as a human-facing question even when a child or recovery role emitted it, because the human answered it.
// Every other child/handler conversation remains excluded.
export { createTaskThreadCoreReader, createTaskThreadReader } from './reader.js'
export type { TaskThreadReaderResult } from './reader.js'
export { createThreadJournalStore } from './journal-store.js'
export type { ThreadJournalRead, ThreadJournalStore, ThreadJournalStoreDependencies } from './journal-store.js'
export { createAppendThreadJournal, createAppendThreadJournalCursor, createReadRunLogStat, createReadThreadJournalText, createWriteThreadJournalText } from './journal-files.js'
export type { AppendThreadJournal, AppendThreadJournalCursor, ReadRunLogStat, ReadThreadJournalText, WriteThreadJournalText } from './journal-files.js'
export { createTaskThreadSummarizer } from './summarizer.js'
export type { TaskThreadSummarySnapshot } from './summarizer.js'
export type { TaskThreadPagination, TaskThreadResponse } from './model.js'
export type { TaskThreadPageRequest } from './pagination.js'
