// The task-history drawer: the app-shell modal that shows the human↔orchestrator thread grouped by run from root to current. Human and orchestrator turns render their prose through the caller's sanitized Markdown renderer; system markers and every machine field (labels, timestamps, run ids, statuses) stay plain text. Only task-thread entries are rendered, so reasoning, tool, and subagent traffic cannot leak in through this surface.

import type { LooseH, Vnode, VnodeChildInput } from '../../vendor/hyperapp.js'
import type { TaskThreadEntry, TaskThreadResponse } from './wire.js'
import type { TaskThreadLoadState } from './state.js'

type RenderMarkdown = (text: string) => VnodeChildInput

const TASK_HISTORY_HEADING_ID = 'task-history-heading'

export interface TaskHistoryRunGroup {
	runId: string
	entries: TaskThreadEntry[]
	isRoot: boolean
	isCurrent: boolean
}

export interface TaskHistoryDrawerProps {
	thread: TaskThreadResponse | null
	loadState: TaskThreadLoadState
	renderMarkdown: RenderMarkdown
	onClose: unknown
	onRetryLoad?: unknown
	onRetrySummary?: unknown
	summaryRequestPending?: boolean
	summaryRequestFailed?: boolean
}

function findGroupIndex(groups: readonly TaskHistoryRunGroup[], runId: string): number {
	return groups.findIndex((group) => group.runId === runId)
}

function moveGroup(groups: TaskHistoryRunGroup[], runId: string, position: 'first' | 'last'): void {
	const index = findGroupIndex(groups, runId)
	if (index < 0) return
	const [group] = groups.splice(index, 1)
	if (group === undefined) return
	if (position === 'first') groups.unshift(group)
	else groups.push(group)
}

function groupTaskThreadEntries(thread: TaskThreadResponse): TaskHistoryRunGroup[] {
	if (thread.entries.length === 0) return []
	const groups: TaskHistoryRunGroup[] = []
	const indexByRun = new Map<string, number>()
	for (const entry of thread.entries) {
		const existingIndex = indexByRun.get(entry.runId)
		if (existingIndex !== undefined) {
			const existing = groups[existingIndex]
			if (existing !== undefined) existing.entries.push(entry)
			continue
		}
		indexByRun.set(entry.runId, groups.length)
		groups.push({ runId: entry.runId, entries: [entry], isRoot: false, isCurrent: false })
	}
	moveGroup(groups, thread.identity.lineage.rootRunId, 'first')
	moveGroup(groups, thread.runId, 'last')
	for (const group of groups) {
		group.isRoot = group.runId === thread.identity.lineage.rootRunId
		group.isCurrent = group.runId === thread.runId
	}
	return groups
}

function actorLabel(entry: TaskThreadEntry): string {
	if (entry.actor === 'human') return 'You'
	if (entry.actor === 'orchestrator') return 'Orchestrator'
	return 'System'
}

function entryClassName(entry: TaskThreadEntry): string {
	const classes = ['task-history-entry', `task-history-entry--${entry.actor}`]
	if (entry.systemKind !== null) classes.push(`task-history-entry--system-${entry.systemKind}`)
	return classes.join(' ')
}

function entryMeta(h: LooseH, entry: TaskThreadEntry): Vnode {
	const chips: Vnode[] = [h('span', { class: 'task-history-entry-actor' }, actorLabel(entry))]
	if (entry.status !== null) chips.push(h('span', { class: 'task-history-entry-status' }, entry.status))
	if (entry.outcome !== null) chips.push(h('span', { class: 'task-history-entry-outcome' }, entry.outcome))
	return h('div', { class: 'task-history-entry-meta' }, [
		h('span', { class: 'task-history-entry-label' }, entry.label),
		...chips,
		h('time', { class: 'task-history-entry-time', datetime: entry.timestamp }, entry.timestamp),
	])
}

function entryBody(h: LooseH, entry: TaskThreadEntry, renderMarkdown: RenderMarkdown): Vnode[] {
	const children: Vnode[] = []
	if (entry.actor === 'system') children.push(h('p', { class: 'task-history-entry-text task-history-entry-text--system' }, entry.text))
	else children.push(h('div', { class: 'task-history-entry-text markdown' }, renderMarkdown(entry.text)))
	if (entry.context !== null && entry.context !== '') {
		if (entry.actor === 'system') children.push(h('p', { class: 'task-history-entry-context task-history-entry-context--system' }, entry.context))
		else children.push(h('div', { class: 'task-history-entry-context markdown' }, renderMarkdown(entry.context)))
	}
	if (entry.textTruncated) children.push(h('p', { class: 'task-history-entry-truncated' }, 'This turn was truncated.'))
	return children
}

function RunGroup(h: LooseH, group: TaskHistoryRunGroup, index: number, total: number, renderMarkdown: RenderMarkdown): Vnode {
	const tags: Vnode[] = []
	if (group.isRoot) tags.push(h('span', { class: 'task-history-run-tag' }, 'root'))
	if (group.isCurrent) tags.push(h('span', { class: 'task-history-run-tag task-history-run-tag--current' }, 'current'))
	const entries: Vnode[] = group.entries.map((entry) => h('li', { class: entryClassName(entry), id: `task-history-entry-${entry.id}`, 'data-entry-id': entry.id, 'data-system-kind': entry.systemKind ?? '' }, [
		entryMeta(h, entry),
		...entryBody(h, entry, renderMarkdown),
	]))
	return h('section', { class: 'task-history-run' }, [
		h('header', { class: 'task-history-run-heading' }, [
			h('span', { class: 'task-history-run-index' }, `Run ${index + 1} of ${total}`),
			h('span', { class: 'task-history-run-id' }, group.runId),
			...tags,
		]),
		h('ol', { class: 'task-history-entries' }, entries),
	])
}

