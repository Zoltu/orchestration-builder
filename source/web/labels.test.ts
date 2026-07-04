import { describe, expect, test } from 'bun:test'
import { resolveOperationLabel, resolveParticipantLabel } from './static/labels.js'
import { activeStack } from './static/interaction-model.js'
import { scenarios } from './static/scenarios.js'

// Pull the model types off helper signatures so the test fixtures are contextually checked against the JSDoc shape without a cast, mirroring the sibling scenarios.test.ts convention.
type InteractionModel = Parameters<typeof activeStack>[0]
type Participant = InteractionModel['participants'][number]
type Operation = InteractionModel['operations'][number]

// A participant whose role has no registry entry, used to exercise the title-cased role-name fallback.
const unseededParticipant: Participant = { id: 'chef', role: 'sous_chef', kind: 'role' }

// 'recovery' ships only {fun, helpful}; requesting its absent 'detailed' tier exercises the detailed → helpful step of the fallback chain.
const recoveryParticipant: Participant = { id: 'recovery', role: 'recovery', kind: 'role' }

// 'edit_context' ships only {fun}; requesting its absent 'detailed' or 'helpful' tier exercises the helpful → fun step of the fallback chain.
const editContextParticipant: Participant = { id: 'editContext', role: 'edit_context', kind: 'tool' }

describe('resolveParticipantLabel', () => {
	test('returns the requested tier for a seeded role', () => {
		const coder: Participant = { id: 'coder', role: 'coder', kind: 'role' }
		expect(resolveParticipantLabel(coder, 'fun')).toBe('The Builder')
		expect(resolveParticipantLabel(coder, 'helpful')).toBe('Coder')
		expect(resolveParticipantLabel(coder, 'detailed')).toBe('coder')
	})

	test('the human pseudo-role reads "You" across tiers', () => {
		const human: Participant = { id: 'you', role: 'human', kind: 'human' }
		expect(resolveParticipantLabel(human, 'fun')).toBe('You')
		expect(resolveParticipantLabel(human, 'helpful')).toBe('You')
		expect(resolveParticipantLabel(human, 'detailed')).toBe('You (human)')
	})

	test('falls back detailed → helpful → fun when the requested tier is absent', () => {
		// 'recovery' carries only {fun, helpful}: requesting the absent 'detailed' tier resolves to 'helpful' rather than skipping to 'fun', proving the chain walks one step at a time toward less-precise tiers.
		expect(resolveParticipantLabel(recoveryParticipant, 'detailed')).toBe('Recovery')
		expect(resolveParticipantLabel(recoveryParticipant, 'helpful')).toBe('Recovery')
		expect(resolveParticipantLabel(recoveryParticipant, 'fun')).toBe('The Fixer')
		// 'edit_context' carries only {fun}: requesting 'detailed' or 'helpful' walks past the absent tiers and lands on 'fun'.
		expect(resolveParticipantLabel(editContextParticipant, 'detailed')).toBe('The Memory Editor')
		expect(resolveParticipantLabel(editContextParticipant, 'helpful')).toBe('The Memory Editor')
		expect(resolveParticipantLabel(editContextParticipant, 'fun')).toBe('The Memory Editor')
	})

	test('falls back to the title-cased role name when no entry exists', () => {
		expect(resolveParticipantLabel(unseededParticipant, 'fun')).toBe('Sous Chef')
		expect(resolveParticipantLabel(unseededParticipant, 'helpful')).toBe('Sous Chef')
		expect(resolveParticipantLabel(unseededParticipant, 'detailed')).toBe('Sous Chef')
	})
})

