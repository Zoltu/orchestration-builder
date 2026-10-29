import { describe, expect, test } from 'bun:test'
import { deriveTaskIdentityHeader, TASK_IDENTITY_FALLBACK_TITLE_MAX_CHARS, TaskIdentityHeader } from './header.js'
import type { TaskIdentity, TaskThreadEntry, TaskThreadResponse } from './wire.js'

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

function entry(overrides: Partial<TaskThreadEntry> = {}): TaskThreadEntry {
	return {
		id: 'entry-1',
		sequence: 0,
		runId: 'run-1',
		timestamp: '2026-01-01T00:00:00.000Z',
		kind: 'task',
		actor: 'human',
		label: 'Initial task',
		text: 'Fix the parser',
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

function identity(overrides: Partial<TaskIdentity> = {}): TaskIdentity {
	return {
		runId: 'run-1',
		status: 'success',
		title: 'Fix the parser',
		description: 'Fix the parser.',
		currentTask: { runId: 'run-1', text: 'Fix the parser', at: '2026-01-01T00:00:00.000Z', source: 'meta' },
		originalTask: { runId: 'run-1', text: 'Fix the parser', at: '2026-01-01T00:00:00.000Z', source: 'meta' },
		lineage: {
			rootRunId: 'run-1',
			parentRunId: null,
			continuationCount: 0,
			resumeCount: 0,
			resumeCountComplete: true,
			depth: 0,
			complete: true,
			missingParentRunId: null,
			truncatedReason: null,
		},
		latestHumanEvent: null,
		...overrides,
	}
}

function thread(identityOverrides: Partial<TaskIdentity> = {}, overrides: Partial<TaskThreadResponse> = {}): TaskThreadResponse {
	const baseIdentity = identity(identityOverrides)
	return {
		formatVersion: 1,
		runId: 'run-1',
		identity: baseIdentity,
		entries: [entry()],
		summary: null,
		summaryState: 'none',
		truncated: { entries: false, text: false, lineage: false },
		...overrides,
	}
}

const fallback = { title: 'Fallback title', description: 'Fallback description' }

describe('deriveTaskIdentityHeader', () => {
	test('falls back to the selected run label while the thread is absent, never rendering blank', () => {
		const descriptor = deriveTaskIdentityHeader({ thread: null, fallback, summaryRequestPending: false, summaryRequestFailed: false })
		expect(descriptor.title).toBe('Fallback title')
		expect(descriptor.description).toBe('Fallback description')
		expect(descriptor.usingFallback).toBe(true)
		expect(deriveTaskIdentityHeader({ thread: null, fallback: { title: '', description: null }, summaryRequestPending: false, summaryRequestFailed: false }).title).toBe('No run selected')
	})

	test('uses the generated summary title and description only when ready', () => {
		const summary = { formatVersion: 1 as const, runId: 'run-1', fingerprint: 'fp', title: 'Generated title', description: 'Generated description.', generatedAt: '2026-01-01T00:00:00.000Z' }
		const ready = deriveTaskIdentityHeader({ thread: thread({}, { summary, summaryState: 'ready' }), fallback, summaryRequestPending: false, summaryRequestFailed: false })
		expect(ready.title).toBe('Generated title')
		expect(ready.description).toBe('Generated description.')
		const failed = deriveTaskIdentityHeader({ thread: thread({}, { summary, summaryState: 'failed' }), fallback, summaryRequestPending: false, summaryRequestFailed: false })
		expect(failed.title).toBe('Fix the parser')
		expect(failed.description).toBe('Fix the parser.')
	})

	test('shows the original task only when it differs from the current task', () => {
		const same = deriveTaskIdentityHeader({ thread: thread(), fallback, summaryRequestPending: false, summaryRequestFailed: false })
		expect(same.currentTask).toBe('Fix the parser')
		expect(same.originalTask).toBeNull()
		const different = deriveTaskIdentityHeader({
			thread: thread({
				currentTask: { runId: 'run-2', text: 'Now add tests', at: '2026-01-01T00:00:00.000Z', source: 'meta' },
				originalTask: { runId: 'run-1', text: 'Fix the parser', at: '2026-01-01T00:00:00.000Z', source: 'meta' },
			}),
			fallback,
			summaryRequestPending: false, summaryRequestFailed: false,
		})
		expect(different.currentTask).toBe('Now add tests')
		expect(different.originalTask).toBe('Fix the parser')
	})

	test('carries lineage counts and warns when the lineage is incomplete or truncated', () => {
		const descriptor = deriveTaskIdentityHeader({
			thread: thread({
				lineage: {
					rootRunId: 'run-root',
					parentRunId: 'run-missing',
					continuationCount: 2,
					resumeCount: 3,
					resumeCountComplete: false,
					depth: 2,
					complete: false,
					missingParentRunId: 'run-missing',
					truncatedReason: 'missing_parent',
				},
			}),
			fallback,
			summaryRequestPending: false, summaryRequestFailed: false,
		})
		expect(descriptor.continuationCount).toBe(2)
		expect(descriptor.resumeCount).toBe(3)
		expect(descriptor.lineageWarning === null ? '' : descriptor.lineageWarning.text).toBe('Lineage incomplete')
		expect(descriptor.lineageWarning === null ? '' : descriptor.lineageWarning.title).toContain('run-missing')
	})

	test('builds the latest-human chip from a human answer', () => {
		const latestEntry = entry({ id: 'answer-1', kind: 'answer', actor: 'human', label: 'Answer', text: 'Use PostgreSQL' })
		const descriptor = deriveTaskIdentityHeader({
			thread: thread({ latestHumanEvent: { entryId: 'answer-1', kind: 'answer', label: 'Answer', text: 'Use PostgreSQL', timestamp: latestEntry.timestamp, runId: 'run-1' } }, { entries: [latestEntry] }),
			fallback,
			summaryRequestPending: false, summaryRequestFailed: false,
		})
		expect(descriptor.latestHuman).toEqual({ entryId: 'answer-1', label: 'Answer', text: 'Use PostgreSQL' })
	})

	test('marks the summary pending while the trigger or the server reports pending', () => {
		expect(deriveTaskIdentityHeader({ thread: thread(), fallback, summaryRequestPending: true, summaryRequestFailed: false }).summaryPending).toBe(true)
		expect(deriveTaskIdentityHeader({ thread: thread({}, { summaryState: 'pending' }), fallback, summaryRequestPending: false, summaryRequestFailed: false }).summaryPending).toBe(true)
		expect(deriveTaskIdentityHeader({ thread: thread({}, { summaryState: 'pending' }), fallback, summaryRequestPending: false, summaryRequestFailed: true }).summaryPending).toBe(false)
	})
})

describe('TaskIdentityHeader', () => {
	test('renders the title, tasks, lineage chips, latest-human chip, and Tasks history button as text', () => {
		const latestEntry = entry({ id: 'a-entry', kind: 'answer', actor: 'human', label: 'Answer', text: 'Use PostgreSQL' })
		const data = thread({ latestHumanEvent: { entryId: 'a-entry', kind: 'answer', label: 'Answer', text: 'Use PostgreSQL', timestamp: latestEntry.timestamp, runId: 'run-1' } }, { entries: [latestEntry] })
		const descriptor = deriveTaskIdentityHeader({ thread: data, fallback, summaryRequestPending: false, summaryRequestFailed: false })
		const view = TaskIdentityHeader(fakeH, { descriptor, onOpenHistory: 'history', onLatestHuman: 'latest' })
		const text = allText(view)
		expect(text).toContain('Fix the parser')
		expect(text).toContain('Current task')
		expect(text).toContain('0 continuations')
		expect(text).toContain('0 resumes')
		expect(text).toContain('Use PostgreSQL')
		const buttons = allByTag(view, 'button')
		expect(buttons.some((button) => button.props.class === 'task-identity-history-button')).toBe(true)
		const latest = buttons.find((button) => button.props.class === 'task-identity-human-chip')
		expect(latest === undefined ? null : latest.props.onclick).toBe('latest')
	})

	test('hides the Tasks history button when no run is selected', () => {
		const descriptor = deriveTaskIdentityHeader({ thread: null, fallback: { title: 'No run selected', description: null }, summaryRequestPending: false, summaryRequestFailed: false })
		const view = TaskIdentityHeader(fakeH, { descriptor, onOpenHistory: 'history', historyEnabled: false })
		expect(allByTag(view, 'button').some((button) => button.props.class === 'task-identity-history-button')).toBe(false)
	})
})

describe('fallback title clamping', () => {
	test('clamps a long loading/error fallback title like the deterministic title', () => {
		const longTask = 'x'.repeat(TASK_IDENTITY_FALLBACK_TITLE_MAX_CHARS + 80)
		const descriptor = deriveTaskIdentityHeader({ thread: null, fallback: { title: longTask, description: null }, summaryRequestPending: false, summaryRequestFailed: false })
		expect(descriptor.title.length).toBe(TASK_IDENTITY_FALLBACK_TITLE_MAX_CHARS)
		expect(descriptor.title.endsWith('\u2026')).toBe(true)
	})
})
