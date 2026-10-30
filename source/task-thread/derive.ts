import type { QueueItemView } from '../executor/queue/model.js'
import type { LogEvent, RunMeta, TerminalRunStatus } from '../executor/types.js'
import { isObject } from '../executor/validation.js'
import { deriveInterruptHistory, deriveQuestionHistory } from '../run-log/derive/history.js'
import type { QuestionHistoryEntry } from '../run-log/derive/history.js'
import { parseRunMeta } from '../run-log/parse.js'
import { numberField, stringField } from '../run-log/payload.js'
import { compareCodeUnits, compareTimestamps, isTimestampAtOrBefore } from './time.js'
import type { TaskPrompt, TaskSystemKind, TaskThreadActor, TaskThreadEntry, TaskThreadEntryKind, TaskThreadEntrySource, TaskThreadOutcome } from './model.js'

export interface TaskThreadRunInput {
	runId: string
	metaText: string | null
	events: readonly LogEvent[]
	queueItems: readonly QueueItemView[]
	logAvailable: boolean
}

export interface RunThreadFacts {
	runId: string
	meta: RunMeta | null
	task: TaskPrompt | null
	entries: TaskThreadEntry[]
	resumeCount: number
	resumeCountComplete: boolean
	queuedContinuesFrom: string | null
}

interface RootStart {
	roleId: string | null
	task: string | null
	timestamp: string | null
}

interface PausedFinish {
	timestamp: string
	text: string
}

interface RootTerminalFinish {
	timestamp: string
	status: 'success' | 'error'
	summary: string | null
}

interface EntryDraft {
	id: string
	timestamp: string
	kind: TaskThreadEntryKind
	actor: TaskThreadActor
	label: string
	text: string
	context?: string | null
	status?: TerminalRunStatus | null
	systemKind?: TaskSystemKind | null
	outcome?: TaskThreadOutcome | null
	questionId?: string | null
	relatedEntryId?: string | null
	queueItemId?: string | null
	source?: TaskThreadEntrySource
	textTruncated?: boolean
}

// Every resume note, whatever the prior run status, ends its platform framing with this stable separator; parsing it locally avoids importing the executor's orchestration constants.
const OPERATOR_NOTE_SEPARATOR = 'Message from the operator: '

// The task thread shows fixed platform copy rather than the stored pause.message, and owning the text locally keeps the thread module from importing the executor upward.
const OPERATOR_PAUSE_DISPLAY_TEXT = 'The operator paused this run.'

function makeEntry(runId: string, sequence: number, draft: EntryDraft): TaskThreadEntry {
	return {
		id: draft.id,
		sequence,
		runId,
		timestamp: draft.timestamp,
		kind: draft.kind,
		actor: draft.actor,
		label: draft.label,
		text: draft.text,
		context: draft.context ?? null,
		status: draft.status ?? null,
		systemKind: draft.systemKind ?? null,
		outcome: draft.outcome ?? null,
		questionId: draft.questionId ?? null,
		relatedEntryId: draft.relatedEntryId ?? null,
		queueItemId: draft.queueItemId ?? null,
		source: draft.source ?? 'log',
		textTruncated: draft.textTruncated ?? false,
	}
}

function pushEntry(entries: TaskThreadEntry[], runId: string, draft: EntryDraft): TaskThreadEntry {
	const entry = makeEntry(runId, entries.length, draft)
	entries.push(entry)
	return entry
}

function deriveRootStart(events: readonly LogEvent[]): RootStart {
	for (const event of events) {
		if (event.type !== 'role_start') continue
		const payload = event.payload
		if (!isObject(payload)) continue
		if (numberField(payload, 'depth') !== 0) continue
		return {
			roleId: stringField(payload, 'roleId'),
			task: stringField(payload, 'task'),
			timestamp: event.timestamp,
		}
	}
	return { roleId: null, task: null, timestamp: null }
}

