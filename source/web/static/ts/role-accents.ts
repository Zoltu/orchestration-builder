// Per-role accent hues for the visualization views.
//
// Every agent role in a guild gets its own accent hue so nodes read as identity at a glance — most importantly the top bar's small aggregate nodes, which otherwise all look alike. The assignment is a pure function of the guild's FULL role list: the names are sorted (and deduplicated), then hues step around the wheel by the golden angle (137.508°) from a fixed base, so the same guild always produces the same colors no matter when roles appear in a run or in which order callers resolve them. Hosts build the resolver once per config load and consult it statelessly as participants spawn, so a role's color never shifts mid-run; building the resolver from a subset of the roles (e.g. only the ones seen so far) is the one way to break that stability, and no caller does.
//
// Three hue windows are reserved because a color there would read as one of the UI's semantic colors rather than as identity: the error red, the success green, and the tool violet — the pseudo-roles' and tools' fixed identities. A hue landing inside a window is pushed to the nearest window edge (ties push to the lower edge); the windows are disjoint, so the landing edge is outside every window. Golden-angle stepping spreads hues widely, but a push can fold two roles onto the same edge, so a colliding role walks forward in small steps until it reaches a free, unreserved hue — deterministic, and it keeps the color as close as possible to its stepped placement. With a large guild some hues inevitably land close together and visually overlap; that degradation is accepted (see docs/visualization.md "Per-role accent colors") — small guilds, the common case, stay far apart.
//
// Colors are emitted as fixed-saturation, fixed-lightness `hsl(H, S%, L%)` strings: the stylesheet remixes the hue with `color-mix` against the per-theme node tokens (the `*--accented` rules in stylesheets/styles.css), and a mid lightness keeps the mixed tint legible over both the light and dark surfaces.
//
// The module is browser-pure TypeScript and imports only the Participant type.

import type { Participant } from './interaction-model.js'

// The resolver's contract: a known agent role returns its accent color; anything else — a pseudo-role, a tool, a role outside the guild's config — returns null so callers fall back to the neutral look.
export type RoleAccentResolver = (role: string) => string | null

// The golden angle in degrees — the step that spreads successive hues maximally around the wheel.
const GOLDEN_ANGLE_DEGREES = 137.508
// The hue the first sorted role takes. Chosen so a three-role guild's hues (which land at 215, 345, and 105 after push-out) sit well over 100° apart and small guilds avoid the reserved windows entirely; role-accents.test.ts pins both properties so a retuned base or window cannot silently shrink them.
const BASE_HUE = 215
// The collision walk's step in degrees. Coprime with 360, so the walk visits every degree before repeating and is guaranteed to reach a free, unreserved hue.
const COLLISION_STRIDE_DEGREES = 7
// The fixed saturation and lightness of the emitted color — the hue is the only variable (see the module comment for why the values are fixed here rather than theme-dependent).
const ACCENT_SATURATION_PERCENT = 60
const ACCENT_LIGHTNESS_PERCENT = 50

// A clockwise arc of the 360° hue wheel, wrapping at 360. The interior — exclusive of the edges — is reserved; an edge value is where pushes land and stays assignable.
interface ReservedHueWindow {
	lower: number
	upper: number
}

// The reserved windows, walked clockwise from lower to upper. Each is centered on the measured hue of the tokens it defends, with a half-width wide enough to bracket the tokens plus the surrounding band that reads as the same color family: error red (the --svg-error tokens measure ≈ 356 through ≈ 3, so a half-width of 15 around 0 covers the crimson-through-vermillion band), success green (the --svg-success tokens measure ≈ 128–137, so a half-width of 25 around 130 covers the yellow-green-through-teal band), and tool violet (the --svg-tool-node-border tokens measure ≈ 261–262, so a half-width of 25 around 260 covers the blue-violet-through-purple band). The pinned window test in role-accents.test.ts is the real guard: retune a token color here and adjust its window there.
const RESERVED_HUE_WINDOWS: ReservedHueWindow[] = [
	{ lower: 345, upper: 15 },
	{ lower: 105, upper: 155 },
	{ lower: 235, upper: 285 },
]

function windowSpan(window: ReservedHueWindow): number {
	return (window.upper - window.lower + 360) % 360
}

function isInsideWindow(hue: number, window: ReservedHueWindow): boolean {
	const forwardFromLower = (((hue - window.lower) % 360) + 360) % 360
	return forwardFromLower > 0 && forwardFromLower < windowSpan(window)
}

function isReservedHue(hue: number): boolean {
	return RESERVED_HUE_WINDOWS.some((window) => isInsideWindow(hue, window))
}

// Pushes a reserved hue out to the nearest edge of the window that contains it; an exact tie pushes to the lower edge. The windows are disjoint, so the landing edge is outside every window and a single pass suffices.
function pushOutOfReservedWindows(hue: number): number {
	for (const window of RESERVED_HUE_WINDOWS) {
		if (!isInsideWindow(hue, window)) continue
		const distanceToLower = (((hue - window.lower) % 360) + 360) % 360
		const distanceToUpper = (((window.upper - hue) % 360) + 360) % 360
		return distanceToLower <= distanceToUpper ? window.lower : window.upper
	}
	return hue
}

// The hue the sorted role list's index-th entry takes: golden-angle stepping from the base hue, pushed out of the reserved windows.
function steppedHue(index: number): number {
	const stepped = Math.round((BASE_HUE + index * GOLDEN_ANGLE_DEGREES) % 360) % 360
	return pushOutOfReservedWindows(stepped)
}

// Builds the accent resolver over the guild's full role list. Assignment is deterministic in the list alone: each role takes the hue its sorted position steps to, so the caller's role order and resolution order are irrelevant. A hue that collides with an already-assigned role (only possible after a window push folded it onto a taken edge) walks forward in COLLISION_STRIDE_DEGREES steps — passing through reserved hues too — until it lands on a free, unreserved degree; the walk is bounded because the stride is coprime with 360, and the bound's throw names the role that exhausted the wheel rather than hanging the page.
export function createRoleAccentResolver(roleNames: string[]): RoleAccentResolver {
	const hueByRole = new Map<string, number>()
	const usedHues = new Set<number>()
	const sortedUniqueNames = Array.from(new Set(roleNames)).sort()
	for (const [index, name] of sortedUniqueNames.entries()) {
		let hue = steppedHue(index)
		for (let walk = 0; usedHues.has(hue) || isReservedHue(hue); walk += 1) {
			if (walk >= 360) throw new Error(`role accent assignment exhausted the free hues for role "${name}"`)
			hue = (hue + COLLISION_STRIDE_DEGREES) % 360
		}
		usedHues.add(hue)
		hueByRole.set(name, hue)
	}
	return (role: string) => {
		const hue = hueByRole.get(role)
		if (hue === undefined) return null
		return `hsl(${hue}, ${ACCENT_SATURATION_PERCENT}%, ${ACCENT_LIGHTNESS_PERCENT}%)`
	}
}

// The agent role names a participant list carries, in first-appearance order — the input `createRoleAccentResolver` expects. Both hosts derive their participant lists from the guild's config (the app from `GET /api/config`, the demo harness from the scenario manifests), so building the resolver from this helper's output keeps the accent assignment on exactly the same parse the views' column sets come from.
export function agentRoleNames(participants: ReadonlyArray<Participant>): string[] {
	const names: string[] = []
	for (const participant of participants) {
		if (participant.kind !== 'role') continue
		names.push(participant.role)
	}
	return names
}
