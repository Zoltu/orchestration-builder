// Pure accumulation model for the live token stream (see stream-client.js and docs/reference.md "Live token stream"): the app keeps one in-flight partial — the streamed reasoning/content of the role currently generating — and every state transition on it is a pure function here, so the accumulation rules (single-role filter, reset-before-append, per-field append, completion via the inspector's turn pairing) are testable without a DOM or a socket. The partial is ephemeral rendering input only, never an authority on run state; the polled run log is.

import { isObject } from './guards.js'

// The live preview is bounded separately from the full turn: the completed turn always arrives in full through the polled run log, while this ephemeral render input only needs enough recent text to follow the stream. A runaway generation must not grow browser state without bound, so each field is capped generously at ~60k tokens.
export const LIVE_PARTIAL_MAX_CHARS = 250_000

// Trimming to 90% of the cap leaves headroom for later deltas, so the common case appends cheaply instead of slicing the whole cap on every delta.
const LIVE_PARTIAL_TRIM_CHARS = Math.floor(LIVE_PARTIAL_MAX_CHARS * 0.9)

// The live partial as the app state holds it: the role instance it belongs to (`roleId`), the role's display name, and the accumulated text per turn-text field. A partial with no text in either field renders nothing. `truncated` records that a field was capped, and survives later appends until the turn switches or resets.
export interface LivePartial {
	roleId: string
	role: string
	reasoning: string
	content: string
	truncated: boolean
}

interface LiveDelta {
	roleId: string
	role: string
	field: 'reasoning' | 'content'
	text: string
	// The reset flag is read but never shape-validated: only the literal true clears the accumulation, so any other value leaves it intact.
	reset?: unknown
}

// Folds one stream delta into the accumulated partial.
//
// The accumulation is single-role: the executor runs one LLM call at a time, so a delta carrying a different `roleId` means the previous turn's streaming has ended and a new accumulation starts — this also self-heals a host that missed a turn boundary. A delta marked `reset` (the first delta of an attempt whose text re-emits from zero) clears the whole accumulation — reasoning and content — before its own text appends, so re-emitted text never doubles. A delta that fails the shape guard leaves the current accumulation untouched.
export function nextLivePartial(current: LivePartial | null, delta: unknown): LivePartial | null {
	if (!isLiveDelta(delta)) return current
	const sameRole = current !== null && current.roleId === delta.roleId
	const base = sameRole ? current : { roleId: delta.roleId, role: delta.role, reasoning: '', content: '', truncated: false }
	const cleared = delta.reset === true ? { ...base, reasoning: '', content: '', truncated: false } : base
	if (delta.field === 'reasoning') {
		const appended = appendCapped(cleared.reasoning, delta.text, cleared.truncated)
		return { ...cleared, role: delta.role, reasoning: appended.text, truncated: appended.truncated }
	}
	const appended = appendCapped(cleared.content, delta.text, cleared.truncated)
	return { ...cleared, role: delta.role, content: appended.text, truncated: appended.truncated }
}

// Appends within the per-field cap. An overshoot keeps the newest text (the tail) but trims to the lower hysteresis threshold, so the next deltas have room before another trim. A truncation once recorded stays recorded until the turn resets or switches.
function appendCapped(current: string, addition: string, truncated: boolean): { text: string; truncated: boolean } {
	const combined = current + addition
	if (combined.length <= LIVE_PARTIAL_MAX_CHARS) return { text: combined, truncated }
	let start = combined.length - LIVE_PARTIAL_TRIM_CHARS
	// A surrogate pair split at the slice boundary would render as a broken character, so start from the next full code point.
	if (isLowSurrogate(combined.charCodeAt(start))) start += 1
	return { text: combined.slice(start), truncated: true }
}

function isLowSurrogate(codeUnit: number): boolean {
	return codeUnit >= 0xDC00 && codeUnit <= 0xDFFF
}

// The one instance-matching rule the live partial and the inspector renderer share: an entry with its own instance id matches the partial's id when the partial carries one; an entry or partial without an instance id (old logs) falls back to the role name.
export function livePartialMatchesRole(roleId: string, role: string, livePartial: { roleId: string | null; role: string } | null): boolean {
	if (livePartial === null) return false
	const entryHasOwnId = roleId !== role
	const partialHasId = livePartial.roleId !== null && livePartial.roleId !== ''
	if (entryHasOwnId && partialHasId) return roleId === livePartial.roleId
	return role === livePartial.role
}

// The partial as it should stand after a turn-list derivation: null when the accumulated instance no longer holds an in-flight turn — the inspector's `llm_call_start`/`llm_call` pairing (buildTurnIndex, turn-inspector/turns.ts) proves the turn completed, since an in-flight turn keeps its start unmatched in the log — or the partial itself when the role is still generating. Pairing uses livePartialMatchesRole (the renderer applies the same rule through the turn-inspector module entrypoint), so a same-named sibling's in-flight row never hosts another instance's stream; an entry or partial carrying no instance id — old logs, whose turn events predate per-instance ids — falls back to the role name. A non-array or malformed entry list reads as "nothing in flight" and clears, so a derivation that learned nothing never keeps a stale partial.
export function activeLivePartial(livePartial: LivePartial | null, entries: unknown): LivePartial | null {
	if (livePartial === null) return null
	if (!Array.isArray(entries)) return null
	for (const entry of entries) {
		if (!isObject(entry)) continue
		if (entry['kind'] !== 'in_flight') continue
		const role = typeof entry['role'] === 'string' && entry['role'] !== '' ? entry['role'] : null
		if (role === null) continue
		const roleId = typeof entry['roleId'] === 'string' && entry['roleId'] !== '' ? entry['roleId'] : role
		if (livePartialMatchesRole(roleId, role, livePartial)) return livePartial
	}
	return null
}

// The partial as it should stand after a SCOPED window's turn-list derivation (one instance's server-filtered entries): null only when the entries hold a COMPLETED turn matching the partial's instance — positive evidence the poll recorded that turn's `llm_call` — and the partial itself otherwise. A scoped window cannot see other instances' turns, so a partial belonging to a different instance is merely absent here, not completed: clearing on absence would drop a stream that still renders in the scope the partial belongs to, and re-scoping back mid-turn would show the gapped text as continuous. Matching uses the same livePartialMatchesRole rule as `activeLivePartial`; a non-array or malformed entry list proves nothing and keeps the partial.
export function scopedActiveLivePartial(livePartial: LivePartial | null, entries: unknown): LivePartial | null {
	if (livePartial === null) return null
	if (!Array.isArray(entries)) return livePartial
	for (const entry of entries) {
		if (!isObject(entry)) continue
		if (entry['kind'] !== 'completed') continue
		const role = typeof entry['role'] === 'string' && entry['role'] !== '' ? entry['role'] : null
		if (role === null) continue
		const roleId = typeof entry['roleId'] === 'string' && entry['roleId'] !== '' ? entry['roleId'] : role
		if (livePartialMatchesRole(roleId, role, livePartial)) return null
	}
	return livePartial
}

// The delta guard the fold re-validates on its own behalf: the fields the accumulation reads must be present and well-typed. (The stream client validates full wire messages before invoking the host; this guards the helper against any caller.)
function isLiveDelta(value: unknown): value is LiveDelta {
	if (!isObject(value)) return false
	if (typeof value['roleId'] !== 'string') return false
	if (typeof value['role'] !== 'string') return false
	if (value['field'] !== 'reasoning' && value['field'] !== 'content') return false
	return typeof value['text'] === 'string'
}
