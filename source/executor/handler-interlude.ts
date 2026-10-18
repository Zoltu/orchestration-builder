import type { RoleRegistryEntry } from './role-registry.js'
import { logEvent, type EngineContext } from './engine-state.js'
import type { AppendLog } from './persistence.js'
import type { ExecutorConfig, ResultCard } from './types.js'

// The trigger vocabulary of the interrupt/interrupt_resolved event pair every handler interlude logs.
export type InterludeTrigger = 'loop_check' | 'inquiry' | 'context_pressure' | 'context_budget_exceeded'

export interface HandlerInterludeDependencies {
	appendLog: AppendLog
	runRole: (context: EngineContext) => Promise<ResultCard>
}

// The shared handler interlude every handler invocation runs (the loop-check, inquiry, and context handlers): suspend the active role at the safe point, invoke the handler role against its frozen (registered) state, then apply the trigger's resolution step with the handler's finish card.
// The interrupt event lands immediately before the handler's role_start so the interaction model roots the handler under a fresh interrupt participant.
// The handler context is the target's context spread with handlerOf set to the target's instance id — the mark the drain point reads to exempt a handler from interrupt checking and operator-request draining, so a handler can never interrupt itself or consume operator requests meant for real work roles.
// The handler depth is one beneath the target clamped to maxAgentDepth: the interlude is platform infrastructure, not a delegation, so it must never trip the global depth budget itself.
// interruptDetails carries the trigger's extra interrupt event payload fields (the inquiry's verbatim question; nothing for the other triggers).
export async function runHandlerInterlude<Resolution>(
	dependencies: HandlerInterludeDependencies,
	context: EngineContext,
	entry: RoleRegistryEntry,
	config: ExecutorConfig,
	handlerRole: string,
	trigger: InterludeTrigger,
	task: string,
	interruptDetails: Record<string, unknown>,
	resolve: (handlerCard: ResultCard) => Resolution,
): Promise<Resolution> {
	logEvent(dependencies.appendLog, 'interrupt', { trigger, handler: handlerRole, target: entry.roleId, ...interruptDetails })
	const handlerCard = await dependencies.runRole({
		...context,
		depth: Math.min(context.depth + 1, config.maxAgentDepth),
		roleName: handlerRole,
		task,
		parent: context.roleName,
		parentRoleId: entry.roleId,
		handlerOf: entry.roleId,
	})
	return resolve(handlerCard)
}
