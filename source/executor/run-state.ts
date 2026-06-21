import type { AnswerSubmitResult, PendingQuestion, WebHumanBackend } from './human-backend.js'

export interface RunState {
	pendingQuestions(): PendingQuestion[]
	submitAnswer(id: string, answer: string): AnswerSubmitResult
}

export interface RunStateDependencies {
	humanBackend: WebHumanBackend
}

export function createRunState(dependencies: RunStateDependencies): RunState {
	const humanBackend = dependencies.humanBackend
	return {
		pendingQuestions() {
			return humanBackend.pendingQuestions().map((question) => ({ ...question }))
		},
		submitAnswer(id, answer) {
			return humanBackend.submitAnswer(id, answer)
		},
	}
}
