import { askHumanPayload, humanAnswerPayload } from './invocation.js'
import type { AppendLog } from './persistence.js'

export interface HumanAskInvocation {
	// The tool-call id the question is keyed by; the web API answers with this id.
	questionId: string
	callId: string
	parentCallId: string
}

// The executor hands the implementation the identity the invocation journal already allocated. The implementation is responsible for logging ask_human when it starts waiting and human_answer when the answer arrives, using exactly the supplied questionId, callId, and parentCallId so the pair closes the same invocation.
export interface HumanBackend {
	ask(question: string, invocation: HumanAskInvocation, context?: string): Promise<string>
}

export interface PendingQuestion {
	id: string
	question: string
	context?: string
	askedAt: string
}

export type AnswerSubmitResult =
	| { kind: 'resolved'; question: PendingQuestion }
	| { kind: 'not_found' }

export interface WebHumanBackend extends HumanBackend {
	submitAnswer(id: string, answer: string): AnswerSubmitResult
	pendingQuestions(): PendingQuestion[]
	bindRunLog(appendLog: AppendLog | null): void
}

interface PendingEntry {
	question: PendingQuestion
	callId: string
	resolve: (answer: string) => void
}

// The backend is shared across the whole service — the web API's submitAnswer must resolve the promise the executor's ask is awaiting — so the active run's log is bound per-run rather than captured at construction.
// ask and submitAnswer only ever run while a run is active, so the bound log is always the right one when non-null; when null (no run bound, e.g. in unit tests) the log events are skipped.
export function createWebHumanBackend(): WebHumanBackend {
	const pending = new Map<string, PendingEntry>()
	let runLog: AppendLog | null = null

	return {
		bindRunLog(appendLog) {
			runLog = appendLog
		},
		ask(question: string, invocation: HumanAskInvocation, context?: string): Promise<string> {
			const id = invocation.questionId
			const askedAt = new Date().toISOString()
			const pendingQuestion: PendingQuestion = {
				id,
				question,
				...(context !== undefined ? { context } : {}),
				askedAt,
			}
			const log = runLog
			if (log !== null) {
				log({
					timestamp: askedAt,
					type: 'ask_human',
					payload: askHumanPayload({
						questionId: id,
						callId: invocation.callId,
						parentCallId: invocation.parentCallId,
						question,
						...(context !== undefined ? { context } : {}),
					}),
				})
			}
			return new Promise<string>((resolve) => {
				pending.set(id, { question: pendingQuestion, callId: invocation.callId, resolve })
			})
		},
		submitAnswer(id, answer) {
			const entry = pending.get(id)
			if (entry === undefined) return { kind: 'not_found' }
			pending.delete(id)
			const log = runLog
			if (log !== null) {
				log({
					timestamp: new Date().toISOString(),
					type: 'human_answer',
					payload: humanAnswerPayload(id, entry.callId, answer),
				})
			}
			entry.resolve(answer)
			return { kind: 'resolved', question: entry.question }
		},
		pendingQuestions() {
			return Array.from(pending.values(), (entry) => entry.question)
		},
	}
}
