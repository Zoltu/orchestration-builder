// The tools that spawn a child role and suspend the caller mid-turn until it returns. The set lives below the tool platform because checkpoint validation also runs outside a live run (startup reconciliation and submission), where no platform instance exists; keeping one definition here prevents the platform's dispatch rule and the checkpoint guard from drifting apart.
export const SUSPENDING_CHILD_TOOLS: ReadonlySet<string> = new Set(['agent', 'continue_agent'])

export function suspendsChild(toolName: string): boolean {
	return SUSPENDING_CHILD_TOOLS.has(toolName)
}
