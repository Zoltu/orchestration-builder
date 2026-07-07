import { describe, expect, test } from 'bun:test'
import { createLabelResolver } from './static/labels.js'
import { activeStack } from './static/interaction-model.js'
import { scenarios } from './static/scenarios.js'

// Pull the model types off helper signatures so the test fixtures are contextually checked against the JSDoc shape without a cast, mirroring the sibling scenarios.test.ts convention.
type InteractionModel = Parameters<typeof activeStack>[0]
type Participant = InteractionModel['participants'][number]
type Operation = InteractionModel['operations'][number]

// A minimal crafted config exercising the resolver's LOGIC — not a copy of the guild. The real guild has complete three-tier labels for every role and tool, so it cannot exercise the fallback chain (a tier MISSING from an entry) or the missing-entry fallback (an ABSENT role). `edit_context` carries only {playful} to walk the detailed → friendly → playful chain; `sous_chef` is absent entirely to exercise the title-cased role-name fallback. The operation templates include only the discriminators the assertions check plus the per-kind generics the end-to-end scenario loop falls back to.
const sampleConfig = {
	roles: {
		orchestrator: { label: { detailed: 'Orchestrator', friendly: 'Orchestrator', playful: 'Conductor' } },
		planner: { label: { detailed: 'Planner', friendly: 'Planner', playful: 'Strategist' }, workingLabel: { detailed: 'Receiving tokens from {participant}', friendly: '{participant} is planning the approach', playful: '{participant} is charting the course' } },
		coder: { label: { detailed: 'Coder', friendly: 'Coder', playful: 'Builder' } },
		recovery: { label: { detailed: 'Recovery', friendly: 'Recovery', playful: 'Fix-it Fairy' } },
	},
	tools: {
		read_file: {
			humanLabel: { detailed: 'Read File', friendly: 'Read', playful: 'Open Book' },
			humanCallLabel: { detailed: '{source} is invoking tool {destination}', friendly: '{source} is reading a file', playful: '{source} is getting a book off the shelf' },
			humanWorkingLabel: { detailed: 'Reading file contents', friendly: 'Reading a file', playful: 'Reading a book' },
		},
		write_file: { humanLabel: { detailed: 'Write File', friendly: 'Write', playful: 'Pen It Down' } },
		edit_context: { humanLabel: { playful: 'Memory Editor' } },
	},
	visualization: {
		pseudoRoleLabels: {
			human: { detailed: 'The human', friendly: 'The human', playful: 'Hooman' },
			interrupt: { detailed: 'interrupt (pseudo-role)', playful: 'The Doorbell' },
			tools: { detailed: 'tools', friendly: 'Tools', playful: 'The Toolbelt' },
		},
		operationTemplates: {
			call: {
				'human->role': { detailed: '{source} is calling {destination}', friendly: '{source} is asking {destination} to start', playful: '{source} is handing the quest off to {destination}' },
				'role->role': { detailed: '{source} is calling {destination}', friendly: '{source} is delegating to {destination}', playful: '{source} is passing the baton to {destination}' },
				'role->tool': { detailed: '{source} is invoking tool {destination}', friendly: '{source} is using {destination}', playful: '{source} is grabbing the {destination} gadget' },
			},
			return: {
				'role->role': { detailed: '{source} is returning to {destination}', friendly: '{source} is returning to {destination}', playful: '{source} is giving {destination} a thumbs-up' },
				'tool->role': { detailed: 'tool {source} is returning to {destination}', friendly: '{source} is returning result to {destination}', playful: '{source} is reporting back to {destination}' },
			},
			observe: {
				'role->role': { detailed: '{source} is observing {destination}', friendly: '{source} is observing {destination}', playful: '{source} is peeking at {destination}' },
			},
			terminate: {
				'tool->role': { detailed: '{source} is terminating {destination}', friendly: '{source} is rewinding {destination}', playful: '{source} is zapping {destination}' },
			},
		},
		genericOperationTemplates: {
			call: { detailed: '{source} is calling {destination}', friendly: '{source} is calling {destination}', playful: '{source} is ringing up {destination}' },
			return: { detailed: '{source} is returning to {destination}', friendly: '{source} is returning to {destination}', playful: '{source} is reporting back to {destination}' },
			observe: { detailed: '{source} is observing {destination}', friendly: '{source} is observing {destination}', playful: '{source} is peeking at {destination}' },
			terminate: { detailed: '{source} is terminating {destination}', friendly: '{source} is rewinding {destination}', playful: '{source} is zapping {destination}' },
		},
		workingTemplates: {
			role: { detailed: 'Receiving tokens from {participant}', friendly: '{participant} is thinking', playful: '{participant} is on the case' },
			tool: { detailed: 'Executing {participant}', friendly: '{participant} is running', playful: '{participant} is on the job' },
		},
	},
}

