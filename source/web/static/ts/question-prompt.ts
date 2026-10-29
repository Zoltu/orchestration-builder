// Pure derivation of the question prompt the client should show, shared by the flow view, the history rows, and the auto-open path. The module knows only the structural shapes it reads, so neither question source leaks its app-level type in here. Prompt keys are opaque: callers pass `prompt.key` back in rather than parsing or constructing one.

import { isObject } from './guards.js'

// The live endpoint is not run-scoped, so the contract assumes at most one active run and treats the first pending question as that run's question; additional pending entries are ignored.
export interface LiveQuestion {
	id: string
	question: string
	context?: string
}

// The `/api/questions` wire entry: a live question plus the producer's asked-at bookkeeping. A malformed entry is dropped at ingress rather than reaching `live:${undefined}`.
export interface PendingQuestion extends LiveQuestion {
	askedAt: string
}

export interface ParkedQueueItem {
	id: string
	runId?: string
	status: string
	question?: string
}

export type QuestionPrompt =
	| {
		kind: 'live'
		key: string
		runId: string
		questionId: string
		question: string
		context?: string
	}
	| {
		kind: 'parked'
		key: string
		runId: string
		queueItemId: string
		question: string
	}

export interface DeriveQuestionPromptInput {
	pendingQuestions: readonly LiveQuestion[]
	queueItems: readonly ParkedQueueItem[]
	selectedRunId: string | null
	activeRunId: string | null
}

export type QuestionPromptScreen = 'watch' | 'history' | 'compose'

export interface ShouldAutoOpenQuestionPromptInput {
	prompt: QuestionPrompt | null
	screen: QuestionPromptScreen
	selectedRunId: string | null
	openKey: string | null
	// The keys the app has already handled — an answer in flight or landed, a termination, or a dismissal. Callers must add each key on those paths so a handled prompt does not reopen while a different prompt still can.
	suppressedKeys: readonly string[]
}

export interface ResolveQuestionPromptForKeyInput {
	pendingQuestions: readonly LiveQuestion[]
	queueItems: readonly ParkedQueueItem[]
	activeRunId: string | null
	key: string
}

const QUESTION_PROMPT_SUPPRESSED_KEY_LIMIT = 32

// The ingress guard for GET /api/questions: identity, question, and askedAt must be non-empty strings, and context when present must be a string. A malformed entry is dropped rather than stored as a live prompt with an undefined key.
export function isPendingQuestion(value: unknown): value is PendingQuestion {
	if (!isObject(value)) return false
	if (typeof value['id'] !== 'string' || value['id'] === '') return false
	if (typeof value['question'] !== 'string' || value['question'] === '') return false
	if (typeof value['askedAt'] !== 'string' || value['askedAt'] === '') return false
	if (value['context'] !== undefined && typeof value['context'] !== 'string') return false
	return true
}

// A bounded most-recent list: re-suppressing a key moves it to the end, and the oldest fall off past the limit. Handling prompt B must not forget that prompt A was handled, so callers keep a set rather than a single slot.
export function suppressQuestionPromptKey(suppressedKeys: readonly string[], key: string): string[] {
	if (key === '') return [...suppressedKeys]
	const withoutKey = suppressedKeys.filter((existing) => existing !== key)
	const appended = [...withoutKey, key]
	return appended.length > QUESTION_PROMPT_SUPPRESSED_KEY_LIMIT ? appended.slice(appended.length - QUESTION_PROMPT_SUPPRESSED_KEY_LIMIT) : appended
}

function isQuestionPromptSuppressed(suppressedKeys: readonly string[], key: string): boolean {
	return suppressedKeys.includes(key)
}

// A small deterministic FNV-1a hash keeps the opaque parked key bounded while still changing when the question text changes. The length rides along to make accidental collisions even less likely.
function hashQuestionText(text: string): string {
	let hash = 0x811c9dc5
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index)
		hash = Math.imul(hash, 0x01000193)
	}
	return (hash >>> 0).toString(16).padStart(8, '0')
}

function liveQuestionPrompt(question: LiveQuestion, activeRunId: string): QuestionPrompt {
	const key = `live:${activeRunId}:${question.id}`
	if (question.context === undefined) {
		return { kind: 'live', key, runId: activeRunId, questionId: question.id, question: question.question }
	}
	return { kind: 'live', key, runId: activeRunId, questionId: question.id, question: question.question, context: question.context }
}

function deriveLiveQuestionPrompt(pendingQuestions: readonly LiveQuestion[], selectedRunId: string | null, activeRunId: string | null): QuestionPrompt | null {
	if (activeRunId === null) return null
	if (selectedRunId !== activeRunId) return null
	const question = pendingQuestions[0]
	if (question === undefined) return null
	return liveQuestionPrompt(question, activeRunId)
}

function parkedQuestionPrompt(item: ParkedQueueItem): QuestionPrompt | null {
	if (item.status !== 'needs_input') return null
	if (typeof item.question !== 'string' || item.question === '') return null
	if (typeof item.runId !== 'string' || item.runId === '') return null
	// The question identity keeps a re-park on the same item from reusing the suppressed key of the previous question; the same question re-parking keeps the same key and stays suppressed.
	const key = `parked:${item.id}:${item.question.length}:${hashQuestionText(item.question)}`
	return { kind: 'parked', key, runId: item.runId, queueItemId: item.id, question: item.question }
}

