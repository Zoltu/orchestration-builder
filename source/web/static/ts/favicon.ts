// Four-state favicon for the browser tab: one filled triangle in four colors, the color carrying the system state at a glance in a row of tabs. A suspended run is a pause, not work: an operator-policy pause reads as pending-input, while an auto-policy pause reads as waiting. The state is derived from data the product client already polls — the run-list summaries, the pending ask_human questions, and the task queue (the Tick/GotRunList/GotQuestions/GotQueue actions in app.js) — so the favicon needs no request of its own. The module is browser-pure TypeScript (served statically and imported by app.js) and holds no state; its functions are pure, so the TS tests drive them directly, mirroring the sibling labels module convention.
//
// State priority: a pending question means the operator is needed, so 'pending-input' wins even while a run is mid-flight — a needs_clarification run is non-terminal, so both signals typically hold at once. A parked needs_input queue item is the same signal for a run whose question lives on the queue item rather than in `/api/questions`. Any summary whose status is not a known terminal status counts as in progress, including 'unknown': that is a run whose meta.json could not be read, which the rest of the UI also renders as "in progress" and keeps polling. A suspended summary is classified by its resume policy instead: an auto pause waits for automatic recovery, while an operator pause needs a decision. With no pending questions, no parked queue item, and no non-terminal summary — including the no-runs-yet initial state — the favicon reads 'complete'.

import { isTerminalStatus } from './interaction-model.js'
import { isOperatorPauseRecord } from './run-pause.js'

// 'pending-input' (yellow) — at least one pending question awaits an operator answer, or an operator-policy suspension needs a decision; 'working' (red) — a run is in progress and no question is pending; 'waiting' (amber) — an auto-resume provider pause holds a run and automatic recovery is expected; 'complete' (green) — nothing in progress and nothing pending, or the initial idle state.
export type FaviconState = 'pending-input' | 'working' | 'waiting' | 'complete'

// GNOME-palette tones, chosen so all four read on both light and dark browser chrome: yellow 3 is brighter than the amber it replaces, so on light chrome it reads as a bright filled shape rather than a mid-tone. Typed as a plain string record so faviconHref's state lookup keeps its fail-fast runtime guard: a state with no color entry must throw, never encode an undefined fill.
const FAVICON_COLORS: Record<string, string> = {
	'pending-input': '#f6d32d',
	working: '#c01c28',
	waiting: '#e5a50a',
	complete: '#26a269',
}

// One filled upward triangle centered in a 16×16 viewBox; the fill color is the only thing that varies between states. The `{color}` placeholder is substituted by faviconHref.
const FAVICON_SVG_TEMPLATE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M8 2l6 11H2Z" fill="{color}"/></svg>'

// A polled entry only has to admit a `status` field to be weighed: the run-list and queue bodies are external data read one field deep, and any summary entry that cannot prove a terminal status counts as in progress while a queue entry with status needs_input means the operator is needed.
interface StatusCarrier {
	status: unknown
	suspension?: unknown
	pause?: unknown
}

function admitsStatus(value: unknown): value is StatusCarrier {
	return typeof value === 'object' && value !== null
}

// A suspended summary's resume policy decides the tone: an operator pause record always needs a decision, while a provider suspension retries automatically only under an auto policy. A malformed or absent record reads as the operator-needed case so the tab never implies automatic recovery it cannot prove.
function suspendedResumePolicy(value: StatusCarrier): string {
	if (isOperatorPauseRecord(value.pause)) return 'operator'
	const suspension = value.suspension
	if (typeof suspension !== 'object' || suspension === null) return 'operator'
	if (!('resumePolicy' in suspension)) return 'operator'
	return typeof suspension.resumePolicy === 'string' ? suspension.resumePolicy : 'operator'
}

// Derives the favicon state from the app's polled data.
//
// The summary entries arrive as the server returned them and are read only for `status`: an entry whose status is not a known terminal status counts as in progress, while a non-object entry is ignored — a favicon must never tell the operator everything is done while a run might be active. A non-array argument is treated as no data at all; the app's actions normalize every poll to an array, so this only guards a refactor, and a favicon glitch must never take the UI down regardless.
//
// `summaries` are the polled run-list summaries (`GET /api/runs`), read only for each entry's `status` field; `pendingQuestions` are the polled pending questions (`GET /api/questions`), read only for their count; `queueItems` are the polled task-queue items (`GET /api/queue`), read only for the needs_input status a parked run carries. A parked needs_input run's question is not in `/api/questions`, so the queue is the only signal that the operator is needed.
export function deriveFaviconState(summaries?: unknown[], pendingQuestions?: unknown[], queueItems?: unknown[]): FaviconState {
	if (Array.isArray(pendingQuestions) && pendingQuestions.length > 0) return 'pending-input'
	if (Array.isArray(queueItems) && queueItems.some((item) => admitsStatus(item) && item.status === 'needs_input')) return 'pending-input'
	const queueHasSuspended = Array.isArray(queueItems) && queueItems.some((item) => admitsStatus(item) && item.status === 'suspended')
	if (!Array.isArray(summaries)) return queueHasSuspended ? 'pending-input' : 'complete'
	let working = false
	let waitingSuspended = false
	let operatorSuspended = false
	for (const summary of summaries) {
		if (!admitsStatus(summary)) continue
		const { status } = summary
		if (status === 'suspended') {
			if (suspendedResumePolicy(summary) === 'auto') waitingSuspended = true
			else operatorSuspended = true
			continue
		}
		if (typeof status !== 'string' || !isTerminalStatus(status)) working = true
	}
	if (operatorSuspended) return 'pending-input'
	if (working) return 'working'
	if (waitingSuspended) return 'waiting'
	// A suspended queue item with no run summary yet cannot reveal its cause; operator-needed is the safe default over claiming completion.
	if (queueHasSuspended) return 'pending-input'
	return 'complete'
}

// Builds the `<link rel="icon">` href for a state: the state's SVG as a percent-encoded data URI, so the icon ships inline with no extra request and app.js can swap the href on state changes. The encoding escapes the `#` of the fill color, which would otherwise parse as a fragment.
export function faviconHref(faviconState: FaviconState): string {
	const fillColor = FAVICON_COLORS[faviconState]
	if (fillColor === undefined) throw new Error(`Unknown favicon state: ${String(faviconState)}`)
	return `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG_TEMPLATE.replace('{color}', fillColor))}`
}
