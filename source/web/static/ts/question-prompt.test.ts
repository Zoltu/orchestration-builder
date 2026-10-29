import { describe, expect, test } from 'bun:test'
import { deriveQueueRowQuestionPrompt, deriveQuestionPrompt, isPendingQuestion, readPendingQuestions, reconcileQuestionPromptOpenKey, resolveQuestionPromptForKey, rollbackQuestionPromptHandling, settleLiveAnswerPrompt, shouldAutoOpenQuestionPrompt, suppressQuestionPromptKey } from './question-prompt.js'
import type { LiveQuestion, ParkedQueueItem, QuestionPrompt, ShouldAutoOpenQuestionPromptInput } from './question-prompt.js'

function liveQuestion(overrides: Partial<LiveQuestion> = {}): LiveQuestion {
	return { id: 'live-1', question: 'Proceed?', ...overrides }
}

function parkedItem(overrides: Partial<ParkedQueueItem> = {}): ParkedQueueItem {
	return { id: 'queue-1', runId: 'run-1', status: 'needs_input', question: 'Which path?', ...overrides }
}

function requireLivePrompt(prompt: QuestionPrompt | null): Extract<QuestionPrompt, { kind: 'live' }> {
	if (prompt === null || prompt.kind !== 'live') throw new Error('expected a live question prompt')
	return prompt
}

function requireParkedPrompt(prompt: QuestionPrompt | null): Extract<QuestionPrompt, { kind: 'parked' }> {
	if (prompt === null || prompt.kind !== 'parked') throw new Error('expected a parked question prompt')
	return prompt
}

function deriveLivePrompt(questionId: string, runId: string): QuestionPrompt {
	return requireLivePrompt(deriveQuestionPrompt({ pendingQuestions: [liveQuestion({ id: questionId })], queueItems: [], selectedRunId: runId, activeRunId: runId }))
}

function deriveParkedPrompt(queueItemId: string, runId: string): QuestionPrompt {
	return requireParkedPrompt(deriveQuestionPrompt({ pendingQuestions: [], queueItems: [parkedItem({ id: queueItemId, runId })], selectedRunId: runId, activeRunId: null }))
}

function shouldAutoOpen(prompt: QuestionPrompt | null, overrides: Partial<ShouldAutoOpenQuestionPromptInput> = {}): boolean {
	return shouldAutoOpenQuestionPrompt({
		prompt,
		screen: 'watch',
		selectedRunId: 'run-1',
		openKey: null,
		suppressedKeys: [],
		...overrides,
	})
}

function deriveItemPrompt(item: ParkedQueueItem): QuestionPrompt | null {
	return deriveQueueRowQuestionPrompt({ item, activeRunId: null })
}

describe('deriveQuestionPrompt live source', () => {
	test('offers the live question when the selected run is the active run', () => {
		const prompt = requireLivePrompt(deriveQuestionPrompt({ pendingQuestions: [liveQuestion()], queueItems: [], selectedRunId: 'run-1', activeRunId: 'run-1' }))
		expect(prompt.questionId).toBe('live-1')
		expect(prompt.question).toBe('Proceed?')
		expect(prompt.runId).toBe('run-1')
	})

	test('carries the live question context when present', () => {
		const prompt = requireLivePrompt(deriveQuestionPrompt({ pendingQuestions: [liveQuestion({ context: 'Extra context' })], queueItems: [], selectedRunId: 'run-1', activeRunId: 'run-1' }))
		expect(prompt.context).toBe('Extra context')
	})

	test('returns no prompt when the selected run is not the active run', () => {
		const prompt = deriveQuestionPrompt({ pendingQuestions: [liveQuestion()], queueItems: [], selectedRunId: 'run-old', activeRunId: 'run-active' })
		expect(prompt).toBeNull()
	})

	test('returns no live prompt when no run is active', () => {
		const withSelection = deriveQuestionPrompt({ pendingQuestions: [liveQuestion()], queueItems: [], selectedRunId: 'run-1', activeRunId: null })
		const withoutSelection = deriveQuestionPrompt({ pendingQuestions: [liveQuestion()], queueItems: [], selectedRunId: null, activeRunId: null })
		expect(withSelection).toBeNull()
		expect(withoutSelection).toBeNull()
	})

	test('uses the first of multiple pending questions', () => {
		const prompt = requireLivePrompt(deriveQuestionPrompt({ pendingQuestions: [liveQuestion({ id: 'live-1', question: 'First?' }), liveQuestion({ id: 'live-2', question: 'Second?' })], queueItems: [], selectedRunId: 'run-1', activeRunId: 'run-1' }))
		expect(prompt.questionId).toBe('live-1')
		expect(prompt.question).toBe('First?')
	})
})

