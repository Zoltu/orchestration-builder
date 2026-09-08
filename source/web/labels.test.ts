import { describe, expect, test } from 'bun:test'
import { createLabelResolver } from './static/labels.js'
import { activeStack } from './static/interaction-model.js'
import { scenarios } from './static/scenarios.js'

// Pull the model types off helper signatures so the test fixtures are contextually checked against the JSDoc shape without a cast, mirroring the sibling scenarios.test.ts convention.
type InteractionModel = Parameters<typeof activeStack>[0]
type Participant = InteractionModel['participants'][number]
type Operation = InteractionModel['operations'][number]

// A minimal crafted config exercising the resolver's LOGIC — not a copy of the guild. The real guild has complete three-tier list labels for every role and tool, so it cannot exercise the fallback chain (a tier MISSING from an entry) or the missing-entry fallback (an ABSENT role). `edit_context` carries only {whimsical} to walk the detailed → friendly → whimsical chain; `sous_chef` is absent entirely to exercise the title-cased role-name fallback. The operation templates include only the discriminators the assertions check plus the per-kind generics the end-to-end scenario loop falls back to. Every tiered value is a non-empty string list; identity surfaces read index 0 and activity surfaces rotate by seed.
const sampleConfig = {
	roles: {
		orchestrator: { label: { detailed: ['Orchestrator'], friendly: ['Orchestrator'], whimsical: ['Conductor'] } },
		planner: {
			label: { detailed: ['Planner'], friendly: ['Planner'], whimsical: ['Strategist'] },
			workingLabel: {
				detailed: ['role {participantRole} is composing the plan (streaming tokens)'],
				friendly: ['Planning the approach'],
				whimsical: ['Charting the course', 'Mapping the route', 'Noodling on the map'],
			},
		},
		coder: { label: { detailed: ['Coder'], friendly: ['Coder'], whimsical: ['Builder'] } },
		recovery: { label: { detailed: ['Recovery'], friendly: ['Recovery'], whimsical: ['Fix-it Fairy'] } },
	},
	tools: {
		read_file: {
			humanLabel: { detailed: ['Read File'], friendly: ['Read'], whimsical: ['Open Book'] },
			humanCallLabel: {
				detailed: ['role {sourceRole} is invoking tool {destinationRole} (stack {stack})'],
				friendly: ['{source} is reading a file'],
				whimsical: ['{source} is getting a book off the shelf', '{source} is pulling a tome down', '{source} is cracking a book open'],
			},
			humanWorkingLabel: {
				detailed: ['tool {participantRole} is reading file contents'],
				friendly: ['Reading a file'],
				whimsical: ['Cracking open a tome', 'Poring over ancient scrolls', 'Flipping through the pages'],
			},
		},
		write_file: { humanLabel: { detailed: ['Write File'], friendly: ['Write'], whimsical: ['Pen It Down'] } },
		edit_context: { humanLabel: { whimsical: ['Memory Editor'] } },
	},
	visualization: {
		pseudoRoleLabels: {
			human: { detailed: ['The human'], friendly: ['The human'], whimsical: ['The Dreamer'] },
			interrupt: { detailed: ['interrupt'], whimsical: ['The Doorbell'] },
			tools: { detailed: ['tools'], friendly: ['Tools'], whimsical: ['The Toolbelt'] },
		},
		operationTemplates: {
			call: {
				'human->role': {
					detailed: ['human is calling role {destinationRole} (stack {stack})'],
					friendly: ['{source} is asking {destination} to start'],
					whimsical: ['{source} is handing the quest off to {destination}', "{source} is knocking on {destination}'s door", '{source} is sending a carrier pigeon to {destination}'],
				},
				'role->role': {
					detailed: ['role {sourceRole} is calling role {destinationRole} (stack {stack})'],
					friendly: ['{source} is delegating to {destination}'],
					whimsical: ['{source} is passing the baton to {destination}', '{source} is tossing the ball to {destination}', '{source} is handing the reins to {destination}'],
				},
				'role->tool': {
					detailed: ['role {sourceRole} is invoking tool {destinationRole} (stack {stack})'],
					friendly: ['{source} is using {destination}'],
					whimsical: ['{source} is grabbing the {destination} gadget', '{source} is reaching for the {destination} tool', '{source} is pulling {destination} from the belt'],
				},
			},
			return: {
				'role->role': {
					detailed: ['role {sourceRole} is returning {outcome} to role {destinationRole} (stack {stack})'],
					friendly: ['{source} is returning to {destination}'],
					whimsical: ['{source} is giving {destination} a thumbs-up', '{source} is bowing out to {destination}', '{source} is passing the mic back to {destination}'],
				},
				'tool->role': {
					detailed: ['tool {sourceRole} is returning {outcome} to role {destinationRole} (stack {stack})'],
					friendly: ['Returning to {destination}'],
					whimsical: ['{source} is reporting back to {destination}', '{source} is handing the answer to {destination}', '{source} is sliding the result across the table to {destination}'],
				},
			},
			observe: {
				'role->role': {
					detailed: ['role {sourceRole} is observing role {destinationRole} (cross-stack reference, stack {stack})'],
					friendly: ['{source} is observing {destination}'],
					whimsical: ['{source} is peeking at {destination}', "{source} is glancing over {destination}'s shoulder", '{source} is eavesdropping on {destination}'],
				},
			},
			terminate: {
				'tool->role': {
					detailed: ['tool {sourceRole} is reverting role {destinationRole} (terminate, stack {stack})'],
					friendly: ['{source} is rewinding {destination}'],
					whimsical: ['{source} is zapping {destination}', '{source} is vaporizing {destination}', '{source} is hitting {destination} with the undo ray'],
				},
			},
		},
		genericOperationTemplates: {
			call: { detailed: ['{sourceKind} {sourceRole} is calling {destinationKind} {destinationRole} (stack {stack})'], friendly: ['{source} is calling {destination}'], whimsical: ['{source} is ringing up {destination}'] },
			return: { detailed: ['{sourceKind} {sourceRole} is returning {outcome} to {destinationKind} {destinationRole} (stack {stack})'], friendly: ['{source} is returning to {destination}'], whimsical: ['{source} is reporting back to {destination}'] },
			observe: { detailed: ['{sourceKind} {sourceRole} is observing {destinationKind} {destinationRole} (stack {stack})'], friendly: ['{source} is observing {destination}'], whimsical: ['{source} is peeking at {destination}'] },
			terminate: { detailed: ['{sourceKind} {sourceRole} is reverting {destinationKind} {destinationRole} (terminate, stack {stack})'], friendly: ['{source} is rewinding {destination}'], whimsical: ['{source} is zapping {destination}'] },
		},
		workingTemplates: {
			role: { detailed: ['role {participantRole} is generating a response (streaming tokens)'], friendly: ['{participant} is thinking'], whimsical: ['{participant} is on the case', '{participant} is noodling on it', '{participant} is chewing it over'] },
			tool: { detailed: ['tool {participantRole} is executing'], friendly: ['{participant} is running'], whimsical: ['{participant} is on the job', '{participant} is hard at work', '{participant} is grinding away'] },
		},
	},
}

