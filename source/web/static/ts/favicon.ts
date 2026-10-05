// Three-state favicon for the browser tab: one filled triangle in three colors, the color carrying the system state at a glance in a row of tabs. The state is derived from data the product client already polls — the run-list summaries and the pending ask_human questions (the Tick/GotRunList/GotQuestions actions in app.js) — so the favicon needs no request of its own. The module is browser-pure TypeScript (served statically and imported by app.js) and holds no state; its functions are pure, so the TS tests drive them directly, mirroring the sibling labels module convention.
//
// State priority: a pending question means the operator is needed, so 'pending-input' wins even while a run is mid-flight — a needs_clarification run is non-terminal, so both signals typically hold at once. Any summary whose status is not a known terminal status counts as in progress, including 'unknown': that is a run whose meta.json could not be read, which the rest of the UI also renders as "in progress" and keeps polling. With no pending questions and no non-terminal summary — including the no-runs-yet initial state — the favicon reads 'complete'.

import { isTerminalStatus } from './interaction-model.js'

// 'pending-input' (yellow) — at least one pending question awaits an operator answer; 'working' (red) — a run is in progress and no question is pending; 'complete' (green) — nothing in progress and nothing pending, or the initial idle state.
export type FaviconState = 'pending-input' | 'working' | 'complete'

// GNOME-palette tones, chosen so all three read on both light and dark browser chrome: yellow 3 is brighter than the amber it replaces, so on light chrome it reads as a bright filled shape rather than a mid-tone. Typed as a plain string record so faviconHref's state lookup keeps its fail-fast runtime guard: a state with no color entry must throw, never encode an undefined fill.
const FAVICON_COLORS: Record<string, string> = {
	'pending-input': '#f6d32d',
	working: '#c01c28',
	complete: '#26a269',
}

// One filled upward triangle centered in a 16×16 viewBox; the fill color is the only thing that varies between states. The `{color}` placeholder is substituted by faviconHref.
const FAVICON_SVG_TEMPLATE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M8 2l6 11H2Z" fill="{color}"/></svg>'

// A summary entry only has to admit a `status` field to be weighed: the polled run-list body is external data read one field deep, and any entry that cannot prove a terminal status counts as in progress.
function admitsStatus(value: unknown): value is { status: unknown } {
	return typeof value === 'object' && value !== null
}

// Derives the favicon state from the app's polled data.
//
// The summary entries arrive as the server returned them and are read only for `status`: an entry whose status is not a known terminal status counts as in progress, while a non-object entry is ignored — a favicon must never tell the operator everything is done while a run might be active. A non-array argument is treated as no data at all; the app's actions normalize every poll to an array, so this only guards a refactor, and a favicon glitch must never take the UI down regardless.
//
// `summaries` are the polled run-list summaries (`GET /api/runs`), read only for each entry's `status` field; `pendingQuestions` are the polled pending questions (`GET /api/questions`), read only for their count.
export function deriveFaviconState(summaries?: unknown[], pendingQuestions?: unknown[]): FaviconState {
	if (Array.isArray(pendingQuestions) && pendingQuestions.length > 0) return 'pending-input'
	if (!Array.isArray(summaries)) return 'complete'
	for (const summary of summaries) {
		if (!admitsStatus(summary)) continue
		const { status } = summary
		if (typeof status !== 'string' || !isTerminalStatus(status)) return 'working'
	}
	return 'complete'
}

// Builds the `<link rel="icon">` href for a state: the state's SVG as a percent-encoded data URI, so the icon ships inline with no extra request and app.js can swap the href on state changes. The encoding escapes the `#` of the fill color, which would otherwise parse as a fragment.
export function faviconHref(faviconState: FaviconState): string {
	const fillColor = FAVICON_COLORS[faviconState]
	if (fillColor === undefined) throw new Error(`Unknown favicon state: ${String(faviconState)}`)
	return `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG_TEMPLATE.replace('{color}', fillColor))}`
}
