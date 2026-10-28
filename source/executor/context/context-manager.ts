import type { RoleRegistryEntry } from '../role-registry.js'
import { runHandlerInterlude } from '../handler-interlude.js'
import { logEvent, type EngineContext, type RoleState } from '../engine-state.js'
import type { InvocationJournal } from '../invocation.js'
import type { CheckpointRecorder } from '../checkpoint.js'
import type { InterruptQueue } from '../interrupts.js'
import type { AppendLog } from '../persistence.js'
import type { LlmUsage, ResultCard, RoleOutcome, SuspensionRecord } from '../types.js'
import { applyContextBackstop, contextExceededCard, contextHandlerTask, contextManagedNotice, contextPressureNotice, currentEffectiveBudget, MAX_CONTEXT_RECOVERY_ATTEMPTS } from './context-handoff.js'
import { DEFAULT_CONTEXT_PRESSURE_THRESHOLD, recordContextRejection, type ContextPressureTracker } from './context-pressure.js'

export interface ContextRejection {
	promptTokens: number
	contextWindow: number
}

export type ContextDecision =
	| { kind: 'continue' }
	| { kind: 'finished'; card: ResultCard }
	| { kind: 'suspended'; suspension: SuspensionRecord }

export interface ContextDependencies {
	appendLog: AppendLog
	contextPressureTracker: ContextPressureTracker
	invocationJournal: InvocationJournal
	checkpointRecorder: CheckpointRecorder
	interruptQueue: InterruptQueue
	runRole: (context: EngineContext) => Promise<RoleOutcome>
}

export interface ContextManager {
	observeSuccess(roleState: RoleState, usage: LlmUsage | undefined): void
	observeRejection(roleState: RoleState, rejection: ContextRejection): ContextDecision
	resolveSafePoint(roleState: RoleState, entry: RoleRegistryEntry): Promise<ContextDecision>
}