const labels = createLabelResolver(sampleConfig)

function operation(id: string, kind: Operation['kind'], stack: string, source: string, destination: string, outcome: Operation['outcome'] = null): Operation {
	return { id, kind, stack, source, destination, startedAt: 't0', settledAt: null, lifecycle: 'in_flight', outcome, metrics: null }
}

describe('resolveParticipantLabel', () => {
	test('returns index 0 of the requested tier for a seeded role', () => {
		const coder: Participant = { id: 'coder', role: 'coder', kind: 'role' }
		expect(labels.resolveParticipantLabel(coder, 'whimsical')).toBe('Builder')
		expect(labels.resolveParticipantLabel(coder, 'friendly')).toBe('Coder')
		expect(labels.resolveParticipantLabel(coder, 'detailed')).toBe('Coder')
	})

	test('the human pseudo-role reads "The human" at detailed and friendly and "The Dreamer" at whimsical', () => {
		const human: Participant = { id: 'you', role: 'human', kind: 'human' }
		expect(labels.resolveParticipantLabel(human, 'whimsical')).toBe('The Dreamer')
		expect(labels.resolveParticipantLabel(human, 'friendly')).toBe('The human')
		expect(labels.resolveParticipantLabel(human, 'detailed')).toBe('The human')
	})

	test('falls back detailed → friendly → whimsical when the requested tier is absent', () => {
		// 'recovery' carries {detailed, friendly, whimsical}: all three tiers are present, so each request resolves directly to index 0.
		const recoveryParticipant: Participant = { id: 'recovery', role: 'recovery', kind: 'role' }
		expect(labels.resolveParticipantLabel(recoveryParticipant, 'detailed')).toBe('Recovery')
		expect(labels.resolveParticipantLabel(recoveryParticipant, 'friendly')).toBe('Recovery')
		expect(labels.resolveParticipantLabel(recoveryParticipant, 'whimsical')).toBe('Fix-it Fairy')
		// 'edit_context' carries only {whimsical}: requesting 'detailed' or 'friendly' walks past the absent tiers and lands on 'whimsical' (index 0), so the participant label still resolves rather than empty.
		const editContextParticipant: Participant = { id: 'editContext', role: 'edit_context', kind: 'tool' }
		expect(labels.resolveParticipantLabel(editContextParticipant, 'detailed')).toBe('Memory Editor')
		expect(labels.resolveParticipantLabel(editContextParticipant, 'friendly')).toBe('Memory Editor')
		expect(labels.resolveParticipantLabel(editContextParticipant, 'whimsical')).toBe('Memory Editor')
	})

	test('falls back to the title-cased role name when no entry exists', () => {
		const unseededParticipant: Participant = { id: 'chef', role: 'sous_chef', kind: 'role' }
		expect(labels.resolveParticipantLabel(unseededParticipant, 'whimsical')).toBe('Sous Chef')
		expect(labels.resolveParticipantLabel(unseededParticipant, 'friendly')).toBe('Sous Chef')
		expect(labels.resolveParticipantLabel(unseededParticipant, 'detailed')).toBe('Sous Chef')
	})
})

