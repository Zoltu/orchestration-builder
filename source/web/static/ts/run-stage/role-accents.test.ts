import { describe, expect, test } from 'bun:test'
import { createRunStage } from './index.js'
import type { InteractionModel, Participant } from '../interaction-model.js'
import { createLabelResolver } from '../labels.js'
import { isObject } from '../guards.js'
import { createRoleAccentResolver } from './role-accents.js'

// The reserved hue windows, pinned here independently of the stage implementation: if a token's measured anchor moves, this copy fails the suite and forces a conscious re-read of both. The anchors are the OKLCH hues of the shipped status/tool tokens in stylesheets/styles.css — error red ≈ 25° (light #cf222e, dark #f85149), success green ≈ 147° (light #1a7f37, dark #3fb950), tool violet ≈ 297° (light #8250df, dark #a371f7).
const RESERVED_HUE_WINDOWS: { lower: number; upper: number }[] = [
	{ lower: 352, upper: 42 },
	{ lower: 122, upper: 172 },
	{ lower: 272, upper: 322 },
]

// The 21 agent roles the shipped guild declares, so the distinctness assertion runs against the real seed set rather than a synthetic count.
const SEED_GUILD_ROLES = [
	'orchestrator', 'planner', 'architecture_lead', 'style_lead', 'security_lead', 'acceptance_lead',
	'coder', 'technical_writer', 'analyst', 'researcher', 'change_summarizer',
	'architecture_reviewer', 'style_reviewer', 'security_reviewer', 'acceptance_reviewer', 'verifier',
	'style_guide_author', 'loop_detector', 'context_manager', 'inquiry_responder', 'recovery',
]

interface FakeVnode {
	tag: string
	props: Record<string, unknown>
	children: FakeVnodeChild[]
}
type FakeVnodeChild = FakeVnode | string

function fakeH(tag: string, props: Record<string, unknown>, children: FakeVnodeChild[]): FakeVnode {
	return { tag, props, children }
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

function styleVar(vnode: FakeVnode, key: string): string | undefined {
	const style = vnode.props['style']
	if (!isObject(style)) return undefined
	const value = style[key]
	return typeof value === 'string' ? value : undefined
}

function roleModel(roleNames: string[]): InteractionModel {
	const participants: Participant[] = roleNames.map((role, index) => ({ id: `role-${index}`, role, kind: 'role' }))
	return { participants, operations: [], status: 'running' }
}

function accentsByRole(roleNames: string[]): Map<string, string> {
	const stage = createRunStage({ roleNames, roleOrder: [] })
	const view = stage.render(fakeH, {
		model: roleModel(roleNames),
		previousModel: null,
		labels: labels(),
		tier: 'detailed',
		viewMode: 'flow',
		rolesOnly: false,
		guildParticipants: [],
	})
	const accents = new Map<string, string>()
	for (const slot of groupsWithClass(view, 'flow-small-node')) {
		const role = slot.props['data-role']
		const accent = styleVar(slot, '--node-accent')
		if (typeof role !== 'string') continue
		if (accent === undefined) continue
		accents.set(role, accent)
	}
	return accents
}

interface OklchColor {
	lightness: number
	chroma: number
	hue: number
}

function parseAccent(accent: string): OklchColor {
	const match = /^oklch\((\d*\.?\d+) (\d*\.?\d+) (\d*\.?\d+)\)$/.exec(accent)
	if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
		throw new Error(`accent "${accent}" is not the pinned oklch format`)
	}
	return { lightness: Number(match[1]), chroma: Number(match[2]), hue: Number(match[3]) }
}

function isReservedHue(hue: number): boolean {
	return RESERVED_HUE_WINDOWS.some((window) => {
		const span = (window.upper - window.lower + 360) % 360
		const forwardFromLower = (((hue - window.lower) % 360) + 360) % 360
		return forwardFromLower > 0 && forwardFromLower < span
	})
}

function sortedEntries(accents: Map<string, string>): Array<[string, string]> {
	return Array.from(accents.entries()).sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0))
}

