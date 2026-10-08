import { describe, expect, test } from 'bun:test'
import type { Participant } from './static/ts/interaction-model.js'
import { agentRoleNames, createRoleAccentResolver } from './static/ts/role-accents.js'

// The reserved hue windows, pinned here independently of the module's private constants: if the module's bands move, this copy fails the suite and forces a conscious re-read of both. Mirrors the bands documented in the module comment and docs/visualization.md "Per-role accent colors".
const RESERVED_WINDOWS: { lower: number; upper: number }[] = [
	{ lower: 345, upper: 15 },
	{ lower: 105, upper: 155 },
	{ lower: 235, upper: 285 },
]

// Pulls the hue back out of the emitted color string, so the layout assertions assert on degrees rather than on string equality against module constants.
function hueOf(accent: string): number {
	const match = /^hsl\((\d+), 60%, 50%\)$/.exec(accent)
	if (match === null || match[1] === undefined) throw new Error(`accent "${accent}" is not the pinned hsl format`)
	return Number(match[1])
}

// The shortest arc between two hues on the wheel, in degrees.
function circularHueDistance(a: number, b: number): number {
	const raw = Math.abs(a - b) % 360
	return Math.min(raw, 360 - raw)
}

function isReserved(hue: number): boolean {
	return RESERVED_WINDOWS.some((window) => {
		const span = (window.upper - window.lower + 360) % 360
		const forward = (((hue - window.lower) % 360) + 360) % 360
		return forward > 0 && forward < span
	})
}

function minimumPairwiseDistance(hues: number[]): number {
	let minimum = 360
	for (let i = 0; i < hues.length; i += 1) {
		for (let j = i + 1; j < hues.length; j += 1) {
			const a = hues[i]
			const b = hues[j]
			if (a === undefined || b === undefined) throw new Error('hue list shorter than the pairwise scan expected')
			minimum = Math.min(minimum, circularHueDistance(a, b))
		}
	}
	return minimum
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
		// The hosts build the resolver once from the full guild role list and consult it as participants spawn; the pinned contract is that colors come from that list alone — resolving early roles first, then the rest, never shifts an already-seen role's color the way a seen-so-far assignment would.
		const roles = ['alpha', 'beta', 'gamma', 'delta']
		const resolver = createRoleAccentResolver(roles)
		const firstSeen = resolver('alpha')
		expect(firstSeen).not.toBeNull()
		for (const role of ['beta', 'gamma', 'delta']) expect(resolver(role)).not.toBeNull()
		expect(resolver('alpha')).toBe(firstSeen)
	})

	test('duplicate names in the input do not shift hues', () => {
		const withDuplicate = createRoleAccentResolver(['beta', 'alpha', 'alpha'])
		const withoutDuplicate = createRoleAccentResolver(['alpha', 'beta'])
		expect(withDuplicate('alpha')).toBe(withoutDuplicate('alpha'))
		expect(withDuplicate('beta')).toBe(withoutDuplicate('beta'))
	})
})

describe('createRoleAccentResolver — hue layout', () => {
	test('a three-role guild resolves hues far apart', () => {
		// The base hue and window layout put a three-role guild's hues (215, 345, 105) at a 110° minimum pairwise distance — the "very distinguishable" bar for small guilds. Pinned at ≥ 100° so a retuned base or window cannot silently shrink it.
		const resolver = createRoleAccentResolver(['alpha', 'beta', 'gamma'])
		const hues = ['alpha', 'beta', 'gamma'].map((role) => {
			const accent = resolver(role)
			expect(accent).not.toBeNull()
			return hueOf(accent ?? '')
		})
		expect(minimumPairwiseDistance(hues)).toBeGreaterThanOrEqual(100)
	})

	test('a fifty-role guild assigns every role a distinct hue', () => {
		// Near-duplicate hues are accepted degradation for large guilds (golden-angle spread cannot keep 50 hues far apart on one wheel); the assertion pins only that no two roles share an exact hue.
		const roles = Array.from({ length: 50 }, (_, index) => `role_${index}`)
		const resolver = createRoleAccentResolver(roles)
		const hues = roles.map((role) => {
			const accent = resolver(role)
			expect(accent).not.toBeNull()
			return hueOf(accent ?? '')
		})
		expect(new Set(hues).size).toBe(roles.length)
	})

	test('no assigned hue lands inside a reserved window, across a synthetic fifty-role list', () => {
		const roles = Array.from({ length: 50 }, (_, index) => `role_${index}`)
		const resolver = createRoleAccentResolver(roles)
		for (const role of roles) {
			const accent = resolver(role)
			expect(accent).not.toBeNull()
			expect(isReserved(hueOf(accent ?? ''))).toBe(false)
		}
	})

	test('the emitted color is the pinned fixed-saturation hsl format', () => {
		const resolver = createRoleAccentResolver(['alpha', 'beta', 'gamma', 'delta', 'epsilon'])
		for (const role of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) {
			expect(resolver(role)).toMatch(/^hsl\(\d+, 60%, 50%\)$/)
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