const labels = createLabelResolver(sampleConfig)

describe('resolveParticipantLabel', () => {
	test('returns the requested tier for a seeded role', () => {
		const coder: Participant = { id: 'coder', role: 'coder', kind: 'role' }
		expect(labels.resolveParticipantLabel(coder, 'playful')).toBe('Builder')
		expect(labels.resolveParticipantLabel(coder, 'friendly')).toBe('Coder')
		expect(labels.resolveParticipantLabel(coder, 'detailed')).toBe('Coder')
	})

	test('the human pseudo-role reads "The human" at detailed and friendly and "Hooman" at playful', () => {
		const human: Participant = { id: 'you', role: 'human', kind: 'human' }
		expect(labels.resolveParticipantLabel(human, 'playful')).toBe('Hooman')
		expect(labels.resolveParticipantLabel(human, 'friendly')).toBe('The human')
		expect(labels.resolveParticipantLabel(human, 'detailed')).toBe('The human')
	})

	test('falls back detailed → friendly → playful when the requested tier is absent', () => {
		// 'recovery' carries {detailed, friendly, playful}: all three tiers are present, so each request resolves directly.
		const recoveryParticipant: Participant = { id: 'recovery', role: 'recovery', kind: 'role' }
		expect(labels.resolveParticipantLabel(recoveryParticipant, 'detailed')).toBe('Recovery')
		expect(labels.resolveParticipantLabel(recoveryParticipant, 'friendly')).toBe('Recovery')
		expect(labels.resolveParticipantLabel(recoveryParticipant, 'playful')).toBe('Fix-it Fairy')
		// 'edit_context' carries only {playful}: requesting 'detailed' or 'friendly' walks past the absent tiers and lands on 'playful'.
		const editContextParticipant: Participant = { id: 'editContext', role: 'edit_context', kind: 'tool' }
		expect(labels.resolveParticipantLabel(editContextParticipant, 'detailed')).toBe('Memory Editor')
		expect(labels.resolveParticipantLabel(editContextParticipant, 'friendly')).toBe('Memory Editor')
		expect(labels.resolveParticipantLabel(editContextParticipant, 'playful')).toBe('Memory Editor')
	})

	test('falls back to the title-cased role name when no entry exists', () => {
		const unseededParticipant: Participant = { id: 'chef', role: 'sous_chef', kind: 'role' }
		expect(labels.resolveParticipantLabel(unseededParticipant, 'playful')).toBe('Sous Chef')
		expect(labels.resolveParticipantLabel(unseededParticipant, 'friendly')).toBe('Sous Chef')
		expect(labels.resolveParticipantLabel(unseededParticipant, 'detailed')).toBe('Sous Chef')
	})
})