function isRootRoleFinished(event: LogEvent, rootStart: RootStart): boolean {
	if (event.type !== 'role_finished') return false
	const payload = event.payload
	if (!isObject(payload)) return false
	if (numberField(payload, 'depth') !== 0) return false
	if (rootStart.roleId === null) return false
	return stringField(payload, 'roleId') === rootStart.roleId
}

function deriveTask(runId: string, meta: RunMeta | null, rootStart: RootStart): TaskPrompt | null {
	if (meta !== null && meta.task.trim() !== '') {
		return { runId, text: meta.task, at: meta.startTime, source: 'meta' }
	}
	if (rootStart.task !== null && rootStart.task.trim() !== '') {
		return { runId, text: rootStart.task, at: rootStart.timestamp ?? (meta === null ? '' : meta.startTime), source: 'log' }
	}
	return null
}

function lastEventTimestamp(events: readonly LogEvent[]): string | null {
	const event = events.length === 0 ? undefined : events[events.length - 1]
	return event === undefined ? null : event.timestamp
}

function rootPausedFinishes(events: readonly LogEvent[], rootStart: RootStart): PausedFinish[] {
	const finishes: PausedFinish[] = []
	for (const event of events) {
		if (!isRootRoleFinished(event, rootStart)) continue
		const payload = event.payload
		if (!isObject(payload)) continue
		if (stringField(payload, 'status') !== 'needs_clarification') continue
		if (payload['paused'] !== true) continue
		const summary = stringField(payload, 'summary')
		if (summary === null || summary === '') continue
		finishes.push({ timestamp: event.timestamp, text: summary })
	}
	return finishes
}

function lastRootTerminalFinish(events: readonly LogEvent[], rootStart: RootStart): RootTerminalFinish | null {
	let latest: RootTerminalFinish | null = null
	for (const event of events) {
		if (!isRootRoleFinished(event, rootStart)) continue
		const payload = event.payload
		if (!isObject(payload)) continue
		const status = stringField(payload, 'status')
		if (status !== 'success' && status !== 'error') continue
		latest = { timestamp: event.timestamp, status, summary: stringField(payload, 'summary') }
	}
	return latest
}

function stripResumeNoteFraming(note: string): string {
	const separatorIndex = note.indexOf(OPERATOR_NOTE_SEPARATOR)
	if (separatorIndex < 0) return note.trim()
	return note.slice(separatorIndex + OPERATOR_NOTE_SEPARATOR.length).trim()
}

function deriveQueuedContinuesFrom(runId: string, queueItems: readonly QueueItemView[]): string | null {
	const values = new Set<string>()
	for (const item of queueItems) {
		if (item.runId !== runId) continue
		const continuesFrom = item.continuesFrom
		if (continuesFrom === undefined || continuesFrom === '' || continuesFrom === runId) continue
		values.add(continuesFrom)
	}
	if (values.size !== 1) return null
	for (const value of values) return value
	return null
}

function queueQuestionForRun(runId: string, queueItems: readonly QueueItemView[]): { question: string, at: string, itemId: string } | null {
	const candidates = queueItems
		.filter((item) => item.runId === runId && item.status === 'needs_input' && item.question !== undefined && item.question !== '')
		.slice()
		.sort((left, right) => {
			const leftAt = left.suspendedAt ?? left.queuedAt
			const rightAt = right.suspendedAt ?? right.queuedAt
			const byTimestamp = compareTimestamps(leftAt, rightAt)
			return byTimestamp !== 0 ? byTimestamp : compareCodeUnits(left.id, right.id)
		})
	const first = candidates[0]
	if (first === undefined || first.question === undefined) return null
	return { question: first.question, at: first.suspendedAt ?? first.queuedAt, itemId: first.id }
}

