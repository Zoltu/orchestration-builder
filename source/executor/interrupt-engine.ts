import type { ResumedRole } from './engine.js'
import { createResultCard, createToolError } from './errors.js'
import type { InterruptRequest } from './interrupts.js'
import type { RoleRegistry, RoleRegistryEntry } from './role-registry.js'
import { logEvent, type EngineContext, type EngineDependencies, type RoleState } from './engine-state.js'
import type { EffortLevel, ExecutorConfig, ResultCard } from './types.js'

// The marker prefix the orchestrator/planner prompts teach roles to recognize. A notice goes to the run's entry role (the chain root) as run-wide information to act on directly; a plan modification arrives only after active sub-work beneath the plan owner was aborted and asks the owner to re-plan around the change. An operator inquiry is never injected — it is answered by a fresh handler role (runInquiryHandler).
function operatorNoticeMessage(message: string): string {
	return `[Operator notice — a message from the operator or the platform for the run as a whole. Act on it directly, then continue your work.]\n\n${message}`
}

function planModificationMessage(message: string): string {
	return `[Operator plan modification — active sub-work below you was aborted; integrate this change into your plan and re-delegate, continue, or finish]\n\n${message}`
}

function interruptedCard(summary: string): ResultCard {
	return createResultCard('error', summary, { error: createToolError('interrupted', summary) })
}

// Walks the live delegation chain from the given entry up to the run's root, self first. Every ancestor is still registered because each is suspended in its `agent` tool call awaiting the descendant beneath it.
function chainFromEntry(registry: RoleRegistry, entry: RoleRegistryEntry): RoleRegistryEntry[] {
	const chain: RoleRegistryEntry[] = [entry]
	let current = entry
	while (current.parentRoleId !== undefined) {
		const parent = registry.lookup(current.parentRoleId)
		if (parent === undefined) break
		chain.push(parent)
		current = parent
	}
	return chain
}

// Applies a queued operator request that mutates a live role's conversation (an inquiry never reaches here — the drain answers it with a fresh handler role). A notice is injected into the chain root's (the entry role's) history as a marked user message: it lands in the root's frozen history immediately but is read when control next returns to the root (the active leaf keeps working undisturbed). A plan modification marks every chain member below the plan owner (the rootmost chain instance of the configured planOwnerRole, else the chain root) for abort and the owner for injection; the marked roles then unwind one safe point at a time as the agent-call result-card propagation reaches them — the same unwind a child error card already drives, triggered here by an external request.
function routeOperatorInterrupt(
	deps: EngineDependencies,
	roleState: RoleState,
	entry: RoleRegistryEntry,
	config: ExecutorConfig,
	request: InterruptRequest,
): ResultCard | null {
	const chain = chainFromEntry(deps.roleRegistry, entry)
	if (request.kind === 'notice') {
		const root = chain[chain.length - 1]
		if (root === undefined) return null
		root.roleState.history.push({ role: 'user', content: operatorNoticeMessage(request.message) })
		logEvent(deps.appendLog, 'operator_notice', { role: root.roleName, roleId: root.roleId, message: request.message })
		return null
	}
	const planOwnerRole = config.interruptTriggers?.planOwnerRole
	let target = chain[chain.length - 1]
	if (target === undefined) return null
	if (planOwnerRole !== undefined) {
		for (const candidate of chain) {
			if (candidate.roleName === planOwnerRole) target = candidate
		}
	}
	const aborted: string[] = []
	for (const member of chain) {
		if (member.roleId === target.roleId) break
		member.planAbort = true
		aborted.push(member.roleId)
	}
	target.planInjection = request.message
	logEvent(deps.appendLog, 'plan_modification', { target: target.roleId, targetRole: target.roleName, message: request.message, aborted })
	if (entry.planAbort === true) {
		return interruptedCard('Aborted by an operator plan modification')
	}
	if (entry.planInjection !== undefined) {
		entry.planInjection = undefined
		roleState.history.push({ role: 'user', content: planModificationMessage(request.message) })
	}
	return null
}

