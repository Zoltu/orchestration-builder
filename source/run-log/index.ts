// Parsing contract: convert raw run files into validated values for the rest of the server.
//
// Run meta is null when the text is absent, malformed JSON, or not a valid RunMeta; a present value is the stored object unchanged.
// Log parsing is line-oriented and tolerant: empty lines, torn writes, foreign JSON, and objects without string timestamp and type fields contribute no event and never stop the scan, so a truncated or interleaved tail still yields every complete event before it. Payloads are passed through by reference and are neither validated nor mutated; events keep file order, and nothing else is skipped.
// The inputs are never mutated, and no function throws on malformed input.
export { parseLogEventLine, parseLogEvents, parseRunMeta } from './parse.js'
export type { RunSnapshot } from './parse.js'