describe('resolveOperationLabel', () => {
	test('renders each tier for a role-to-role call at seed 0', () => {
		const participants: Participant[] = [
			{ id: 'orchestrator', role: 'orchestrator', kind: 'role' },
			{ id: 'planner', role: 'planner', kind: 'role' },
		]
		const op = operation('op1', 'call', 'root', 'orchestrator', 'planner')
		expect(labels.resolveOperationLabel(op, participants, 'whimsical', 0)).toBe('Conductor is passing the baton to Strategist')
		expect(labels.resolveOperationLabel(op, participants, 'friendly', 0)).toBe('Orchestrator is delegating to Planner')
		expect(labels.resolveOperationLabel(op, participants, 'detailed', 0)).toBe('role orchestrator is calling role planner (stack root)')
	})

	test('rotates through the whimsical list by seed and wraps around', () => {
		const participants: Participant[] = [
			{ id: 'orchestrator', role: 'orchestrator', kind: 'role' },
			{ id: 'planner', role: 'planner', kind: 'role' },
		]
		const op = operation('op1', 'call', 'root', 'orchestrator', 'planner')
		// The role->role whimsical list has three entries; seed picks the index, so different operations of the same kind render different phrases while the same operation stays stable across re-renders.
		expect(labels.resolveOperationLabel(op, participants, 'whimsical', 1)).toBe('Conductor is tossing the ball to Strategist')
		expect(labels.resolveOperationLabel(op, participants, 'whimsical', 2)).toBe('Conductor is handing the reins to Strategist')
		expect(labels.resolveOperationLabel(op, participants, 'whimsical', 3)).toBe('Conductor is passing the baton to Strategist')
	})

	test('a role-to-tool call uses the per-tool humanCallLabel when the tool carries one', () => {
		const participants: Participant[] = [
			{ id: 'coder', role: 'coder', kind: 'role' },
			{ id: 'readFile', role: 'read_file', kind: 'tool' },
		]
		const op = operation('op1', 'call', 'root', 'coder', 'readFile')
		expect(labels.resolveOperationLabel(op, participants, 'whimsical', 0)).toBe('Builder is getting a book off the shelf')
		expect(labels.resolveOperationLabel(op, participants, 'friendly', 0)).toBe('Coder is reading a file')
		expect(labels.resolveOperationLabel(op, participants, 'detailed', 0)).toBe('role coder is invoking tool read_file (stack root)')
	})

	test('a role-to-tool call falls back to the discriminator template when the tool has no humanCallLabel', () => {
		const participants: Participant[] = [
			{ id: 'coder', role: 'coder', kind: 'role' },
			{ id: 'writeFile', role: 'write_file', kind: 'tool' },
		]
		const op = operation('op1', 'call', 'root', 'coder', 'writeFile')
		expect(labels.resolveOperationLabel(op, participants, 'whimsical', 0)).toBe('Builder is grabbing the Pen It Down gadget')
		expect(labels.resolveOperationLabel(op, participants, 'detailed', 0)).toBe('role coder is invoking tool write_file (stack root)')
	})

	test('interpolates both source and destination labels into the rendered operation label', () => {
		const participants: Participant[] = [
			{ id: 'you', role: 'human', kind: 'human' },
			{ id: 'orchestrator', role: 'orchestrator', kind: 'role' },
		]
		const op = operation('op1', 'call', 'root', 'you', 'orchestrator')
		const rendered = labels.resolveOperationLabel(op, participants, 'friendly', 0)
		expect(rendered).toContain('The human')
		expect(rendered).toContain('Orchestrator')
	})

	test('the detailed tier names the raw role ids, kinds, stack, and outcome for troubleshooting', () => {
		const participants: Participant[] = [
			{ id: 'readFile', role: 'read_file', kind: 'tool' },
			{ id: 'coder', role: 'coder', kind: 'role' },
		]
		const op = operation('op1', 'return', 'root', 'readFile', 'coder', 'error')
		expect(labels.resolveOperationLabel(op, participants, 'detailed', 0)).toBe('tool read_file is returning error to role coder (stack root)')
	})

	test('falls back to the per-kind generic template for an unseeded participant-kind combination', () => {
		// No specific 'tool->tool' discriminator is seeded, so a call between two tools uses the generic 'call' template at the chosen tier.
		const participants: Participant[] = [
			{ id: 'readFile', role: 'read_file', kind: 'tool' },
			{ id: 'writeFile', role: 'write_file', kind: 'tool' },
		]
		const op = operation('op1', 'call', 'root', 'readFile', 'writeFile')
		expect(labels.resolveOperationLabel(op, participants, 'detailed', 0)).toBe('tool read_file is calling tool write_file (stack root)')
		expect(labels.resolveOperationLabel(op, participants, 'friendly', 0)).toBe('Read is calling Write')
	})
})

