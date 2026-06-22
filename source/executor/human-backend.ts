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
}

interface PendingEntry {
	question: PendingQuestion
	resolve: (answer: string) => void
}

export function createWebHumanBackend(): WebHumanBackend {
	const pending = new Map<string, PendingEntry>()

	return {
		ask(question, context) {
			const id = crypto.randomUUID()
			const pendingQuestion: PendingQuestion = {
				id,
				question,
				...(context !== undefined ? { context } : {}),
				askedAt: new Date().toISOString(),
			}
			return new Promise<string>((resolve) => {
				pending.set(id, { question: pendingQuestion, resolve })
			})
		},
		submitAnswer(id, answer) {
			const entry = pending.get(id)
			if (entry === undefined) return { kind: 'not_found' }
			pending.delete(id)
			entry.resolve(answer)
			return { kind: 'resolved', question: entry.question }
		},
		pendingQuestions() {
			return Array.from(pending.values(), (entry) => entry.question)
		},
	}
}