describe('resolveOperationLabel', () => {
	test('renders each tier for a role-to-role call', () => {
		const participants: Participant[] = [
			{ id: 'orchestrator', role: 'orchestrator', kind: 'role' },
			{ id: 'planner', role: 'planner', kind: 'role' },
		]
		const operation: Operation = { id: 'op1', kind: 'call', stack: 'root', source: 'orchestrator', destination: 'planner', startedAt: 't0', settledAt: null, lifecycle: 'in_flight', outcome: null, details: null, metrics: null }
		expect(labels.resolveOperationLabel(operation, participants, 'playful')).toBe('Conductor is passing the baton to Strategist')
		expect(labels.resolveOperationLabel(operation, participants, 'friendly')).toBe('Orchestrator is delegating to Planner')
		expect(labels.resolveOperationLabel(operation, participants, 'detailed')).toBe('Orchestrator is calling Planner')
	})

	test('a role-to-tool call uses the per-tool humanCallLabel when the tool carries one', () => {
		const participants: Participant[] = [
			{ id: 'coder', role: 'coder', kind: 'role' },
			{ id: 'readFile', role: 'read_file', kind: 'tool' },
		]
		const operation: Operation = { id: 'op1', kind: 'call', stack: 'root', source: 'coder', destination: 'readFile', startedAt: 't0', settledAt: null, lifecycle: 'in_flight', outcome: null, details: null, metrics: null }
		expect(labels.resolveOperationLabel(operation, participants, 'playful')).toBe('Builder is getting a book off the shelf')
		expect(labels.resolveOperationLabel(operation, participants, 'friendly')).toBe('Coder is reading a file')
		expect(labels.resolveOperationLabel(operation, participants, 'detailed')).toBe('Coder is invoking tool Read File')
	})

	test('a role-to-tool call falls back to the generic discriminator template when the tool has no humanCallLabel', () => {
		const participants: Participant[] = [
			{ id: 'coder', role: 'coder', kind: 'role' },
			{ id: 'writeFile', role: 'write_file', kind: 'tool' },
		]
		const operation: Operation = { id: 'op1', kind: 'call', stack: 'root', source: 'coder', destination: 'writeFile', startedAt: 't0', settledAt: null, lifecycle: 'in_flight', outcome: null, details: null, metrics: null }
		expect(labels.resolveOperationLabel(operation, participants, 'playful')).toBe('Builder is grabbing the Pen It Down gadget')
		expect(labels.resolveOperationLabel(operation, participants, 'detailed')).toBe('Coder is invoking tool Write File')
	})

	test('interpolates both source and destination labels into the rendered operation label', () => {
		const participants: Participant[] = [
			{ id: 'you', role: 'human', kind: 'human' },
			{ id: 'orchestrator', role: 'orchestrator', kind: 'role' },
		]
		const operation: Operation = { id: 'op1', kind: 'call', stack: 'root', source: 'you', destination: 'orchestrator', startedAt: 't0', settledAt: null, lifecycle: 'in_flight', outcome: null, details: null, metrics: null }
		const rendered = labels.resolveOperationLabel(operation, participants, 'friendly')
		expect(rendered).toContain('The human')
		expect(rendered).toContain('Orchestrator')
	})

	test('falls back to the per-kind generic template for an unseeded participant-kind combination', () => {
		// No specific 'tool->tool' discriminator is seeded, so a call between two tools uses the generic 'call' template at the chosen tier.
		const participants: Participant[] = [
			{ id: 'readFile', role: 'read_file', kind: 'tool' },
			{ id: 'writeFile', role: 'write_file', kind: 'tool' },
		]
		const operation: Operation = { id: 'op1', kind: 'call', stack: 'root', source: 'readFile', destination: 'writeFile', startedAt: 't0', settledAt: null, lifecycle: 'in_flight', outcome: null, details: null, metrics: null }
		expect(labels.resolveOperationLabel(operation, participants, 'detailed')).toBe('Read File is calling Write File')
		expect(labels.resolveOperationLabel(operation, participants, 'friendly')).toBe('Read is calling Write')
	})
})