describe('resolveWorkingLabel', () => {
	test('returns the per-role working label interpolated at the chosen tier, rotating the whimsical list by seed', () => {
		// 'planner' carries a workingLabel with all three tiers. The detailed tier interpolates the raw role id; the friendly tier reads alone; the whimsical tier rotates through its three entries by seed.
		const planner: Participant = { id: 'planner', role: 'planner', kind: 'role' }
		expect(labels.resolveWorkingLabel(planner, 'detailed', 0)).toBe('role planner is composing the plan (streaming tokens)')
		expect(labels.resolveWorkingLabel(planner, 'friendly', 0)).toBe('Planning the approach')
		expect(labels.resolveWorkingLabel(planner, 'whimsical', 0)).toBe('Charting the course')
		expect(labels.resolveWorkingLabel(planner, 'whimsical', 1)).toBe('Mapping the route')
		expect(labels.resolveWorkingLabel(planner, 'whimsical', 2)).toBe('Noodling on the map')
		expect(labels.resolveWorkingLabel(planner, 'whimsical', 3)).toBe('Charting the course')
	})

	test('falls back to the generic per-kind working template when the role has no workingLabel', () => {
		// 'coder' has no workingLabel, so the resolver falls back to visualization.workingTemplates.role. {participant} interpolates to coder's own label at each tier (index 0); {participantRole} interpolates to the raw id.
		const coder: Participant = { id: 'coder', role: 'coder', kind: 'role' }
		expect(labels.resolveWorkingLabel(coder, 'detailed', 0)).toBe('role coder is generating a response (streaming tokens)')
		expect(labels.resolveWorkingLabel(coder, 'friendly', 0)).toBe('Coder is thinking')
		expect(labels.resolveWorkingLabel(coder, 'whimsical', 0)).toBe('Builder is on the case')
	})

	test('uses the per-tool humanWorkingLabel when the tool carries one', () => {
		// 'read_file' carries a humanWorkingLabel with all three tiers; the templates read as tool-specific actions rather than naming the tool.
		const readFile: Participant = { id: 'readFile', role: 'read_file', kind: 'tool' }
		expect(labels.resolveWorkingLabel(readFile, 'detailed', 0)).toBe('tool read_file is reading file contents')
		expect(labels.resolveWorkingLabel(readFile, 'friendly', 0)).toBe('Reading a file')
		expect(labels.resolveWorkingLabel(readFile, 'whimsical', 0)).toBe('Cracking open a tome')
		expect(labels.resolveWorkingLabel(readFile, 'whimsical', 1)).toBe('Poring over ancient scrolls')
	})

	test('falls back to the generic tool working template when the tool has no humanWorkingLabel', () => {
		// 'write_file' has no humanWorkingLabel, so the resolver falls back to visualization.workingTemplates.tool, interpolated with write_file's own label at each tier.
		const writeFile: Participant = { id: 'writeFile', role: 'write_file', kind: 'tool' }
		expect(labels.resolveWorkingLabel(writeFile, 'detailed', 0)).toBe('tool write_file is executing')
		expect(labels.resolveWorkingLabel(writeFile, 'friendly', 0)).toBe('Write is running')
		expect(labels.resolveWorkingLabel(writeFile, 'whimsical', 0)).toBe('Pen It Down is on the job')
	})

	test('returns null when no working label is configured anywhere for the participant kind', () => {
		// A config with no visualization.workingTemplates and a role with no workingLabel: the resolver returns null so the caller can fall back to the operation label.
		const minimal = createLabelResolver({ roles: { coder: { label: { detailed: ['Coder'], friendly: ['Coder'], whimsical: ['Builder'] } } }, tools: {} })
		const coder: Participant = { id: 'coder', role: 'coder', kind: 'role' }
		expect(minimal.resolveWorkingLabel(coder, 'detailed', 0)).toBeNull()
	})
})