function queueResultForRun(runId: string, queueItems: readonly QueueItemView[]): { status: TerminalRunStatus, text: string, at: string, itemId: string } | null {
	const candidates = queueItems
		.filter((item) => item.runId === runId && (item.status === 'done' || item.status === 'error') && item.settledAt !== undefined)
		.slice()
		.sort((left, right) => {
			const leftAt = left.settledAt ?? left.queuedAt
			const rightAt = right.settledAt ?? right.queuedAt
			const byTimestamp = compareTimestamps(leftAt, rightAt)
			return byTimestamp !== 0 ? byTimestamp : compareCodeUnits(left.id, right.id)
		})
	const latest = candidates[candidates.length - 1]
	if (latest === undefined || latest.settledAt === undefined) return null
	if (latest.status === 'done') {
		const text = latest.resultSummary !== undefined && latest.resultSummary !== '' ? latest.resultSummary : 'Run completed.'
		return { status: 'success', text, at: latest.settledAt, itemId: latest.id }
	}
	const text = latest.error !== undefined && latest.error !== '' ? latest.error : latest.resultSummary !== undefined && latest.resultSummary !== '' ? latest.resultSummary : 'Run failed.'
	return { status: 'error', text, at: latest.settledAt, itemId: latest.id }
}

function providerFailureText(payload: unknown): string {
	const category = stringField(payload, 'category')
	const message = stringField(payload, 'message')
	if (category !== null && message !== null && message !== '') return `Provider failure (${category}): ${message}`
	if (category !== null) return `Provider failure (${category})`
	return 'Provider failure'
}

function resultText(meta: RunMeta): string {
	const summary = meta.result?.summary
	if (summary !== undefined && summary !== '') return summary
	const runError = meta.error?.message
	if (runError !== undefined && runError !== '') return runError
	const cardError = meta.result?.error?.message
	if (cardError !== undefined && cardError !== '') return cardError
	return meta.status === 'success' ? 'Run completed.' : 'Run failed.'
}

function appendTask(entries: TaskThreadEntry[], runId: string, task: TaskPrompt | null): void {
	if (task === null) return
	pushEntry(entries, runId, {
		id: `task:${runId}`,
		timestamp: task.at,
		kind: 'task',
		actor: 'human',
		label: 'Task',
		text: task.text,
		source: task.source,
	})
}

// Every ask_human that reached the human is human-facing, even when emitted by a child or recovery role, because the human answered it; no other child/handler conversation enters the thread.
function appendQuestions(entries: TaskThreadEntry[], runId: string, questionHistory: readonly QuestionHistoryEntry[]): void {
	for (let index = 0; index < questionHistory.length; index++) {
		const question = questionHistory[index]
		if (question === undefined) continue
		const questionId = question.id
		const questionEntryId = `ask:${runId}:${questionId ?? index}`
		const answerEntryId = `answer:${runId}:${questionId ?? index}`
		const questionEntry = pushEntry(entries, runId, {
			id: questionEntryId,
			timestamp: question.askedAt,
			kind: 'question',
			actor: 'orchestrator',
			label: 'Question',
			text: question.question,
			context: question.context ?? null,
			outcome: question.answer === undefined ? 'waiting' : 'answered',
			questionId,
			relatedEntryId: question.answer === undefined ? null : answerEntryId,
		})
		if (question.answer === undefined || question.answeredAt === undefined) continue
		pushEntry(entries, runId, {
			id: answerEntryId,
			timestamp: question.answeredAt,
			kind: 'answer',
			actor: 'human',
			label: 'Answer',
			text: question.answer,
			questionId,
			relatedEntryId: questionEntry.id,
		})
	}
}

function findPausedFinish(pausedFinishes: readonly PausedFinish[], used: ReadonlySet<number>, atOrBefore: string | null): { index: number, finish: PausedFinish | null } {
	let index = -1
	let finish: PausedFinish | null = null
	for (let candidateIndex = 0; candidateIndex < pausedFinishes.length; candidateIndex++) {
		const candidate = pausedFinishes[candidateIndex]
		if (candidate === undefined || used.has(candidateIndex)) continue
		if (atOrBefore !== null && !isTimestampAtOrBefore(candidate.timestamp, atOrBefore)) continue
		index = candidateIndex
		finish = candidate
	}
	if (finish !== null) return { index, finish }
	for (let candidateIndex = 0; candidateIndex < pausedFinishes.length; candidateIndex++) {
		const candidate = pausedFinishes[candidateIndex]
		if (candidate === undefined || used.has(candidateIndex)) continue
		index = candidateIndex
		finish = candidate
	}
	return { index, finish }
}

