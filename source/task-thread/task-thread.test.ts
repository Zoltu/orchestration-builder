import { describe, expect, test } from 'bun:test'
import type { QueueItemView } from '../executor/queue/model.js'
import type { LogEvent, RunMeta } from '../executor/types.js'
import {
	TASK_IDENTITY_DESCRIPTION_MAX_CHARS,
	TASK_IDENTITY_TITLE_MAX_CHARS,
	TASK_THREAD_FORMAT_VERSION,
	TASK_THREAD_MAX_ENTRIES,
	TASK_THREAD_MAX_ENTRIES_PER_RUN,
	TASK_THREAD_MAX_ENTRY_TEXT_CHARS,
	TASK_THREAD_MAX_LATEST_HUMAN_CHIP_CHARS,
	TASK_THREAD_MAX_LINEAGE_RUNS,
	TASK_THREAD_MAX_TEXT_CHARS,
	isTaskThreadEntry,
	isTaskThreadResponse,
} from './model.js'
import type { TaskThreadEntry, TaskThreadResponse } from './model.js'
import { deriveRunThreadFacts } from './derive.js'
import type { RunThreadFacts } from './derive.js'
import { deriveTaskLineage } from './lineage.js'
import { deriveTaskThread } from './identity.js'
import type { TaskThreadDerivationOptions } from './identity.js'

const RUN_A = 'run-20260101-000000'
const RUN_B = 'run-20260101-000100'
const RUN_C = 'run-20260101-000200'
const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-01-01T00:00:01.000Z'
const T2 = '2026-01-01T00:00:02.000Z'
const T3 = '2026-01-01T00:00:03.000Z'
const T4 = '2026-01-01T00:00:04.000Z'
const T5 = '2026-01-01T00:00:05.000Z'
const T6 = '2026-01-01T00:00:06.000Z'
const T7 = '2026-01-01T00:00:07.000Z'

const OPTIONS: TaskThreadDerivationOptions = {
	maxRuns: TASK_THREAD_MAX_LINEAGE_RUNS,
	maxEntries: TASK_THREAD_MAX_ENTRIES,
	maxEntriesPerRun: TASK_THREAD_MAX_ENTRIES_PER_RUN,
	maxTextChars: TASK_THREAD_MAX_TEXT_CHARS,
	maxLatestHumanChipChars: TASK_THREAD_MAX_LATEST_HUMAN_CHIP_CHARS,
}

function sampleMeta(runId: string, overrides: Partial<RunMeta> = {}): RunMeta {
	const status = overrides.status ?? 'success'
	const base: RunMeta = {
		runId,
		task: 'fix the bug',
		status,
		startTime: T0,
	}
	if (status !== 'running' && status !== 'suspended') base.endTime = T1
	return { ...base, ...overrides }
}

function metaText(runId: string, overrides: Partial<RunMeta> = {}): string {
	return JSON.stringify(sampleMeta(runId, overrides))
}

function event(type: string, payload: unknown, timestamp: string): LogEvent {
	return { timestamp, type, payload }
}

function roleStart(timestamp: string, task: string, options: { role?: string, roleId?: string, depth?: number } = {}): LogEvent {
	return event('role_start', {
		role: options.role ?? 'main',
		roleId: options.roleId ?? 'main-0-1',
		depth: options.depth ?? 0,
		task,
	}, timestamp)
}

function roleFinished(timestamp: string, status: string, options: { role?: string, roleId?: string, depth?: number, summary?: string, paused?: boolean } = {}): LogEvent {
	return event('role_finished', {
		role: options.role ?? 'main',
		roleId: options.roleId ?? 'main-0-1',
		depth: options.depth ?? 0,
		status,
		...(options.summary !== undefined ? { summary: options.summary } : {}),
		...(options.paused === true ? { paused: true } : {}),
	}, timestamp)
}

function ask(timestamp: string, id: string, question: string, context?: string): LogEvent {
	return event('ask_human', { id, question, ...(context !== undefined ? { context } : {}) }, timestamp)
}

function answer(timestamp: string, id: string, text: string, question?: string): LogEvent {
	return event('human_answer', { id, answer: text, ...(question !== undefined ? { question } : {}) }, timestamp)
}

function factsFor(runId: string, events: readonly LogEvent[], overrides: Partial<RunMeta> = {}, queueItems: readonly QueueItemView[] = []): RunThreadFacts {
	return deriveRunThreadFacts({ runId, metaText: metaText(runId, overrides), events, queueItems, logAvailable: true })
}

function factsWithoutMeta(runId: string, events: readonly LogEvent[], queueItems: readonly QueueItemView[] = [], logAvailable = true): RunThreadFacts {
	return deriveRunThreadFacts({ runId, metaText: null, events, queueItems, logAvailable })
}

function lookupOf(...facts: readonly RunThreadFacts[]): (runId: string) => RunThreadFacts | null {
	const byId = new Map<string, RunThreadFacts>()
	for (const fact of facts) byId.set(fact.runId, fact)
	return (runId) => byId.get(runId) ?? null
}

function queueItem(id: string, overrides: Partial<QueueItemView> = {}): QueueItemView {
	return {
		id,
		task: 'queued task',
		status: 'waiting',
		queuedAt: T0,
		...overrides,
	}
}

function defined<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new Error(`${label} is undefined`)
	return value
}

function present<T>(value: T | null, label: string): T {
	if (value === null) throw new Error(`${label} is null`)
	return value
}

