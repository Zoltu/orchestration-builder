import { describe, expect, test } from 'bun:test'
import { createRunStage } from './index.js'
import type { InteractionModel, Participant } from '../interaction-model.js'
import { createLabelResolver } from '../labels.js'
import { createParticipantComparator } from './participant-order.js'

interface FakeVnode {
	tag: string
	props: Record<string, unknown>
	children: FakeVnodeChild[]
}
type FakeVnodeChild = FakeVnode | string

function fakeH(tag: string, props: Record<string, unknown>, children: FakeVnodeChild[]): FakeVnode {
	return { tag, props, children }
}

function participant(kind: Participant['kind'], role: string): Participant {
	return { id: `${kind}:${role}`, role, kind }
}

function modelWith(participants: Participant[]): InteractionModel {
	return { participants, operations: [], status: 'running' }
}

function labels() {
	return createLabelResolver({})
}

function groupsWithClass(view: FakeVnode, token: string): FakeVnode[] {
	const found: FakeVnode[] = []
	const walk = (node: FakeVnode): void => {
		for (const child of node.children) {
			if (typeof child === 'string') continue
			const classes = typeof child.props['class'] === 'string' ? child.props['class'].split(' ') : []
			if (classes.includes(token)) found.push(child)
			walk(child)
		}
	}
	walk(view)
	return found
}

function topBarRoles(model: InteractionModel, roleOrder: readonly string[]): string[] {
	const stage = createRunStage({ roleNames: [], roleOrder })
	const view = stage.render(fakeH, { model, previousModel: null, labels: labels(), tier: 'detailed', viewMode: 'flow', rolesOnly: false, guildParticipants: [] })
	return groupsWithClass(view, 'flow-small-node').map((slot) => (typeof slot.props['data-role'] === 'string' ? slot.props['data-role'] : ''))
}

function columnRoles(model: InteractionModel, roleOrder: readonly string[]): string[] {
	const stage = createRunStage({ roleNames: [], roleOrder })
	const view = stage.render(fakeH, { model, previousModel: null, labels: labels(), tier: 'detailed', viewMode: 'sequence', rolesOnly: false, guildParticipants: model.participants })
	return groupsWithClass(view, 'seq-column').map((column) => (typeof column.props['data-role'] === 'string' ? column.props['data-role'] : ''))
}

describe('stage participant ordering', () => {
	const participants = [
		participant('tool', 'write_file'),
		participant('role', 'coder'),
		participant('interrupt', 'interrupt'),
		participant('human', 'human'),
		participant('role', 'orchestrator'),
		participant('tool', 'glob_files'),
	]

	test('the flow top bar orders interrupt, then roles by roleOrder, then tools alphabetically', () => {
		expect(topBarRoles(modelWith(participants), ['orchestrator', 'coder'])).toEqual(['interrupt', 'orchestrator', 'coder', 'glob_files', 'write_file'])
	})

	test('unlisted roles sort after every listed role, then by name', () => {
		const roles = [participant('role', 'zulu'), participant('role', 'beta'), participant('role', 'alpha'), participant('role', 'yak')]
		expect(topBarRoles(modelWith(roles), ['alpha', 'beta'])).toEqual(['alpha', 'beta', 'yak', 'zulu'])
	})

	test('the sequence columns keep human first, then interrupt, then ordered roles, then the shared tools column', () => {
		expect(columnRoles(modelWith(participants), ['orchestrator', 'coder'])).toEqual(['human', 'interrupt', 'orchestrator', 'coder', 'tools'])
	})
})

interface OrderableFixture {
	kind: Participant['kind']
	role: string
}

function orderedFixtures(roleOrder: readonly string[], entries: OrderableFixture[]): string[] {
	return entries
		.slice()
		.sort(createParticipantComparator(roleOrder))
		.map((entry) => `${entry.kind}:${entry.role}`)
}

describe('participant comparator invariants', () => {
	test('human and interrupt compare by kind rank alone, whatever their names', () => {
		const entries: OrderableFixture[] = [
			{ kind: 'interrupt', role: 'zzz-interrupt' },
			{ kind: 'human', role: 'zzz-human' },
		]
		expect(orderedFixtures([], entries)).toEqual(['human:zzz-human', 'interrupt:zzz-interrupt'])
	})

	test('listed roles sort by roleOrder, then unlisted roles alphabetically', () => {
		const entries: OrderableFixture[] = [
			{ kind: 'role', role: 'zulu' },
			{ kind: 'role', role: 'beta' },
			{ kind: 'role', role: 'alpha' },
			{ kind: 'role', role: 'yak' },
		]
		expect(orderedFixtures(['beta', 'alpha'], entries)).toEqual(['role:beta', 'role:alpha', 'role:yak', 'role:zulu'])
	})

	test('tools sort alphabetically regardless of roleOrder', () => {
		const entries: OrderableFixture[] = [
			{ kind: 'tool', role: 'write_file' },
			{ kind: 'tool', role: 'glob_files' },
			{ kind: 'tool', role: 'read_file' },
		]
		expect(orderedFixtures(['write_file', 'read_file'], entries)).toEqual(['tool:glob_files', 'tool:read_file', 'tool:write_file'])
	})

	test('building the comparator neither mutates roleOrder nor tracks later changes to it', () => {
		const roleOrder = ['beta', 'alpha']
		const comparator = createParticipantComparator(roleOrder)
		comparator({ kind: 'role', role: 'alpha' }, { kind: 'role', role: 'beta' })
		expect(roleOrder).toEqual(['beta', 'alpha'])
		roleOrder.reverse()
		expect(comparator({ kind: 'role', role: 'alpha' }, { kind: 'role', role: 'beta' })).toBeGreaterThan(0)
	})
})
