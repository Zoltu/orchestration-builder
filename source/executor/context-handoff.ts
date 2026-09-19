import { compactHistoryForContextBudget, type ContextCompactionReport } from './context-policy.js'
import { effectiveContextBudget } from './context-pressure.js'
import { createResultCard, createToolError } from './errors.js'
import { runHandlerInterlude } from './interrupt-engine.js'
import type { RoleRegistryEntry } from './role-registry.js'
import { logEvent, type EngineContext, type EngineDependencies, type RoleState, type RunRole } from './engine-state.js'
import type { ResultCard } from './types.js'

// The recovery loop for a context-window rejection: each rejection compacts with a fresh endpoint-reported token count, so the estimate recalibrates on every attempt. Three attempts give the estimate room to converge without letting a hopeless request spin.
export const MAX_CONTEXT_RECOVERY_ATTEMPTS = 3
// Compact to this fraction of the window, leaving headroom for estimator error and the completion reservation.
const CONTEXT_RECOVERY_TARGET_FRACTION = 0.7

// The platform notice a role receives after the executor compacted its conversation following a context-window rejection. It is a user message, not a synthetic tool result: on OpenAI-compatible endpoints a tool message must answer an assistant tool_call, so an orphan tool message would make the recovery request itself a malformed 400.
function contextRecoveryNotice(llmResult: { promptTokens: number; contextWindow: number }, report: ContextCompactionReport): string {
	const sizePart = llmResult.promptTokens > 0 ? ` (~${llmResult.promptTokens} prompt tokens vs window ${llmResult.contextWindow})` : ` (window ${llmResult.contextWindow} tokens)`
	const reasoningPart = report.strippedReasoningMessages > 0
		? `, and cleared reasoning from ${report.strippedReasoningMessages} older messages`
		: '; reasoning was not removed'
	return [
		`[Platform notice — context window exceeded] Your last request to the model was rejected because this conversation had grown past the model's context window${sizePart}.`,
		`The platform compacted this conversation so work can continue: it dropped ${report.droppedMessages} older messages and truncated ${report.truncatedToolMessages} oversized tool results${reasoningPart} (the estimated prompt size is now ~${report.estimatedPromptTokens} tokens).`,
		'Your system prompt, your original task, and your most recent messages are intact.',
		'Continue from your most recent state; re-read files or re-run commands if you need information that was removed.',
		'If the task cannot be completed without the removed context, call finish with status "error" and error.kind "context_budget_exceeded" so the work can be re-delegated in smaller pieces.',
	].join(' ')
}

// The notice a role receives after the context handler compacted its conversation. Unlike the naive backstop's notice there are no drop counts to report — the handler chose what to remove, and its own summary says what.
export function contextManagedNotice(trigger: 'context_pressure' | 'context_budget_exceeded', summary: string): string {
	const reason = trigger === 'context_pressure'
		? 'your conversation crossed the platform\'s context-pressure threshold'
		: 'your last request to the model was rejected because this conversation had grown past the context window'
	return [
		`[Platform notice — context compacted] The platform paused you and the context manager compacted this conversation because ${reason}.`,
		`The context manager reports: ${summary}`,
		'Your system prompt, your original task, and your most recent messages should be intact.',
		'Continue from your most recent state; re-read files or re-run commands if you need information that was removed.',
	].join(' ')
}

export function contextExceededCard(reason: string): { kind: 'finished'; card: ResultCard } {
	return {
		kind: 'finished',
		card: createResultCard('error', reason, { error: createToolError('context_budget_exceeded', reason) }),
	}
}

// The naive in-place backstop for a context-window rejection: drop the oldest turns, truncate oversized surviving tool results, strip reasoning from the oldest survivors as a last resort, then resume with a platform notice (see compactHistoryForContextBudget). Returns the terminal card when even the undeletable remainder cannot fit, null when the compacted role may continue. Used directly when no context handler is configured, and as the fallback when the handler cannot do better.
export function applyContextBackstop(roleState: RoleState, deps: EngineDependencies, context: EngineContext, rejection: { promptTokens: number; contextWindow: number }): ResultCard | null {
	const report = compactHistoryForContextBudget(roleState.history, {
		contextWindow: rejection.contextWindow,
		promptTokens: rejection.promptTokens,
		targetFraction: CONTEXT_RECOVERY_TARGET_FRACTION,
	})
	roleState.history = report.history
	// The compaction rewrote the history out from under the llm_call delta baseline — truncation changes content without changing length, so the emission's length check cannot see it — forcing the role's next llm_call to log a full snapshot.
	roleState.logSentBaseline = undefined
	if (!report.fits) {
		return createResultCard('error', 'Context window exceeded and the conversation cannot be compacted enough to continue', {
			error: createToolError('context_budget_exceeded', 'Context window exceeded and the conversation cannot be compacted enough to continue'),
		})
	}
	logEvent(deps.appendLog, 'context_compacted', {
		role: context.roleName,
		droppedMessages: report.droppedMessages,
		truncatedToolMessages: report.truncatedToolMessages,
		strippedReasoningMessages: report.strippedReasoningMessages,
		estimatedPromptTokens: report.estimatedPromptTokens,
		contextWindow: rejection.contextWindow,
	})
	roleState.history.push({ role: 'user', content: contextRecoveryNotice(rejection, report) })
	return null
}