describe('deriveQuestionPrompt parked source', () => {
	test('offers the parked question for the selected run', () => {
		const prompt = requireParkedPrompt(deriveQuestionPrompt({ pendingQuestions: [], queueItems: [parkedItem()], selectedRunId: 'run-1', activeRunId: null }))
		expect(prompt.queueItemId).toBe('queue-1')
		expect(prompt.question).toBe('Which path?')
		expect(prompt.runId).toBe('run-1')
	})

	test('skips queue items that do not match the selected run', () => {
		const prompt = requireParkedPrompt(deriveQuestionPrompt({ pendingQuestions: [], queueItems: [parkedItem({ id: 'queue-2', runId: 'run-2' }), parkedItem()], selectedRunId: 'run-1', activeRunId: null }))
		expect(prompt.queueItemId).toBe('queue-1')
	})

	test('rejects a parked question for a different run', () => {
		const prompt = deriveQuestionPrompt({ pendingQuestions: [], queueItems: [parkedItem({ runId: 'run-2' })], selectedRunId: 'run-1', activeRunId: null })
		expect(prompt).toBeNull()
	})

	test('rejects a queue item that is not parked on a question', () => {
		const prompt = deriveQuestionPrompt({ pendingQuestions: [], queueItems: [parkedItem({ status: 'waiting' })], selectedRunId: 'run-1', activeRunId: null })
		expect(prompt).toBeNull()
	})

	test('rejects a parked item with no question', () => {
		const missing = deriveQuestionPrompt({ pendingQuestions: [], queueItems: [parkedItem({ question: undefined })], selectedRunId: 'run-1', activeRunId: null })
		const empty = deriveQuestionPrompt({ pendingQuestions: [], queueItems: [parkedItem({ question: '' })], selectedRunId: 'run-1', activeRunId: null })
		expect(missing).toBeNull()
		expect(empty).toBeNull()
	})

	test('rejects a parked item with no run id', () => {
		const prompt = deriveQuestionPrompt({ pendingQuestions: [], queueItems: [parkedItem({ runId: undefined })], selectedRunId: 'run-1', activeRunId: null })
		expect(prompt).toBeNull()
	})

	test('rejects a stale parked item whose run is the active run', () => {
		const prompt = deriveQuestionPrompt({ pendingQuestions: [], queueItems: [parkedItem()], selectedRunId: 'run-1', activeRunId: 'run-1' })
		expect(prompt).toBeNull()
	})

	test('offers the parked question of a paused selected run while another run is active', () => {
		const prompt = requireParkedPrompt(deriveQuestionPrompt({ pendingQuestions: [], queueItems: [parkedItem()], selectedRunId: 'run-1', activeRunId: 'run-2' }))
		expect(prompt.queueItemId).toBe('queue-1')
	})
})

