import { createResultCard } from './errors.js'
import type { ResultCard } from './types.js'

// The platform-known workspace-mutating tools that make a role write-capable (docs/queueing.md "Parking: the pre-write rule"). The checker tools count because they run arbitrary commands; write_plan (run bookkeeping) and edit_context (conversations) deliberately do not.
export const WRITE_CAPABLE_TOOL_NAMES: ReadonlySet<string> = new Set(['write_file', 'run_shell', 'typecheck', 'test'])

export function isWriteCapableRole(toolNames: readonly string[]): boolean {
	return toolNames.some((toolName) => WRITE_CAPABLE_TOOL_NAMES.has(toolName))
}

// The exact summary format of a platform-authored park card. The settlement hook and boot repair recover the question from a terminal meta's result summary by stripping this prefix; a summary without it is a directly-finished needs_clarification whose LLM-authored summary is stored verbatim as the question — both parse the same way and the distinction affects only the question text's cleanliness.
export const PARK_SUMMARY_PREFIX = 'waiting for an answer to: '

export function parkSummary(question: string): string {
	return `${PARK_SUMMARY_PREFIX}${question}`
}

export function questionFromParkSummary(summary: string): string {
	return summary.startsWith(PARK_SUMMARY_PREFIX) ? summary.slice(PARK_SUMMARY_PREFIX.length) : summary
}

// The run-scoped park state (docs/queueing.md "Parking: the pre-write rule"). writeCapableStarted flips once any write-capable role starts and never resets — it rides the checkpoint like learnedContextCeiling so a restart cannot reset it and park a run whose writes happened before the restart. parkedQuestion records the question of an in-progress park and doubles as the terminate mark the engine checks at every safe point; it deliberately does not ride the checkpoint, because a crash mid-park is resolved by the resumed run re-asking — and, the queue-tracking mark not riding the checkpoint either, blocking on /api/answer as any untracked run does. queueTracked is what activates the pre-write park: the dispatch path (the submission layer's submit — the scheduler is its only caller) sets it on every run dispatched from the task queue, because only such a run's parked question is answerable through the queue's answer endpoint; a run the queue does not track — a boot-resumed run — must never park, and its asks block exactly as they did before queueing, answerable through /api/answer.
export interface RunParkTracker {
	writeCapableStarted: boolean
	queueTracked?: boolean
	parkedQuestion?: string
}

export function createRunParkTracker(writeCapableStarted?: boolean, queueTracked?: boolean): RunParkTracker {
	return {
		writeCapableStarted: writeCapableStarted === true,
		...(queueTracked === true ? { queueTracked: true } : {}),
	}
}

// The platform-authored card every role in a parking run finishes with at its next safe point — the LLM is never asked to author or soften it.
export function parkCard(question: string): ResultCard {
	return createResultCard('needs_clarification', parkSummary(question))
}