// Suspends the active role and invokes the guild-configured handler role against its frozen (registered) state, then applies the handler's trigger_interrupt action: continue resumes unchanged, redirect resumes with the handler's message already injected (by the tool) into the target's history, abort finishes the target with a loop_detected card. The interrupt event lands immediately before the handler's role_start so the interaction model roots the handler under a fresh interrupt participant.
// runRole is threaded in by the engine so this module can drive role turns without importing the turn loop at runtime (the engine imports this module).
async function runInterruptHandler(
	runRole: (deps: EngineDependencies, context: EngineContext, resumed?: ResumedRole) => Promise<ResultCard>,
	deps: EngineDependencies,
	context: EngineContext,
	entry: RoleRegistryEntry,
	handlerRole: string,
	config: ExecutorConfig,
): Promise<ResultCard | null> {
	const task = [
		`The platform flagged role instance "${entry.roleId}" (role "${context.roleName}") for a loop check.`,
		`It has made ${entry.roleState.toolCallCount} tool calls and generated ${entry.roleState.generatedTokens} tokens so far.`,
		'Investigate whether it is stuck in a loop, then call trigger_interrupt with that role-instance id and your decision.',
	].join(' ')
	logEvent(deps.appendLog, 'interrupt', { trigger: 'loop_check', handler: handlerRole, target: entry.roleId })
	const handlerCard = await runRole(deps, {
		...context,
		depth: Math.min(context.depth + 1, config.maxAgentDepth),
		roleName: handlerRole,
		task,
		parent: context.roleName,
		parentRoleId: entry.roleId,
		handlerOf: entry.roleId,
	})
	const action = entry.interruptAction
	entry.interruptAction = undefined
	if (action === undefined) {
		// A handler that finishes without calling trigger_interrupt decides nothing; the target resumes unchanged. The handler's own outcome is logged for the reviewer.
		logEvent(deps.appendLog, 'interrupt_resolved', { trigger: 'loop_check', handler: handlerRole, target: entry.roleId, action: 'continue', handlerStatus: handlerCard.status })
		return null
	}
	logEvent(deps.appendLog, 'interrupt_resolved', { trigger: 'loop_check', handler: handlerRole, target: entry.roleId, action: action.action })
	if (action.action === 'abort') {
		const summary = action.reason !== '' ? action.reason : 'Aborted by the loop-check handler'
		return createResultCard('error', summary, { error: createToolError('loop_detected', action.reason) })
	}
	return null
}

// Suspends the active role and invokes the configured inquiry handler role to answer the operator's question — the same preempt-and-resume interlude as the loop-check and context handlers, so it logs the same interrupt/interrupt_resolved pair and the interaction model roots the handler on a fresh interrupt stack. The handler is a fresh agent that was never given the run's conversations: the briefing lists the live (suspended) instances root first and points at the run-log tools and the workspace for researching roles that already finished. Its finish-card summary is the answer shown to the operator. The target always resumes afterwards, whatever the handler did — a question never finishes a run.
async function runInquiryHandler(
	runRole: (deps: EngineDependencies, context: EngineContext, resumed?: ResumedRole) => Promise<ResultCard>,
	deps: EngineDependencies,
	context: EngineContext,
	entry: RoleRegistryEntry,
	config: ExecutorConfig,
	request: InterruptRequest,
): Promise<void> {
	const handlerRole = config.inquiryHandlerRole
	if (handlerRole === undefined) {
		// A run without an inquiry handler drops the question rather than dying over it: the operator gets no answer, but the work continues.
		logEvent(deps.appendLog, 'inquiry_dropped', { message: request.message, reason: 'executor.inquiryHandlerRole is not configured' })
		return
	}
	// The chain from the draining leaf IS the entire live role set in this sequential engine; chainFromEntry is leaf-first, so reverse it for the root-first briefing list.
	const liveInstances = chainFromEntry(deps.roleRegistry, entry).reverse()
	const instanceLines = liveInstances.map((member) => `- ${member.roleId} (${member.roleName}, depth ${member.depth})${member.parentRoleId !== undefined ? `, child of ${member.parentRoleId}` : ''}`)
	const finishedRolesNote = 'Roles that already finished have no live conversation; their work is recorded in the run log and in the workspace itself. Read the run log with read_run_log (its llm_call events carry the full sent and received messages) and search_run_log, and the workspace with the file tools.'
	const task = [
		"[Operator inquiry] The operator interrupted the run to ask a question. Answer it on the run's behalf.",
		'',
		'Question:',
		request.message,
		'',
		'You are a fresh agent and were not given the run\'s conversations — investigate with your tools before answering.',
		'Live role instances (suspended while you work), root first:',
		...instanceLines,
		'',
		'Read a live instance\'s conversation with list_role_messages, read_message_window, search_role_blocks, recent_role_tool_calls, or context_info (targetRole is the instance id).',
		finishedRolesNote,
		'When you know the answer, call finish with status "success" and put the answer, in plain language, in the summary — the summary is shown to the operator as your answer. Do not modify the workspace or any role\'s conversation.',
	].join('\n')
	logEvent(deps.appendLog, 'interrupt', { trigger: 'inquiry', handler: handlerRole, target: entry.roleId, message: request.message })
	const handlerCard = await runRole(deps, {
		...context,
		depth: Math.min(context.depth + 1, config.maxAgentDepth),
		roleName: handlerRole,
		task,
		parent: context.roleName,
		parentRoleId: entry.roleId,
		handlerOf: entry.roleId,
	})
	if (handlerCard.status === 'success') {
		logEvent(deps.appendLog, 'interrupt_resolved', { trigger: 'inquiry', handler: handlerRole, target: entry.roleId, action: 'answered', summary: handlerCard.summary })
	} else {
		logEvent(deps.appendLog, 'interrupt_resolved', { trigger: 'inquiry', handler: handlerRole, target: entry.roleId, action: 'failed', handlerStatus: handlerCard.status, summary: handlerCard.summary })
	}
}