describe('deriveQuestionPrompt precedence', () => {
	test('prefers the live question when a stale parked item also exists', () => {
		const prompt = requireLivePrompt(deriveQuestionPrompt({ pendingQuestions: [liveQuestion()], queueItems: [parkedItem()], selectedRunId: 'run-1', activeRunId: 'run-1' }))
		expect(prompt.questionId).toBe('live-1')
	})

	test('falls back to the parked question when no live question is pending', () => {
		const prompt = requireParkedPrompt(deriveQuestionPrompt({ pendingQuestions: [], queueItems: [parkedItem()], selectedRunId: 'run-1', activeRunId: 'run-2' }))
		expect(prompt.queueItemId).toBe('queue-1')
	})

	test('returns null when neither source is eligible', () => {
		const prompt = deriveQuestionPrompt({ pendingQuestions: [], queueItems: [], selectedRunId: 'run-1', activeRunId: null })
		expect(prompt).toBeNull()
	})
})

describe('question prompt keys', () => {
	test('keeps live keys stable across derivations', () => {
		const first = requireLivePrompt(deriveQuestionPrompt({ pendingQuestions: [liveQuestion()], queueItems: [], selectedRunId: 'run-1', activeRunId: 'run-1' }))
		const second = requireLivePrompt(deriveQuestionPrompt({ pendingQuestions: [liveQuestion()], queueItems: [], selectedRunId: 'run-1', activeRunId: 'run-1' }))
		expect(second.key).toBe(first.key)
	})

	test('keeps parked keys stable across derivations', () => {
		const first = requireParkedPrompt(deriveQuestionPrompt({ pendingQuestions: [], queueItems: [parkedItem()], selectedRunId: 'run-1', activeRunId: null }))
		const second = requireParkedPrompt(deriveQuestionPrompt({ pendingQuestions: [], queueItems: [parkedItem()], selectedRunId: 'run-1', activeRunId: null }))
		expect(second.key).toBe(first.key)
	})

	test('distinguishes live and parked keys', () => {
		const live = requireLivePrompt(deriveQuestionPrompt({ pendingQuestions: [liveQuestion()], queueItems: [], selectedRunId: 'run-1', activeRunId: 'run-1' }))
		const parked = requireParkedPrompt(deriveQuestionPrompt({ pendingQuestions: [], queueItems: [parkedItem()], selectedRunId: 'run-1', activeRunId: null }))
		expect(live.key).not.toBe(parked.key)
	})

	test('distinguishes keys for the same id in different sources', () => {
		const live = requireLivePrompt(deriveQuestionPrompt({ pendingQuestions: [liveQuestion({ id: 'shared-id' })], queueItems: [], selectedRunId: 'run-1', activeRunId: 'run-1' }))
		const parked = requireParkedPrompt(deriveQuestionPrompt({ pendingQuestions: [], queueItems: [parkedItem({ id: 'shared-id' })], selectedRunId: 'run-1', activeRunId: null }))
		expect(live.key).not.toBe(parked.key)
	})
})

describe('shouldAutoOpenQuestionPrompt', () => {
	test('opens only on the watch screen', () => {
		const prompt = deriveLivePrompt('live-1', 'run-1')
		expect(shouldAutoOpen(prompt)).toBe(true)
		expect(shouldAutoOpen(prompt, { screen: 'history' })).toBe(false)
		expect(shouldAutoOpen(prompt, { screen: 'compose' })).toBe(false)
	})

	test('opens only for the selected run', () => {
		const prompt = deriveLivePrompt('live-1', 'run-2')
		expect(shouldAutoOpen(prompt, { selectedRunId: 'run-1' })).toBe(false)
		expect(shouldAutoOpen(prompt, { selectedRunId: null })).toBe(false)
	})

	test('opens a parked prompt for the selected paused run', () => {
		const prompt = deriveParkedPrompt('queue-1', 'run-1')
		expect(shouldAutoOpen(prompt)).toBe(true)
		expect(shouldAutoOpen(prompt, { screen: 'history' })).toBe(false)
	})

	test('suppresses the prompt while its key is already open', () => {
		const prompt = deriveLivePrompt('live-1', 'run-1')
		const other = deriveLivePrompt('live-2', 'run-1')
		expect(shouldAutoOpen(prompt, { openKey: prompt.key })).toBe(false)
		expect(shouldAutoOpen(prompt, { openKey: other.key })).toBe(true)
	})

	test('does not reopen a prompt key suppressed after answering or terminating', () => {
		const prompt = deriveLivePrompt('live-1', 'run-1')
		expect(shouldAutoOpen(prompt, { suppressedKeys: [prompt.key] })).toBe(false)
	})

	test('opens a new prompt after a different key was suppressed', () => {
		const handled = deriveLivePrompt('live-1', 'run-1')
		const next = deriveLivePrompt('live-2', 'run-1')
		expect(shouldAutoOpen(next, { suppressedKeys: [handled.key] })).toBe(true)
	})

	test('does not open without a prompt', () => {
		expect(shouldAutoOpen(null)).toBe(false)
	})
})

