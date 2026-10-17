import { describe, expect, test } from 'bun:test'
import type { Participant } from './static/ts/interaction-model.js'
import { agentRoleNames, createRoleAccentResolver } from './static/ts/role-accents.js'

// The reserved hue windows, pinned here independently of the module's palette: if a token's measured anchor moves, this copy fails the suite and forces a conscious re-read of both. The anchors are the OKLCH hues of the shipped status/tool tokens in stylesheets/styles.css — error red ≈ 25° (light #cf222e, dark #f85149), success green ≈ 147° (light #1a7f37, dark #3fb950), tool violet ≈ 297° (light #8250df, dark #a371f7).
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

// The OKLab a/b components of an oklch color, so the distance below is perceptual rather than a raw hue arc.
function toOklab(color: OklchColor): { lightness: number; a: number; b: number } {
	const radians = (color.hue * Math.PI) / 180
	return { lightness: color.lightness, a: color.chroma * Math.cos(radians), b: color.chroma * Math.sin(radians) }
}

function colorDistance(a: OklchColor, b: OklchColor): number {
	const first = toOklab(a)
	const second = toOklab(b)
	return Math.hypot(first.lightness - second.lightness, first.a - second.a, first.b - second.b)
}

function minimumPairwiseDistance(colors: OklchColor[]): number {
	let minimum = Number.POSITIVE_INFINITY
	for (let i = 0; i < colors.length; i++) {
		for (let j = i + 1; j < colors.length; j++) {
			const a = colors[i]
			const b = colors[j]
			if (a === undefined || b === undefined) throw new Error('color list shorter than the pairwise scan expected')
			minimum = Math.min(minimum, colorDistance(a, b))
		}
	}
	return minimum
}

function isReservedHue(hue: number): boolean {
	return RESERVED_HUE_WINDOWS.some((window) => {
		const span = (window.upper - window.lower + 360) % 360
		const forward = (((hue - window.lower) % 360) + 360) % 360
		return forward > 0 && forward < span
	})
}

// Resolves a list of roles and returns each role's raw accent string, failing fast on a null (the resolver must know every role it was given).
function accentsFor(roleNames: string[]): string[] {
	const resolver = createRoleAccentResolver(roleNames)
	return roleNames.map((role) => {
		const accent = resolver(role)
		if (accent === null) throw new Error(`resolver returned null for a declared role "${role}"`)
		return accent
	})
}

// Resolves a list of roles and returns each role's parsed color.
function colorsFor(roleNames: string[]): OklchColor[] {
	return accentsFor(roleNames).map(parseAccent)
}

describe('createRoleAccentResolver — determinism and stability', () => {
	test('the same role list resolves the same colors on every build', () => {
		const roles = ['planner', 'coder', 'orchestrator', 'critic']
		const first = createRoleAccentResolver(roles)
		const second = createRoleAccentResolver(roles)
		for (const role of roles) {
			const accent = first(role)
			expect(accent).not.toBeNull()
			expect(second(role)).toBe(accent)
		}
	})

	test('the assignment does not depend on the order the roles are given in', () => {
		const roles = ['planner', 'coder', 'orchestrator', 'critic', 'loop_detector']
		const forward = createRoleAccentResolver(roles)
		const reversed = createRoleAccentResolver([...roles].reverse())
		for (const role of roles) expect(reversed(role)).toBe(forward(role))
	})

	test('a role keeps its color as the observed subset grows (the resolver is stateless)', () => {
		const roles = ['alpha', 'beta', 'gamma', 'delta']
		const resolver = createRoleAccentResolver(roles)
		const firstSeen = resolver('alpha')
		expect(firstSeen).not.toBeNull()
		for (const role of ['beta', 'gamma', 'delta']) expect(resolver(role)).not.toBeNull()
		expect(resolver('alpha')).toBe(firstSeen)
	})

	test('duplicate names in the input do not shift colors', () => {
		const withDuplicate = createRoleAccentResolver(['beta', 'alpha', 'alpha'])
		const withoutDuplicate = createRoleAccentResolver(['alpha', 'beta'])
		expect(withDuplicate('alpha')).toBe(withoutDuplicate('alpha'))
		expect(withDuplicate('beta')).toBe(withoutDuplicate('beta'))
	})
})

