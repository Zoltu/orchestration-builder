import type { RoleRegistryEntry } from './role-registry.js'
import type { EngineContext } from './engine-state.js'
import type { RoleOutcome } from './types.js'
import type { InvocationJournal } from './invocation.js'
import type { ExecutorConfig, OperatorPauseRecord, ResultCard, SuspensionRecord } from './types.js'
import type { CheckpointRecorder, InterludeTrigger } from './checkpoint.js'
import type { InterruptQueue } from './interrupts.js'

export interface HandlerInterludeDependencies {
	invocationJournal: InvocationJournal
	checkpointRecorder: CheckpointRecorder
	interruptQueue: InterruptQueue
	runRole: (context: EngineContext) => Promise<RoleOutcome>
}

export type HandlerInterludeOutcome<Resolution> =
	| { kind: 'resolved'; resolution: Resolution }
	| { kind: 'suspended'; suspension: SuspensionRecord }
	| { kind: 'operator_paused'; pause: OperatorPauseRecord }

// The shared handler interlude every handler invocation runs (the loop-check, inquiry, and context handlers): suspend the active role at the safe point, invoke the handler role against its frozen (registered) state, then apply the trigger's resolution step with the handler's finish card.
// The interrupt event lands immediately before the handler's role_start so the interaction model roots the handler under a fresh interrupt participant; the handler role_start's parentCallId is that interrupt call, while an ordinary child role is parented to its caller role.
// The handler context is the target's context spread with handlerOf set to the target's instance id — the mark the drain point reads to exempt a handler from interrupt checking and operator-request draining, so a handler can never interrupt itself or consume operator requests meant for real work roles.
// The handler depth is one beneath the target clamped to maxAgentDepth: the interlude is platform infrastructure, not a delegation, so it must never trip the global depth budget itself.
// interruptDetails carries the trigger's extra interrupt event payload fields (the inquiry's verbatim question; nothing for the other triggers).
// The pending-interlude record is written before the handler starts, so a provider failure inside the handler leaves a durable intent to re-run it from the target's pre-interlude state. On a normal resolution the record is cleared and the write persists the cleared state.
export async function runHandlerInterlude<Resolution>(
	dependencies: HandlerInterludeDependencies,
	context: EngineContext,
	entry: RoleRegistryEntry,
	config: ExecutorConfig,
	handlerRole: string,
	trigger: InterludeTrigger,
	task: string,
	interruptDetails: Record<string, unknown>,
	resolve: (handlerCard: ResultCard, interruptCallId: string) => Resolution,
): Promise<HandlerInterludeOutcome<Resolution>> {
	const interrupt = dependencies.invocationJournal.interruptStarted(entry.roleId, { trigger, handler: handlerRole, target: entry.roleId, ...interruptDetails })
	// A nested interlude runs inside an already-active handler. The outer pre-interlude checkpoint is the replay point: the outer handler will re-run and re-trigger this nested one, so it must neither overwrite the outer pending record nor attempt a suppressed write.
	const nested = dependencies.checkpointRecorder.hasActiveHandler()
	if (!nested) {
		dependencies.checkpointRecorder.setPendingInterlude({
			targetRoleId: entry.roleId,
			trigger,
			details: interruptDetails,
			pendingOperatorRequests: dependencies.interruptQueue.pendingRequests(),
		})
		if (!dependencies.checkpointRecorder.write()) throw new Error(`handler interlude: could not checkpoint the pending ${trigger} interlude for ${entry.roleId}`)
	}
	const handlerOutcome = await dependencies.runRole({
		...context,
		depth: Math.min(context.depth + 1, config.maxAgentDepth),
		roleName: handlerRole,
		task,
		parent: context.roleName,
		parentRoleId: entry.roleId,
		parentCallId: interrupt.callId,
		handlerOf: entry.roleId,
	})
	if (handlerOutcome.kind === 'suspended' || handlerOutcome.kind === 'operator_paused') return handlerOutcome
	const resolution = resolve(handlerOutcome.card, interrupt.callId)
	if (!nested) {
		dependencies.checkpointRecorder.setPendingInterlude(undefined)
		if (!dependencies.checkpointRecorder.write()) throw new Error(`handler interlude: could not clear the pending ${trigger} interlude for ${entry.roleId}`)
	}
	return { kind: 'resolved', resolution }
}
