import { isMessage } from './message-validation.js'
import { classifyVersion, ROLE_SNAPSHOT_FORMAT_VERSION } from './orchestration-version.js'
import type { Message } from './types.js'
import { isNonNegativeInteger, isObject, isString } from './validation.js'

export interface RoleSnapshotInput {
	roleId: string
	roleName: string
	depth: number
	task: string
	parentRoleId: string
	finishedAt: string
	history: Message[]
}

export interface RoleSnapshot extends RoleSnapshotInput {
	version: typeof ROLE_SNAPSHOT_FORMAT_VERSION
	runId: string
}

export interface RoleSnapshotSummary {
	roleId: string
	roleName: string
	depth: number
	parentRoleId: string
	finishedAt: string
}

export interface RoleSnapshotStore {
	write(input: RoleSnapshotInput): void
	read(roleId: string): RoleSnapshot | null
	list(): RoleSnapshotSummary[]
}

export function isRoleSnapshot(value: unknown): value is RoleSnapshot {
	if (!isObject(value)) return false
	if (classifyVersion(value, ROLE_SNAPSHOT_FORMAT_VERSION) !== 'current') return false
	if (!isString(value.runId)) return false
	if (!isString(value.roleId)) return false
	if (!isString(value.roleName)) return false
	if (!isNonNegativeInteger(value.depth)) return false
	if (!isString(value.task)) return false
	if (!isString(value.parentRoleId)) return false
	if (!isString(value.finishedAt)) return false
	if (!Array.isArray(value.history) || !value.history.every(isMessage)) return false
	return true
}

// Resolves which finished child a continue_agent call refers to, from the persisted snapshots alone. Only children of the calling parent instance qualify — a parent can never continue another parent's child — and the role name must match. An explicit roleId must be one of those qualified snapshots (an id naming a foreign parent's child is unknown, not a fallback to a name match). Without one, the most recently finished wins, so a parent that has continued a role before continues the latest instance unless it names an earlier one explicitly.
export function selectContinuableChild(summaries: RoleSnapshotSummary[], query: { parentRoleId: string; roleName: string; roleId?: string }): { ok: true; roleId: string } | { ok: false; reason: 'no_finished_child' | 'unknown_id' } {
	const matches = summaries.filter((summary) => summary.parentRoleId === query.parentRoleId && summary.roleName === query.roleName)
	if (query.roleId !== undefined) {
		const exact = matches.find((summary) => summary.roleId === query.roleId)
		if (exact === undefined) return { ok: false, reason: 'unknown_id' }
		return { ok: true, roleId: exact.roleId }
	}
	if (matches.length === 0) return { ok: false, reason: 'no_finished_child' }
	const sorted = [...matches].sort((a, b) => {
		if (a.finishedAt !== b.finishedAt) return a.finishedAt < b.finishedAt ? 1 : -1
		if (a.roleId === b.roleId) return 0
		return a.roleId < b.roleId ? -1 : 1
	})
	const mostRecent = sorted[0]
	if (mostRecent === undefined) return { ok: false, reason: 'no_finished_child' }
	return { ok: true, roleId: mostRecent.roleId }
}

// Removes the terminal finish block from a finished role's history so a continued instance re-enters at the last input boundary rather than replaying its own completion. An implicit finish (a final assistant message with no tool calls) drops that assistant turn. An explicit finish drops the finish tool result and the assistant turn that called it. A batched turn (the finish shares its assistant turn with other tool calls) or an error/interruption termination (whose last assistant turn carries non-finish calls) already ends at a tool/user boundary and is returned unchanged — truncating there would sever a turn the continued instance must see whole.
function truncateTerminalFinishBlock(history: Message[]): Message[] {
	const last = history[history.length - 1]
	if (last === undefined) return history
	if (last.role === 'assistant') {
		if (last.tool_calls === undefined || last.tool_calls.length === 0) return history.slice(0, -1)
		return history
	}
	if (last.role !== 'tool') return history
	let assistantIndex = history.length - 1
	while (assistantIndex >= 0 && history[assistantIndex]?.role === 'tool') assistantIndex--
	const assistant = history[assistantIndex]
	if (assistant === undefined || assistant.role !== 'assistant') return history
	const calls = assistant.tool_calls
	if (calls === undefined || calls.length !== 1 || calls[0]?.function.name !== 'finish') return history
	return history.slice(0, assistantIndex)
}

// The seed for a continued instance. The returned array is always fresh: the caller hands it to a new instance's RoleState.history, and truncateTerminalFinishBlock returns the input array by reference when it makes no change, so copying here keeps the store's array from aliasing the live instance.
export function buildContinuationHistory(history: Message[], comment: string | undefined): Message[] {
	if (comment !== undefined) return [...history, { role: 'user', content: comment }]
	return [...truncateTerminalFinishBlock(history)]
}