describe('resolveOperationLabel', () => {
	test('renders each tier for a role-to-role call', () => {
		const participants: Participant[] = [
			{ id: 'orchestrator', role: 'orchestrator', kind: 'role' },
			{ id: 'planner', role: 'planner', kind: 'role' },
		]
		const operation: Operation = { id: 'op1', kind: 'call', stack: 'root', source: 'orchestrator', destination: 'planner', startedAt: 't0', settledAt: null, lifecycle: 'in_flight', outcome: null, details: null, metrics: null }
		expect(resolveOperationLabel(operation, participants, 'fun')).toBe('The Conductor pass the baton to The Mapmaker')
		expect(resolveOperationLabel(operation, participants, 'helpful')).toBe('Orchestrator delegate to Planner')
		expect(resolveOperationLabel(operation, participants, 'detailed')).toBe('call orchestrator → planner')
	})

	test('a role-to-tool call reads playfully in fun and precisely in detailed', () => {
		const participants: Participant[] = [
			{ id: 'coder', role: 'coder', kind: 'role' },
			{ id: 'readFile', role: 'read_file', kind: 'tool' },
		]
		const operation: Operation = { id: 'op1', kind: 'call', stack: 'root', source: 'coder', destination: 'readFile', startedAt: 't0', settledAt: null, lifecycle: 'in_flight', outcome: null, details: null, metrics: null }
		expect(resolveOperationLabel(operation, participants, 'fun')).toBe('The Builder grab the The Page Turner gadget')
		expect(resolveOperationLabel(operation, participants, 'detailed')).toBe('coder invoked tool read_file (tool)')
	})

	test('interpolates both source and destination labels into the rendered operation label', () => {
		const participants: Participant[] = [
			{ id: 'you', role: 'human', kind: 'human' },
			{ id: 'orchestrator', role: 'orchestrator', kind: 'role' },
		]
		const operation: Operation = { id: 'op1', kind: 'call', stack: 'root', source: 'you', destination: 'orchestrator', startedAt: 't0', settledAt: null, lifecycle: 'in_flight', outcome: null, details: null, metrics: null }
		const rendered = resolveOperationLabel(operation, participants, 'helpful')
		expect(rendered).toContain('You')
		expect(rendered).toContain('Orchestrator')
	})

	test('falls back to the per-kind generic template for an unseeded participant-kind combination', () => {
		// No specific 'tool->tool' discriminator is seeded, so a call between two tools uses the generic 'call' template at the chosen tier.
		const participants: Participant[] = [
			{ id: 'readFile', role: 'read_file', kind: 'tool' },
			{ id: 'writeFile', role: 'write_file', kind: 'tool' },
		]
		const operation: Operation = { id: 'op1', kind: 'call', stack: 'root', source: 'readFile', destination: 'writeFile', startedAt: 't0', settledAt: null, lifecycle: 'in_flight', outcome: null, details: null, metrics: null }
		expect(resolveOperationLabel(operation, participants, 'detailed')).toBe('call read_file (tool) → write_file (tool)')
		expect(resolveOperationLabel(operation, participants, 'helpful')).toBe('The Page Turner call The Scribe')
	})

	test('renders observes, returns, and interrupt-rooted calls across all three tiers', () => {
		const participants: Participant[] = [
			{ id: 'interrupt', role: 'interrupt', kind: 'interrupt' },
			{ id: 'loopDetector', role: 'loop_detector', kind: 'role' },
			{ id: 'coder', role: 'coder', kind: 'role' },
		]
		const interruptCall: Operation = { id: 'op1', kind: 'call', stack: 'interrupt-stack', source: 'interrupt', destination: 'loopDetector', startedAt: 't0', settledAt: null, lifecycle: 'in_flight', outcome: null, details: null, metrics: null }
		expect(resolveOperationLabel(interruptCall, participants, 'fun')).toBe('The Doorbell butt in on The Loop Sniffer')
		expect(resolveOperationLabel(interruptCall, participants, 'detailed')).toBe('interrupt (pseudo-role) preempted loop_detector')
		const observe: Operation = { id: 'op2', kind: 'observe', stack: 'interrupt-stack', source: 'loopDetector', destination: 'coder', startedAt: 't1', settledAt: 't1', lifecycle: 'settled', outcome: null, details: null, metrics: null }
		expect(resolveOperationLabel(observe, participants, 'fun')).toBe('The Loop Sniffer peek at The Builder')
		expect(resolveOperationLabel(observe, participants, 'detailed')).toBe('observe loop_detector → coder')
		const returnToInterrupt: Operation = { id: 'op3', kind: 'return', stack: 'interrupt-stack', source: 'loopDetector', destination: 'interrupt', startedAt: 't2', settledAt: 't3', lifecycle: 'settled', outcome: 'success', details: null, metrics: null }
		expect(resolveOperationLabel(returnToInterrupt, participants, 'helpful')).toBe('Loop Detector return to The Doorbell')
	})

	test('every participant and operation of every demo scenario renders a non-empty label at every tier', () => {
		for (const scenario of scenarios) {
			const finalFrame = scenario.frames[scenario.frames.length - 1]
			if (finalFrame === undefined) throw new Error(`scenario "${scenario.id}" has no frames`)
			for (const participant of finalFrame.participants) {
				for (const tier of ['fun', 'helpful', 'detailed'] as const) {
					const label = resolveParticipantLabel(participant, tier)
					expect(label.length).toBeGreaterThan(0)
				}
			}
			for (const operation of finalFrame.operations) {
				for (const tier of ['fun', 'helpful', 'detailed'] as const) {
					const label = resolveOperationLabel(operation, finalFrame.participants, tier)
					expect(label.length).toBeGreaterThan(0)
				}
			}
		}
	})
})