describe('deriveQueueRowQuestionPrompt', () => {
	test('derives the same stable key as the selected-run parked derivation', () => {
		const item = parkedItem()
		const direct = requireParkedPrompt(deriveItemPrompt(item))
		const selected = requireParkedPrompt(deriveQuestionPrompt({ pendingQuestions: [], queueItems: [item], selectedRunId: 'run-1', activeRunId: null }))
		expect(direct.key).toBe(selected.key)
		expect(direct.queueItemId).toBe('queue-1')
		expect(direct.question).toBe('Which path?')
	})

	test('rejects an item that is not parked on a question or has no run id', () => {
		expect(deriveItemPrompt(parkedItem({ status: 'waiting' }))).toBeNull()
		expect(deriveItemPrompt(parkedItem({ question: undefined }))).toBeNull()
		expect(deriveItemPrompt(parkedItem({ question: '' }))).toBeNull()
		expect(deriveItemPrompt(parkedItem({ runId: undefined }))).toBeNull()
		expect(deriveItemPrompt(parkedItem({ runId: '' }))).toBeNull()
	})
})

describe('resolveQuestionPromptForKey', () => {
	test('resolves a live key to the prompt whose question is still pending', () => {
		const live = requireLivePrompt(deriveQuestionPrompt({ pendingQuestions: [liveQuestion()], queueItems: [], selectedRunId: 'run-1', activeRunId: 'run-1' }))
		const resolved = resolveQuestionPromptForKey({ pendingQuestions: [liveQuestion()], queueItems: [], activeRunId: 'run-1', key: live.key })
		expect(requireLivePrompt(resolved).questionId).toBe('live-1')
	})

	test('resolves a parked key independent of the selected run', () => {
		const parking = parkedItem({ id: 'queue-9', runId: 'run-parked' })
		const key = requireParkedPrompt(deriveItemPrompt(parking)).key
		const resolved = resolveQuestionPromptForKey({ pendingQuestions: [], queueItems: [parking], activeRunId: 'run-other', key })
		expect(requireParkedPrompt(resolved).queueItemId).toBe('queue-9')
	})

	test('returns null when the key names no current source', () => {
		const live = deriveLivePrompt('live-1', 'run-1')
		expect(resolveQuestionPromptForKey({ pendingQuestions: [], queueItems: [], activeRunId: 'run-1', key: live.key })).toBeNull()
		expect(resolveQuestionPromptForKey({ pendingQuestions: [liveQuestion()], queueItems: [], activeRunId: 'run-1', key: 'parked:missing' })).toBeNull()
	})

	test('does not resolve a live key once no run is active', () => {
		const live = deriveLivePrompt('live-1', 'run-1')
		expect(resolveQuestionPromptForKey({ pendingQuestions: [liveQuestion()], queueItems: [], activeRunId: null, key: live.key })).toBeNull()
	})
})

