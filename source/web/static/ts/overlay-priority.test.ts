import { describe, expect, test } from 'bun:test'
import { topmostAppOverlay } from './overlay-priority.js'

describe('topmostAppOverlay', () => {
	test('the task-history drawer wins over the question prompt and inspector', () => {
		expect(topmostAppOverlay({ taskHistory: true, questionPrompt: true, inspector: true })).toBe('task-history')
	})

	test('the question prompt wins over the inspector when the drawer is closed', () => {
		expect(topmostAppOverlay({ taskHistory: false, questionPrompt: true, inspector: true })).toBe('question-prompt')
	})

	test('the inspector is the fallback and no open overlay yields null', () => {
		expect(topmostAppOverlay({ taskHistory: false, questionPrompt: false, inspector: true })).toBe('inspector')
		expect(topmostAppOverlay({ taskHistory: false, questionPrompt: false, inspector: false })).toBeNull()
	})
})