function deriveParkedQuestionPrompt(queueItems: readonly ParkedQueueItem[], selectedRunId: string | null, activeRunId: string | null): QuestionPrompt | null {
	if (selectedRunId === null) return null
	// A parked item for the active run is stale: the run is live again (resuming or reconciling), so only a paused selected run can surface a parked question.
	if (selectedRunId === activeRunId) return null
	for (const item of queueItems) {
		if (item.runId !== selectedRunId) continue
		const prompt = parkedQuestionPrompt(item)
		if (prompt !== null) return prompt
	}
	return null
}

export function deriveQuestionPrompt(input: DeriveQuestionPromptInput): QuestionPrompt | null {
	const livePrompt = deriveLiveQuestionPrompt(input.pendingQuestions, input.selectedRunId, input.activeRunId)
	if (livePrompt !== null) return livePrompt
	return deriveParkedQuestionPrompt(input.queueItems, input.selectedRunId, input.activeRunId)
}

// Resolves an open key back to its prompt for rendering, independent of the current selection: a queue row may have opened a prompt for a run other than the selected one. It still applies the source rules: a live key needs an active run, and a parked item whose run has since become active is stale and stops resolving.
export function resolveQuestionPromptForKey(input: ResolveQuestionPromptForKeyInput): QuestionPrompt | null {
	if (input.activeRunId !== null) {
		const question = input.pendingQuestions[0]
		if (question !== undefined) {
			const prompt = liveQuestionPrompt(question, input.activeRunId)
			if (prompt.key === input.key) return prompt
		}
	}
	for (const item of input.queueItems) {
		const prompt = parkedQuestionPrompt(item)
		if (prompt === null) continue
		if (prompt.runId === input.activeRunId) continue
		if (prompt.key === input.key) return prompt
	}
	return null
}

function promptKeyMatches(key: string | null, promptKey: string): boolean {
	return key !== null && key === promptKey
}

export function shouldAutoOpenQuestionPrompt(input: ShouldAutoOpenQuestionPromptInput): boolean {
	const prompt = input.prompt
	if (prompt === null) return false
	if (input.screen !== 'watch') return false
	if (prompt.runId !== input.selectedRunId) return false
	if (promptKeyMatches(input.openKey, prompt.key)) return false
	if (isQuestionPromptSuppressed(input.suppressedKeys, prompt.key)) return false
	return true
}

// Reads one GET /api/questions response. A failed or non-array poll returns null so the caller keeps the held list instead of presenting a transport failure as "no questions"; an array is filtered to its valid entries.
export function readPendingQuestions(ok: boolean, body: unknown): PendingQuestion[] | null {
	if (!ok || !Array.isArray(body)) return null
	return body.filter(isPendingQuestion)
}

// A queue row opens its own item's prompt, but the same stale rule the renderer and key resolver use applies: an item whose run has since become active no longer names a parked prompt.
export interface DeriveQueueRowQuestionPromptInput {
	item: ParkedQueueItem
	activeRunId: string | null
}

export function deriveQueueRowQuestionPrompt(input: DeriveQueueRowQuestionPromptInput): QuestionPrompt | null {
	const prompt = parkedQuestionPrompt(input.item)
	if (prompt === null) return null
	if (prompt.runId === input.activeRunId) return null
	return prompt
}

export interface ReconcileQuestionPromptOpenKeyInput {
	openKey: string | null
	pendingQuestions: readonly LiveQuestion[]
	queueItems: readonly ParkedQueueItem[]
	activeRunId: string | null
}

// Drops an open key whose prompt no longer resolves, so a stale key cannot keep the same question from auto-opening when it returns. The key itself is returned unchanged while it still resolves because keys are opaque.
export function reconcileQuestionPromptOpenKey(input: ReconcileQuestionPromptOpenKeyInput): string | null {
	if (input.openKey === null) return null
	const resolved = resolveQuestionPromptForKey({
		pendingQuestions: input.pendingQuestions,
		queueItems: input.queueItems,
		activeRunId: input.activeRunId,
		key: input.openKey,
	})
	return resolved === null ? null : input.openKey
}

export interface RollbackQuestionPromptHandlingInput {
	promptKey: string
	openKey: string | null
	suppressedKeys: readonly string[]
}

export interface RolledBackQuestionPromptHandling {
	openKey: string | null
	suppressedKeys: string[]
}

// A failed answer or termination rolls its key back out of the suppression set and keeps the prompt open, so a still-needs_input question is not hidden by a failed handling attempt.
export function rollbackQuestionPromptHandling(input: RollbackQuestionPromptHandlingInput): RolledBackQuestionPromptHandling {
	const suppressedKeys = input.suppressedKeys.filter((existing) => existing !== input.promptKey)
	const openKey = input.openKey === null ? input.promptKey : input.openKey
	return { openKey, suppressedKeys }
}

export interface SettleLiveAnswerPromptInput {
	promptKey: string
	ok: boolean
	openKey: string | null
	suppressedKeys: readonly string[]
}

export interface SettledLiveAnswerPrompt {
	openKey: string | null
	suppressedKeys: string[]
}

// A live answer only clears and suppresses its prompt on a successful response. A failed response leaves the prompt open and un-suppressed so the operator can retry.
export function settleLiveAnswerPrompt(input: SettleLiveAnswerPromptInput): SettledLiveAnswerPrompt {
	if (!input.ok) return rollbackQuestionPromptHandling(input)
	const openKey = input.openKey === input.promptKey ? null : input.openKey
	return { openKey, suppressedKeys: suppressQuestionPromptKey(input.suppressedKeys, input.promptKey) }
}