// The platform's single safe point, run at the top of every turn: no LLM call is in flight here, so suspending or unwinding the role cannot tear a turn. Returns a ResultCard when the role must finish, or null to continue the turn.
// Order: marks set by an earlier routing first, then (for non-handler roles only) the loop-check cadence, then one queued operator request.
export async function drainInterrupts(
	runRole: (deps: EngineDependencies, context: EngineContext, resumed?: ResumedRole) => Promise<ResultCard>,
	deps: EngineDependencies,
	context: EngineContext,
	roleState: RoleState,
	entry: RoleRegistryEntry,
	config: ExecutorConfig,
): Promise<ResultCard | null> {
	if (entry.planAbort === true) {
		return interruptedCard('Aborted by an operator plan modification')
	}
	if (entry.planInjection !== undefined) {
		const message = entry.planInjection
		entry.planInjection = undefined
		roleState.history.push({ role: 'user', content: planModificationMessage(message) })
	}

	if (context.handlerOf !== undefined) return null

	const triggers = config.interruptTriggers
	if (triggers !== undefined && context.roleName !== triggers.handlerRole) {
		// The per-tier cadence scale is a tuning table preserving the old threshold × (effort + 1) spread of 2×–6×; a context without effort (a pre-effort checkpoint's frames) gets the most frequent checking.
		const scaleByEffort: Record<EffortLevel, number> = { quick: 2, standard: 4, thorough: 6 }
		const scale = scaleByEffort[context.effort ?? 'quick']
		const toolCallThreshold = triggers.everyToolCalls * scale
		const tokenThreshold = triggers.everyTokens * scale
		const fireOnToolCalls = roleState.toolCallCount >= roleState.loopCheckToolCallWatermark + toolCallThreshold
		const fireOnTokens = roleState.generatedTokens >= roleState.loopCheckTokenWatermark + tokenThreshold
		if (fireOnToolCalls || fireOnTokens) {
			roleState.loopCheckToolCallWatermark = roleState.toolCallCount
			roleState.loopCheckTokenWatermark = roleState.generatedTokens
			const abortCard = await runInterruptHandler(runRole, deps, context, entry, triggers.handlerRole, config)
			if (abortCard !== null) return abortCard
		}
	}

	const request = deps.interruptQueue.drain()
	if (request !== undefined) {
		// An inquiry is answered by a fresh handler role against the suspended chain, never injected into a working role's history; the run continues whatever the handler did.
		if (request.kind === 'inquiry') {
			await runInquiryHandler(runRole, deps, context, entry, config, request)
			return null
		}
		const routedCard = routeOperatorInterrupt(deps, roleState, entry, config, request)
		if (routedCard !== null) return routedCard
	}
	return null
}