function appendClarifications(entries: TaskThreadEntry[], runId: string, events: readonly LogEvent[], meta: RunMeta | null, rootStart: RootStart, questionHistory: readonly QuestionHistoryEntry[]): void {
	const pausedFinishes = rootPausedFinishes(events, rootStart)
	const usedPausedFinishes = new Set<number>()
	let clarificationIndex = 0
	let lastClarificationAnswerTimestamp: string | null = null
	for (const event of events) {
		if (event.type !== 'human_answer') continue
		const payload = event.payload
		if (!isObject(payload)) continue
		if (stringField(payload, 'id') !== 'clarification') continue
		const answer = stringField(payload, 'answer')
		if (answer === null) continue
		const payloadQuestion = stringField(payload, 'question')
		const found = findPausedFinish(pausedFinishes, usedPausedFinishes, event.timestamp)
		const questionText = payloadQuestion !== null && payloadQuestion !== '' ? payloadQuestion : found.finish?.text ?? null
		if (questionText === null || questionText === '') continue
		if (found.index >= 0) usedPausedFinishes.add(found.index)
		const questionEntryId = `clarify-question:${runId}:${clarificationIndex}`
		const answerEntryId = `clarify-answer:${runId}:${clarificationIndex}`
		const questionEntry = pushEntry(entries, runId, {
			id: questionEntryId,
			timestamp: found.finish?.timestamp ?? event.timestamp,
			kind: 'question',
			actor: 'orchestrator',
			label: 'Clarification',
			text: questionText,
			outcome: 'answered',
			questionId: 'clarification',
			relatedEntryId: answerEntryId,
		})
		pushEntry(entries, runId, {
			id: answerEntryId,
			timestamp: event.timestamp,
			kind: 'answer',
			actor: 'human',
			label: 'Answer',
			text: answer,
			questionId: 'clarification',
			relatedEntryId: questionEntry.id,
		})
		lastClarificationAnswerTimestamp = event.timestamp
		clarificationIndex++
	}
	const waitingAsk = questionHistory.some((question) => question.answer === undefined)
	if (waitingAsk) return
	if (meta !== null && meta.status !== 'needs_clarification' && meta.status !== 'interrupted') return
	let currentFinish: PausedFinish | null = null
	for (let index = 0; index < pausedFinishes.length; index++) {
		const candidate = pausedFinishes[index]
		if (candidate === undefined || usedPausedFinishes.has(index)) continue
		if (lastClarificationAnswerTimestamp !== null && compareTimestamps(candidate.timestamp, lastClarificationAnswerTimestamp) <= 0) continue
		currentFinish = candidate
	}
	const metaQuestion = meta?.result?.summary !== undefined && meta.result.summary !== '' ? meta.result.summary : null
	const questionText = currentFinish?.text ?? metaQuestion
	if (questionText === null || questionText === '') return
	const timestamp = currentFinish?.timestamp ?? meta?.endTime ?? lastEventTimestamp(events) ?? meta?.startTime
	if (timestamp === undefined) return
	pushEntry(entries, runId, {
		id: `clarify-question:${runId}:current`,
		timestamp,
		kind: 'question',
		actor: 'orchestrator',
		label: 'Clarification',
		text: questionText,
		outcome: 'waiting',
		questionId: 'clarification',
		source: currentFinish === null ? 'meta' : 'log',
	})
}