describe('resolveWorkingLabel', () => {
	test('returns the per-role working label interpolated with the role label at the chosen tier', () => {
		// 'planner' carries a workingLabel with all three tiers; {participant} interpolates to planner's own label at each tier.
		const planner: Participant = { id: 'planner', role: 'planner', kind: 'role' }
		expect(labels.resolveWorkingLabel(planner, 'detailed')).toBe('Receiving tokens from Planner')
		expect(labels.resolveWorkingLabel(planner, 'friendly')).toBe('Planner is planning the approach')
		expect(labels.resolveWorkingLabel(planner, 'playful')).toBe('Strategist is charting the course')
	})

	test('falls back to the generic per-kind working template when the role has no workingLabel', () => {
		// 'coder' has no workingLabel, so the resolver falls back to visualization.workingTemplates.role, interpolated with coder's own label.
		const coder: Participant = { id: 'coder', role: 'coder', kind: 'role' }
		expect(labels.resolveWorkingLabel(coder, 'detailed')).toBe('Receiving tokens from Coder')
		expect(labels.resolveWorkingLabel(coder, 'friendly')).toBe('Coder is thinking')
		expect(labels.resolveWorkingLabel(coder, 'playful')).toBe('Builder is on the case')
	})

	test('uses the per-tool humanWorkingLabel when the tool carries one', () => {
		// 'read_file' carries a humanWorkingLabel with all three tiers; the template has no {participant} placeholder, so the text reads as a tool-specific action ("Reading file contents" / "Reading a book") rather than naming the tool.
		const readFile: Participant = { id: 'readFile', role: 'read_file', kind: 'tool' }
		expect(labels.resolveWorkingLabel(readFile, 'detailed')).toBe('Reading file contents')
		expect(labels.resolveWorkingLabel(readFile, 'friendly')).toBe('Reading a file')
		expect(labels.resolveWorkingLabel(readFile, 'playful')).toBe('Reading a book')
	})

	test('falls back to the generic tool working template when the tool has no humanWorkingLabel', () => {
		// 'write_file' has no humanWorkingLabel, so the resolver falls back to visualization.workingTemplates.tool.
		const writeFile: Participant = { id: 'writeFile', role: 'write_file', kind: 'tool' }
		expect(labels.resolveWorkingLabel(writeFile, 'detailed')).toBe('Executing Write File')
		expect(labels.resolveWorkingLabel(writeFile, 'friendly')).toBe('Write is running')
		expect(labels.resolveWorkingLabel(writeFile, 'playful')).toBe('Pen It Down is on the job')
	})

	test('returns null when no working label is configured anywhere for the participant kind', () => {
		// A config with no visualization.workingTemplates and a role with no workingLabel: the resolver returns null so the caller can fall back to the operation label.
		const minimal = createLabelResolver({ roles: { coder: { label: { detailed: 'Coder', friendly: 'Coder', playful: 'Builder' } } }, tools: {} })
		const coder: Participant = { id: 'coder', role: 'coder', kind: 'role' }
		expect(minimal.resolveWorkingLabel(coder, 'detailed')).toBeNull()
	})
})

describe('end-to-end over the demo scenarios', () => {
	test('every participant and operation of every demo scenario renders a non-empty label at every tier', () => {
		for (const scenario of scenarios) {
			const finalFrame = scenario.frames[scenario.frames.length - 1]
			if (finalFrame === undefined) throw new Error(`scenario "${scenario.id}" has no frames`)
			for (const participant of finalFrame.participants) {
				for (const tier of ['playful', 'friendly', 'detailed'] as const) {
					const label = labels.resolveParticipantLabel(participant, tier)
					expect(label.length).toBeGreaterThan(0)
				}
			}
			for (const operation of finalFrame.operations) {
				for (const tier of ['playful', 'friendly', 'detailed'] as const) {
					const label = labels.resolveOperationLabel(operation, finalFrame.participants, tier)
					expect(label.length).toBeGreaterThan(0)
				}
			}
		}
	})
})