function entryById(entries: readonly TaskThreadEntry[], id: string): TaskThreadEntry {
	const found = entries.find((entry) => entry.id === id)
	if (found === undefined) throw new Error(`entry ${id} is missing`)
	return found
}

function entriesOfKind(entries: readonly TaskThreadEntry[], kind: TaskThreadEntry['kind']): TaskThreadEntry[] {
	return entries.filter((entry) => entry.kind === kind)
}

function deriveFrom(current: RunThreadFacts, others: readonly RunThreadFacts[], options: TaskThreadDerivationOptions = OPTIONS) {
	return deriveTaskThread(current, lookupOf(current, ...others), options)
}

describe('tasks', () => {
	test('uses meta.task for the initial task and meta.startTime for its timestamp', () => {
		const facts = factsFor(RUN_A, [roleStart(T2, 'log task')])
		const task = present(facts.task, 'facts.task')
		expect(task.text).toBe('fix the bug')
		expect(task.at).toBe(T0)
		expect(task.source).toBe('meta')
		expect(entryById(facts.entries, `task:${RUN_A}`).label).toBe('Task')
	})

	test('falls back to the first depth-0 role_start task when meta.task is empty', () => {
		const facts = factsFor(RUN_A, [roleStart(T2, 'log task')], { task: '' })
		const task = present(facts.task, 'facts.task')
		expect(task.text).toBe('log task')
		expect(task.at).toBe(T2)
		expect(task.source).toBe('log')
	})

	test('derives a log-only task when meta is absent', () => {
		const facts = factsWithoutMeta(RUN_A, [roleStart(T2, 'recovered task')])
		expect(facts.meta).toBeNull()
		expect(present(facts.task, 'facts.task').text).toBe('recovered task')
	})

	test('labels continuation-run tasks as follow-ups and keeps the root as original', () => {
		const parent = factsFor(RUN_A, [roleStart(T0, 'first task')], { task: 'first task' })
		const child = factsFor(RUN_B, [roleStart(T2, 'second task')], { task: 'second task', continuesFrom: RUN_A, startTime: T2 })
		const derived = deriveFrom(child, [parent])
		expect(derived.identity.originalTask?.runId).toBe(RUN_A)
		expect(derived.identity.originalTask?.text).toBe('first task')
		expect(derived.identity.currentTask?.text).toBe('second task')
		const taskEntries = entriesOfKind(derived.entries, 'task')
		expect(taskEntries.map((entry) => entry.label)).toEqual(['Initial task', 'Follow-up'])
	})
})

describe('ordering and dedupe', () => {
	test('orders by timestamp, then run order, then source order', () => {
		const parent = factsFor(RUN_A, [roleStart(T1, 'first task')], { task: 'first task', startTime: T1 })
		const child = factsFor(RUN_B, [roleStart(T1, 'second task')], { task: 'second task', continuesFrom: RUN_A, startTime: T1 })
		const derived = deriveFrom(child, [parent])
		const tasks = entriesOfKind(derived.entries, 'task')
		expect(tasks.map((entry) => entry.runId)).toEqual([RUN_A, RUN_B])
		const firstTask = defined(tasks[0], 'tasks[0]')
		const secondTask = defined(tasks[1], 'tasks[1]')
		expect(firstTask.sequence).toBeLessThan(secondTask.sequence)
	})

	test('keeps a question before its answer when timestamps tie', () => {
		const facts = factsFor(RUN_A, [roleStart(T0, 'task'), ask(T2, 'q1', 'why?'), answer(T2, 'q1', 'because')])
		const derived = deriveFrom(facts, [])
		const question = entryById(derived.entries, `ask:${RUN_A}:q1`)
		const reply = entryById(derived.entries, `answer:${RUN_A}:q1`)
		expect(question.sequence).toBeLessThan(reply.sequence)
	})

	test('sorts malformed timestamps deterministically after valid ones without Date.parse', () => {
		const facts = factsWithoutMeta(RUN_A, [
			roleStart('not-a-timestamp', 'task'),
			event('plan_modification', { message: 'zulu', aborted: [] }, 'zzz'),
			event('plan_modification', { message: 'alpha', aborted: [] }, 'aaa'),
			event('plan_modification', { message: 'valid', aborted: [] }, T1),
		])
		const derived = deriveFrom(facts, [])
		expect(derived.entries.map((entry) => entry.text)).toEqual(['valid', 'alpha', 'task', 'zulu'])
	})

	test('prefers meta result over a duplicate root role_finished result', () => {
		const facts = factsFor(RUN_A, [roleStart(T0, 'task'), roleFinished(T1, 'success', { summary: 'done' })], {
			result: { status: 'success', summary: 'done' },
		})
		const derived = deriveFrom(facts, [])
		expect(entriesOfKind(derived.entries, 'result').length).toBe(1)
		expect(entryById(derived.entries, `result:${RUN_A}`).text).toBe('done')
	})

	test('prefers meta.suspension over provider_failure and never exposes provider detail', () => {
		const suspension = { category: 'transient' as const, resumePolicy: 'auto' as const, message: 'Provider is down.', suspendedAt: T2 }
		const facts = factsFor(RUN_A, [
			roleStart(T0, 'task'),
			event('provider_failure', { category: 'transient', message: 'provider body', detail: 'RAW SECRET BODY' }, T2),
		], { status: 'suspended', suspension, endTime: undefined })
		const derived = deriveFrom(facts, [])
		const suspensions = derived.entries.filter((entry) => entry.systemKind === 'suspension')
		expect(suspensions.length).toBe(1)
		expect(suspensions[0]?.text).toBe('Provider is down.')
		expect(JSON.stringify(derived.entries)).not.toContain('RAW SECRET BODY')
	})

	test('represents an operator pause as its own system kind with fixed platform copy, never the stored message', () => {
		const pause = { message: 'Agent-written platform wording', pausedAt: T2 }
		const facts = factsFor(RUN_A, [
			roleStart(T0, 'task'),
			event('run_paused', { role: 'main', roleId: 'main-0-1', pausedAt: T2 }, T2),
		], { status: 'suspended', pause, endTime: undefined })
		const derived = deriveFrom(facts, [])
		const pauses = derived.entries.filter((entry) => entry.systemKind === 'operator_pause')
		expect(pauses.length).toBe(1)
		expect(pauses[0]?.text).toBe('The operator paused this run.')
		expect(pauses[0]?.text).not.toContain('Agent-written')
		expect(pauses[0]?.timestamp).toBe(T2)
		expect(derived.identity.status).toBe('suspended')
		expect(derived.entries.some((entry) => entry.systemKind === 'pause')).toBe(false)
	})

	test('falls back to the run_paused log event when a pause meta is unavailable', () => {
		const derived = deriveFrom(factsWithoutMeta(RUN_A, [
			roleStart(T0, 'task'),
			event('run_paused', { role: 'main', roleId: 'main-0-1', pausedAt: T2 }, T2),
		]), [])
		const pauses = derived.entries.filter((entry) => entry.systemKind === 'operator_pause')
		expect(pauses.length).toBe(1)
		expect(pauses[0]?.text).toBe('The operator paused this run.')
		expect(derived.identity.status).toBe('suspended')
	})

	test('dedupes repeated run_resumed and run_terminated events', () => {
		const facts = factsFor(RUN_A, [
			roleStart(T0, 'task'),
			event('run_resumed', { runId: RUN_A, resumedFrames: 1 }, T1),
			event('run_resumed', { runId: RUN_A, resumedFrames: 1 }, T1),
			event('run_terminated', { reason: 'operator', message: 'stopped' }, T2),
			event('run_terminated', { reason: 'operator', message: 'stopped again' }, T3),
		], { status: 'interrupted', endTime: T3, error: { kind: 'interrupted', message: 'meta stop' } })
		const derived = deriveFrom(facts, [])
		expect(facts.resumeCount).toBe(1)
		expect(derived.entries.filter((entry) => entry.systemKind === 'resume').length).toBe(1)
		const terminations = derived.entries.filter((entry) => entry.systemKind === 'termination')
		expect(terminations.length).toBe(1)
		expect(terminations[0]?.text).toBe('stopped')
	})
})