function appendQueueQuestion(entries: TaskThreadEntry[], runId: string, meta: RunMeta | null, queueItems: readonly QueueItemView[]): void {
	if (meta !== null && meta.status !== 'needs_clarification') return
	if (entries.some((entry) => entry.kind === 'question' && entry.outcome === 'waiting')) return
	const queueQuestion = queueQuestionForRun(runId, queueItems)
	if (queueQuestion === null) return
	pushEntry(entries, runId, {
		id: `queue-question:${runId}`,
		timestamp: queueQuestion.at,
		kind: 'question',
		actor: 'orchestrator',
		label: 'Question',
		text: queueQuestion.question,
		outcome: 'waiting',
		queueItemId: queueQuestion.itemId,
		source: 'queue',
	})
}

function appendPause(entries: TaskThreadEntry[], runId: string, meta: RunMeta | null, events: readonly LogEvent[]): void {
	if (meta === null || meta.status !== 'needs_clarification') return
	pushEntry(entries, runId, {
		id: `pause:${runId}`,
		timestamp: meta.endTime ?? lastEventTimestamp(events) ?? meta.startTime,
		kind: 'system',
		actor: 'system',
		label: 'Paused',
		text: 'Run paused awaiting an answer.',
		systemKind: 'pause',
		source: 'meta',
	})
}

function appendOperatorPause(entries: TaskThreadEntry[], runId: string, meta: RunMeta | null, events: readonly LogEvent[]): void {
	if (meta !== null && meta.status === 'suspended' && meta.pause !== undefined) {
		pushEntry(entries, runId, {
			id: `operator-pause:${runId}`,
			timestamp: meta.pause.pausedAt,
			kind: 'system',
			actor: 'system',
			label: 'Paused',
			text: OPERATOR_PAUSE_DISPLAY_TEXT,
			systemKind: 'operator_pause',
			source: 'meta',
		})
		return
	}
	if (meta !== null) return
	let lastPauseEvent: LogEvent | null = null
	for (const event of events) {
		if (event.type === 'run_paused') lastPauseEvent = event
	}
	if (lastPauseEvent === null) return
	const pausedAt = isObject(lastPauseEvent.payload) ? stringField(lastPauseEvent.payload, 'pausedAt') : null
	pushEntry(entries, runId, {
		id: `operator-pause:${runId}`,
		timestamp: pausedAt ?? lastPauseEvent.timestamp,
		kind: 'system',
		actor: 'system',
		label: 'Paused',
		text: OPERATOR_PAUSE_DISPLAY_TEXT,
		systemKind: 'operator_pause',
	})
}

function appendResumeHistory(entries: TaskThreadEntry[], runId: string, events: readonly LogEvent[]): number {
	const seenResumes = new Set<string>()
	let resumeIndex = 0
	let resumeCount = 0
	for (const event of events) {
		if (event.type !== 'run_resumed') continue
		const payload = event.payload
		const operatorNote = isObject(payload) ? stringField(payload, 'operatorNote') : null
		const resumeKey = `${event.timestamp}\u0000${operatorNote ?? ''}`
		if (seenResumes.has(resumeKey)) continue
		seenResumes.add(resumeKey)
		resumeCount++
		pushEntry(entries, runId, {
			id: `resume:${runId}:${resumeIndex}`,
			timestamp: event.timestamp,
			kind: 'system',
			actor: 'system',
			label: 'Resumed',
			text: 'Run resumed from its checkpoint.',
			systemKind: 'resume',
		})
		if (operatorNote !== null && operatorNote !== '') {
			const note = stripResumeNoteFraming(operatorNote)
			if (note !== '') {
				pushEntry(entries, runId, {
					id: `resume-note:${runId}:${resumeIndex}`,
					timestamp: event.timestamp,
					kind: 'resume_note',
					actor: 'human',
					label: 'Resume note',
					text: note,
				})
			}
		}
		resumeIndex++
	}
	return resumeCount
}

