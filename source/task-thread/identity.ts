import type { RunThreadFacts } from './derive.js'
import { deriveTaskLineage, type TaskLineageWalk } from './lineage.js'
import { TASK_IDENTITY_DESCRIPTION_MAX_CHARS, TASK_IDENTITY_TITLE_MAX_CHARS } from './model.js'
import type { TaskIdentity, TaskLatestHumanEvent, TaskLineage, TaskPrompt, TaskThreadEntry } from './model.js'
import { compareCodeUnits, compareTimestamps } from './time.js'

export interface TaskThreadBounds {
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

interface CollectedEntries {
	entries: IndexedEntry[]
	duplicatesDropped: boolean
}

function collectEntries(runs: readonly RunThreadFacts[]): CollectedEntries {
	const entries: IndexedEntry[] = []
	const seenIds = new Set<string>()
	let duplicatesDropped = false
	for (let runIndex = 0; runIndex < runs.length; runIndex++) {
		const run = runs[runIndex]
		if (run === undefined) continue
		for (const entry of run.entries) {
			if (seenIds.has(entry.id)) {
				duplicatesDropped = true
				continue
			}
			seenIds.add(entry.id)
			entries.push({ entry: { ...entry, label: taskLabelFor(entry, runIndex) }, runIndex })
		}
	}
	return { entries, duplicatesDropped }
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
	assertPositiveInteger(bounds.maxLatestHumanChipChars, 'maxLatestHumanChipChars')
	const collected = collectEntries(runs)
	const sortedAll = collected.entries.sort(compareEntries)
	const latestHumanEvent = latestHumanFromEntries(sortedAll, bounds.maxLatestHumanChipChars)
	const entries = sortedAll.map((item, sequence) => ({ ...item.entry, sequence }))
	return {
		entries,
		latestHumanEvent,
		truncated: { entries: collected.duplicatesDropped, text: false },
	}
}

function copyPrompt(prompt: TaskPrompt | null): TaskPrompt | null {
	return prompt === null ? null : { ...prompt }
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
		if (entry.systemKind === 'suspension' || entry.systemKind === 'operator_pause') status = 'suspended'
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
	const currentTask = copyPrompt(current.task)
	const originalTask = copyPrompt(original === undefined ? null : original.task)
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
	const lineage = walk.lineage
	const merge = mergeTaskThreadEntries(walk.runs, options)
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
