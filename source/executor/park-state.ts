import { createResultCard } from './errors.js'
import type { ResultCard } from './types.js'

// The platform-known workspace-mutating tools that make a role write-capable (docs/queueing.md "Parking: the pre-write rule"). The checker tools count because they run arbitrary commands; write_plan (run bookkeeping) and edit_context (conversations) deliberately do not.
export const WRITE_CAPABLE_TOOL_NAMES: ReadonlySet<string> = new Set(['write_file', 'run_shell', 'typecheck', 'test'])

export function isWriteCapableRole(toolNames: readonly string[]): boolean {
	return toolNames.some((toolName) => WRITE_CAPABLE_TOOL_NAMES.has(toolName))
}

// The exact summary format of a platform-authored park card. The settlement hook and boot repair recover the question from a terminal meta's result summary by stripping this prefix; a summary without it is a directly-finished needs_clarification whose LLM-authored summary is stored verbatim as the question. Both parse the same way, and the distinction also selects the answer-resume kind: a park replaces its tool result, a direct finish re-enters with a framed note.
export const PARK_SUMMARY_PREFIX = 'waiting for an answer to: '

export function parkSummary(question: string): string {
	return `${PARK_SUMMARY_PREFIX}${question}`
}

export function questionFromParkSummary(summary: string): string {
	return summary.startsWith(PARK_SUMMARY_PREFIX) ? summary.slice(PARK_SUMMARY_PREFIX.length) : summary
}

// A direct finish's question is not necessarily in the checkpointed conversation — a checkpoint predating the finish turn describes a fresh direct finish — so the resume note carries both sides.
export function clarificationAnswerNote(question: string, answer: string): string {
	return `The run paused to ask the operator a question: ${question}\nThe operator answered: ${answer}`
}

// The two shapes of a paused checkpoint: a parked ask whose tool result the answer replaces, or a direct clarification finish whose answer arrives as a framed note. deliveredAnswerId/deliveredAnswerConsumed describe the clarification note already written into the checkpoint: consumed is set once the resumed run wrote its running meta, so an answer checkpointed but never started is still retried.
export type PauseState = { kind: 'parked_ask'; ask: ParkedAsk } | { kind: 'clarification'; deliveredAnswerId?: string; deliveredAnswerConsumed?: boolean }

// The parked question and the tool call it belongs to; both ride the checkpoint so the queue answer can resume the same run and deliver the answer as that call's tool result.
export interface ParkedAsk {
	roleId: string
	// The model tool-call id used to locate the ask's history message and as the queue's answer handle.
	toolCallId: string
	// The invocation identity allocated for the ask.
	callId: string
	questionId: string
	question: string
}

// The operator's answer to a parked ask, delivered into the existing ask_human tool result on resume.
export interface ParkedAnswer {
	question: string
	answer: string
	toolCallId: string
}

// The run-scoped park state (docs/queueing.md "Parking: the pre-write rule"). writeCapableStarted flips once any write-capable role starts and never resets — it rides the checkpoint like learnedContextCeiling so a restart cannot reset it and park a run whose writes happened before the restart. parkedAsk rides the checkpoint and identifies the parked tool call so an answer can resume the same run and replace that call's result; parkedQuestion is the terminate mark the engine checks at every safe point and deliberately does not ride the checkpoint. queueTracked is what activates the pre-write park: the dispatch path (the submission layer's submit — the scheduler is its only caller) sets it on every run dispatched from the task queue, because only such a run's parked question is answerable through the queue's answer endpoint; a run the queue does not track — a boot- or error-resumed run — must never park, and its asks block exactly as they did before queueing, answerable through /api/answer; the queue's answer resume is the one resume that restores the mark.
export interface RunParkTracker {
	writeCapableStarted: boolean
	queueTracked?: boolean
	parkedQuestion?: string
	parkedAsk?: ParkedAsk
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
