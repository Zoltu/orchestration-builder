import type { AppendLog } from './persistence.js'

export interface HumanBackend {
	ask(question: string, context?: string): Promise<string>
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
	ask(question: string, context?: string): Promise<string>
	submitAnswer(id: string, answer: string): AnswerSubmitResult
	pendingQuestions(): PendingQuestion[]
	bindRunLog(appendLog: AppendLog | null): void
}

interface PendingEntry {
	question: PendingQuestion
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
		ask(question, context) {
			const id = crypto.randomUUID()
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
					payload: {
						id,
						question,
						...(context !== undefined ? { context } : {}),
					},
				})
			}
			return new Promise<string>((resolve) => {
				pending.set(id, { question: pendingQuestion, resolve })
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
					payload: { id, answer },
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
