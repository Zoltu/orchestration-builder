// Presentation contract: render parsed log events as the view's one-line rows, paired detail sections, and text export.
//
// Inputs are never mutated: returned entries and sections are fresh values, and the payload content they reference stays untouched.
// Output order follows the input log: a text export emits one line per event in log order, a recent entry preserves the supplied log-wide index, and detail sections appear in their documented per-type order.
// An empty log renders an empty string and an event with no paired detail yields null sections. Formatting is best-effort on malformed payloads: absent or wrongly typed fields degrade to a bare label or an omitted section, and no function throws.
export { formatLogAsText, formatLogDetailSections, toRecentLogEntry } from './format.js'
export type { LogDetailSection, RecentLogEntry } from './format.js'