describe('questions and answers', () => {
	test('derives a blocking question and its answer with context and pairing', () => {
		const facts = factsFor(RUN_A, [roleStart(T0, 'task'), ask(T1, 'q1', 'which?', 'context'), answer(T2, 'q1', 'this one')])
		const derived = deriveFrom(facts, [])
		const question = entryById(derived.entries, `ask:${RUN_A}:q1`)
		const reply = entryById(derived.entries, `answer:${RUN_A}:q1`)
		expect(question.text).toBe('which?')
		expect(question.context).toBe('context')
		expect(question.actor).toBe('orchestrator')
		expect(question.outcome).toBe('answered')
		expect(reply.text).toBe('this one')
		expect(reply.actor).toBe('human')
		expect(question.relatedEntryId).toBe(reply.id)
		expect(reply.relatedEntryId).toBe(question.id)
	})

	test('keeps a parked ask as the only question and adds a pause marker', () => {
		const facts = factsFor(RUN_A, [
			roleStart(T0, 'task'),
			ask(T1, 'q1', 'which?'),
			roleFinished(T1, 'needs_clarification', { summary: 'which?', paused: true }),
		], { status: 'needs_clarification', result: { status: 'needs_clarification', summary: 'which?' }, endTime: T1 })
		const derived = deriveFrom(facts, [])
		const questions = entriesOfKind(derived.entries, 'question')
		expect(questions.length).toBe(1)
		expect(questions[0]?.id).toBe(`ask:${RUN_A}:q1`)
		expect(questions[0]?.outcome).toBe('waiting')
		expect(derived.entries.some((entry) => entry.systemKind === 'pause')).toBe(true)
	})
})

