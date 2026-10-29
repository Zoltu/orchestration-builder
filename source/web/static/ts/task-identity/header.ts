// The task-identity header above the Watch stage. It renders the generated summary when one is ready, the deterministic identity otherwise, and a fallback label while the thread is loading or unreadable so the bar is never blank. All fields are plain text nodes; no prose from the thread goes through an HTML path here.

import type { LooseH, Vnode } from '../../vendor/hyperapp.js'
import type { TaskLineage, TaskThreadResponse } from './wire.js'

export const TASK_IDENTITY_FALLBACK_TITLE_MAX_CHARS = 160

export interface TaskIdentityFallback {
	title: string
	description: string | null
}

export interface TaskIdentityHumanChip {
	entryId: string
	label: string
	text: string
}

export interface TaskIdentityHeaderWarning {
	text: string
	title: string
}

export interface TaskIdentityHeaderDescriptor {
	title: string
	description: string
	currentTask: string | null
	originalTask: string | null
	continuationCount: number
	resumeCount: number
	lineageWarning: TaskIdentityHeaderWarning | null
	latestHuman: TaskIdentityHumanChip | null
	summaryPending: boolean
	usingFallback: boolean
}

export interface TaskIdentityHeaderInput {
	thread: TaskThreadResponse | null
	fallback: TaskIdentityFallback
	summaryRequestPending: boolean
	summaryRequestFailed: boolean
}

export interface TaskIdentityHeaderProps {
	descriptor: TaskIdentityHeaderDescriptor
	onOpenHistory: unknown
	onLatestHuman?: unknown
	historyEnabled?: boolean
}

function nonBlank(value: string | null | undefined): string | null {
	if (typeof value !== 'string') return null
	const trimmed = value.trim()
	return trimmed === '' ? null : trimmed
}

function taskText(value: string | null | undefined): string | null {
	return nonBlank(value)
}

function clampTitle(title: string): string {
	if (title.length <= TASK_IDENTITY_FALLBACK_TITLE_MAX_CHARS) return title
	return title.slice(0, TASK_IDENTITY_FALLBACK_TITLE_MAX_CHARS - 1) + '\u2026'
}

function pluralCount(count: number, singular: string, plural: string): string {
	return `${count} ${count === 1 ? singular : plural}`
}

function lineageWarning(lineage: TaskLineage): TaskIdentityHeaderWarning | null {
	const reasons: string[] = []
	if (!lineage.complete) reasons.push('the lineage is incomplete')
	if (!lineage.resumeCountComplete) reasons.push('the resume count is incomplete')
	if (lineage.missingParentRunId !== null) reasons.push(`parent run ${lineage.missingParentRunId} is missing`)
	if (lineage.truncatedReason !== null) reasons.push(`the lineage was truncated (${lineage.truncatedReason})`)
	if (reasons.length === 0) return null
	return { text: 'Lineage incomplete', title: reasons.join('; ') }
}

function latestHumanChip(thread: TaskThreadResponse): TaskIdentityHumanChip | null {
	const latest = thread.identity.latestHumanEvent
	if (latest === null) return null
	return {
		entryId: latest.entryId,
		label: latest.label,
		text: latest.text,
	}
}

export function deriveTaskIdentityHeader(input: TaskIdentityHeaderInput): TaskIdentityHeaderDescriptor {
	const thread = input.thread
	if (thread === null) {
		const title = clampTitle(nonBlank(input.fallback.title) ?? 'No run selected')
		return {
			title,
			description: nonBlank(input.fallback.description) ?? '',
			currentTask: null,
			originalTask: null,
			continuationCount: 0,
			resumeCount: 0,
			lineageWarning: null,
			latestHuman: null,
			summaryPending: input.summaryRequestPending && !input.summaryRequestFailed,
			usingFallback: true,
		}
	}
	const identity = thread.identity
	const summary = thread.summaryState === 'ready' ? thread.summary : null
	const title = nonBlank(summary === null ? identity.title : summary.title)
		?? nonBlank(input.fallback.title)
		?? thread.runId
	const description = nonBlank(summary === null ? identity.description : summary.description) ?? nonBlank(input.fallback.description) ?? ''
	const currentTask = taskText(identity.currentTask === null ? null : identity.currentTask.text)
	const originalTaskText = taskText(identity.originalTask === null ? null : identity.originalTask.text)
	const originalTask = originalTaskText !== null && originalTaskText !== currentTask ? originalTaskText : null
	return {
		title,
		description,
		currentTask,
		originalTask,
		continuationCount: identity.lineage.continuationCount,
		resumeCount: identity.lineage.resumeCount,
		lineageWarning: lineageWarning(identity.lineage),
		latestHuman: latestHumanChip(thread),
		summaryPending: !input.summaryRequestFailed && (input.summaryRequestPending || thread.summaryState === 'pending'),
		usingFallback: false,
	}
}