describe('parked question identity', () => {
	test('a re-park on the same item with a different question gets a new key that auto-opens', () => {
		const first = requireParkedPrompt(deriveItemPrompt(parkedItem({ id: 'queue-1', question: 'Which path?' })))
		const answered = suppressQuestionPromptKey([], first.key)
		const reparked = requireParkedPrompt(deriveItemPrompt(parkedItem({ id: 'queue-1', question: 'Which database?' })))
		expect(reparked.key).not.toBe(first.key)
		expect(shouldAutoOpen(reparked, { suppressedKeys: answered })).toBe(true)
	})

	test('the same item re-parking with the same question keeps the key suppressed', () => {
		const first = requireParkedPrompt(deriveItemPrompt(parkedItem({ id: 'queue-1', question: 'Which path?' })))
		const answered = suppressQuestionPromptKey([], first.key)
		const reparked = requireParkedPrompt(deriveItemPrompt(parkedItem({ id: 'queue-1', question: 'Which path?' })))
		expect(reparked.key).toBe(first.key)
		expect(shouldAutoOpen(reparked, { suppressedKeys: answered })).toBe(false)
	})

	test('different items asking the same question still get different keys', () => {
		const first = requireParkedPrompt(deriveItemPrompt(parkedItem({ id: 'queue-1', question: 'Which path?' })))
		const second = requireParkedPrompt(deriveItemPrompt(parkedItem({ id: 'queue-2', question: 'Which path?' })))
		expect(second.key).not.toBe(first.key)
	})
})

describe('suppressed question keys', () => {
	test('handling a second key keeps the first key suppressed', () => {
		const first = deriveLivePrompt('live-1', 'run-1')
		const second = deriveLivePrompt('live-2', 'run-1')
		const suppressed = suppressQuestionPromptKey(suppressQuestionPromptKey([], first.key), second.key)
		expect(suppressed).toContain(first.key)
		expect(suppressed).toContain(second.key)
	})

	test('re-suppressing a key does not duplicate it', () => {
		const prompt = deriveLivePrompt('live-1', 'run-1')
		const suppressed = suppressQuestionPromptKey(suppressQuestionPromptKey([], prompt.key), prompt.key)
		expect(suppressed).toEqual([prompt.key])
	})

	test('prunes the oldest key once the bounded set is full', () => {
		let suppressed: string[] = []
		for (let index = 0; index < 100; index += 1) suppressed = suppressQuestionPromptKey(suppressed, `live:${index}`)
		expect(suppressed.length).toBeLessThan(100)
		expect(suppressed).not.toContain('live:0')
		expect(suppressed).toContain('live:99')
	})
})

describe('resolveQuestionPromptForKey stale parked rule', () => {
	test('does not resolve a parked key once its run becomes active', () => {
		const item = parkedItem({ id: 'queue-1', runId: 'run-1' })
		const key = requireParkedPrompt(deriveItemPrompt(item)).key
		expect(resolveQuestionPromptForKey({ pendingQuestions: [], queueItems: [item], activeRunId: 'run-1', key })).toBeNull()
	})

	test('still resolves a parked key while another run is active', () => {
		const item = parkedItem({ id: 'queue-1', runId: 'run-1' })
		const key = requireParkedPrompt(deriveItemPrompt(item)).key
		expect(requireParkedPrompt(resolveQuestionPromptForKey({ pendingQuestions: [], queueItems: [item], activeRunId: 'run-2', key })).queueItemId).toBe('queue-1')
	})
})

describe('isPendingQuestion', () => {
	test('accepts a complete live question with or without context', () => {
		expect(isPendingQuestion({ id: 'q1', question: 'Proceed?', askedAt: 't1' })).toBe(true)
		expect(isPendingQuestion({ id: 'q1', question: 'Proceed?', context: 'details', askedAt: 't1' })).toBe(true)
	})

	test('rejects malformed entries before they can form a live key', () => {
		expect(isPendingQuestion(null)).toBe(false)
		expect(isPendingQuestion([])).toBe(false)
		expect(isPendingQuestion({ id: '', question: 'Proceed?', askedAt: 't1' })).toBe(false)
		expect(isPendingQuestion({ id: 'q1', question: '', askedAt: 't1' })).toBe(false)
		expect(isPendingQuestion({ id: 'q1', askedAt: 't1' })).toBe(false)
		expect(isPendingQuestion({ id: 'q1', question: 'Proceed?', askedAt: '' })).toBe(false)
		expect(isPendingQuestion({ id: 'q1', question: 'Proceed?' })).toBe(false)
		expect(isPendingQuestion({ id: 'q1', question: 'Proceed?', context: 7, askedAt: 't1' })).toBe(false)
	})
})

