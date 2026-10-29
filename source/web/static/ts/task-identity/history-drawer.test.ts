import { describe, expect, test } from 'bun:test'
import { createTaskHistoryDrawerRenderer } from './history-drawer.js'
import type { TaskThreadEntry, TaskThreadResponse } from './wire.js'

interface Vnode {
	tag: string
	props: Record<string, unknown>
	children: VnodeChild[]
}
type VnodeChild = Vnode | string
type VnodeChildInput = VnodeChild | VnodeChildInput[] | null | undefined | boolean

function fakeH(tag: string, props: Record<string, unknown>, children: VnodeChildInput): Vnode {
	return { tag, props, children: normalizeChildren(children) }
}

function normalizeChildren(children: VnodeChildInput): VnodeChild[] {
	const out: VnodeChild[] = []
	pushChildren(out, children)
	return out
}

function pushChildren(out: VnodeChild[], children: VnodeChildInput): void {
	if (children === null || children === undefined || typeof children === 'boolean') return
	if (Array.isArray(children)) {
		for (const child of children) pushChildren(out, child)
		return
	}
	out.push(children)
}

function isVnode(value: VnodeChild): value is Vnode {
	return typeof value !== 'string'
}

function allByTag(vnode: Vnode, tag: string): Vnode[] {
	const found: Vnode[] = []
	for (const child of vnode.children) {
		if (!isVnode(child)) continue
		if (child.tag === tag) found.push(child)
		for (const descendant of allByTag(child, tag)) found.push(descendant)
	}
	return found
}

function allText(vnode: Vnode): string {
	let text = ''
	for (const child of vnode.children) {
		if (typeof child === 'string') text += child
		else text += allText(child)
	}
	return text
}

function markers(calls: string[]): (text: string) => Vnode {
	return (text: string): Vnode => {
		calls.push(text)
		return { tag: 'span', props: { class: 'md-marker', 'data-text': text }, children: [text] }
	}
}

function renderDrawer(props: Parameters<ReturnType<typeof createTaskHistoryDrawerRenderer>['render']>[1]): Vnode {
	return createTaskHistoryDrawerRenderer().render(fakeH, props)
}

function renderedRunIds(target: TaskThreadResponse): string[] {
	const view = renderDrawer({ thread: target, loadState: 'ready', renderMarkdown: markers([]), onClose: 'close' })
	return allByTag(view, 'section')
		.filter((section) => section.props.class === 'task-history-run')
		.map((section) => {
			const id = allByTag(section, 'span').find((span) => span.props.class === 'task-history-run-id')
			return id === undefined ? '' : allText(id)
		})
}

function entry(overrides: Partial<TaskThreadEntry> = {}): TaskThreadEntry {
	return {
		id: 'entry-1',
		sequence: 0,
		runId: 'run-root',
		timestamp: '2026-01-01T00:00:00.000Z',
		kind: 'task',
		actor: 'human',
		label: 'Initial task',
		text: 'Start the task',
		context: null,
		status: null,
		systemKind: null,
		outcome: null,
		questionId: null,
		relatedEntryId: null,
		queueItemId: null,
		source: 'log',
		textTruncated: false,
		...overrides,
	}
}

function thread(entries: TaskThreadEntry[], overrides: Partial<TaskThreadResponse> = {}): TaskThreadResponse {
	return {
		formatVersion: 1,
		runId: 'run-current',
		identity: {
			runId: 'run-current',
			status: 'running',
			title: 'Current task',
			description: 'Current task.',
			currentTask: null,
			originalTask: null,
			lineage: {
				rootRunId: 'run-root',
				parentRunId: 'run-root',
				continuationCount: 1,
				resumeCount: 0,
				resumeCountComplete: true,
				depth: 1,
				complete: true,
				missingParentRunId: null,
				truncatedReason: null,
			},
			latestHumanEvent: null,
		},
		entries,
		summary: null,
		summaryState: 'none',
		truncated: { entries: false, text: false, lineage: false },
		...overrides,
	}
}

describe('groupTaskThreadEntries', () => {
	test('groups by run in thread order with the root first and the current run last', () => {
		expect(renderedRunIds(thread([
			entry({ id: 'root-1', sequence: 0, runId: 'run-root' }),
			entry({ id: 'middle-1', sequence: 1, runId: 'run-middle' }),
			entry({ id: 'current-1', sequence: 2, runId: 'run-current' }),
		]))).toEqual(['run-root', 'run-middle', 'run-current'])
	})

	test('moves a root whose entries appear later to the front and keeps one group per run', () => {
		const view = renderDrawer({ thread: thread([
			entry({ id: 'current-1', sequence: 0, runId: 'run-current' }),
			entry({ id: 'root-1', sequence: 1, runId: 'run-root' }),
			entry({ id: 'root-2', sequence: 2, runId: 'run-root' }),
		]), loadState: 'ready', renderMarkdown: markers([]), onClose: 'close' })
		expect(renderedRunIds(thread([
			entry({ id: 'current-1', sequence: 0, runId: 'run-current' }),
			entry({ id: 'root-1', sequence: 1, runId: 'run-root' }),
			entry({ id: 'root-2', sequence: 2, runId: 'run-root' }),
		]))).toEqual(['run-root', 'run-current'])
		const firstRun = allByTag(view, 'section').find((section) => section.props.class === 'task-history-run')
		expect(firstRun === undefined ? 0 : allByTag(firstRun, 'li').length).toBe(2)
	})
})