function TaskLine(h: LooseH, label: string, text: string): Vnode {
	return h('p', { class: 'task-identity-task' }, [
		h('span', { class: 'task-identity-task-label' }, label),
		h('span', { class: 'task-identity-task-text', title: text }, text),
	])
}

export function TaskIdentityHeader(h: LooseH, props: TaskIdentityHeaderProps): Vnode {
	const descriptor = props.descriptor
	const children: Vnode[] = []
	const titleBlockChildren: Vnode[] = [
		h('h2', { class: descriptor.usingFallback ? 'task-identity-title task-identity-title--fallback' : 'task-identity-title', title: descriptor.title }, descriptor.title),
	]
	if (descriptor.description !== '') {
		titleBlockChildren.push(h('p', { class: 'task-identity-description' }, descriptor.description))
	}
	const actionChildren: Vnode[] = []
	if (descriptor.summaryPending) {
		actionChildren.push(h('span', { class: 'task-identity-summarizing', role: 'status' }, 'Summarizing\u2026'))
	}
	if (props.historyEnabled !== false) actionChildren.push(h('button', { type: 'button', class: 'task-identity-history-button', onclick: props.onOpenHistory }, 'Tasks history'))
	children.push(h('div', { class: 'task-identity-head' }, [
		h('div', { class: 'task-identity-title-block' }, titleBlockChildren),
		h('div', { class: 'task-identity-actions' }, actionChildren),
	]))
	const taskChildren: Vnode[] = []
	if (descriptor.currentTask !== null) taskChildren.push(TaskLine(h, 'Current task', descriptor.currentTask))
	if (descriptor.originalTask !== null) taskChildren.push(TaskLine(h, 'Original task', descriptor.originalTask))
	if (taskChildren.length > 0) children.push(h('div', { class: 'task-identity-tasks' }, taskChildren))
	const latest = descriptor.latestHuman
	if (latest !== null) {
		const onclick = props.onLatestHuman === undefined ? props.onOpenHistory : props.onLatestHuman
		children.push(h('div', { class: 'task-identity-human-row' }, [
			h('button', { type: 'button', class: 'task-identity-human-chip', title: `${latest.label}: ${latest.text}`, 'data-entry-id': latest.entryId, onclick }, [
				h('span', { class: 'task-identity-human-label' }, latest.label),
				h('span', { class: 'task-identity-human-text' }, latest.text),
			]),
		]))
	}
	const lineageChildren: Vnode[] = [
		h('span', { class: 'task-identity-chip', title: 'Continuations in this task\u2019s lineage' }, pluralCount(descriptor.continuationCount, 'continuation', 'continuations')),
		h('span', { class: 'task-identity-chip', title: 'Resumes recorded across this lineage' }, pluralCount(descriptor.resumeCount, 'resume', 'resumes')),
	]
	if (descriptor.lineageWarning !== null) {
		lineageChildren.push(h('span', { class: 'task-identity-chip task-identity-chip--warning', role: 'status', title: descriptor.lineageWarning.title }, descriptor.lineageWarning.text))
	}
	children.push(h('div', { class: 'task-identity-lineage' }, lineageChildren))
	return h('header', { class: 'task-identity-header', 'aria-label': 'Task identity' }, children)
}
