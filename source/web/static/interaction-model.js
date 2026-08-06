// InteractionModel — the shared timeline both views read.
//
// The model is a chronologically ordered list of operations (calls, returns, observes, terminates) over a set of participants, plus a run status. It is neither a current-state graph nor an event stream: every "what is happening right now" question the two views need is answered by a pure helper over this list, so they never answer it independently and never drift.
//
// The single invariant the helpers encode: at most one operation is in flight in the active stack; observe and terminate never affect activity. The active stack is the stack of the latest operation, with two refinements: a freshly preempted stack (pushed by an interrupt, carrying no operations yet — the preemption itself is the latest activity) is active on arrival, and a resolved stack (its root call has returned) yields activity to the innermost stack still carrying open work, staying active only when no stack carries open work. The active participant is the destination of the active stack's current focus: an in-flight return's destination while its response leg travels, else the innermost open call's destination, else the stack's root when the stack has no operations yet. Every other stack that still carries open calls is paused — its in-flight operations stay in flight (the model never flips lifecycle on pause) and its lines do not animate.
//
// Interrupts spawn fresh call stacks rooted at a fresh Interrupt participant instance (instance-per-interrupt, like every role). A paused stack's fate (resuming / rewinding / terminating / terminated / active) is read off its own operations after the preemption point, never stored as a field — see fateOf.
//
// The module is browser-pure JS (served statically and imported by the view modules) and imports nothing. JSDoc typedefs carry the shape the TS tests assert against, mirroring how the view modules will be consumed by their tests.

/**
 * @typedef {'human' | 'interrupt' | 'role' | 'tool'} ParticipantKind
 *   'human' is the You root and 'interrupt' is a per-interrupt root — both pseudo-roles. 'role' and 'tool' are real invocations.
 */

/**
 * @typedef {'call' | 'return' | 'observe' | 'terminate'} OperationKind
 *   'call'/'return' hand off activity between participants; 'observe' is a read-only cross-stack reference; 'terminate' is a destructive close where a tool reverts a target node — it pops the targeted open call (so the node is removed immediately and no separate 'terminated' return is needed for that call) but never hands off activity, so the active operation stays the interrupt's own call rather than the terminate. observe never affects activity and never enters a call chain; terminate affects call-chain structure but not activity.
 */

/**
 * @typedef {'in_flight' | 'settled'} OperationLifecycle
 */

/**
 * @typedef {'success' | 'error' | 'terminated'} OperationOutcome
 *   Only 'return' operations carry an outcome; a 'call' is null until it settles, and 'observe' and 'terminate' are always null.
 */

/**
 * @typedef {'running' | 'success' | 'error' | 'needs_clarification' | 'interrupted' | 'unknown'} RunStatus
 *   Mirrors the executor RunMeta status with an 'unknown' fallback for a malformed or absent meta read.
 */

/**
 * @typedef {Object} Participant
 * @property {string} id
 *   Instance-scoped, unique per invocation — the flow-view node key. A role invoked twice carries two participants with distinct ids.
 * @property {string} role
 *   The role or tool name; 'human' for the You root and 'interrupt' for interrupt roots. The sequence-view column key.
 * @property {ParticipantKind} kind
 */

/**
 * @typedef {Object} OperationMetrics
 * @property {number | null} tokens
 * @property {number | null} cachedPromptTokens
 * @property {number | null} elapsedSeconds
 */

/**
 * @typedef {Object} Operation
 * @property {string} id
 * @property {OperationKind} kind
 * @property {string} stack
 *   The call-stack id this operation belongs to. The active stack is the stack of the latest operation.
 * @property {string} source
 *   The participant id the operation originates from. For 'observe' and 'terminate' this may sit in a different (active) stack than destination — a tool in the active stack reaches across into a paused stack.
 * @property {string} destination
 *   The participant id the operation is addressed to. Never equals source for 'call'/'return'.
 * @property {string} startedAt
 * @property {string | null} settledAt
 *   null while in_flight; equals startedAt for 'observe' and 'terminate' because both are instantaneous.
 * @property {OperationLifecycle} lifecycle
 * @property {OperationOutcome | null} outcome
 *   Set on 'return' only; null for 'call', 'observe', and 'terminate'.
 * @property {string | null} details
 *   Adapter-formatted markdown body for tooltip and detail surfaces. This is data, not localization.
 * @property {OperationMetrics | null} metrics
 */

/**
 * @typedef {Object} StackRecord
 * @property {string} id
 * @property {string} root
 *   The stack's root participant id (the You root or an Interrupt instance).
 */

