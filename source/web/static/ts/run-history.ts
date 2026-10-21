// Pure derivations for the merged history screen: which rows to show, what labels they carry, and how a run's lineage is presented. Rendering lives in app.ts; this module keeps the merge and label policy testable in memory.

import { deriveQueuedItems, taskFirstLine } from './queue-panel.js'
import type { QueueItemLike } from './queue-panel.js'
import type { RunSummary } from './run-list-feed/index.js'

export type HistoryEntry =
	| { kind: 'queued'; item: QueueItemLike }
	| { kind: 'run'; summary: RunSummary }

// The single row per task: queued rows come first in display order, then the runs whose id no queued row already represents. A queued row represents both the run it is attached to (`runId`) and the paused run it will re-enter (`resumesRunId`), so an active, answered, or parked task never appears twice.
export function deriveHistoryEntries(items: QueueItemLike[], summaries: RunSummary[]): HistoryEntry[] {
	const queued = deriveQueuedItems(items)
	const orderedItems = [...queued.waiting, ...queued.active, ...queued.needsInput]
	const representedRunIds = new Set<string>()
	for (const item of orderedItems) {
		if (typeof item.runId === 'string' && item.runId !== '') representedRunIds.add(item.runId)
		if (typeof item.resumesRunId === 'string' && item.resumesRunId !== '') representedRunIds.add(item.resumesRunId)
	}
	const entries: HistoryEntry[] = orderedItems.map((item) => ({ kind: 'queued', item }))
	for (const summary of summaries) {
		if (representedRunIds.has(summary.runId)) continue
		entries.push({ kind: 'run', summary })
	}
	return entries
}

// The row's primary label: a running or paused run names the task it is working on, because its generated summary and any result card describe an earlier state. A finished run prefers its generated summary, then the task, then the id.
export function runPrimaryLabel(summary: RunSummary): string {
	const taskLine = typeof summary.task === 'string' && summary.task !== '' ? taskFirstLine(summary.task) : ''
	if (summary.status === 'running' || summary.status === 'needs_clarification') return taskLine !== '' ? taskLine : summary.runId
	if (typeof summary.summary === 'string' && summary.summary !== '') return summary.summary
	return taskLine !== '' ? taskLine : summary.runId
}

export interface LineageLink {
	runId: string
	label: string
	// Whether the parent is present in the current summaries; a missing parent keeps its id as the label but is rendered as non-interactive text rather than a link to an unknown run.
	available: boolean
}

// One map per history render is the lookup every lineage link shares, so a long list does not rescan the summaries for every row and again for its expanded details.
export function runSummaryIndex(summaries: RunSummary[]): Map<string, RunSummary> {
	const index = new Map<string, RunSummary>()
	for (const summary of summaries) index.set(summary.runId, summary)
	return index
}

function lineageLinkFromIndex(continuesFrom: string | null | undefined, summariesById: Map<string, RunSummary>): LineageLink | null {
	if (typeof continuesFrom !== 'string' || continuesFrom === '') return null
	const parent = summariesById.get(continuesFrom)
	return { runId: continuesFrom, label: parent === undefined ? continuesFrom : runPrimaryLabel(parent), available: parent !== undefined }
}

// The parent run a row continues, labelled by the parent's own primary label when it is in the list and by its id otherwise. The caller may pass the once-per-render index so a long list never rescans the summaries. No lineage link is shown for a run that does not continue anything.
export function lineageLink(continuesFrom: string | null | undefined, summaries: RunSummary[] | Map<string, RunSummary>): LineageLink | null {
	const summariesById = summaries instanceof Map ? summaries : runSummaryIndex(summaries)
	return lineageLinkFromIndex(continuesFrom, summariesById)
}

// A queue item's lineage, suppressing a self-reference: an item may name its own dispatched or paused run in continuesFrom, which must not render as a link to itself.
export function queueItemLineageLink(item: Pick<QueueItemLike, 'continuesFrom' | 'runId' | 'resumesRunId'>, summariesById: Map<string, RunSummary>): LineageLink | null {
	const continuesFrom = item.continuesFrom
	if (typeof continuesFrom !== 'string' || continuesFrom === '') return null
	if (continuesFrom === item.runId || continuesFrom === item.resumesRunId) return null
	return lineageLinkFromIndex(continuesFrom, summariesById)
}
