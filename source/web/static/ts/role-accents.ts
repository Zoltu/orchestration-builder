// Per-role accent colors for the visualization views.
//
// Every agent role in a guild gets its own accent color so nodes read as identity at a glance — most importantly the flow view's top bar, whose small aggregate slots otherwise all look alike. The assignment is a pure function of the guild's FULL role list: the names are sorted (and deduplicated), then each takes the palette color at its sorted index, so the same guild always produces the same colors no matter when roles appear or in which order callers resolve them. Hosts build the resolver once per config load and consult it statelessly as participants spawn, so a role's color never shifts mid-run; building the resolver from a subset of the roles (e.g. only the ones seen so far) is the one way to break that stability, and no caller does.
//
// The palette is a curated, ordered list of perceptually distinct colors rather than a hue-stepping formula: a golden-angle walk on one wheel folds a large guild onto a few edges, and a single fixed saturation/lightness leaves same-family colors indistinguishable. Each entry varies hue, chroma, AND lightness, so ~24 roles stay visually apart. Colors are emitted as `oklch(L C H)` strings; the stylesheet remixes them with `color-mix(in oklch, ...)` against the per-theme node tokens, and a mid lightness with moderate chroma keeps the tint legible over both the light and dark surfaces.
//
// Three hue families stay reserved so a role color never reads as one of the UI's semantic signals: error red, success green, and tool violet (tools keep their own shared violet). The anchors are the measured OKLCH hues of the shipped tokens in stylesheets/styles.css — error red ≈ 25° (light #cf222e ≈ 24.5°, dark #f85149 ≈ 27.0°), success green ≈ 147° (light #1a7f37 ≈ 148.0°, dark #3fb950 ≈ 145.6°), tool violet ≈ 297° (light #8250df ≈ 295.0°, dark #a371f7 ≈ 298.1°). Every palette entry sits outside those families; role-accents.test.ts pins the windows and asserts it.
//
// When a guild declares more roles than the palette has entries, the assignment extends deterministically: a color's hue is kept and its lightness (and slightly its chroma) steps down by a fixed amount per full cycle. The per-cycle shift keeps the reserved hues reserved but its floors would eventually fold two cycles onto one clamped color, so a colliding index then walks a deterministic (hue, lightness) lattice — skipping reserved hues and every already-assigned color — until it reaches a free color. The walk is bounded and throws with the offending role's name if it exhausts the lattice, so no two roles ever share a color.
//
// The module is browser-pure TypeScript and imports only the Participant type.

import type { Participant } from './interaction-model.js'

// The resolver's contract: a known agent role returns its accent color; anything else — a pseudo-role, a tool, a role outside the guild's config — returns null so callers fall back to the neutral look.
export type RoleAccentResolver = (role: string) => string | null

interface RoleAccentColor {
	lightness: number
	chroma: number
	hue: number
}

// A clockwise arc of the 360° hue wheel, wrapping at 360. The interior — exclusive of the edges — is reserved; an edge value stays assignable.
interface ReservedHueWindow {
	lower: number
	upper: number
}

// The reserved windows, walked clockwise from lower to upper. Each brackets a semantic family: red spans 352→42, centered a touch below the measured ≈25° anchor so the window covers the crimson-through-vermillion band the error tokens sit in; green (122→172, centered ≈147°) and violet (272→322, centered ≈297°) bracket their anchors symmetrically. role-accents.test.ts pins an identical copy.
const RESERVED_HUE_WINDOWS: ReservedHueWindow[] = [
	{ lower: 352, upper: 42 },
	{ lower: 122, upper: 172 },
	{ lower: 272, upper: 322 },
]

// The curated palette, assigned to sorted roles in order. Hue, chroma, and lightness all vary so same-family colors still separate: the blue/teal family runs slate → deep blue → indigo → periwinkle → azure → sky → powder blue; the green-adjacent family runs deep teal → turquoise → sage → chartreuse → lime → olive; the warm family runs burnt orange → tangerine → amber → sand → mustard → gold → pale gold; and magenta, pink, mulberry, and dusty rose fill the remaining family. Every hue avoids the reserved red/green/violet anchors documented in the module comment.
const ROLE_ACCENT_PALETTE: readonly RoleAccentColor[] = [
	{ lightness: 0.5, chroma: 0.09, hue: 220 }, // slate
	{ lightness: 0.8, chroma: 0.18, hue: 50 }, // tangerine
	{ lightness: 0.8, chroma: 0.18, hue: 262 }, // periwinkle
	{ lightness: 0.5, chroma: 0.18, hue: 50 }, // burnt orange
	{ lightness: 0.62, chroma: 0.18, hue: 332 }, // magenta
	{ lightness: 0.74, chroma: 0.18, hue: 182 }, // turquoise
	{ lightness: 0.62, chroma: 0.18, hue: 114 }, // chartreuse
	{ lightness: 0.8, chroma: 0.12, hue: 336 }, // pink
	{ lightness: 0.8, chroma: 0.18, hue: 112 }, // lime
	{ lightness: 0.62, chroma: 0.18, hue: 262 }, // indigo
	{ lightness: 0.5, chroma: 0.09, hue: 346 }, // mulberry
	{ lightness: 0.68, chroma: 0.09, hue: 64 }, // sand
	{ lightness: 0.62, chroma: 0.18, hue: 212 }, // azure
	{ lightness: 0.5, chroma: 0.09, hue: 106 }, // olive
	{ lightness: 0.74, chroma: 0.09, hue: 228 }, // powder blue
	{ lightness: 0.5, chroma: 0.18, hue: 182 }, // deep teal
	{ lightness: 0.5, chroma: 0.18, hue: 258 }, // deep blue
	{ lightness: 0.56, chroma: 0.18, hue: 82 }, // mustard
	{ lightness: 0.62, chroma: 0.18, hue: 50 }, // amber
	{ lightness: 0.8, chroma: 0.18, hue: 214 }, // sky
	{ lightness: 0.68, chroma: 0.09, hue: 346 }, // dusty rose
	{ lightness: 0.8, chroma: 0.09, hue: 80 }, // pale gold
	{ lightness: 0.62, chroma: 0.09, hue: 182 }, // sage
	{ lightness: 0.74, chroma: 0.18, hue: 82 }, // gold
]

