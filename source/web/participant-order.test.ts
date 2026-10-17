import { describe, expect, test } from 'bun:test'
import { createParticipantComparator } from './static/ts/participant-order.js'
import type { OrderableParticipant } from './static/ts/participant-order.js'

function participant(kind: OrderableParticipant['kind'], role: string): OrderableParticipant {
	return { kind, role }
}

// Sorts a copy through the comparator and renders each entry as "kind:role", so assertions read the full ordering (kind rank and name) rather than only the role names.
function ordered(roleOrder: readonly string[], participants: OrderableParticipant[]): string[] {
	return participants
		.slice()
		.sort(createParticipantComparator(roleOrder))
		.map((entry) => `${entry.kind}:${entry.role}`)
}

describe('createParticipantComparator', () => {
	test('human sorts first, then interrupt, then roles, then tools', () => {
		const participants = [
			participant('tool', 'read_file'),
			participant('role', 'coder'),
			participant('interrupt', 'interrupt'),
			participant('human', 'human'),
		]
		expect(ordered([], participants)).toEqual(['human:human', 'interrupt:interrupt', 'role:coder', 'tool:read_file'])
	})

	test('roles sort by their index in roleOrder', () => {
		const participants = [participant('role', 'alpha'), participant('role', 'beta'), participant('role', 'gamma')]
		expect(ordered(['gamma', 'alpha', 'beta'], participants)).toEqual(['role:gamma', 'role:alpha', 'role:beta'])
	})

	test('a role absent from roleOrder sorts after every listed role, then by name', () => {
		const participants = [participant('role', 'zulu'), participant('role', 'beta'), participant('role', 'alpha'), participant('role', 'yak')]
		expect(ordered(['alpha', 'beta'], participants)).toEqual(['role:alpha', 'role:beta', 'role:yak', 'role:zulu'])
	})

	test('unlisted roles break ties by name ascending', () => {
		const participants = [participant('role', 'charlie'), participant('role', 'alpha'), participant('role', 'bravo')]
		expect(ordered([], participants)).toEqual(['role:alpha', 'role:bravo', 'role:charlie'])
	})

	test('tools sort alphabetically by name', () => {
		const participants = [participant('tool', 'write_file'), participant('tool', 'read_file'), participant('tool', 'glob_files')]
		expect(ordered([], participants)).toEqual(['tool:glob_files', 'tool:read_file', 'tool:write_file'])
	})

	test('human and interrupt compare by kind rank alone, whatever their names', () => {
		const participants = [participant('interrupt', 'interrupt'), participant('human', 'human')]
		expect(ordered([], participants)).toEqual(['human:human', 'interrupt:interrupt'])
	})

	test('building the comparator neither mutates roleOrder nor tracks later changes to it', () => {
		const roleOrder = ['beta', 'alpha']
		const comparator = createParticipantComparator(roleOrder)
		comparator(participant('role', 'alpha'), participant('role', 'beta'))
		expect(roleOrder).toEqual(['beta', 'alpha'])
		// The comparator snapshots roleOrder at construction: reversing the array afterwards must not change the ordering it yields.
		roleOrder.reverse()
		expect(comparator(participant('role', 'alpha'), participant('role', 'beta'))).toBeGreaterThan(0)
	})
})