describe('TaskHistoryDrawer', () => {
	test('renders human and orchestrator turns with distinct classes and prose through the Markdown renderer', () => {
		const calls: string[] = []
		const view = renderDrawer({
			thread: thread([
				entry({ id: 'human-1', sequence: 0, actor: 'human', text: 'Human prose' }),
				entry({ id: 'bot-1', sequence: 1, actor: 'orchestrator', text: 'Orchestrator prose' }),
			]),
			loadState: 'ready',
			renderMarkdown: markers(calls),
			onClose: 'close',
		})
		const items = allByTag(view, 'li')
		expect(items.some((item) => item.props.class === 'task-history-entry task-history-entry--human')).toBe(true)
		expect(items.some((item) => item.props.class === 'task-history-entry task-history-entry--orchestrator')).toBe(true)
		expect(calls).toEqual(['Human prose', 'Orchestrator prose'])
	})

	test('renders system markers with their systemKind class and plain text, never through Markdown', () => {
		const calls: string[] = []
		const view = renderDrawer({
			thread: thread([entry({ id: 'sys-1', actor: 'system', kind: 'system', systemKind: 'failure', label: 'Run failed', text: 'The provider failed' })]),
			loadState: 'ready',
			renderMarkdown: markers(calls),
			onClose: 'close',
		})
		const items = allByTag(view, 'li')
		const system = items.find((item) => item.props['data-system-kind'] === 'failure')
		expect(system === undefined ? '' : system.props.class).toBe('task-history-entry task-history-entry--system task-history-entry--system-failure')
		expect(calls).toEqual([])
		expect(allText(view)).toContain('The provider failed')
	})

	test('shows truncation notices and per-turn truncation', () => {
		const view = renderDrawer({
			thread: thread([entry({ textTruncated: true })], { truncated: { entries: true, text: true, lineage: true } }),
			loadState: 'ready',
			renderMarkdown: markers([]),
			onClose: 'close',
		})
		const text = allText(view)
		expect(text).toContain('Older turns were omitted')
		expect(text).toContain('Some turn text was shortened.')
		expect(text).toContain('The lineage is incomplete')
		expect(text).toContain('This turn was truncated.')
	})

	test('renders the no-run, loading, error, and empty states', () => {
		const renderMarkdown = markers([])
		const noRun = renderDrawer({ thread: null, loadState: 'idle', renderMarkdown, onClose: 'close' })
		expect(allText(noRun)).toContain('Select a run to see its tasks.')
		const loading = renderDrawer({ thread: null, loadState: 'loading', renderMarkdown, onClose: 'close' })
		expect(allText(loading)).toContain('Loading task history')
		const error = renderDrawer({ thread: null, loadState: 'error', renderMarkdown, onClose: 'close', onRetryLoad: 'retry-load' })
		expect(allText(error)).toContain('Task history could not be loaded')
		const retry = allByTag(error, 'button').find((button) => button.props.class === 'task-history-retry')
		expect(retry === undefined ? null : retry.props.onclick).toBe('retry-load')
		const empty = renderDrawer({ thread: thread([]), loadState: 'ready', renderMarkdown, onClose: 'close' })
		expect(allText(empty)).toContain('No task turns recorded yet.')
	})

	test('pending shows Summarizing and failed offers Retry summary', () => {
		const renderMarkdown = markers([])
		const pending = renderDrawer({ thread: thread([entry()], { summaryState: 'pending' }), loadState: 'ready', renderMarkdown, onClose: 'close' })
		expect(allText(pending)).toContain('Summarizing')
		const timedOut = renderDrawer({ thread: thread([entry()], { summaryState: 'pending' }), loadState: 'ready', renderMarkdown, onClose: 'close', summaryRequestFailed: true, onRetrySummary: 'retry-summary' })
		expect(allText(timedOut)).toContain('Summary unavailable.')
		expect(allText(timedOut)).not.toContain('Summarizing')
		const failed = renderDrawer({ thread: thread([entry()], { summaryState: 'failed' }), loadState: 'ready', renderMarkdown, onClose: 'close', onRetrySummary: 'retry-summary' })
		expect(allText(failed)).toContain('Summary unavailable.')
		const retry = allByTag(failed, 'button').find((button) => button.props.class === 'task-history-summary-retry')
		expect(retry === undefined ? null : retry.props.onclick).toBe('retry-summary')
	})

	test('Close and the backdrop both invoke the close handler', () => {
		const view = renderDrawer({
			thread: thread([entry()]),
			loadState: 'ready',
			renderMarkdown: markers([]),
			onClose: 'close',
		})
		const close = allByTag(view, 'button').find((button) => button.props.class === 'task-history-close')
		expect(close === undefined ? null : close.props.onclick).toBe('close')
		const backdrop = allByTag(view, 'div').find((node) => node.props.class === 'task-history-backdrop')
		expect(backdrop === undefined ? null : backdrop.props.onclick).toBe('close')
	})
})

describe('createTaskHistoryDrawerRenderer', () => {
	test('returns the cached vnode for unchanged props and rebuilds when the thread or flags change', () => {
		const renderer = createTaskHistoryDrawerRenderer()
		const renderMarkdown = markers([])
		const data = thread([entry()])
		const props = { thread: data, loadState: 'ready' as const, renderMarkdown, onClose: 'close' }
		const first = renderer.render(fakeH, props)
		expect(renderer.render(fakeH, props)).toBe(first)
		const nextThread = thread([entry({ text: 'changed' })])
		expect(renderer.render(fakeH, { ...props, thread: nextThread })).not.toBe(first)
		expect(renderer.render(fakeH, { ...props, summaryRequestPending: true })).not.toBe(first)
	})

	test('clear forces a fresh vnode for the same props', () => {
		const renderer = createTaskHistoryDrawerRenderer()
		const renderMarkdown = markers([])
		const props = { thread: thread([entry()]), loadState: 'ready' as const, renderMarkdown, onClose: 'close' }
		const first = renderer.render(fakeH, props)
		renderer.clear()
		expect(renderer.render(fakeH, props)).not.toBe(first)
	})
})
