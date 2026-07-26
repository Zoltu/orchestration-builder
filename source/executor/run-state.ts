import type { AnswerSubmitResult, PendingQuestion, WebHumanBackend } from './human-backend.js'
import type { InterruptChannel, InterruptRequest, InterruptSubmitResult } from './interrupts.js'

export interface RunState {
	pendingQuestions(): PendingQuestion[]
	submitAnswer(id: string, answer: string): AnswerSubmitResult
	submitInterrupt(request: InterruptRequest): InterruptSubmitResult
	interruptPending(): boolean
}

export interface RunStateDependencies {
	humanBackend: WebHumanBackend
	interruptChannel: InterruptChannel
}

export function createRunState(dependencies: RunStateDependencies): RunState {
	const humanBackend = dependencies.humanBackend
	const interruptChannel = dependencies.interruptChannel
	return {
		pendingQuestions() {
			return humanBackend.pendingQuestions().map((question) => ({ ...question }))
		},
		submitAnswer(id, answer) {
			return humanBackend.submitAnswer(id, answer)
		},
		submitInterrupt(request) {
			return interruptChannel.submit(request)
		},
		interruptPending() {
			return interruptChannel.pending()
		},
	}
}