// The effective budget a role's reported prompt size is measured against: the static math (window minus the reserved completion budget) tightened by whatever the run has learned from endpoint rejections.
export function currentEffectiveBudget(context: EngineContext, deps: EngineDependencies): number {
	const modelConfig = context.loadedGuild.deployment.model
	return effectiveContextBudget(modelConfig.contextWindow, modelConfig.generation.maxTokens ?? 0, deps.contextPressureTracker.learnedCeiling)
}

// The one-shot notice a role receives when its reported prompt size crosses the pressure threshold, asking it to hand off while it still has its full context — the working agent is the best-qualified summarizer of its own work, and a fresh small conversation is the cache-cheapest continuation. The entry role's own prompt teaches it to read the notice as "wrap the run toward a resumable checkpoint" instead, since no parent can re-spawn it.
export function contextPressureNotice(promptTokens: number, effectiveBudget: number): string {
	const percent = effectiveBudget > 0 ? Math.round((100 * promptTokens) / effectiveBudget) : 100
	return [
		`[Platform notice — context pressure] Your conversation has reached ${percent}% of the effective context budget (~${promptTokens} prompt tokens of ~${effectiveBudget}).`,
		'Do not start new major work.',
		'At the next safe point, call finish with status "error" and error.kind "context_handoff", and write the summary as a handoff brief for the fresh agent that will replace you: what is done, what remains, key file paths, decisions made, and the immediate next step.',
	].join(' ')
}

// The context-compaction interlude (runHandlerInterlude in interrupt-engine.ts) for the two context triggers. The target always resumes afterwards: a successful handler leaves a compacted history; a failed one leaves the history untouched and the caller falls back (the handoff notice at depth 0, the naive backstop at the wall).
export async function runContextManagerHandler(
	runRole: RunRole,
	deps: EngineDependencies,
	context: EngineContext,
	entry: RoleRegistryEntry,
	trigger: 'context_pressure' | 'context_budget_exceeded',
	reported: { promptTokens: number; budgetTokens: number },
): Promise<ResultCard> {
	const config = context.loadedGuild.deployment.executor
	const handlerRole = config.contextHandlerRole
	if (handlerRole === undefined) throw new Error('runContextManagerHandler called without executor.contextHandlerRole configured')
	const task = trigger === 'context_pressure'
		? [
			`The platform flagged role instance "${entry.roleId}" (role "${context.roleName}"): its conversation crossed the context-pressure threshold (${reported.promptTokens} reported prompt tokens against an effective budget of ${reported.budgetTokens}).`,
			`Compact its conversation now: inspect it with list_role_messages, read_message_window, and search_role_blocks, prune it with edit_context (targetRole "${entry.roleId}"), confirm the reduction with context_info (targetRole "${entry.roleId}"), then call finish.`,
			'It resumes its work when you finish, so preserve what it needs to continue.',
		].join(' ')
		: [
			`Role instance "${entry.roleId}" (role "${context.roleName}") had a request rejected by the model endpoint for exceeding the context window (${reported.promptTokens} reported prompt tokens against a window of ${reported.budgetTokens}). Its next request fails again unless the conversation shrinks decisively.`,
			`Compact its conversation now: inspect it with list_role_messages, read_message_window, and search_role_blocks, prune it with edit_context (targetRole "${entry.roleId}"), confirm the reduction with context_info (targetRole "${entry.roleId}"), then call finish.`,
			'It resumes its work when you finish, so preserve what it needs to continue.',
		].join(' ')
	return runHandlerInterlude(runRole, deps, context, entry, config, handlerRole, trigger, task, {}, (handlerCard) => {
		if (handlerCard.status === 'success') {
			logEvent(deps.appendLog, 'interrupt_resolved', { trigger, handler: handlerRole, target: entry.roleId, action: 'compacted' })
		} else {
			logEvent(deps.appendLog, 'interrupt_resolved', { trigger, handler: handlerRole, target: entry.roleId, action: 'failed', handlerStatus: handlerCard.status })
		}
		return handlerCard
	})
}
