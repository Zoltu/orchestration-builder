import type { RunThreadFacts } from './derive.js'
import { deriveTaskLineage, type TaskLineageWalk } from './lineage.js'
import {
	TASK_IDENTITY_DESCRIPTION_MAX_CHARS,
	TASK_IDENTITY_TITLE_MAX_CHARS,
	TASK_THREAD_MAX_ENTRY_CONTEXT_CHARS,
	TASK_THREAD_MAX_ENTRY_TEXT_CHARS,
} from './model.js'
import type { TaskIdentity, TaskLatestHumanEvent, TaskLineage, TaskPrompt, TaskThreadEntry } from './model.js'
import { compareCodeUnits, compareTimestamps } from './time.js'

export interface TaskThreadBounds {
	maxEntries: number
	maxEntriesPerRun: number
	maxTextChars: number
	maxLatestHumanChipChars: number
}

interface TaskThreadMerge {
	entries: TaskThreadEntry[]
	latestHumanEvent: TaskLatestHumanEvent | null
	truncated: {
		entries: boolean
		text: boolean
	}
}

interface TaskIdentityInput {
	runId: string
	runs: readonly RunThreadFacts[]
	lineage: TaskLineage
	entries: readonly TaskThreadEntry[]
	latestHumanChipChars: number
	latestHumanEvent?: TaskLatestHumanEvent | null
}

export interface TaskThreadDerivationOptions extends TaskThreadBounds {
	maxRuns: number
	// True when the reader dropped cached relevant events; the resume count can then be incomplete even though the log file itself was readable.
	sourcesTruncated?: boolean
}

export interface TaskThreadDerivation {
	runs: RunThreadFacts[]
	lineage: TaskLineage
	entries: TaskThreadEntry[]
	identity: TaskIdentity
	latestHumanEvent: TaskLatestHumanEvent | null
	truncated: {
		entries: boolean
		text: boolean
		lineage: boolean
	}
}

interface IndexedEntry {
	entry: TaskThreadEntry
	runIndex: number
}

interface CappedText {
	text: string
	truncated: boolean
}