describe('direct clarification', () => {
	test('pairs a paused root finish with a clarification human_answer', () => {
		const facts = factsFor(RUN_A, [
			roleStart(T0, 'task'),
			roleFinished(T1, 'needs_clarification', { summary: 'Which database?', paused: true }),
			event('run_resumed', { runId: RUN_A, resumedFrames: 1 }, T2),
			answer(T3, 'clarification', 'Postgres', 'Which database?'),
		])
		const derived = deriveFrom(facts, [])
		const question = entryById(derived.entries, `clarify-question:${RUN_A}:0`)
		const reply = entryById(derived.entries, `clarify-answer:${RUN_A}:0`)
		expect(question.text).toBe('Which database?')
		expect(question.outcome).toBe('answered')
		expect(reply.text).toBe('Postgres')
		expect(question.relatedEntryId).toBe(reply.id)
	})

	test('derives the current unresolved direct clarification and pause marker', () => {
		const facts = factsFor(RUN_A, [
			roleStart(T0, 'task'),
			roleFinished(T1, 'needs_clarification', { summary: 'Which database?', paused: true }),
		], { status: 'needs_clarification', result: { status: 'needs_clarification', summary: 'Which database?' }, endTime: T2 })
		const derived = deriveFrom(facts, [])
		const question = entryById(derived.entries, `clarify-question:${RUN_A}:current`)
		expect(question.text).toBe('Which database?')
		expect(question.outcome).toBe('waiting')
		expect(entriesOfKind(derived.entries, 'question').length).toBe(1)
		expect(derived.entries.some((entry) => entry.systemKind === 'pause')).toBe(true)
	})

	test('keeps the unanswered clarification question when the run is later terminated', () => {
		const facts = factsFor(RUN_A, [
			roleStart(T0, 'task'),
			roleFinished(T1, 'needs_clarification', { summary: 'Which database?', paused: true }),
			event('run_terminated', { reason: 'operator', message: 'Terminated while waiting for an answer.' }, T2),
		], { status: 'interrupted', error: { kind: 'interrupted', message: 'terminated' }, endTime: T2 })
		const derived = deriveFrom(facts, [])
		const question = entryById(derived.entries, `clarify-question:${RUN_A}:current`)
		expect(question.text).toBe('Which database?')
		expect(question.outcome).toBe('waiting')
		expect(derived.entries.some((entry) => entry.systemKind === 'termination')).toBe(true)
	})
})

describe('resume notes and counts', () => {
	test('strips the platform framing from an operator resume note', () => {
		const facts = factsFor(RUN_A, [
			roleStart(T0, 'task'),
			event('run_resumed', { runId: RUN_A, resumedFrames: 1, operatorNote: 'The operator resumed this run after a failure. Message from the operator: try again' }, T1),
			event('run_resumed', { runId: RUN_A, resumedFrames: 1 }, T2),
		])
		const derived = deriveFrom(facts, [])
		expect(facts.resumeCount).toBe(2)
		const notes = entriesOfKind(derived.entries, 'resume_note')
		expect(notes.length).toBe(1)
		expect(notes[0]?.text).toBe('try again')
		expect(derived.entries.filter((entry) => entry.systemKind === 'resume').length).toBe(2)
	})

	test('sums resume counts across the lineage', () => {
		const parentEvents = [roleStart(T0, 'parent'), event('run_resumed', { runId: RUN_A, resumedFrames: 1 }, T1)]
		const childEvents = [
			roleStart(T2, 'child'),
			event('run_resumed', { runId: RUN_B, resumedFrames: 1 }, T3),
			event('run_resumed', { runId: RUN_B, resumedFrames: 1 }, T4),
		]
		const parent = factsFor(RUN_A, parentEvents)
		const child = factsFor(RUN_B, childEvents, { continuesFrom: RUN_A, startTime: T2 })
		const derived = deriveFrom(child, [parent])
		expect(derived.lineage.resumeCount).toBe(3)
		expect(derived.lineage.resumeCountComplete).toBe(true)
	})

	test('marks the resume count incomplete when a run log is unavailable', () => {
		const facts = deriveRunThreadFacts({ runId: RUN_A, metaText: metaText(RUN_A), events: [], queueItems: [], logAvailable: false })
		expect(facts.resumeCount).toBe(0)
		expect(facts.resumeCountComplete).toBe(false)
		expect(deriveFrom(facts, []).lineage.resumeCountComplete).toBe(false)
	})
})

describe('plan modifications, inquiries, and notices', () => {
	test('derives answered inquiries, failed inquiries, dropped inquiries, and plan changes', () => {
		const facts = factsFor(RUN_A, [
			roleStart(T0, 'task'),
			event('interrupt', { trigger: 'inquiry', handler: 'inquiry_responder', target: 'main-0-1', message: 'status?' }, T1),
			event('interrupt_resolved', { trigger: 'inquiry', handler: 'inquiry_responder', target: 'main-0-1', action: 'answered', summary: 'fine' }, T2),
			event('interrupt', { trigger: 'inquiry', handler: 'inquiry_responder', target: 'main-0-1', message: 'really?' }, T3),
			event('interrupt_resolved', { trigger: 'inquiry', handler: 'inquiry_responder', target: 'main-0-1', action: 'failed' }, T4),
			event('inquiry_dropped', { message: 'anyone?', reason: 'no handler' }, T5),
			event('plan_modification', { target: 'main-0-1', targetRole: 'main', message: 'use sessions', aborted: [] }, T6),
		])
		const derived = deriveFrom(facts, [])
		const inquiries = entriesOfKind(derived.entries, 'inquiry')
		expect(inquiries.map((entry) => entry.text)).toEqual(['status?', 'really?', 'anyone?'])
		expect(inquiries.map((entry) => entry.outcome)).toEqual(['answered', 'failed', 'dropped'])
		expect(entriesOfKind(derived.entries, 'inquiry_answer').map((entry) => entry.text)).toEqual(['fine'])
		expect(entriesOfKind(derived.entries, 'plan_modification').map((entry) => entry.text)).toEqual(['use sessions'])
	})

	test('shows an operator notice as a system entry, not a human turn', () => {
		const facts = factsFor(RUN_A, [roleStart(T0, 'task'), event('operator_notice', { role: 'main', roleId: 'main-0-1', message: 'winding down' }, T1)])
		const derived = deriveFrom(facts, [])
		const notice = derived.entries.find((entry) => entry.systemKind === 'notice')
		expect(notice?.text).toBe('winding down')
		expect(notice?.actor).toBe('system')
		expect(derived.latestHumanEvent?.text).toBe('fix the bug')
	})
})

