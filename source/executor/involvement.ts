import type { InvolvementLevel } from './types.js'

// The run-level default applied when neither a per-run override, a project setting, nor the deployment file fixes the involvement level.
export const DEFAULT_INVOLVEMENT: InvolvementLevel = 'early-engagement'

// The per-level guidance directive the executor injects verbatim; the exact wording is a stable contract the Guild role prompts defer to.
export function involvementDirective(involvement: InvolvementLevel): string {
	if (involvement === 'autonomous') {
		return 'Human involvement: autonomous. The operator has delegated decisions to you. Do not ask clarifying questions; choose the most reasonable interpretation, record material assumptions in your final summary, and proceed. Inform the human only at completion. Stop only if you truly cannot proceed without a decision that is theirs to make.'
	}
	if (involvement === 'collaborative') {
		return 'Human involvement: collaborative. Keep the operator in the loop throughout. Ask before making material choices, confirm before irreversible or out-of-scope actions, and check in as you work. Offer a suggested default so they can simply confirm. Report progress as you go.'
	}
	return 'Human involvement: early-engagement. Resolve genuine ambiguity with the operator before you begin, and for non-trivial tasks confirm your approach before the first change. After that, work autonomously: prefer reasonable defaults over further questions and stop only for a genuine blocker. Report at meaningful milestones and at completion.'
}