function appendInterruptHistory(entries: TaskThreadEntry[], runId: string, events: readonly LogEvent[]): void {
	const interruptHistory = deriveInterruptHistory([...events])
	for (let index = 0; index < interruptHistory.length; index++) {
		const interrupt = interruptHistory[index]
		if (interrupt === undefined) continue
		if (interrupt.kind === 'plan_modification') {
			pushEntry(entries, runId, {
				id: `plan:${runId}:${index}`,
				timestamp: interrupt.askedAt,
				kind: 'plan_modification',
				actor: 'human',
				label: 'Plan change',
				text: interrupt.message,
			})
			continue
		}
		const inquiryEntryId = `inquiry:${runId}:${index}`
		const answerEntryId = `inquiry-answer:${runId}:${index}`
		const inquiryEntry = pushEntry(entries, runId, {
			id: inquiryEntryId,
			timestamp: interrupt.askedAt,
			kind: 'inquiry',
			actor: 'human',
			label: 'Operator inquiry',
			text: interrupt.message,
			outcome: interrupt.answer !== null ? 'answered' : interrupt.ended ? 'failed' : 'waiting',
			relatedEntryId: interrupt.answer === null ? null : answerEntryId,
		})
		if (interrupt.answer === null || interrupt.answeredAt === null) continue
		pushEntry(entries, runId, {
			id: answerEntryId,
			timestamp: interrupt.answeredAt,
			kind: 'inquiry_answer',
			actor: 'orchestrator',
			label: 'Inquiry answer',
			text: interrupt.answer,
			outcome: 'answered',
			relatedEntryId: inquiryEntry.id,
		})
	}
}

function appendNotices(entries: TaskThreadEntry[], runId: string, events: readonly LogEvent[]): void {
	let droppedInquiryIndex = 0
	let noticeIndex = 0
	for (const event of events) {
		const payload = event.payload
		const message = isObject(payload) ? stringField(payload, 'message') : null
		if (message === null || message === '') continue
		if (event.type === 'inquiry_dropped') {
			pushEntry(entries, runId, {
				id: `inquiry-dropped:${runId}:${droppedInquiryIndex}`,
				timestamp: event.timestamp,
				kind: 'inquiry',
				actor: 'human',
				label: 'Operator inquiry',
				text: message,
				outcome: 'dropped',
			})
			droppedInquiryIndex++
			continue
		}
		if (event.type !== 'operator_notice') continue
		pushEntry(entries, runId, {
			id: `notice:${runId}:${noticeIndex}`,
			timestamp: event.timestamp,
			kind: 'system',
			actor: 'system',
			label: 'Platform notice',
			text: message,
			systemKind: 'notice',
		})
		noticeIndex++
	}
}

function appendSuspension(entries: TaskThreadEntry[], runId: string, meta: RunMeta | null, events: readonly LogEvent[]): void {
	if (meta !== null && meta.status === 'suspended' && meta.suspension !== undefined) {
		pushEntry(entries, runId, {
			id: `suspension:${runId}`,
			timestamp: meta.suspension.suspendedAt,
			kind: 'system',
			actor: 'system',
			label: 'Suspended',
			text: meta.suspension.message,
			systemKind: 'suspension',
			source: 'meta',
		})
		return
	}
	if (meta !== null) return
	let lastProviderFailure: LogEvent | null = null
	for (const event of events) {
		if (event.type === 'provider_failure') lastProviderFailure = event
	}
	if (lastProviderFailure === null) return
	pushEntry(entries, runId, {
		id: `suspension:${runId}`,
		timestamp: lastProviderFailure.timestamp,
		kind: 'system',
		actor: 'system',
		label: 'Suspension',
		text: providerFailureText(lastProviderFailure.payload),
		systemKind: 'suspension',
	})
}