function assertPositiveInteger(value: number, label: string): void {
	if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer, received ${value}`)
}

function capText(text: string, maxChars: number): CappedText {
	assertPositiveInteger(maxChars, 'maxChars')
	if (text.length <= maxChars) return { text, truncated: false }
	const available = maxChars - 1
	const slice = text.slice(0, available)
	const lastSpace = slice.lastIndexOf(' ')
	const cut = lastSpace > available / 2 ? slice.slice(0, lastSpace) : slice
	return { text: `${cut}…`, truncated: true }
}

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, ' ').trim()
}

function stripScaffolding(text: string): string {
	let stripped = text
	let previous: string
	do {
		previous = stripped
		stripped = stripped.replace(/^(?:[-*+]\s*|#{1,6}\s*|>\s*|\d+[.)]\s*)/, '')
	} while (stripped !== previous)
	if (stripped.length >= 2 && stripped.startsWith('"') && stripped.endsWith('"')) return stripped.slice(1, -1).trim()
	return stripped
}

function taskTitle(text: string): string {
	const line = text.split('\n').map((candidate) => candidate.trim()).find((candidate) => candidate !== '')
	if (line === undefined) return ''
	const stripped = stripScaffolding(line)
	if (stripped === '') return ''
	return capText(stripped, TASK_IDENTITY_TITLE_MAX_CHARS).text
}

function taskDescription(text: string): string {
	const firstParagraph = text.split(/\n\s*\n/)[0]
	if (firstParagraph === undefined) return ''
	const collapsed = collapseWhitespace(firstParagraph)
	if (collapsed === '') return ''
	return capText(collapsed, TASK_IDENTITY_DESCRIPTION_MAX_CHARS).text
}

function textLength(entry: TaskThreadEntry): number {
	return entry.text.length + (entry.context === null ? 0 : entry.context.length)
}

function compareEntries(left: IndexedEntry, right: IndexedEntry): number {
	const byTimestamp = compareTimestamps(left.entry.timestamp, right.entry.timestamp)
	if (byTimestamp !== 0) return byTimestamp
	if (left.runIndex !== right.runIndex) return left.runIndex - right.runIndex
	if (left.entry.sequence !== right.entry.sequence) return left.entry.sequence - right.entry.sequence
	return compareCodeUnits(left.entry.id, right.entry.id)
}

function taskLabelFor(entry: TaskThreadEntry, runIndex: number): string {
	if (entry.kind !== 'task') return entry.label
	return runIndex === 0 ? 'Initial task' : 'Follow-up'
}

function compareWithinRun(left: TaskThreadEntry, right: TaskThreadEntry): number {
	const byTimestamp = compareTimestamps(left.timestamp, right.timestamp)
	if (byTimestamp !== 0) return byTimestamp
	if (left.sequence !== right.sequence) return left.sequence - right.sequence
	return compareCodeUnits(left.id, right.id)
}

function boundRunEntries(entries: readonly TaskThreadEntry[], maxEntriesPerRun: number, runIndex: number): { entries: TaskThreadEntry[], truncated: boolean } {
	if (entries.length <= maxEntriesPerRun) {
		return { entries: entries.map((entry) => ({ ...entry })), truncated: false }
	}
	const sorted = [...entries].sort(compareWithinRun)
	const first = sorted[0]
	if (first === undefined) return { entries: [], truncated: false }
	if (maxEntriesPerRun === 1) return { entries: [{ ...first }], truncated: true }
	const kept = sorted.slice(sorted.length - (maxEntriesPerRun - 1))
	const bounded = [{ ...first, label: taskLabelFor(first, runIndex) }, ...kept.map((entry) => ({ ...entry }))]
	return { entries: bounded, truncated: true }
}

interface CollectedEntries {
	entries: IndexedEntry[]
	entriesDropped: boolean
	textTruncated: boolean
}

function collectEntries(runs: readonly RunThreadFacts[]): CollectedEntries {
	const entries: IndexedEntry[] = []
	const seenIds = new Set<string>()
	let entriesDropped = false
	let textTruncated = false
	for (let runIndex = 0; runIndex < runs.length; runIndex++) {
		const run = runs[runIndex]
		if (run === undefined) continue
		for (const entry of run.entries) {
			if (seenIds.has(entry.id)) {
				entriesDropped = true
				continue
			}
			seenIds.add(entry.id)
			const text = capText(entry.text, TASK_THREAD_MAX_ENTRY_TEXT_CHARS)
			const context = entry.context === null ? null : capText(entry.context, TASK_THREAD_MAX_ENTRY_CONTEXT_CHARS)
			const adjusted: TaskThreadEntry = {
				...entry,
				label: taskLabelFor(entry, runIndex),
				text: text.text,
				context: context === null ? null : context.text,
				textTruncated: entry.textTruncated || text.truncated || (context !== null && context.truncated),
			}
			if (adjusted.textTruncated) textTruncated = true
			entries.push({ entry: adjusted, runIndex })
		}
	}
	return { entries, entriesDropped, textTruncated }
}

function latestHumanFromEntries(entries: readonly IndexedEntry[], maxChipChars: number): TaskLatestHumanEvent | null {
	for (let index = entries.length - 1; index >= 0; index--) {
		const item = entries[index]
		if (item === undefined || item.entry.actor !== 'human') continue
		return {
			entryId: item.entry.id,
			kind: item.entry.kind,
			label: item.entry.label,
			text: capText(collapseWhitespace(item.entry.text), maxChipChars).text,
			timestamp: item.entry.timestamp,
			runId: item.entry.runId,
		}
	}
	return null
}

function mergeTaskThreadEntries(runs: readonly RunThreadFacts[], bounds: TaskThreadBounds): TaskThreadMerge {
	assertPositiveInteger(bounds.maxEntries, 'maxEntries')
	assertPositiveInteger(bounds.maxEntriesPerRun, 'maxEntriesPerRun')
	assertPositiveInteger(bounds.maxTextChars, 'maxTextChars')
	assertPositiveInteger(bounds.maxLatestHumanChipChars, 'maxLatestHumanChipChars')
	const collected = collectEntries(runs)
	const sortedAll = [...collected.entries].sort(compareEntries)
	// Compute the latest human turn before any truncation: a cap that drops the oldest middle turns must not make an older human event look like the latest one.
	const latestHumanEvent = latestHumanFromEntries(sortedAll, bounds.maxLatestHumanChipChars)
	let entriesDropped = collected.entriesDropped
	let textTruncated = collected.textTruncated
	const groups: IndexedEntry[][] = runs.map(() => [])
	for (const item of sortedAll) {
		const group = groups[item.runIndex]
		if (group !== undefined) group.push(item)
	}
	const perRun: IndexedEntry[] = []
	for (let runIndex = 0; runIndex < groups.length; runIndex++) {
		const group = groups[runIndex]
		if (group === undefined) continue
		const bounded = boundRunEntries(group.map((item) => item.entry), bounds.maxEntriesPerRun, runIndex)
		if (bounded.truncated) entriesDropped = true
		for (const entry of bounded.entries) perRun.push({ entry, runIndex })
	}
	perRun.sort(compareEntries)

	// The initial task and the newest turns are the parts a truncated thread must keep: the drawer's tail stays truthful while the oldest middle turns are dropped first.
	let kept: IndexedEntry[] = []
	const first = perRun[0]
	if (first !== undefined) {
		const firstLength = textLength(first.entry)
		if (firstLength > bounds.maxTextChars) {
			const capped = capText(first.entry.text, bounds.maxTextChars)
			kept.push({ entry: { ...first.entry, text: capped.text, context: null, textTruncated: true }, runIndex: first.runIndex })
			textTruncated = true
		} else {
			kept.push(first)
		}
	}
	let usedText = 0
	const firstKept = kept[0]
	if (firstKept !== undefined) usedText = textLength(firstKept.entry)
	for (let index = perRun.length - 1; index >= 1; index--) {
		const candidate = perRun[index]
		if (candidate === undefined) continue
		if (kept.length >= bounds.maxEntries) break
		const candidateLength = textLength(candidate.entry)
		if (usedText + candidateLength > bounds.maxTextChars) {
			textTruncated = true
			entriesDropped = true
			break
		}
		kept.splice(1, 0, candidate)
		usedText += candidateLength
	}
	if (kept.length < perRun.length) entriesDropped = true
	const entries = kept.map((item, sequence) => ({ ...item.entry, sequence }))
	if (entries.some((entry) => entry.textTruncated)) textTruncated = true
	return {
		entries,
		latestHumanEvent,
		truncated: { entries: entriesDropped, text: textTruncated },
	}
}

function boundPrompt(prompt: TaskPrompt | null): TaskPrompt | null {
	if (prompt === null) return null
	return { ...prompt, text: capText(prompt.text, TASK_THREAD_MAX_ENTRY_TEXT_CHARS).text }
}

function derivedStatusFromEntries(entries: readonly TaskThreadEntry[]): TaskIdentity['status'] {
	let status: TaskIdentity['status'] = 'unknown'
	const ordered = [...entries].sort((left, right) => {
		const byTimestamp = compareTimestamps(left.timestamp, right.timestamp)
		if (byTimestamp !== 0) return byTimestamp
		if (left.sequence !== right.sequence) return left.sequence - right.sequence
		return compareCodeUnits(left.id, right.id)
	})
	for (const entry of ordered) {
		if (entry.kind === 'result' && entry.status !== null) {
			status = entry.status
			continue
		}
		if (entry.kind !== 'system') continue
		if (entry.systemKind === 'suspension') status = 'suspended'
		if (entry.systemKind === 'pause') status = 'needs_clarification'
		if (entry.systemKind === 'failure' || entry.systemKind === 'termination') status = 'interrupted'
		if (entry.systemKind === 'resume') status = 'running'
	}
	return status
}

function deriveTaskIdentity(input: TaskIdentityInput): TaskIdentity {
	const current = input.runs[input.runs.length - 1]
	if (current === undefined) throw new Error(`deriveTaskIdentity: no run facts for ${input.runId}`)
	const original = input.runs[0]
	const currentTask = boundPrompt(current.task)
	const originalTask = boundPrompt(original === undefined ? null : original.task)
	const taskText = currentTask?.text ?? originalTask?.text ?? ''
	const status = current.meta === null ? derivedStatusFromEntries(current.entries) : current.meta.status
	const title = taskTitle(taskText)
	const description = taskDescription(taskText)
	const latestHumanEvent = input.latestHumanEvent !== undefined
		? input.latestHumanEvent
		: latestHumanFromEntries(input.entries.map((entry) => ({ entry, runIndex: 0 })), input.latestHumanChipChars)
	return {
		runId: input.runId,
		status,
		title: title === '' ? `Run ${input.runId}` : title,
		description: description === '' ? `Run ${input.runId}.` : description,
		currentTask,
		originalTask,
		lineage: input.lineage,
		latestHumanEvent,
	}
}

export function deriveTaskThread(current: RunThreadFacts, lookupRun: (runId: string) => RunThreadFacts | null, options: TaskThreadDerivationOptions): TaskThreadDerivation {
	const walk: TaskLineageWalk = deriveTaskLineage(current, lookupRun, options.maxRuns)
	const merge = mergeTaskThreadEntries(walk.runs, options)
	const lineage = options.sourcesTruncated === true ? { ...walk.lineage, resumeCountComplete: false } : walk.lineage
	const identity = deriveTaskIdentity({ runId: current.runId, runs: walk.runs, lineage, entries: merge.entries, latestHumanChipChars: options.maxLatestHumanChipChars, latestHumanEvent: merge.latestHumanEvent })
	return {
		runs: walk.runs,
		lineage,
		entries: merge.entries,
		identity,
		latestHumanEvent: merge.latestHumanEvent,
		truncated: {
			entries: merge.truncated.entries,
			text: merge.truncated.text,
			lineage: !walk.lineage.complete,
		},
	}
}