function drawerStatus(h: LooseH, props: TaskHistoryDrawerProps): Vnode | null {
	const thread = props.thread
	if (thread === null) return null
	if (props.summaryRequestFailed === true || thread.summaryState === 'failed') {
		const retry = props.onRetrySummary === undefined
			? null
			: h('button', { type: 'button', class: 'task-history-summary-retry', onclick: props.onRetrySummary }, 'Retry summary')
		return h('div', { class: 'task-history-summary-status task-history-summary-status--failed', role: 'alert' }, [
			h('span', {}, 'Summary unavailable.'),
			retry,
		])
	}
	if (props.summaryRequestPending === true || thread.summaryState === 'pending') {
		return h('p', { class: 'task-history-summary-status', role: 'status' }, 'Summarizing\u2026')
	}
	return null
}

function drawerBody(h: LooseH, props: TaskHistoryDrawerProps): Vnode[] {
	const thread = props.thread
	if (thread === null) {
		if (props.loadState === 'idle') return [h('p', { class: 'task-history-state' }, 'Select a run to see its tasks.')]
		if (props.loadState === 'error') {
			const retry = props.onRetryLoad === undefined
				? null
				: h('button', { type: 'button', class: 'task-history-retry', onclick: props.onRetryLoad }, 'Retry')
			return [h('div', { class: 'task-history-state task-history-state--error', role: 'alert' }, [
				h('p', {}, 'Task history could not be loaded.'),
				retry,
			])]
		}
		return [h('p', { class: 'task-history-state', role: 'status' }, 'Loading task history\u2026')]
	}
	const children: Vnode[] = []
	const status = drawerStatus(h, props)
	if (status !== null) children.push(status)
	if (thread.truncated.entries) children.push(h('p', { class: 'task-history-notice' }, 'Older turns were omitted from this history.'))
	if (thread.truncated.text) children.push(h('p', { class: 'task-history-notice' }, 'Some turn text was shortened.'))
	if (thread.truncated.lineage) children.push(h('p', { class: 'task-history-notice task-history-notice--warning' }, 'The lineage is incomplete; some earlier runs may be missing.'))
	if (thread.entries.length === 0) {
		children.push(h('p', { class: 'task-history-state' }, 'No task turns recorded yet.'))
		return children
	}
	const groups = groupTaskThreadEntries(thread)
	for (let index = 0; index < groups.length; index++) {
		const group = groups[index]
		if (group === undefined) continue
		children.push(RunGroup(h, group, index, groups.length, props.renderMarkdown))
	}
	return children
}

// The Close button takes focus on mount; a full focus trap and shell inerting are deferred, so the drawer remains a keyboard-dismissable dialog without claiming to isolate background focus.
function TaskHistoryDrawer(h: LooseH, props: TaskHistoryDrawerProps): Vnode {
	return h('div', { class: 'task-history-overlay' }, [
		h('div', { class: 'task-history-backdrop', onclick: props.onClose }),
		h('section', { class: 'task-history-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': TASK_HISTORY_HEADING_ID }, [
			h('header', { class: 'task-history-head' }, [
				h('div', { class: 'task-history-heading-block' }, [
					h('h2', { class: 'task-history-heading', id: TASK_HISTORY_HEADING_ID }, 'Tasks history'),
					props.thread === null ? null : h('p', { class: 'task-history-run-id' }, props.thread.runId),
				]),
				h('button', { type: 'button', class: 'task-history-close', autofocus: true, onclick: props.onClose }, 'Close'),
			]),
			h('div', { class: 'task-history-body' }, drawerBody(h, props)),
		]),
	])
}

export interface TaskHistoryDrawerRenderer {
	render(h: LooseH, props: TaskHistoryDrawerProps): Vnode
	clear(): void
}

interface TaskHistoryDrawerCache {
	h: LooseH
	thread: TaskThreadResponse | null
	loadState: TaskThreadLoadState
	renderMarkdown: RenderMarkdown
	onClose: unknown
	onRetryLoad: unknown
	onRetrySummary: unknown
	summaryRequestPending: boolean
	summaryRequestFailed: boolean
	vnode: Vnode
}

export function createTaskHistoryDrawerRenderer(): TaskHistoryDrawerRenderer {
	let cached: TaskHistoryDrawerCache | null = null
	return {
		clear(): void {
			cached = null
		},
		render(h: LooseH, props: TaskHistoryDrawerProps): Vnode {
			if (cached !== null
				&& cached.h === h
				&& cached.thread === props.thread
				&& cached.loadState === props.loadState
				&& cached.renderMarkdown === props.renderMarkdown
				&& cached.onClose === props.onClose
				&& cached.onRetryLoad === props.onRetryLoad
				&& cached.onRetrySummary === props.onRetrySummary
				&& cached.summaryRequestPending === (props.summaryRequestPending === true)
				&& cached.summaryRequestFailed === (props.summaryRequestFailed === true)) {
				return cached.vnode
			}
			const vnode = TaskHistoryDrawer(h, props)
			cached = {
				h,
				thread: props.thread,
				loadState: props.loadState,
				renderMarkdown: props.renderMarkdown,
				onClose: props.onClose,
				onRetryLoad: props.onRetryLoad,
				onRetrySummary: props.onRetrySummary,
				summaryRequestPending: props.summaryRequestPending === true,
				summaryRequestFailed: props.summaryRequestFailed === true,
				vnode,
			}
			return vnode
		},
	}
}