/**
 * @typedef {Object} InteractionModel
 * @property {Participant[]} participants
 *   Chronological first-appearance order.
 * @property {Operation[]} operations
 *   Chronological; the index is the sequence-view row.
 * @property {RunStatus} status
 * @property {StackRecord[]} [stacks]
 *   Stack roots in push order (oldest first), emitted by producers that track stack pushes (the backend adapter). A freshly preempted stack has no operations yet, so operations alone cannot name it. When absent (hand-authored models), the helpers derive stack structure from operations and a zero-operation stack renders nothing.
 */

const TERMINAL_STATUSES = new Set(['success', 'error', 'needs_clarification', 'interrupted'])

/**
 * Returns whether a run status is terminal — the run will produce no more activity, so clients stop polling it and the result affordance may open. Shared by every client surface (product client, dev harness, view modules) so the terminal set is defined once, next to the RunStatus typedef it reads.
 *
 * @param {string} status
 * @returns {boolean}
 */
export function isTerminalStatus(status) {
	return TERMINAL_STATUSES.has(status)
}

// The stack records the helpers read: the model's own records when present, else a derivation from operations (first-appearance order; the root is the stack's first operation's source, which for any well-formed model is its root call's source). A zero-operation stack exists only in the model's own records — operations cannot name it.
function stackRecordsOf(model) {
	if (model.stacks !== undefined) return model.stacks
	const records = []
	const seen = new Set()
	for (const operation of model.operations) {
		if (seen.has(operation.stack)) continue
		seen.add(operation.stack)
		records.push({ id: operation.stack, root: operation.source })
	}
	return records
}

function stackRecordOf(model, stackId) {
	for (const record of stackRecordsOf(model)) {
		if (record.id === stackId) return record
	}
	return undefined
}

/**
 * Returns the active stack id, or null for a model with no operations. The active stack is the stack of the latest operation, whatever its kind — so an observe or terminate logged on a paused stack does not steal activity — with two refinements: a freshly preempted stack (the newest stack record carries no operations yet; the preemption itself is the latest activity) is active on arrival, and a resolved stack (its open chain is empty because its root call has returned) yields activity to the innermost stack still carrying open work, staying active only when no stack carries open work (its final return's destination remains the focus).
 *
 * @param {InteractionModel} model
 * @returns {string | null}
 */
export function activeStack(model) {
	if (model.operations.length === 0) return null
	const records = stackRecordsOf(model)
	const newest = records[records.length - 1]
	if (newest !== undefined && !model.operations.some((operation) => operation.stack === newest.id)) {
		return newest.id
	}
	const candidate = model.operations[model.operations.length - 1].stack
	const chains = openCallsByStack(model)
	const candidateChain = chains.get(candidate)
	if (candidateChain === undefined || candidateChain.length > 0) return candidate
	for (let index = records.length - 1; index >= 0; index -= 1) {
		const record = records[index]
		const chain = chains.get(record.id)
		if (chain !== undefined && chain.length > 0) return record.id
	}
	return candidate
}

/**
 * Returns the operation the active stack is currently focused on: the active stack's latest call or return — its destination is the focus (the caller while a return leg travels or has just landed, the current worker otherwise) — or null when the active stack carries no call or return at all (a freshly preempted stack with no operations yet, or a stack whose only operations are observes/terminates). When the latest activity operation is a call that is no longer open (killed by a terminate or abandoned by a torn read), the live innermost open call is the focus instead of the dead call. This is the single "what is in flight right now" answer both views read: the model invariant guarantees at most one in-flight operation per stack, so the focused operation is exactly the operation whose line animates (when in_flight) and whose destination pulses. 'observe' and 'terminate' are skipped because neither affects activity — a terminate closes a call but does not hand the active role to anyone.
 *
 * @param {InteractionModel} model
 * @returns {Operation | null}
 */
export function activeOperation(model) {
	const stack = activeStack(model)
	if (stack === null) return null
	for (let index = model.operations.length - 1; index >= 0; index -= 1) {
		const operation = model.operations[index]
		if (operation.stack !== stack) continue
		if (operation.kind === 'observe' || operation.kind === 'terminate') continue
		if (operation.kind === 'return') return operation
		const chain = callChainOf(model, stack)
		for (const call of chain) {
			if (call.id === operation.id) return operation
		}
		return chain[chain.length - 1] ?? null
	}
	return null
}

/**
 * Returns the destination of the active stack's current focus (see activeOperation), or null when there is no active stack. A freshly preempted stack has no call or return yet: its root is the current worker while the preempting party readies its first act.
 *
 * @param {InteractionModel} model
 * @returns {string | null}
 */
export function activeParticipant(model) {
	const operation = activeOperation(model)
	if (operation !== null) return operation.destination
	const stack = activeStack(model)
	if (stack === null) return null
	const record = stackRecordOf(model, stack)
	return record === undefined ? null : record.root
}