describe('terminal outcomes', () => {
	test('derives success and error result entries from meta', () => {
		const success = factsFor(RUN_A, [roleStart(T0, 'task')], { result: { status: 'success', summary: 'all done' } })
		expect(entryById(deriveFrom(success, []).entries, `result:${RUN_A}`)).toMatchObject({ status: 'success', text: 'all done' })
		const failure = factsFor(RUN_B, [roleStart(T0, 'task')], { status: 'error', error: { kind: 'llm_unavailable', message: 'endpoint down' }, endTime: undefined })
		expect(entryById(deriveFrom(failure, []).entries, `result:${RUN_B}`)).toMatchObject({ status: 'error', text: 'endpoint down' })
	})

	test('derives an interrupted run as a system failure, not a result card', () => {
		const facts = factsFor(RUN_A, [roleStart(T0, 'task')], { status: 'interrupted', error: { kind: 'interrupted', message: 'could not resume' } })
		const derived = deriveFrom(facts, [])
		expect(entriesOfKind(derived.entries, 'result').length).toBe(0)
		const failure = derived.entries.find((entry) => entry.systemKind === 'failure')
		expect(failure?.text).toBe('could not resume')
	})

	test('derives suspension and termination system entries', () => {
		const suspension = { category: 'billing' as const, resumePolicy: 'operator' as const, message: 'Top up.', suspendedAt: T1 }
		const suspended = factsFor(RUN_A, [roleStart(T0, 'task')], { status: 'suspended', suspension, endTime: undefined })
		const suspensionEntries = deriveFrom(suspended, []).entries.filter((entry) => entry.systemKind === 'suspension')
		expect(suspensionEntries.length).toBe(1)
		expect(suspensionEntries[0]?.text).toBe('Top up.')

		const terminated = factsFor(RUN_B, [
			roleStart(T0, 'task'),
			event('run_terminated', { reason: 'operator', message: 'Terminated by the operator while waiting for an answer.' }, T2),
		], { status: 'interrupted', error: { kind: 'interrupted', message: 'meta message' }, endTime: T2 })
		const terminatedEntries = deriveFrom(terminated, []).entries
		expect(terminatedEntries.filter((entry) => entry.systemKind === 'termination').length).toBe(1)
		expect(terminatedEntries.filter((entry) => entry.systemKind === 'failure').length).toBe(0)
	})
})

describe('queue fallbacks', () => {
	test('uses a unique queue continuesFrom edge when meta has none', () => {
		const parent = factsFor(RUN_A, [roleStart(T0, 'parent')], { task: 'parent task' })
		const child = factsFor(RUN_B, [roleStart(T2, 'child')], { task: 'child task', startTime: T2 }, [
			queueItem('item-1', { runId: RUN_B, continuesFrom: RUN_A, status: 'waiting' }),
		])
		const derived = deriveFrom(child, [parent])
		expect(derived.lineage.parentRunId).toBe(RUN_A)
		expect(derived.lineage.continuationCount).toBe(1)
	})

	test('ignores ambiguous queue lineage', () => {
		const child = factsFor(RUN_B, [roleStart(T2, 'child')], {}, [
			queueItem('item-1', { runId: RUN_B, continuesFrom: RUN_A }),
			queueItem('item-2', { runId: RUN_B, continuesFrom: RUN_C }),
		])
		const derived = deriveFrom(child, [])
		expect(derived.lineage.parentRunId).toBeNull()
		expect(derived.lineage.continuationCount).toBe(0)
	})

	test('falls back to a queue needs_input question', () => {
		const facts = factsFor(RUN_A, [roleStart(T0, 'task')], { status: 'needs_clarification', result: { status: 'needs_clarification', summary: '' }, endTime: T1 }, [
			queueItem('item-1', { runId: RUN_A, status: 'needs_input', question: 'Which port?', suspendedAt: T1 }),
		])
		const derived = deriveFrom(facts, [])
		const question = derived.entries.find((entry) => entry.source === 'queue' && entry.kind === 'question')
		expect(question?.text).toBe('Which port?')
		expect(question?.outcome).toBe('waiting')
		expect(question?.queueItemId).toBe('item-1')
	})

	test('falls back to a queue terminal result when meta is absent', () => {
		const facts = factsWithoutMeta(RUN_A, [roleStart(T0, 'task')], [
			queueItem('item-1', { runId: RUN_A, status: 'done', settledAt: T2, resultSummary: 'queued done' }),
		])
		const result = entryById(deriveFrom(facts, []).entries, `queue-result:${RUN_A}`)
		expect(result.status).toBe('success')
		expect(result.text).toBe('queued done')
		expect(result.source).toBe('queue')
		expect(result.queueItemId).toBe('item-1')
	})
})