describe('hashString', () => {
	test('is deterministic and non-negative for the operation ids the scenarios use', () => {
		// The same id always hashes to the same value across runs; different ids differ. The caption and the render sites read the seed off the resolver's hashString, so pinning its contract keeps their rotation deterministic.
		expect(labels.hashString('op1')).toBe(labels.hashString('op1'))
		expect(labels.hashString('op1')).toBeGreaterThanOrEqual(0)
		expect(labels.hashString('op1')).not.toBe(labels.hashString('op2'))
		expect(labels.hashString('')).toBe(0)
	})
})

describe('end-to-end over the demo scenarios', () => {
	test('every participant, operation, and working label of every demo scenario renders a non-empty label at every tier', () => {
		for (const scenario of scenarios) {
			const finalFrame = scenario.frames[scenario.frames.length - 1]
			if (finalFrame === undefined) throw new Error(`scenario "${scenario.id}" has no frames`)
			for (const participant of finalFrame.participants) {
				for (const tier of ['whimsical', 'friendly', 'detailed'] as const) {
					const label = labels.resolveParticipantLabel(participant, tier)
					expect(label.length).toBeGreaterThan(0)
					const working = labels.resolveWorkingLabel(participant, tier, 0)
					// Human/interrupt pseudo-roles have no per-kind working template, so the resolver returns null for them; every role/tool resolves a non-empty working phrase.
					expect(working === null || working.length > 0).toBe(true)
				}
			}
			for (const operation of finalFrame.operations) {
				for (const tier of ['whimsical', 'friendly', 'detailed'] as const) {
					const seed = labels.hashString(operation.id)
					const label = labels.resolveOperationLabel(operation, finalFrame.participants, tier, seed)
					expect(label.length).toBeGreaterThan(0)
				}
			}
		}
	})
})