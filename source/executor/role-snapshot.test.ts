import { describe, expect, test } from 'bun:test'

import { buildContinuationHistory, isRoleSnapshot, selectContinuableChild, type RoleSnapshot, type RoleSnapshotSummary } from './role-snapshot.ts'
import type { Message, ToolCall } from './types.ts'

function message(role: Message['role'], content: string, extra: Partial<Message> = {}): Message {
	return { role, content, ...extra }
}

function toolCall(name: string, id: string = 'c1'): ToolCall {
	return { id, type: 'function', function: { name, arguments: '{}' } }
}

function validSnapshot(): RoleSnapshot {
	return {
		version: 1,
		runId: 'run-1',
		roleId: 'coder-1-2',
		roleName: 'coder',
		depth: 1,
		task: 'do it',
		parentRoleId: 'parent-0-1',
		finishedAt: '2026-01-01T00:00:00.000Z',
		history: [message('system', 'p'), message('user', 'do it')],
	}
}

function summary(roleId: string, roleName: string, parentRoleId: string, finishedAt: string): RoleSnapshotSummary {
	return { roleId, roleName, depth: 1, parentRoleId, finishedAt }
}

describe('isRoleSnapshot', () => {
	test('accepts a well-formed snapshot and round-trips it through JSON', () => {
		expect(isRoleSnapshot(validSnapshot())).toBe(true)
		const copy: unknown = JSON.parse(JSON.stringify(validSnapshot()))
		expect(isRoleSnapshot(copy)).toBe(true)
	})

	test('rejects wrong versions, missing fields, bad depth, and malformed history', () => {
		expect(isRoleSnapshot(null)).toBe(false)
		expect(isRoleSnapshot('snapshot')).toBe(false)
		expect(isRoleSnapshot({ ...validSnapshot(), version: 2 })).toBe(false)
		expect(isRoleSnapshot({ ...validSnapshot(), roleId: 7 })).toBe(false)
		expect(isRoleSnapshot({ ...validSnapshot(), parentRoleId: undefined })).toBe(false)
		expect(isRoleSnapshot({ ...validSnapshot(), depth: -1 })).toBe(false)
		expect(isRoleSnapshot({ ...validSnapshot(), depth: 1.5 })).toBe(false)
		expect(isRoleSnapshot({ ...validSnapshot(), history: 'nope' })).toBe(false)
		expect(isRoleSnapshot({ ...validSnapshot(), history: [{ role: 'ghost', content: 'x' }] })).toBe(false)
	})
})

describe('selectContinuableChild', () => {
	test('selects the unique finished child of the parent and role', () => {
		const summaries = [summary('coder-1-2', 'coder', 'parent-0-1', '2026-01-01T00:00:00.000Z')]
		expect(selectContinuableChild(summaries, { parentRoleId: 'parent-0-1', roleName: 'coder' })).toEqual({ ok: true, roleId: 'coder-1-2' })
	})

	test('picks the most recently finished when several match, breaking ties by roleId ascending', () => {
		const summaries = [
			summary('coder-1-2', 'coder', 'parent-0-1', '2026-01-01T00:00:00.000Z'),
			summary('coder-1-4', 'coder', 'parent-0-1', '2026-01-02T00:00:00.000Z'),
			summary('coder-1-3', 'coder', 'parent-0-1', '2026-01-02T00:00:00.000Z'),
		]
		expect(selectContinuableChild(summaries, { parentRoleId: 'parent-0-1', roleName: 'coder' })).toEqual({ ok: true, roleId: 'coder-1-3' })
	})

	test('an explicit roleId picks that exact finished child', () => {
		const summaries = [
			summary('coder-1-2', 'coder', 'parent-0-1', '2026-01-01T00:00:00.000Z'),
			summary('coder-1-4', 'coder', 'parent-0-1', '2026-01-02T00:00:00.000Z'),
		]
		expect(selectContinuableChild(summaries, { parentRoleId: 'parent-0-1', roleName: 'coder', roleId: 'coder-1-2' })).toEqual({ ok: true, roleId: 'coder-1-2' })
	})

	test('an explicit roleId that matches no finished child is unknown_id', () => {
		const summaries = [summary('coder-1-2', 'coder', 'parent-0-1', '2026-01-01T00:00:00.000Z')]
		expect(selectContinuableChild(summaries, { parentRoleId: 'parent-0-1', roleName: 'coder', roleId: 'coder-9-9' })).toEqual({ ok: false, reason: 'unknown_id' })
	})

	test('no matching finished child is no_finished_child', () => {
		expect(selectContinuableChild([], { parentRoleId: 'parent-0-1', roleName: 'coder' })).toEqual({ ok: false, reason: 'no_finished_child' })
		expect(selectContinuableChild([summary('coder-1-2', 'writer', 'parent-0-1', '2026-01-01T00:00:00.000Z')], { parentRoleId: 'parent-0-1', roleName: 'coder' })).toEqual({ ok: false, reason: 'no_finished_child' })
	})

	test('a child of a different parent is excluded, even when named explicitly', () => {
		const summaries = [summary('coder-1-2', 'coder', 'other-0-9', '2026-01-01T00:00:00.000Z')]
		expect(selectContinuableChild(summaries, { parentRoleId: 'parent-0-1', roleName: 'coder' })).toEqual({ ok: false, reason: 'no_finished_child' })
		expect(selectContinuableChild(summaries, { parentRoleId: 'parent-0-1', roleName: 'coder', roleId: 'coder-1-2' })).toEqual({ ok: false, reason: 'unknown_id' })
	})
})