describe('readPendingQuestions', () => {
	test('filters malformed entries from a usable array without discarding the valid ones', () => {
		const questions = readPendingQuestions(true, [{ id: 'q1', question: 'Proceed?', askedAt: 't1' }, { id: '', question: 'bad', askedAt: 't2' }, { id: 'q2', question: 'Again?', askedAt: 't3' }])
		expect(questions?.map((question) => question.id)).toEqual(['q1', 'q2'])
	})

	test('returns null for a failed or non-array poll so the caller keeps its held list', () => {
		expect(readPendingQuestions(false, [])).toBeNull()
		expect(readPendingQuestions(true, null)).toBeNull()
		expect(readPendingQuestions(true, { questions: [] })).toBeNull()
		expect(readPendingQuestions(true, 'unavailable')).toBeNull()
	})
})

describe('reconcileQuestionPromptOpenKey', () => {
	test('clears an open key whose prompt no longer resolves', () => {
		const openKey = requireLivePrompt(deriveQuestionPrompt({ pendingQuestions: [liveQuestion()], queueItems: [], selectedRunId: 'run-1', activeRunId: 'run-1' })).key
		const reconciled = reconcileQuestionPromptOpenKey({ openKey, pendingQuestions: [], queueItems: [], activeRunId: 'run-1' })
		expect(reconciled).toBeNull()
	})

	test('keeps a key that still resolves', () => {
		const prompt = deriveLivePrompt('live-1', 'run-1')
		const reconciled = reconcileQuestionPromptOpenKey({ openKey: prompt.key, pendingQuestions: [liveQuestion()], queueItems: [], activeRunId: 'run-1' })
		expect(reconciled).toBe(prompt.key)
	})

	test('a stale key does not block the same question from auto-opening once it returns', () => {
		const prompt = deriveLivePrompt('live-1', 'run-1')
		const cleared = reconcileQuestionPromptOpenKey({ openKey: prompt.key, pendingQuestions: [], queueItems: [], activeRunId: 'run-1' })
		expect(cleared).toBeNull()
		expect(shouldAutoOpen(prompt, { openKey: cleared })).toBe(true)
	})
})

describe('settleLiveAnswerPrompt', () => {
	test('a failed live answer keeps the prompt open and un-suppressed', () => {
		const prompt = deriveLivePrompt('live-1', 'run-1')
		const settled = settleLiveAnswerPrompt({ promptKey: prompt.key, ok: false, openKey: prompt.key, suppressedKeys: [] })
		expect(settled.openKey).toBe(prompt.key)
		expect(settled.suppressedKeys).toEqual([])
	})

	test('a successful live answer clears its open key and suppresses it', () => {
		const prompt = deriveLivePrompt('live-1', 'run-1')
		const settled = settleLiveAnswerPrompt({ promptKey: prompt.key, ok: true, openKey: prompt.key, suppressedKeys: [] })
		expect(settled.openKey).toBeNull()
		expect(settled.suppressedKeys).toContain(prompt.key)
	})

	test('a successful answer for another key leaves the current open key alone', () => {
		const answered = deriveLivePrompt('live-1', 'run-1')
		const other = deriveLivePrompt('live-2', 'run-1')
		const settled = settleLiveAnswerPrompt({ promptKey: answered.key, ok: true, openKey: other.key, suppressedKeys: [] })
		expect(settled.openKey).toBe(other.key)
	})
})

describe('deferred parked answer suppression', () => {
	test('a suppressed parked key does not reopen when a late poll still shows the item parked', () => {
		const prompt = deriveParkedPrompt('queue-1', 'run-1')
		const suppressedKeys = suppressQuestionPromptKey([], prompt.key)
		const latePollPrompt = requireParkedPrompt(deriveQuestionPrompt({ pendingQuestions: [], queueItems: [parkedItem()], selectedRunId: 'run-1', activeRunId: null }))
		expect(shouldAutoOpen(latePollPrompt, { suppressedKeys })).toBe(false)
	})
})