describe('lineage boundaries', () => {
	test('stops at a missing parent', () => {
		const child = factsFor(RUN_B, [roleStart(T0, 'child')], { continuesFrom: RUN_A })
		const walk = deriveTaskLineage(child, lookupOf(child), TASK_THREAD_MAX_LINEAGE_RUNS)
		expect(walk.runs.length).toBe(1)
		expect(walk.lineage.complete).toBe(false)
		expect(walk.lineage.truncatedReason).toBe('missing_parent')
		expect(walk.lineage.missingParentRunId).toBe(RUN_A)
	})

	test('reports a malformed queue lineage edge', () => {
		const child = factsFor(RUN_B, [roleStart(T0, 'child')], {}, [
			queueItem('item-1', { runId: RUN_B, continuesFrom: 'not-a-run-id' }),
		])
		const walk = deriveTaskLineage(child, lookupOf(child), TASK_THREAD_MAX_LINEAGE_RUNS)
		expect(walk.lineage.complete).toBe(false)
		expect(walk.lineage.truncatedReason).toBe('malformed_parent')
		expect(walk.lineage.missingParentRunId).toBe('not-a-run-id')
	})

	test('detects a cycle', () => {
		const first = factsFor(RUN_A, [roleStart(T0, 'first')], { continuesFrom: RUN_B })
		const second = factsFor(RUN_B, [roleStart(T1, 'second')], { continuesFrom: RUN_A })
		const walk = deriveTaskLineage(first, lookupOf(first, second), TASK_THREAD_MAX_LINEAGE_RUNS)
		expect(walk.runs.length).toBe(2)
		expect(walk.lineage.complete).toBe(false)
		expect(walk.lineage.truncatedReason).toBe('cycle')
	})

	test('caps a deep lineage', () => {
		const current = factsFor(RUN_A, [roleStart(T0, 'current')], { continuesFrom: RUN_B })
		const parent = factsFor(RUN_B, [roleStart(T0, 'parent')], { continuesFrom: RUN_C })
		const grandparent = factsFor(RUN_C, [roleStart(T0, 'grandparent')])
		const walk = deriveTaskLineage(current, lookupOf(current, parent, grandparent), 2)
		expect(walk.runs.length).toBe(2)
		expect(walk.lineage.complete).toBe(false)
		expect(walk.lineage.truncatedReason).toBe('depth')
	})

	test('marks the resume count incomplete whenever the lineage is truncated', () => {
		const child = factsFor(RUN_B, [roleStart(T0, 'child'), event('run_resumed', { runId: RUN_B, resumedFrames: 1 }, T1)], { continuesFrom: RUN_A })
		const walk = deriveTaskLineage(child, lookupOf(child), TASK_THREAD_MAX_LINEAGE_RUNS)
		expect(walk.lineage.truncatedReason).toBe('missing_parent')
		expect(walk.lineage.resumeCount).toBe(1)
		expect(walk.lineage.resumeCountComplete).toBe(false)
	})
})

describe('bounds and latest human event', () => {
	test('keeps the initial task plus the newest entries under the global entry cap', () => {
		const events: LogEvent[] = [roleStart(T0, 'task')]
		for (let index = 1; index <= 6; index++) {
			events.push(event('plan_modification', { message: `plan ${index}`, aborted: [] }, `2026-01-01T00:00:0${index}.000Z`))
		}
		const facts = factsFor(RUN_A, events)
		const derived = deriveFrom(facts, [], { ...OPTIONS, maxEntries: 3 })
		expect(derived.entries.length).toBe(3)
		expect(derived.entries[0]?.kind).toBe('task')
		expect(derived.entries.slice(1).map((entry) => entry.text)).toEqual(['plan 5', 'plan 6'])
		expect(derived.truncated.entries).toBe(true)
	})

	test('caps entries per run', () => {
		const events: LogEvent[] = [roleStart(T0, 'task')]
		for (let index = 1; index <= 6; index++) {
			events.push(event('plan_modification', { message: `plan ${index}`, aborted: [] }, `2026-01-01T00:00:0${index}.000Z`))
		}
		const facts = factsFor(RUN_A, events)
		const derived = deriveFrom(facts, [], { ...OPTIONS, maxEntriesPerRun: 3 })
		expect(derived.entries.length).toBe(3)
		expect(derived.entries.map((entry) => entry.text)).toEqual(['fix the bug', 'plan 5', 'plan 6'])
		expect(derived.truncated.entries).toBe(true)
	})

	test('caps total text and truncates overlong entry text', () => {
		const longText = 'word '.repeat(1000).trim()
		const facts = factsFor(RUN_A, [
			roleStart(T0, 'task'),
			event('plan_modification', { message: longText, aborted: [] }, T1),
			event('plan_modification', { message: longText, aborted: [] }, T2),
		])
		const derived = deriveFrom(facts, [], { ...OPTIONS, maxTextChars: 30 })
		expect(derived.entries.length).toBe(1)
		expect(derived.entries[0]?.text).toBe('fix the bug')
		expect(derived.truncated.text).toBe(true)

		const large = deriveFrom(facts, [], OPTIONS)
		const largeEntry = defined(large.entries.find((entry) => entry.text.startsWith('word')), 'large entry')
		expect(largeEntry.textTruncated).toBe(true)
		expect(largeEntry.text.length).toBeLessThanOrEqual(TASK_THREAD_MAX_ENTRY_TEXT_CHARS)
	})

	test('latest human event skips later system and result entries and caps its chip text', () => {
		const longAnswer = 'a'.repeat(200)
		const facts = factsFor(RUN_A, [
			roleStart(T0, 'task'),
			ask(T1, 'q1', 'which?'),
			answer(T2, 'q1', longAnswer),
			event('run_resumed', { runId: RUN_A, resumedFrames: 1 }, T3),
		], { result: { status: 'success', summary: 'done' } })
		const derived = deriveFrom(facts, [], { ...OPTIONS, maxLatestHumanChipChars: 10 })
		expect(derived.latestHumanEvent?.kind).toBe('answer')
		expect(derived.latestHumanEvent?.text.endsWith('…')).toBe(true)
		expect(derived.latestHumanEvent?.text.length).toBeLessThanOrEqual(10)
	})

	test('keeps the true latest human turn even when truncation drops it from the entries', () => {
		const events: LogEvent[] = [roleStart(T0, 'task'), ask(T1, 'q1', 'which?'), answer(T2, 'q1', 'the real latest human turn')]
		for (let index = 3; index <= 8; index++) {
			events.push(event('run_resumed', { runId: RUN_A, resumedFrames: 1 }, `2026-01-01T00:00:0${index}.000Z`))
		}
		const facts = factsFor(RUN_A, events)
		const derived = deriveFrom(facts, [], { ...OPTIONS, maxEntries: 3 })
		expect(derived.entries.some((entry) => entry.kind === 'answer')).toBe(false)
		expect(derived.latestHumanEvent?.kind).toBe('answer')
		expect(derived.latestHumanEvent?.text).toBe('the real latest human turn')
	})

	test('rejects invalid bounds', () => {
		const facts = factsFor(RUN_A, [roleStart(T0, 'task')])
		expect(() => deriveTaskThread(facts, lookupOf(facts), { ...OPTIONS, maxEntries: 0 })).toThrow()
		expect(() => deriveTaskThread(facts, lookupOf(facts), { ...OPTIONS, maxEntriesPerRun: 0 })).toThrow()
		expect(() => deriveTaskThread(facts, lookupOf(facts), { ...OPTIONS, maxTextChars: 0 })).toThrow()
		expect(() => deriveTaskThread(facts, lookupOf(facts), { ...OPTIONS, maxLatestHumanChipChars: 0 })).toThrow()
		expect(() => deriveTaskLineage(facts, lookupOf(facts), 0)).toThrow()
	})
})

