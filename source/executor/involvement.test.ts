import { describe, expect, test } from 'bun:test'

import { DEFAULT_INVOLVEMENT, involvementDirective } from './involvement.ts'

describe('involvementDirective', () => {
	// The directive string is a stable contract the Guild prompts branch on; pin it exactly.
	test('renders the fixed directive for each level', () => {
		expect(involvementDirective('autonomous')).toBe('Human involvement: autonomous. The operator has delegated decisions to you. Do not ask clarifying questions; choose the most reasonable interpretation, record material assumptions in your final summary, and proceed. Inform the human only at completion. Stop only if you truly cannot proceed without a decision that is theirs to make.')
		expect(involvementDirective('early-engagement')).toBe('Human involvement: early-engagement. Resolve genuine ambiguity with the operator before you begin, and for non-trivial tasks confirm your approach before the first change. After that, work autonomously: prefer reasonable defaults over further questions and stop only for a genuine blocker. Report at meaningful milestones and at completion.')
		expect(involvementDirective('collaborative')).toBe('Human involvement: collaborative. Keep the operator in the loop throughout. Ask before making material choices, confirm before irreversible or out-of-scope actions, and check in as you work. Offer a suggested default so they can simply confirm. Report progress as you go.')
	})
})

describe('DEFAULT_INVOLVEMENT', () => {
	test('is early engagement', () => {
		expect(DEFAULT_INVOLVEMENT).toBe('early-engagement')
	})
})