describe('buildContinuationHistory — terminal finish truncation', () => {
	test('drops the final assistant message on an implicit finish', () => {
		const history = [message('system', 'p'), message('user', 'task'), message('assistant', 'all done')]
		expect(buildContinuationHistory(history, undefined)).toEqual([message('system', 'p'), message('user', 'task')])
	})

	test('drops the assistant turn and its tool result on an explicit finish-only turn', () => {
		const history = [
			message('system', 'p'),
			message('user', 'task'),
			message('assistant', '', { tool_calls: [toolCall('finish')] }),
			message('tool', '{"status":"success"}', { tool_call_id: 'c1' }),
		]
		expect(buildContinuationHistory(history, undefined)).toEqual([message('system', 'p'), message('user', 'task')])
	})

	test('leaves a batched turn whose assistant also called other tools unchanged', () => {
		const history = [
			message('system', 'p'),
			message('user', 'task'),
			message('assistant', '', { tool_calls: [toolCall('agent', 'a1'), toolCall('finish', 'f1')] }),
			message('tool', 'child', { tool_call_id: 'a1' }),
			message('tool', '{"status":"success"}', { tool_call_id: 'f1' }),
		]
		expect(buildContinuationHistory(history, undefined)).toEqual(history)
	})

	test('leaves an error-path tool result whose assistant turn called a non-finish tool unchanged', () => {
		const history = [
			message('system', 'p'),
			message('user', 'task'),
			message('assistant', '', { tool_calls: [toolCall('agent', 'a1')] }),
			message('tool', '{"kind":"error"}', { tool_call_id: 'a1' }),
		]
		expect(buildContinuationHistory(history, undefined)).toEqual(history)
	})

	test('leaves a history ending at a user message unchanged', () => {
		const history = [message('system', 'p'), message('user', 'follow-up')]
		expect(buildContinuationHistory(history, undefined)).toEqual(history)
	})

	test('returns an empty history as-is', () => {
		expect(buildContinuationHistory([], undefined)).toEqual([])
	})
})

describe('buildContinuationHistory', () => {
	test('appends exactly one user message when a comment is provided', () => {
		const history = [message('system', 'p'), message('user', 'task')]
		const result = buildContinuationHistory(history, 'keep going')
		expect(result).toEqual([message('system', 'p'), message('user', 'task'), message('user', 'keep going')])
		// The source history is never mutated.
		expect(history.length).toBe(2)
	})

	test('returns a fresh array that does not alias the source history when nothing is appended or truncated', () => {
		const history = [message('system', 'p'), message('user', 'follow-up')]
		const result = buildContinuationHistory(history, undefined)
		expect(result).toEqual(history)
		expect(result).not.toBe(history)
		result.push(message('user', 'later'))
		expect(history.length).toBe(2)
	})
})
