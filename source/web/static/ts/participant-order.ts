// The one deterministic participant order the flow view's top bar and the sequence view's role columns share.
//
// The order is: `human` (sequence view only), then `interrupt`, then agent roles, then tools. Agent roles sort by a guild-declared `roleOrder` (guild.json `visualization.roleOrder`), a role the list does not name sorting after every listed role and breaking ties by name; tools sort alphabetically. The executor never hard-codes role names — the order is guild data, and this module only encodes the kind ranking and the comparator the views apply to it.
//
// The module is browser-pure TypeScript and imports only the ParticipantKind type from its sibling interaction-model.
//
// Integration contract for consumers: `roleOrder` is read-only and is not preserved (the comparator keeps its own index map), so a caller may hand in a fresh array per render without disturbing an earlier comparator.

import type { ParticipantKind } from './interaction-model.js'

// The shape the comparator orders: any participant-like value carrying a kind and a role. The flow view's TopBarSlot and the sequence view's SequenceColumn both satisfy it structurally.
export interface OrderableParticipant {
	kind: ParticipantKind
	role: string
}

// The kind rank that groups the strip: human first (the sequence view's leftmost column), then interrupt, then agent roles, then tools.
const PARTICIPANT_KIND_RANK: Record<ParticipantKind, number> = { human: 0, interrupt: 1, role: 2, tool: 3 }

function compareNames(a: string, b: string): number {
	if (a < b) return -1
	if (a > b) return 1
	return 0
}

// Builds the comparator over a guild's declared role order. Two roles sort by their index in `roleOrder`; a role the list does not name sorts after every listed role; listed-vs-listed ties cannot occur because the order is deduplicated upstream, and unlisted-vs-unlisted (or any same-kind fall-through) breaks by role name ascending. Tools sort by name; human and interrupt compare by kind rank alone, with the name as a stable tie-break.
export function createParticipantComparator(roleOrder: readonly string[]): (a: OrderableParticipant, b: OrderableParticipant) => number {
	const indexByRole = new Map<string, number>()
	for (let index = 0; index < roleOrder.length; index++) {
		const role = roleOrder[index]
		if (role === undefined) continue
		indexByRole.set(role, index)
	}
	return (a, b) => {
		const rankDifference = PARTICIPANT_KIND_RANK[a.kind] - PARTICIPANT_KIND_RANK[b.kind]
		if (rankDifference !== 0) return rankDifference
		if (a.kind === 'role') {
			const indexA = indexByRole.get(a.role)
			const indexB = indexByRole.get(b.role)
			if (indexA !== undefined && indexB !== undefined) return indexA - indexB
			if (indexA !== undefined) return -1
			if (indexB !== undefined) return 1
		}
		return compareNames(a.role, b.role)
	}
}