describe('role accents through the stage', () => {
	test('the same role list resolves the same colors on every build', () => {
		expect(sortedEntries(accentsByRole(SEED_GUILD_ROLES))).toEqual(sortedEntries(accentsByRole(SEED_GUILD_ROLES)))
	})

	test('the assignment does not depend on the order the roles are given in', () => {
		expect(sortedEntries(accentsByRole(SEED_GUILD_ROLES))).toEqual(sortedEntries(accentsByRole(SEED_GUILD_ROLES.slice().reverse())))
	})

	test('duplicate names in the input do not shift colors', () => {
		expect(sortedEntries(accentsByRole(['coder', 'coder', 'planner']))).toEqual(sortedEntries(accentsByRole(['coder', 'planner'])))
	})

	test('the 21-role seed guild resolves 21 distinct, reserved-free colors', () => {
		const accents = accentsByRole(SEED_GUILD_ROLES)
		expect(accents.size).toBe(SEED_GUILD_ROLES.length)
		expect(new Set(accents.values()).size).toBe(SEED_GUILD_ROLES.length)
		for (const accent of accents.values()) {
			expect(isReservedHue(parseAccent(accent).hue)).toBe(false)
		}
	})

	test('overflow past the palette length still yields distinct, reserved-free colors', () => {
		const roleNames = Array.from({ length: 200 }, (_, index) => `role-${index}`)
		const accents = accentsByRole(roleNames)
		expect(accents.size).toBe(roleNames.length)
		expect(new Set(accents.values()).size).toBe(roleNames.length)
		for (const accent of accents.values()) {
			expect(accent).toMatch(/^oklch\(/)
			expect(isReservedHue(parseAccent(accent).hue)).toBe(false)
		}
	})

	test('unknown roles and pseudo-roles resolve to null', () => {
		const model: InteractionModel = {
			participants: [
				{ id: 'human', role: 'human', kind: 'human' },
				{ id: 'tool', role: 'read_file', kind: 'tool' },
				{ id: 'unknown', role: 'outside-guild', kind: 'role' },
			],
			operations: [],
			status: 'running',
		}
		const stage = createRunStage({ roleNames: ['coder'], roleOrder: [] })
		const view = stage.render(fakeH, { model, previousModel: null, labels: labels(), tier: 'detailed', viewMode: 'flow', rolesOnly: false, guildParticipants: [] })
		for (const group of groupsWithClass(view, 'flow-node')) {
			expect(styleVar(group, '--node-accent')).toBeUndefined()
		}
		for (const slot of groupsWithClass(view, 'flow-small-node')) {
			expect(styleVar(slot, '--node-accent')).toBeUndefined()
		}
	})

	test('an empty role list accents nothing', () => {
		expect(accentsByRole([]).size).toBe(0)
	})
})

// The OKLab a/b components of an oklch color, so distance is perceptual rather than a raw hue arc.
function toOklab(color: OklchColor): { lightness: number; a: number; b: number } {
	const radians = (color.hue * Math.PI) / 180
	return { lightness: color.lightness, a: color.chroma * Math.cos(radians), b: color.chroma * Math.sin(radians) }
}

function colorDistance(first: OklchColor, second: OklchColor): number {
	const a = toOklab(first)
	const b = toOklab(second)
	return Math.hypot(a.lightness - b.lightness, a.a - b.a, a.b - b.b)
}

function minimumPairwiseDistance(colors: OklchColor[]): number {
	let minimum = Number.POSITIVE_INFINITY
	for (let firstIndex = 0; firstIndex < colors.length; firstIndex++) {
		for (let secondIndex = firstIndex + 1; secondIndex < colors.length; secondIndex++) {
			const first = colors[firstIndex]
			const second = colors[secondIndex]
			if (first === undefined || second === undefined) throw new Error('color list shorter than the pairwise scan expected')
			minimum = Math.min(minimum, colorDistance(first, second))
		}
	}
	return minimum
}

function accentsFor(roleNames: readonly string[]): string[] {
	const resolver = createRoleAccentResolver(roleNames)
	return roleNames.map((role) => {
		const accent = resolver(role)
		if (accent === null) throw new Error(`resolver returned null for a declared role "${role}"`)
		return accent
	})
}

describe('role accent stability and separation', () => {
	test('a role keeps its color as the observed subset grows (the resolver is stateless)', () => {
		const resolver = createRoleAccentResolver(SEED_GUILD_ROLES)
		const firstSeen = resolver('orchestrator')
		expect(firstSeen).not.toBeNull()
		for (const role of ['planner', 'coder', 'verifier', 'recovery']) expect(resolver(role)).not.toBeNull()
		expect(resolver('orchestrator')).toBe(firstSeen)
	})

	test('the 21-role seed guild clears the pinned perceptual separation', () => {
		const colors = Array.from(accentsByRole(SEED_GUILD_ROLES).values()).map(parseAccent)
		expect(new Set(colors.map((color) => `${color.lightness} ${color.chroma} ${color.hue}`)).size).toBe(SEED_GUILD_ROLES.length)
		expect(minimumPairwiseDistance(colors)).toBeGreaterThanOrEqual(0.05)
	})

	test('the collision boundary stays unique at the palette length, one past it, and the old first-collision count', () => {
		for (const count of [24, 25, 121]) {
			const roles = Array.from({ length: count }, (_, index) => `role_${index}`)
			expect(new Set(accentsFor(roles)).size).toBe(count)
		}
	})

	test('the emitted color is the pinned oklch format', () => {
		for (const accent of accentsFor(['alpha', 'beta', 'gamma', 'delta', 'epsilon'])) {
			expect(accent).toMatch(/^oklch\(\d*\.?\d+ \d*\.?\d+ \d*\.?\d+\)$/)
		}
	})
})