// Per full palette cycle, the overflow shift: lightness drops and chroma eases, keeping the hue (and so the reserved-family guarantee) while separating the next 24 roles from the first.
const OVERFLOW_LIGHTNESS_STEP = 0.06
const OVERFLOW_CHROMA_STEP = 0.02
// The clamp floors keep an overflowed color legible on both themes; a clamped candidate that collides with an earlier role is resolved by the collision walk below rather than by emitting a duplicate.
const OVERFLOW_MIN_LIGHTNESS = 0.3
const OVERFLOW_MIN_CHROMA = 0.02

// The collision walk's hue stride, coprime with 360 so 360 successive steps visit every hue before repeating. The walk lifts lightness a fixed step per full hue revolution, so the lattice it searches is (hue, lightness) with the candidate's chroma held fixed.
const COLLISION_HUE_STRIDE = 7
const COLLISION_HUE_STEPS = 360
const COLLISION_LIGHTNESS_STEP = 0.02
const COLLISION_MIN_LIGHTNESS = 0.3
const COLLISION_MAX_LIGHTNESS = 0.95
// The walk is bounded so a genuinely exhausted color space fails loudly instead of hanging the page.
const MAX_COLLISION_WALK = COLLISION_HUE_STEPS * 40

function roundTo(value: number, decimals: number): number {
	const factor = 10 ** decimals
	return Math.round(value * factor) / factor
}

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

// The palette color for a sorted role index. Indices past the palette length wrap to the same hue family with the lightness (and chroma) stepped down once per full cycle.
function paletteColorAt(index: number): RoleAccentColor {
	const base = ROLE_ACCENT_PALETTE[index % ROLE_ACCENT_PALETTE.length]
	if (base === undefined) throw new Error('role accent palette is empty')
	const cycle = Math.floor(index / ROLE_ACCENT_PALETTE.length)
	if (cycle === 0) return base
	return {
		lightness: roundTo(Math.max(OVERFLOW_MIN_LIGHTNESS, base.lightness - cycle * OVERFLOW_LIGHTNESS_STEP), 3),
		chroma: roundTo(Math.max(OVERFLOW_MIN_CHROMA, base.chroma - cycle * OVERFLOW_CHROMA_STEP), 3),
		hue: base.hue,
	}
}

// The walk's `walk`-th candidate: the hue steps around the wheel by the coprime stride, and the lightness lifts one step each full revolution. `walk` starts at 1 so candidate 0 is the base color itself.
function walkedColor(base: RoleAccentColor, walk: number): RoleAccentColor {
	const step = walk - 1
	const hueStep = step % COLLISION_HUE_STEPS
	const lightnessStep = Math.floor(step / COLLISION_HUE_STEPS)
	const hue = (base.hue + hueStep * COLLISION_HUE_STRIDE) % 360
	const lightness = roundTo(Math.min(COLLISION_MAX_LIGHTNESS, Math.max(COLLISION_MIN_LIGHTNESS, base.lightness + (lightnessStep + 1) * COLLISION_LIGHTNESS_STEP)), 3)
	return { lightness, chroma: base.chroma, hue }
}

function formatAccent(color: RoleAccentColor): string {
	return `oklch(${color.lightness} ${color.chroma} ${color.hue})`
}

// The emitted color for a candidate: the candidate itself when it is free and unreserved, else the first free, unreserved color on the collision walk. The throw is the bound: a color space that cannot seat the role fails loudly rather than looping.
function assignAccent(candidate: RoleAccentColor, usedAccents: ReadonlySet<string>, roleName: string): string {
	const candidateAccent = formatAccent(candidate)
	if (!isReservedHue(candidate.hue) && !usedAccents.has(candidateAccent)) return candidateAccent
	for (let walk = 1; walk <= MAX_COLLISION_WALK; walk++) {
		const color = walkedColor(candidate, walk)
		if (isReservedHue(color.hue)) continue
		const accent = formatAccent(color)
		if (usedAccents.has(accent)) continue
		return accent
	}
	throw new Error(`role accent assignment exhausted the palette colors for role "${roleName}"`)
}

// Builds the accent resolver over the guild's full role list. Assignment is deterministic in the list alone: each role takes the palette color at its sorted position (walking on the rare collision), so the caller's role order and resolution order are irrelevant and a growing subset never shifts an already-seen role's color.
export function createRoleAccentResolver(roleNames: string[]): RoleAccentResolver {
	const colorByRole = new Map<string, string>()
	const usedAccents = new Set<string>()
	const sortedUniqueNames = Array.from(new Set(roleNames)).sort()
	for (let index = 0; index < sortedUniqueNames.length; index++) {
		const name = sortedUniqueNames[index]
		if (name === undefined) continue
		const accent = assignAccent(paletteColorAt(index), usedAccents, name)
		usedAccents.add(accent)
		colorByRole.set(name, accent)
	}
	return (role: string) => colorByRole.get(role) ?? null
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