// Replays the operations in order to track the open call chain per stack id: a 'call' pushes onto its stack's chain, a 'return' pops the most recent open call on its own stack, and a 'terminate' closes the targeted call without handing off activity — it pops the open call whose destination matches the terminate's destination, so the node is removed immediately (the next frame the call is absent from the chain) and no separate 'terminated' return is needed for that call. A return closes a call regardless of outcome (a 'terminated' return pops just like a 'success' return), so the chain reflects "still open" rather than "still succeeding". 'observe' is ignored — it never enters a call chain. A terminate's destination lives in a different (paused) stack than the terminate itself (a tool in the active stack reaches across into a paused stack), so the match is by destination across every chain rather than by the terminate's own stack.
function openCallsByStack(model) {
	const chains = new Map()
	for (const operation of model.operations) {
		if (operation.kind === 'call') {
			let chain = chains.get(operation.stack)
			if (chain === undefined) {
				chain = []
				chains.set(operation.stack, chain)
			}
			chain.push(operation)
		} else if (operation.kind === 'return') {
			const chain = chains.get(operation.stack)
			if (chain !== undefined && chain.length > 0) chain.pop()
		} else if (operation.kind === 'terminate') {
			for (const chain of chains.values()) {
				let popped = false
				for (let index = chain.length - 1; index >= 0; index -= 1) {
					const call = chain[index]
					if (call === undefined) continue
					if (call.destination === operation.destination) {
						chain.splice(index, 1)
						popped = true
						break
					}
				}
				if (popped) break
			}
		}
	}
	return chains
}

// The latest activity-affecting operation on a stack (a 'call' or 'return'), or undefined when the stack carries only observes/terminates (or nothing). stacksOf uses this to detect a lingering in_flight return leg on an otherwise-empty stack, and the flow view's row projection uses the same rule to decide whether the stack still renders a row. observe and terminate are skipped because neither affects activity, so an operation of theirs logged after an in_flight return must not hide the lingering return leg (a terminate closes its own targeted call but does not settle the active stack's in_flight return).
function latestActivityOperationOnStack(model, stackId) {
	for (let index = model.operations.length - 1; index >= 0; index -= 1) {
		const operation = model.operations[index]
		if (operation.stack !== stackId) continue
		if (operation.kind === 'observe' || operation.kind === 'terminate') continue
		return operation
	}
	return undefined
}

/**
 * Returns the stack ids that still render a row in push order (oldest first). Rows never reorder as activity moves — the main run stays the top row and each preempting interrupt stays below it in preemption order; the active stack is conveyed by the pulsing node and marching lines, not by row position. A stack renders a row while it carries an open call, or — once its chain is empty — while its latest activity-affecting operation is an in_flight return (a lingering response leg the view draws until the return settles). A freshly preempted stack — pushed by an interrupt but carrying no operations yet — also renders a row holding just its root; operations alone cannot name such a stack, so only stack records reveal it (a producer that does not emit records renders nothing for it).
 *
 * @param {InteractionModel} model
 * @returns {string[]}
 */
export function stacksOf(model) {
	const chains = openCallsByStack(model)
	const records = stackRecordsOf(model)
	const orderByStack = new Map()
	records.forEach((record, index) => orderByStack.set(record.id, index))
	const open = []
	for (const [stackId, chain] of chains) {
		if (chain.length > 0) {
			open.push(stackId)
			continue
		}
		// A stack whose open call chain is empty still renders a row while its latest activity-affecting operation is an in_flight return (a lingering response leg), so a terminal return's transit frame keeps the stack's row until the return settles and the returner departs.
		const latest = latestActivityOperationOnStack(model, stackId)
		if (latest !== undefined && latest.kind === 'return' && latest.lifecycle === 'in_flight') {
			open.push(stackId)
		}
	}
	const firstRecord = records[0]
	if (firstRecord !== undefined) {
		for (const record of records) {
			if (record.id === firstRecord.id) continue
			if (open.includes(record.id)) continue
			if (model.operations.some((operation) => operation.stack === record.id)) continue
			open.push(record.id)
		}
	}
	open.sort((a, b) => (orderByStack.get(a) ?? 0) - (orderByStack.get(b) ?? 0))
	return open
}

/**
 * Returns the open call chain of a stack in call order (outermost first), for the flow view's active-path projection. Calls whose return has already appeared are absent, as are calls closed by a terminate (a terminate pops the open call whose destination it targets). 'observe' never appears here.
 *
 * @param {InteractionModel} model
 * @param {string} stackId
 * @returns {Operation[]}
 */
export function callChainOf(model, stackId) {
	const chain = openCallsByStack(model).get(stackId)
	if (chain === undefined) return []
	return chain.slice()
}

/**
 * True when the stack is not the active stack and still carries open calls. A paused stack's in-flight operations stay in flight (the model never flips lifecycle on pause); this helper is the rule the view reads to freeze a paused stack's lines without touching the model.
 *
 * @param {InteractionModel} model
 * @param {string} stackId
 * @returns {boolean}
 */