// The context lifecycle for one role instance: it owns the pressure threshold, rejection recovery bounds, compaction ordering, notices, and context-handler interludes, so the engine only observes outcomes and asks for the safe-point decision.
export function createContextManager(context: EngineContext, dependencies: ContextDependencies): ContextManager {
	const config = context.loadedGuild.deployment.executor

	function effectiveBudget(): number {
		return currentEffectiveBudget(context, dependencies.contextPressureTracker)
	}

	function appendUserNotice(roleState: RoleState, content: string): void {
		roleState.history.push({ role: 'user', content })
	}

	async function runContextHandler(entry: RoleRegistryEntry, trigger: 'context_pressure' | 'context_budget_exceeded', reported: { promptTokens: number; budgetTokens: number }, apply: (handlerCard: ResultCard) => ContextDecision): Promise<ContextDecision> {
		const handlerRole = config.contextHandlerRole
		if (handlerRole === undefined) throw new Error('context handler interlude requested without executor.contextHandlerRole configured')
		const task = contextHandlerTask(trigger, context, entry, reported)
		const interlude = await runHandlerInterlude({ invocationJournal: dependencies.invocationJournal, checkpointRecorder: dependencies.checkpointRecorder, interruptQueue: dependencies.interruptQueue, runRole: dependencies.runRole }, context, entry, config, handlerRole, trigger, task, {}, (handlerCard, interruptCallId) => {
			if (handlerCard.status === 'success') {
				dependencies.invocationJournal.interruptFinished(interruptCallId, { trigger, handler: handlerRole, target: entry.roleId, action: 'compacted' })
			} else {
				dependencies.invocationJournal.interruptFinished(interruptCallId, { trigger, handler: handlerRole, target: entry.roleId, action: 'failed', handlerStatus: handlerCard.status })
			}
			return apply(handlerCard)
		})
		if (interlude.kind === 'suspended') return interlude
		return interlude.resolution
	}

	function observeSuccess(roleState: RoleState, usage: LlmUsage | undefined): void {
		roleState.contextExceededAttempts = 0
		if (usage === undefined) return
		roleState.lastPromptTokens = usage.promptTokens
		roleState.generatedTokens += usage.completionTokens
		if (roleState.contextPressureNotice !== undefined) return
		const threshold = config.contextPressureThreshold ?? DEFAULT_CONTEXT_PRESSURE_THRESHOLD
		const budget = effectiveBudget()
		if (roleState.lastPromptTokens < threshold * budget) return
		roleState.contextPressureNotice = 'pending'
		logEvent(dependencies.appendLog, 'context_pressure', { role: context.roleName, promptTokens: roleState.lastPromptTokens, effectiveBudget: budget })
	}

	function observeRejection(roleState: RoleState, rejection: ContextRejection): ContextDecision {
		recordContextRejection(dependencies.contextPressureTracker, rejection.promptTokens)
		logEvent(dependencies.appendLog, 'context_budget_exceeded', {
			role: context.roleName,
			promptTokens: rejection.promptTokens,
			contextWindow: rejection.contextWindow,
		})
		roleState.contextExceededAttempts += 1
		if (roleState.contextExceededAttempts > MAX_CONTEXT_RECOVERY_ATTEMPTS) {
			return contextExceededCard(`Context window exceeded and ${MAX_CONTEXT_RECOVERY_ATTEMPTS} compaction attempts did not make the request fit`)
		}
		// With a context handler configured, the overflow is answered at the next turn boundary by suspending the role and letting the handler prune surgically — the rejection is detected mid-turn, but a handler can only run at the safe point. The naive backstop remains for handler-less configurations and as the fallback when the handler fails.
		if (config.contextHandlerRole !== undefined) {
			roleState.contextCompactionPending = { promptTokens: rejection.promptTokens, contextWindow: rejection.contextWindow }
			return { kind: 'continue' }
		}
		const backstopCard = applyContextBackstop(roleState, context, rejection, dependencies)
		return backstopCard === null ? { kind: 'continue' } : { kind: 'finished', card: backstopCard }
	}

	async function resolveSafePoint(roleState: RoleState, entry: RoleRegistryEntry): Promise<ContextDecision> {
		// A queued overflow compaction runs first: the role's last request was rejected for context size and cannot succeed until the handler shrinks the history (or the naive backstop does when the handler fails).
		if (roleState.contextCompactionPending !== undefined) {
			const pending = roleState.contextCompactionPending
			const decision = await runContextHandler(entry, 'context_budget_exceeded', { promptTokens: pending.promptTokens, budgetTokens: pending.contextWindow }, (handlerCard) => {
				roleState.contextCompactionPending = undefined
				if (handlerCard.status === 'success') {
					appendUserNotice(roleState, contextManagedNotice('context_budget_exceeded', handlerCard.summary))
					return { kind: 'continue' }
				}
				const backstopCard = applyContextBackstop(roleState, context, pending, dependencies)
				return backstopCard === null ? { kind: 'continue' } : { kind: 'finished', card: backstopCard }
			})
			if (decision.kind === 'suspended') return decision
			if (decision.kind === 'finished') return decision
		}

		// The pressure response lands at a turn boundary — after the previous turn's tool results — never between an assistant tool_calls message and its tool results, which is a malformed request on strict endpoints. The entry role has no parent to hand off to, so with a context handler configured the platform compacts it instead of sending the handoff notice (falling back to the notice when the handler fails); child roles get the append-only notice, which preserves the endpoint's prefix cache.
		if (roleState.contextPressureNotice === 'pending') {
			if (context.depth === 0 && config.contextHandlerRole !== undefined) {
				const decision = await runContextHandler(entry, 'context_pressure', { promptTokens: roleState.lastPromptTokens, budgetTokens: effectiveBudget() }, (handlerCard) => {
					roleState.contextPressureNotice = 'sent'
					if (handlerCard.status === 'success') appendUserNotice(roleState, contextManagedNotice('context_pressure', handlerCard.summary))
					else appendUserNotice(roleState, contextPressureNotice(roleState.lastPromptTokens, effectiveBudget()))
					return { kind: 'continue' }
				})
				if (decision.kind === 'suspended') return decision
			} else {
				roleState.contextPressureNotice = 'sent'
				appendUserNotice(roleState, contextPressureNotice(roleState.lastPromptTokens, effectiveBudget()))
			}
		}

		return { kind: 'continue' }
	}

	return { observeSuccess, observeRejection, resolveSafePoint }
}
