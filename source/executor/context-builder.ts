import type { EngineContext } from './engine-state.js'
import type { Message, RunContinuation } from './types.js'
import { effortDirective } from './effort.js'
import { buildProjectContextBlock, type ReadProjectDoc } from './project-docs.js'

// The continuation block appended to the entry role's initial user message, below the operator's task and a blank line. The bracketed first line marks the block as platform-provided context, and the read_plan hint names the exact parameter so the Guild can pull the prior run's plan document; wording stays factual because the block must read coherently as conversation context, and it must stay inside the same user message — a second system message would break strict chat templates. The prior-run lines render when the run genuinely continues a prior run (runId present); the queue briefing lines render when the scheduler supplied them; a continuation with neither renders nothing.
function continuationBriefing(continuation: RunContinuation): string {
	const lines: string[] = []
	if (continuation.runId !== undefined) {
		lines.push(`[This run continues run ${continuation.runId}.] Prior task: ${continuation.task}`)
		lines.push(`Prior outcome: ${continuation.summary}`)
		lines.push(`The prior run's plan document is available with the read_plan tool (runId: "${continuation.runId}").`)
	}
	if (continuation.briefing !== undefined) {
		lines.push(...continuation.briefing)
	}
	return lines.join('\n')
}

// Assembles a role's first messages: the system prompt, then the user task.
// The entry role (depth 0) additionally receives the effort directive appended to the system prompt, so prompts can branch on the run's quality level. The directive is merged into the single system message rather than emitted as a second one: many model chat templates (Gemma-family and others) reject a `system` message that is not the first message, so two consecutive system messages would break those endpoints. Child roles never receive the directive — the depth-0 gate ensures it even though the agent spawn copies the context — leaving the parent to translate effort into delegation instructions.
// The continuation briefing (prior-run lineage and/or the queue's interim briefing, docs/queueing.md "The interim briefing") and the project-context block (a depth-0 role's declared projectDocs, project-docs.ts) are appended to the entry role's initial user message after the operator's task text, keeping the task as the message's first line. The same depth-0 gate keeps child histories free of both, so each appears exactly once across the run, and checkpointed histories already contain them — they are never re-derived on resume.
export function buildInitialHistory(systemPrompt: string, context: EngineContext, dependencies: { readProjectDoc: ReadProjectDoc }): Message[] {
	let systemContent = systemPrompt
	if (context.depth === 0 && context.effort !== undefined) {
		systemContent = `${systemPrompt}\n\n${effortDirective(context.effort)}`
	}
	const history: Message[] = [{ role: 'system', content: systemContent }]
	const blocks: string[] = []
	if (context.depth === 0 && context.continuation !== undefined) {
		const briefing = continuationBriefing(context.continuation)
		if (briefing !== '') blocks.push(briefing)
	}
	if (context.depth === 0) {
		const projectDocs = context.loadedGuild.config.roles[context.roleName]?.projectDocs
		if (projectDocs !== undefined && projectDocs.length > 0) {
			blocks.push(buildProjectContextBlock(projectDocs, dependencies))
		}
	}
	if (blocks.length === 0) {
		history.push({ role: 'user', content: context.task })
	} else {
		history.push({ role: 'user', content: `${context.task}\n\n${blocks.join('\n\n')}` })
	}
	return history
}