describe('queue row and renderer agreement', () => {
	test('row-open only yields a key the resolver accepts', () => {
		const item = parkedItem({ id: 'queue-1', runId: 'run-1' })
		const prompt = requireParkedPrompt(deriveQueueRowQuestionPrompt({ item, activeRunId: null }))
		const resolved = requireParkedPrompt(resolveQuestionPromptForKey({ pendingQuestions: [], queueItems: [item], activeRunId: null, key: prompt.key }))
		expect(resolved.key).toBe(prompt.key)
	})

	test('row-open refuses a stale item whose run has become active, matching the resolver', () => {
		const item = parkedItem({ id: 'queue-1', runId: 'run-1' })
		expect(deriveQueueRowQuestionPrompt({ item, activeRunId: 'run-1' })).toBeNull()
		const keyFromOldState = requireParkedPrompt(deriveItemPrompt(item)).key
		expect(resolveQuestionPromptForKey({ pendingQuestions: [], queueItems: [item], activeRunId: 'run-1', key: keyFromOldState })).toBeNull()
	})
})

describe('run-scoped live keys', () => {
	test('the same question id on a different active run gets a different key', () => {
		const first = requireLivePrompt(deriveQuestionPrompt({ pendingQuestions: [liveQuestion()], queueItems: [], selectedRunId: 'run-1', activeRunId: 'run-1' }))
		const second = requireLivePrompt(deriveQuestionPrompt({ pendingQuestions: [liveQuestion()], queueItems: [], selectedRunId: 'run-2', activeRunId: 'run-2' }))
		expect(second.key).not.toBe(first.key)
	})

	test('an open key from the previous active run no longer resolves after a run change', () => {
		const oldPrompt = requireLivePrompt(deriveQuestionPrompt({ pendingQuestions: [liveQuestion()], queueItems: [], selectedRunId: 'run-1', activeRunId: 'run-1' }))
		const resolved = resolveQuestionPromptForKey({ pendingQuestions: [liveQuestion()], queueItems: [], activeRunId: 'run-2', key: oldPrompt.key })
		expect(resolved).toBeNull()
	})
})

describe('rollbackQuestionPromptHandling', () => {
	test('a failed handling removes its key from suppression and reopens the prompt', () => {
		const prompt = deriveLivePrompt('live-1', 'run-1')
		const suppressed = suppressQuestionPromptKey([], prompt.key)
		const rolled = rollbackQuestionPromptHandling({ promptKey: prompt.key, openKey: null, suppressedKeys: suppressed })
		expect(rolled.openKey).toBe(prompt.key)
		expect(rolled.suppressedKeys).not.toContain(prompt.key)
	})

	test('a failed parked answer or terminate keeps other suppressed keys intact', () => {
		const first = deriveParkedPrompt('queue-1', 'run-1')
		const second = deriveParkedPrompt('queue-2', 'run-1')
		const suppressed = suppressQuestionPromptKey(suppressQuestionPromptKey([], first.key), second.key)
		const rolled = rollbackQuestionPromptHandling({ promptKey: second.key, openKey: null, suppressedKeys: suppressed })
		expect(rolled.suppressedKeys).toContain(first.key)
		expect(rolled.suppressedKeys).not.toContain(second.key)
	})

	test('a failed live answer rolls a prior suppression of the same key back too', () => {
		const prompt = deriveLivePrompt('live-1', 'run-1')
		const suppressed = suppressQuestionPromptKey([], prompt.key)
		const settled = settleLiveAnswerPrompt({ promptKey: prompt.key, ok: false, openKey: null, suppressedKeys: suppressed })
		expect(settled.openKey).toBe(prompt.key)
		expect(settled.suppressedKeys).not.toContain(prompt.key)
	})
})