function appendTermination(entries: TaskThreadEntry[], runId: string, meta: RunMeta | null, events: readonly LogEvent[]): void {
	let terminationEvent: LogEvent | null = null
	for (const event of events) {
		if (event.type !== 'run_terminated') continue
		terminationEvent = event
		break
	}
	if (terminationEvent !== null) {
		const message = isObject(terminationEvent.payload) ? stringField(terminationEvent.payload, 'message') : null
		pushEntry(entries, runId, {
			id: `termination:${runId}`,
			timestamp: terminationEvent.timestamp,
			kind: 'system',
			actor: 'system',
			label: 'Terminated',
			text: message !== null && message !== '' ? message : 'Terminated by the operator.',
			systemKind: 'termination',
		})
		return
	}
	if (meta === null || meta.status !== 'interrupted') return
	const message = meta.error !== undefined && meta.error.message !== '' ? meta.error.message : 'Run was interrupted.'
	pushEntry(entries, runId, {
		id: `failure:${runId}`,
		timestamp: meta.endTime ?? lastEventTimestamp(events) ?? meta.startTime,
		kind: 'system',
		actor: 'system',
		label: 'Interrupted',
		text: message,
		systemKind: 'failure',
		source: 'meta',
	})
}

function appendResult(entries: TaskThreadEntry[], runId: string, meta: RunMeta | null, events: readonly LogEvent[], rootStart: RootStart, queueItems: readonly QueueItemView[]): void {
	if (meta !== null && (meta.status === 'success' || meta.status === 'error')) {
		pushEntry(entries, runId, {
			id: `result:${runId}`,
			timestamp: meta.endTime ?? lastEventTimestamp(events) ?? meta.startTime,
			kind: 'result',
			actor: 'orchestrator',
			label: meta.status === 'success' ? 'Completed' : 'Failed',
			text: resultText(meta),
			status: meta.status,
			source: 'meta',
		})
		return
	}
	if (meta !== null) return
	const rootFinish = lastRootTerminalFinish(events, rootStart)
	if (rootFinish !== null) {
		const text = rootFinish.summary !== null && rootFinish.summary !== '' ? rootFinish.summary : rootFinish.status === 'success' ? 'Run completed.' : 'Run failed.'
		pushEntry(entries, runId, {
			id: `result:${runId}`,
			timestamp: rootFinish.timestamp,
			kind: 'result',
			actor: 'orchestrator',
			label: rootFinish.status === 'success' ? 'Completed' : 'Failed',
			text,
			status: rootFinish.status,
		})
		return
	}
	const queueResult = queueResultForRun(runId, queueItems)
	if (queueResult === null) return
	pushEntry(entries, runId, {
		id: `queue-result:${runId}`,
		timestamp: queueResult.at,
		kind: 'result',
		actor: 'orchestrator',
		label: queueResult.status === 'success' ? 'Completed' : 'Failed',
		text: queueResult.text,
		status: queueResult.status,
		queueItemId: queueResult.itemId,
		source: 'queue',
	})
}

export function deriveRunThreadFacts(input: TaskThreadRunInput): RunThreadFacts {
	const parsedMeta = parseRunMeta(input.metaText)
	const meta = parsedMeta !== null && parsedMeta.runId === input.runId ? parsedMeta : null
	const rootStart = deriveRootStart(input.events)
	const task = deriveTask(input.runId, meta, rootStart)
	const entries: TaskThreadEntry[] = []
	appendTask(entries, input.runId, task)
	const questionHistory = deriveQuestionHistory([...input.events])
	appendQuestions(entries, input.runId, questionHistory)
	appendClarifications(entries, input.runId, input.events, meta, rootStart, questionHistory)
	appendQueueQuestion(entries, input.runId, meta, input.queueItems)
	appendPause(entries, input.runId, meta, input.events)
	appendOperatorPause(entries, input.runId, meta, input.events)
	const resumeCount = appendResumeHistory(entries, input.runId, input.events)
	appendInterruptHistory(entries, input.runId, input.events)
	appendNotices(entries, input.runId, input.events)
	appendSuspension(entries, input.runId, meta, input.events)
	appendTermination(entries, input.runId, meta, input.events)
	appendResult(entries, input.runId, meta, input.events, rootStart, input.queueItems)
	return {
		runId: input.runId,
		meta,
		task,
		entries,
		resumeCount,
		resumeCountComplete: input.logAvailable,
		queuedContinuesFrom: deriveQueuedContinuesFrom(input.runId, input.queueItems),
	}
}
