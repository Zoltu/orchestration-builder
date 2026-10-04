// Pure accumulation model for the live token stream (see stream-client.js and docs/reference.md "Live token stream"): the app keeps one in-flight partial — the streamed reasoning/content of the role currently generating — and every state transition on it is a pure function here, so the accumulation rules (single-role filter, reset-before-append, per-field append, completion via the inspector's turn pairing) are testable without a DOM or a socket. The partial is ephemeral rendering input only, never an authority on run state; the polled run log is.

import { isObject } from './guards.js'

/**
 * The live partial as the app state holds it: the role instance it belongs to (`roleId`), the role's display name, and the accumulated text per turn-text field. A partial with no text in either field renders nothing.
 *
 * @typedef {Object} LivePartial
 * @property {string} roleId
 * @property {string} role
 * @property {string} reasoning
 * @property {string} content
 */

/**
 * Folds one stream delta into the accumulated partial.
 *
 * The accumulation is single-role: the executor runs one LLM call at a time, so a delta carrying a different `roleId` means the previous turn's streaming has ended and a new accumulation starts — this also self-heals a host that missed a turn boundary. A delta marked `reset` (the first delta of an attempt whose text re-emits from zero) clears the whole accumulation — reasoning and content — before its own text appends, so re-emitted text never doubles. A delta that fails the shape guard leaves the current accumulation untouched.
 *
 * @param {LivePartial|null} current
 * @param {unknown} delta
 * @returns {LivePartial|null}
 */
export function nextLivePartial(current, delta) {
	if (!isLiveDelta(delta)) return current
	const sameRole = current !== null && current.roleId === delta.roleId
	const base = sameRole ? current : { roleId: delta.roleId, role: delta.role, reasoning: '', content: '' }
	const cleared = delta.reset === true ? { ...base, reasoning: '', content: '' } : base
	if (delta.field === 'reasoning') return { ...cleared, role: delta.role, reasoning: cleared.reasoning + delta.text }
	return { ...cleared, role: delta.role, content: cleared.content + delta.text }
}

/**
 * The partial as it should stand after a turn-list derivation: null when the accumulated instance no longer holds an in-flight turn — the inspector's `llm_call_start`/`llm_call` pairing (buildTurnIndex, inspector-modal.js) proves the turn completed, since an in-flight turn keeps its start unmatched in the log — or the partial itself when the role is still generating. Pairing matches the entry's `roleId` first (mirroring isLiveTurn in inspector-modal.js, so a same-named sibling's in-flight row never hosts another instance's stream); an entry or partial carrying no instance id — old logs, whose turn events predate per-instance ids — falls back to the role name. A non-array or malformed entry list reads as "nothing in flight" and clears, so a derivation that learned nothing never keeps a stale partial.
 *
 * @param {LivePartial|null} livePartial
 * @param {unknown} entries
 * @returns {LivePartial|null}
 */
export function activeLivePartial(livePartial, entries) {
	if (livePartial === null) return null
	if (!Array.isArray(entries)) return null
	for (const entry of entries) {
		if (!isObject(entry)) continue
		if (entry['kind'] !== 'in_flight') continue
		const role = typeof entry['role'] === 'string' && entry['role'] !== '' ? entry['role'] : null
		if (role === null) continue
		const roleId = typeof entry['roleId'] === 'string' && entry['roleId'] !== '' ? entry['roleId'] : null
		const entryHasOwnId = roleId !== null && roleId !== role
		const partialHasId = livePartial.roleId !== null && livePartial.roleId !== ''
		if (entryHasOwnId && partialHasId) {
			if (roleId === livePartial.roleId) return livePartial
			continue
		}
		if (role === livePartial.role) return livePartial
	}
	return null
}

// The delta guard the fold re-validates on its own behalf: the fields the accumulation reads must be present and well-typed. (The stream client validates full wire messages before invoking the host; this guards the helper against any caller.)
/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isLiveDelta(value) {
	if (!isObject(value)) return false
	if (typeof value['roleId'] !== 'string') return false
	if (typeof value['role'] !== 'string') return false
	if (value['field'] !== 'reasoning' && value['field'] !== 'content') return false
	return typeof value['text'] === 'string'
}
