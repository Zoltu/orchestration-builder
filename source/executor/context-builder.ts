import type { EngineContext } from './engine-state.js'
import type { Message, RoleDefinition, RunContinuation } from './types.js'
import { stripReasoning } from './context-policy.js'
import { effortDirective } from './effort.js'

export function buildMessages(roleDefinition: RoleDefinition, messages: Message[]): Message[] {
	if (!roleDefinition.includeReasoning) {
		return stripReasoning(messages, 2)
	}
	return messages
}

// The continuation block appended to the entry role's initial user message, below the operator's task and a blank line. The bracketed first line marks the block as platform-provided context, and the read_plan hint names the exact parameter so the Guild can pull the prior run's plan document; wording stays factual because the block must read coherently as conversation context, and it must stay inside the same user message — a second system message would break strict chat templates.
function continuationBriefing(continuation: RunContinuation): string {
	return `[This run continues run ${continuation.runId}.] Prior task: ${continuation.task}\nPrior outcome: ${continuation.summary}\nThe prior run's plan document is available with the read_plan tool (runId: "${continuation.runId}").`
}

// Assembles a role's first messages: the system prompt, then the user task.
// The entry role (depth 0) additionally receives the effort directive appended to the system prompt, so prompts can branch on the run's quality level. The directive is merged into the single system message rather than emitted as a second one: many model chat templates (Gemma-family and others) reject a `system` message that is not the first message, so two consecutive system messages would break those endpoints. Child roles never receive the directive — the depth-0 gate ensures it even though the agent spawn copies the context — leaving the parent to translate effort into delegation instructions.
// The continuation briefing (when the run continues a prior run) is appended to the entry role's initial user message after the operator's task text, keeping the task as the message's first line. The same depth-0 gate keeps child histories free of it, so the briefing appears exactly once across the run.
export function buildInitialHistory(systemPrompt: string, context: EngineContext): Message[] {
	let systemContent = systemPrompt
	if (context.depth === 0 && context.effort !== undefined) {
		systemContent = `${systemPrompt}\n\n${effortDirective(context.effort)}`
	}
	const history: Message[] = [{ role: 'system', content: systemContent }]
	if (context.depth === 0 && context.continuation !== undefined) {
		history.push({ role: 'user', content: `${context.task}\n\n${continuationBriefing(context.continuation)}` })
	} else {
		history.push({ role: 'user', content: context.task })
	}
	return history
}