describe('excluded internal events', () => {
	test('never surfaces child-role or handler-role turns', () => {
		const facts = factsFor(RUN_A, [
			roleStart(T0, 'root task'),
			roleStart(T1, 'child secret task', { role: 'coder', roleId: 'coder-1-2', depth: 1 }),
			roleFinished(T2, 'success', { role: 'coder', roleId: 'coder-1-2', depth: 1, summary: 'child secret summary' }),
			roleStart(T3, 'handler secret task', { role: 'handler', roleId: 'handler-0-9', depth: 0 }),
			roleFinished(T4, 'needs_clarification', { role: 'handler', roleId: 'handler-0-9', depth: 0, summary: 'handler secret summary' }),
			event('llm_call', { role: 'coder', roleId: 'coder-1-2', sent: [{ role: 'user', content: 'secret reasoning' }] }, T5),
			event('tool_call', { role: 'coder', tool: 'read_file', arguments: '{}' }, T6),
			event('tool_result', { role: 'coder', tool: 'read_file', result: { kind: 'success' } }, T7),
		], { result: { status: 'success', summary: 'root done' } })
		const derived = deriveFrom(facts, [])
		const serialized = JSON.stringify(derived.entries)
		expect(serialized).not.toContain('child secret')
		expect(serialized).not.toContain('handler secret')
		expect(serialized).not.toContain('secret reasoning')
		expect(entriesOfKind(derived.entries, 'task').map((entry) => entry.text)).toEqual(['fix the bug'])
	})

	test('keeps a child-role ask and its human answer without exposing the child conversation', () => {
		const facts = factsFor(RUN_A, [
			roleStart(T0, 'root task'),
			roleStart(T1, 'child secret task', { role: 'coder', roleId: 'coder-1-2', depth: 1 }),
			ask(T2, 'child-q', 'child question?'),
			answer(T3, 'child-q', 'human answer'),
			roleFinished(T4, 'success', { role: 'coder', roleId: 'coder-1-2', depth: 1, summary: 'child secret summary' }),
		], { result: { status: 'success', summary: 'root done' } })
		const derived = deriveFrom(facts, [])
		const question = entryById(derived.entries, `ask:${RUN_A}:child-q`)
		const reply = entryById(derived.entries, `answer:${RUN_A}:child-q`)
		expect(question.text).toBe('child question?')
		expect(reply.text).toBe('human answer')
		const serialized = JSON.stringify(derived.entries)
		expect(serialized).not.toContain('child secret task')
		expect(serialized).not.toContain('child secret summary')
	})

	test('fails closed when a depth-0 finish has a missing or mismatched roleId', () => {
		const facts = factsWithoutMeta(RUN_A, [
			roleStart(T0, 'root task'),
			roleFinished(T1, 'success', { roleId: 'handler-0-9', summary: 'handler secret' }),
			event('role_finished', { role: 'main', depth: 0, status: 'needs_clarification', summary: 'missing id question', paused: true }, T2),
		])
		const derived = deriveFrom(facts, [])
		expect(entriesOfKind(derived.entries, 'result').length).toBe(0)
		expect(entriesOfKind(derived.entries, 'question').length).toBe(0)
		expect(JSON.stringify(derived.entries)).not.toContain('handler secret')
		expect(JSON.stringify(derived.entries)).not.toContain('missing id question')
	})
})