describe('createRoleAccentResolver — palette layout', () => {
	test('the 21-role seed guild resolves 21 pairwise-distinct, well-separated colors', () => {
		// The curated palette exists because the old hue-stepping folded a 21-role guild onto a few edges; this pins a perceptual minimum separation (OKLab distance) rather than mere string inequality, so a regression that re-clusters the palette fails.
		const accents = colorsFor(SEED_GUILD_ROLES)
		expect(new Set(accents.map((color) => `${color.lightness} ${color.chroma} ${color.hue}`)).size).toBe(SEED_GUILD_ROLES.length)
		expect(minimumPairwiseDistance(accents)).toBeGreaterThanOrEqual(0.05)
	})

	test('no assigned hue lands inside a reserved semantic window, across the seed guild and a synthetic fifty-role list', () => {
		const roles = Array.from({ length: 50 }, (_, index) => `role_${index}`)
		for (const color of [...colorsFor(SEED_GUILD_ROLES), ...colorsFor(roles)]) {
			expect(isReservedHue(color.hue)).toBe(false)
		}
	})

	test('overflow past the palette length yields 200 pairwise-distinct, reserved-free colors', () => {
		// 200 roles far exceed the 24-entry palette: the per-cycle lightness/chroma shift clamps long before the end, so the collision walk is what keeps every color unique. The clamped-only scheme this replaces first emitted a duplicate at 121 roles.
		const roles = Array.from({ length: 200 }, (_, index) => `role_${index}`)
		const accents = accentsFor(roles)
		expect(new Set(accents).size).toBe(roles.length)
		for (const color of colorsFor(roles)) expect(isReservedHue(color.hue)).toBe(false)
	})

	test('the collision boundary stays unique — at the palette length, one past it, and the old first-collision count', () => {
		// The palette itself (24), the first overflow role (25), and the count where the previous clamped-only scheme first collided (121) all resolve pairwise-distinct colors.
		for (const count of [24, 25, 121]) {
			const roles = Array.from({ length: count }, (_, index) => `role_${index}`)
			expect(new Set(accentsFor(roles)).size).toBe(count)
		}
	})

	test('the emitted color is the pinned oklch format', () => {
		const resolver = createRoleAccentResolver(['alpha', 'beta', 'gamma', 'delta', 'epsilon'])
		for (const role of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) {
			expect(resolver(role)).toMatch(/^oklch\(\d*\.?\d+ \d*\.?\d+ \d*\.?\d+\)$/)
		}
	})
})

describe('createRoleAccentResolver — fallbacks', () => {
	test('unknown roles and the pseudo-roles resolve to null', () => {
		const resolver = createRoleAccentResolver(['coder', 'planner'])
		for (const role of ['human', 'interrupt', 'tools', 'unknown_role']) expect(resolver(role)).toBeNull()
	})

	test('an empty role list accents nothing', () => {
		const resolver = createRoleAccentResolver([])
		expect(resolver('coder')).toBeNull()
	})
})

describe('agentRoleNames', () => {
	test('collects the role-kind names in order, skipping tools and pseudo-roles', () => {
		const participants: Participant[] = [
			{ id: 'you', role: 'human', kind: 'human' },
			{ id: 'guild:orchestrator', role: 'orchestrator', kind: 'role' },
			{ id: 'guild:read_file', role: 'read_file', kind: 'tool' },
			{ id: 'guild:coder', role: 'coder', kind: 'role' },
			{ id: 'int', role: 'interrupt', kind: 'interrupt' },
		]
		expect(agentRoleNames(participants)).toEqual(['orchestrator', 'coder'])
	})
})