export function isPaused(model, stackId) {
	if (activeStack(model) === stackId) return false
	return callChainOf(model, stackId).length > 0
}

// The latest contiguous run of operations on a stack — the stack's current phase, ending at its most recent operation. For a paused stack this is the block it produced after the preempting stack's final return and before it was paused again; fateOf reads the fate off it. Observes are logged on the active stack, so they never split a paused stack's phase.
function latestContiguousBlockOnStack(model, stackId) {
	const operations = model.operations
	let endIndex = -1
	for (let index = operations.length - 1; index >= 0; index -= 1) {
		if (operations[index].stack === stackId) {
			endIndex = index
			break
		}
	}
	if (endIndex === -1) return []
	let startIndex = endIndex
	for (let index = endIndex - 1; index >= 0; index -= 1) {
		if (operations[index].stack !== stackId) break
		startIndex = index
	}
	return operations.slice(startIndex, endIndex + 1)
}

/**
 * Returns the fate of a stack, read off its own operations after the preemption point rather than stored as a field. The fates are:
 * - 'active' — the stack is the active stack.
 * - 'terminated' — the stack has no open calls remaining (fully closed).
 * - 'resuming' — paused, and its current phase shows no in-progress teardown or rewind: either no terminated returns, or a rewind whose restart call has already been followed by normal work (the rewind completed and the stack resumed). A freshly paused stack with no post-preemption operations yet lands here too, since there is no evidence of termination.
 * - 'terminating' — paused, and its current phase ends in terminated returns with no restart call after them (calls are being closed toward the root). A fresh teardown that began after a completed rewind (terminated returns in the post-restart tail) also lands here.
 * - 'rewinding' — paused, and its current phase's latest operation is a rewind's restart call: a call immediately preceded by terminated returns, with no normal work following it yet. An ancestor restarted a leg after backing out, and the restart has not yet produced normal work. Once normal work follows the restart call, the rewind is complete and the stack reads 'resuming'.
 *
 * The rewind is identified by its restart call — the call that immediately follows a terminated return — and read off only the tail after the last such restart, so a stack that rewound and then resumed normal nested calls before being re-paused reads 'resuming' (the rewind is done) rather than 'rewinding'. Scanning the whole phase for "any terminated return plus any call" would let the rewind's terminated returns outweigh the later normal work and mislabel a completed rewind as in-progress.
 *
 * @param {InteractionModel} model
 * @param {string} stackId
 * @returns {'resuming' | 'rewinding' | 'terminating' | 'terminated' | 'active'}
 */
export function fateOf(model, stackId) {
	if (activeStack(model) === stackId) return 'active'
	if (callChainOf(model, stackId).length === 0) return 'terminated'
	const phase = latestContiguousBlockOnStack(model, stackId)
	let lastRestartIndex = -1
	let phaseHasTerminatedReturn = false
	for (let index = 0; index < phase.length; index += 1) {
		const operation = phase[index]
		if (operation.kind === 'return' && operation.outcome === 'terminated') {
			phaseHasTerminatedReturn = true
		} else if (operation.kind === 'call' && index > 0) {
			const previous = phase[index - 1]
			if (previous.kind === 'return' && previous.outcome === 'terminated') lastRestartIndex = index
		}
	}
	if (lastRestartIndex === -1) {
		if (phaseHasTerminatedReturn) return 'terminating'
		return 'resuming'
	}
	if (lastRestartIndex === phase.length - 1) return 'rewinding'
	for (let index = lastRestartIndex + 1; index < phase.length; index += 1) {
		const operation = phase[index]
		if (operation.kind === 'return' && operation.outcome === 'terminated') return 'terminating'
	}
	return 'resuming'
}

/**
 * Returns the observe operations in chronological order. An observe spans stacks — its source sits in the active stack and its destination in a paused stack — so the sequence view draws these as static cross-stack lines that never animate and never enter any call chain.
 *
 * @param {InteractionModel} model
 * @returns {Operation[]}
 */
export function observesOf(model) {
	return model.operations.filter((operation) => operation.kind === 'observe')
}

/**
 * Returns the terminate operations in chronological order. A terminate is a destructive close: a rewind tool in the active stack reverts a target node in a paused stack, so the view draws a red dotted line from the tool to the target and an orange dotted border on the target for the single frame the terminate is the latest operation; the next frame the target is gone (the terminate closed its call). Like observe, a terminate spans stacks, never animates, and never affects activity — but unlike observe it closes the targeted call (pops it from the open chain) without handing activity to anyone, so the node is removed immediately and no separate 'terminated' return is needed for that call.
 *
 * @param {InteractionModel} model
 * @returns {Operation[]}
 */
export function terminatesOf(model) {
	return model.operations.filter((operation) => operation.kind === 'terminate')
}