describe('identity', () => {
	test('derives a deterministic title and description from the current task', () => {
		const facts = factsFor(RUN_A, [roleStart(T0, 'task')], { task: '## Fix the parser\n\nKeep the public API stable.' })
		const derived = deriveFrom(facts, [])
		expect(derived.identity.title).toBe('Fix the parser')
		expect(derived.identity.description).toBe('## Fix the parser')
		expect(derived.identity.title.length).toBeLessThanOrEqual(TASK_IDENTITY_TITLE_MAX_CHARS)
		expect(derived.identity.description.length).toBeLessThanOrEqual(TASK_IDENTITY_DESCRIPTION_MAX_CHARS)
	})

	test('falls back to a run-id title when no task text exists', () => {
		const facts = factsWithoutMeta(RUN_A, [], [], true)
		const derived = deriveFrom(facts, [])
		expect(derived.identity.title).toBe(`Run ${RUN_A}`)
		expect(derived.identity.description).toBe(`Run ${RUN_A}.`)
		expect(derived.identity.latestHumanEvent).toBeNull()
	})

	test('uses the current run status when meta is present', () => {
		const facts = factsFor(RUN_A, [roleStart(T0, 'task')], { status: 'error', error: { kind: 'llm_unavailable', message: 'down' } })
		expect(deriveFrom(facts, []).identity.status).toBe('error')
	})

	test('infers the identity status from a derived result when meta is absent', () => {
		const facts = factsWithoutMeta(RUN_A, [roleStart(T0, 'task'), roleFinished(T1, 'success', { summary: 'done' })])
		const derived = deriveFrom(facts, [])
		expect(derived.identity.status).toBe('success')
	})

	test('does not inherit a parent result status for a log-only continuation', () => {
		const parent = factsFor(RUN_A, [roleStart(T0, 'parent')], { result: { status: 'success', summary: 'parent done' } })
		const child = factsWithoutMeta(RUN_B, [roleStart(T2, 'log-only child')])
		const derived = deriveFrom(child, [parent])
		expect(derived.identity.status).toBe('unknown')
	})

	test('applies a resume after a suspension when meta is unavailable', () => {
		const facts = factsWithoutMeta(RUN_A, [
			roleStart(T0, 'task'),
			event('provider_failure', { category: 'transient', message: 'down' }, T1),
			event('run_resumed', { runId: RUN_A, resumedFrames: 1 }, T2),
		])
		expect(deriveFrom(facts, []).identity.status).toBe('running')
	})

	test('bounds the current and original task text', () => {
		const longTask = 'word '.repeat(1000).trim()
		const parent = factsFor(RUN_B, [roleStart(T0, 'parent')], { task: longTask })
		const child = factsFor(RUN_A, [roleStart(T2, 'child')], { task: longTask, continuesFrom: RUN_B, startTime: T2 })
		const derived = deriveFrom(child, [parent])
		expect(derived.identity.currentTask?.text.length).toBeLessThanOrEqual(TASK_THREAD_MAX_ENTRY_TEXT_CHARS)
		expect(derived.identity.originalTask?.text.length).toBeLessThanOrEqual(TASK_THREAD_MAX_ENTRY_TEXT_CHARS)
	})
})

describe('model guards', () => {
	function validResponse(): TaskThreadResponse {
		const facts = factsFor(RUN_A, [roleStart(T0, 'task')])
		const derived = deriveFrom(facts, [])
		return {
			formatVersion: TASK_THREAD_FORMAT_VERSION,
			runId: RUN_A,
			identity: derived.identity,
			entries: derived.entries,
			summary: null,
			summaryState: 'none',
			truncated: derived.truncated,
		}
	}

	test('accepts a derived thread response and rejects mismatched identity', () => {
		const response = validResponse()
		expect(isTaskThreadResponse(response)).toBe(true)
		expect(isTaskThreadResponse({ ...response, identity: { ...response.identity, runId: RUN_B } })).toBe(false)
	})

	test('rejects malformed entries and illegal field combinations', () => {
		const response = validResponse()
		const first = defined(response.entries[0], 'response.entries[0]')
		expect(isTaskThreadEntry({ ...first, kind: 'unknown' })).toBe(false)
		expect(isTaskThreadEntry({ ...first, kind: 'system', systemKind: null })).toBe(false)
		expect(isTaskThreadEntry({ ...first, kind: 'task', status: 'success' })).toBe(false)
		expect(isTaskThreadEntry({ ...first, kind: 'result', status: null })).toBe(false)
		expect(isTaskThreadEntry({ ...first, kind: 'result', status: 'success', outcome: 'waiting' })).toBe(false)
		expect(isTaskThreadEntry({ ...first, kind: 'question', outcome: 'failed' })).toBe(false)
		expect(isTaskThreadEntry({ ...first, kind: 'answer', outcome: 'answered' })).toBe(false)
		expect(isTaskThreadEntry({ ...first, kind: 'system', actor: 'system', systemKind: 'pause', outcome: 'answered' })).toBe(false)
		expect(isTaskThreadEntry({ ...first, queueItemId: 'item-1', source: 'log' })).toBe(false)
	})

	test('rejects a complete lineage with a truncation reason and an invalid summary state', () => {
		const response = validResponse()
		expect(isTaskThreadResponse({ ...response, identity: { ...response.identity, lineage: { ...response.identity.lineage, complete: true, truncatedReason: 'depth' } } })).toBe(false)
		expect(isTaskThreadResponse({ ...response, summaryState: 'unknown' })).toBe(false)
	})

	test('enforces summary and state correlation', () => {
		const response = validResponse()
		const summary = { formatVersion: 1, runId: RUN_A, fingerprint: 'fp', title: 'Title', description: 'Description.', generatedAt: T0 }
		expect(isTaskThreadResponse({ ...response, summaryState: 'ready', summary })).toBe(true)
		expect(isTaskThreadResponse({ ...response, summaryState: 'ready', summary: null })).toBe(false)
		expect(isTaskThreadResponse({ ...response, summaryState: 'pending', summary })).toBe(false)
	})
})
