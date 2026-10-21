import type { EngineContext } from '../engine-state.js'
import type { ProtectedPrefixLength } from '../state.js'
import type { Message, RunContinuation, TerminalRunStatus } from '../types.js'
import { effortDirective } from '../effort.js'
import { involvementDirective } from '../involvement.js'
import { buildProjectContextBlock, type ReadProjectDoc } from '../project-docs.js'
import { DEFAULT_PROTECTED_PREFIX_LENGTH } from './context-policy.js'

const MISSING_PRIOR_TASK = "(The prior run's task was not recorded.)"

function hasText(value: string | undefined): value is string {
	return value !== undefined && value.trim() !== ''
}

// The status the prior run is shown with: the terminal status wins, then the result card's status, then the run-level error kind distinguishes an interrupted run from any other failure. A continuation carrying none of them displays as unknown rather than inventing an outcome.
function resolvePriorStatus(continuation: RunContinuation): TerminalRunStatus | 'unknown' {
	if (continuation.status !== undefined) return continuation.status
	if (continuation.result !== undefined) return continuation.result.status
	if (continuation.error?.kind === 'interrupted') return 'interrupted'
	if (continuation.error !== undefined) return 'error'
	return 'unknown'
}

// The surfaced error message, preferring the run-level record because it is the terminal outcome the run actually ended with; a card-only error still renders when the run-level record is absent or carries no message.
function priorErrorMessage(continuation: RunContinuation): string | undefined {
	if (hasText(continuation.error?.message)) return continuation.error.message
	if (hasText(continuation.result?.error?.message)) return continuation.result.error.message
	return undefined
}

// Renders the prior run as the assistant turn that precedes the new task, so the new run reads the prior outcome as a real conversational turn instead of a platform block inside its own task. The output is deterministic and always non-empty: the wire mapping drops empty assistant turns, which would leave two adjacent user messages and erase the turn boundary. The machine error kind is deliberately not rendered — it is executor vocabulary, not operator-facing prose — and neither is the raw technical detail, which is endpoint payload intended for the collapsed operator view, not assistant-authority conversation content.
function formatPriorAssistantResult(continuation: RunContinuation): string {
	const sections: string[] = []
	const resultSummary = continuation.result?.summary
	const summary = hasText(resultSummary) ? resultSummary : continuation.summary
	if (hasText(summary)) sections.push(summary)
	const artifacts = continuation.result?.artifacts
	if (artifacts !== undefined && artifacts.length > 0) {
		sections.push(['Artifacts:', ...artifacts.map((artifact) => `- ${artifact}`)].join('\n'))
	}
	const errorMessage = priorErrorMessage(continuation)
	if (errorMessage !== undefined) {
		sections.push(`Error: ${errorMessage}`)
	} else if (continuation.error !== undefined || continuation.result?.error !== undefined) {
		sections.push('Error: (No error message was recorded.)')
	}
	if (sections.length === 0) {
		sections.push('(No result summary, artifacts, or error were recorded for the prior run.)')
	}
	return [`[Prior run result — status: ${resolvePriorStatus(continuation)}.]`, ...sections].join('\n\n')
}

function continuationMarker(runId: string): string {
	return `[This run continues run ${runId}.] The prior run's plan document is available with the read_plan tool (runId: "${runId}").`
}

// Assembles a role's first messages: the system prompt, then the user task.
// The entry role (depth 0) additionally receives the effort and human-involvement directives appended to the system prompt, so prompts can branch on the run's quality level and ask posture.
// Each directive is merged into the single system message rather than emitted as a second one: many model chat templates (Gemma-family and others) reject a `system` message that is not the first message, so two consecutive system messages would break those endpoints.
// Child roles never receive the directives — the depth-0 gate ensures it even though the agent spawn copies the context — leaving the parent to translate effort and involvement into delegation instructions.
// A genuine continuation (a continuation carrying a runId) additionally gets the prior operator task as a user turn and the prior terminal result as an assistant turn, directly after the system prompt, so the new run's history is [system, prior task, prior result, new task] rather than one user message mixing the old and new work.
// The new user message then carries only the follow-up task, the lineage/plan marker, the queue briefing (docs/queueing.md "The interim briefing"), the project-context block (a depth-0 role's declared projectDocs, project-docs.ts), and the workspace git notice (git-state.ts), the task staying its first line and each block separated by a blank line.
// A first queue dispatch has no runId, so it gets only the briefing and the other depth-0 blocks in the same user message, with no prior turns and no marker.
// The same depth-0 gate keeps child histories free of all prior turns and blocks, so each appears exactly once across the run, and checkpointed histories already contain them — they are never re-derived on resume.
// The protected prefix length is returned explicitly: only a history this function actually opened with the prior user/assistant turns gets 4, while every other history (including a seeded child conversation whose roles happen to look similar) gets 2. Callers persist it on the role state so compaction and edit_context never have to infer it from message roles.
export function buildInitialHistory(systemPrompt: string, context: EngineContext, dependencies: { readProjectDoc: ReadProjectDoc }): { history: Message[]; protectedPrefixLength: ProtectedPrefixLength } {
	let systemContent = systemPrompt
	if (context.depth === 0 && context.effort !== undefined) {
		systemContent = `${systemPrompt}\n\n${effortDirective(context.effort)}`
	}
	if (context.depth === 0 && context.involvement !== undefined) {
		systemContent = `${systemContent}\n\n${involvementDirective(context.involvement)}`
	}
	const history: Message[] = [{ role: 'system', content: systemContent }]
	let protectedPrefixLength: ProtectedPrefixLength = DEFAULT_PROTECTED_PREFIX_LENGTH
	const continuation = context.continuation
	if (context.depth === 0 && continuation !== undefined && continuation.runId !== undefined) {
		const priorTask = hasText(continuation.task) ? continuation.task : MISSING_PRIOR_TASK
		history.push({ role: 'user', content: priorTask })
		history.push({ role: 'assistant', content: formatPriorAssistantResult(continuation) })
		protectedPrefixLength = 4
	}
	const blocks: string[] = []
	if (context.depth === 0 && continuation !== undefined) {
		if (continuation.runId !== undefined) blocks.push(continuationMarker(continuation.runId))
		if (continuation.briefing !== undefined && continuation.briefing.length > 0) {
			const briefing = continuation.briefing.join('\n')
			if (briefing !== '') blocks.push(briefing)
		}
	}
	if (context.depth === 0) {
		const projectDocs = context.loadedGuild.config.roles[context.roleName]?.projectDocs
		if (projectDocs !== undefined && projectDocs.length > 0) {
			blocks.push(buildProjectContextBlock(projectDocs, dependencies))
		}
		if (context.workspaceGitNotice !== undefined) {
			blocks.push(context.workspaceGitNotice)
		}
	}
	if (blocks.length === 0) {
		history.push({ role: 'user', content: context.task })
	} else {
		history.push({ role: 'user', content: `${context.task}\n\n${blocks.join('\n\n')}` })
	}
	return { history, protectedPrefixLength }
}
