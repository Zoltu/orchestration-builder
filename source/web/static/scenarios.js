// Demo scenarios authored directly as InteractionModel frame sequences.
//
// Each scenario is an ordered list of operation specs, and the frame builder expands every call/return spec into two consecutive frames — a transit frame (the operation is in_flight, so its line animates and its destination pulses) and a working frame (the operation is settled, so its line goes solid while its destination keeps pulsing) — so both phases of a step are scrubber-controllable rather than collapsed into one frame. An observe is instantaneous (it is a reference, not a call), so it expands to a single frame that keeps the prior active operation in its working phase. The frame builder overrides only the latest non-observe operation on the active stack; every earlier operation keeps the lifecycle the normal materialization derives, so paused stacks still carry their genuinely in_flight operations and the model's single invariant holds.
//
// Authoring against the model contract (operations and participants as first-class data, no event vocabulary and no window reconstruction) is what lets the scenarios exercise the cases the previous fixture set covered plus the cases only the new model can express honestly: instance-per-invocation retries, cross-stack observes, and the three interrupt fates (resume / rewind / terminate) read off operation sequences rather than a fate field.
//
// The scenarios are browser-pure JS (no imports) so the static server serves them and the test runner imports them from the filesystem, mirroring the sibling interaction-model.js convention.

/**
 * @typedef {'human' | 'interrupt' | 'role' | 'tool'} ParticipantKind
 */

/**
 * @typedef {Object} Participant
 * @property {string} id
 *   Instance-scoped, unique per invocation. A role invoked twice carries two participants with distinct ids, so a retry renders a second node rather than a counter on the first.
 * @property {string} role
 *   The role or tool name; 'human' for the You root and 'interrupt' for interrupt roots.
 * @property {ParticipantKind} kind
 */

/**
 * @typedef {'call' | 'return' | 'observe' | 'terminate'} OperationKind
 */

/**
 * @typedef {'success' | 'error' | 'terminated'} OperationOutcome
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
 * @property {string} source
 * @property {string} destination
 * @property {string} startedAt
 * @property {string | null} settledAt
 * @property {'in_flight' | 'settled'} lifecycle
 * @property {OperationOutcome | null} outcome
 * @property {string | null} details
 * @property {OperationMetrics | null} metrics
 */

/**
 * @typedef {'running' | 'success' | 'error' | 'needs_clarification' | 'unknown'} RunStatus
 */

/**
 * @typedef {Object} InteractionModel
 * @property {Participant[]} participants
 * @property {Operation[]} operations
 * @property {RunStatus} status
 */

// An operation spec is the authored input to the frame builder: a call carries no settledAt/lifecycle/outcome (those are derived from how later specs advance it), a return carries its own settledAt and outcome, and an observe is instantaneous.
/**
 * @typedef {Object} OperationSpec
 * @property {string} id
 * @property {OperationKind} kind
 * @property {string} stack
 * @property {string} source
 * @property {string} destination
 * @property {string} startedAt
 * @property {string} [settledAt]
 *   Return only: when the return completed.
 * @property {OperationOutcome} [outcome]
 *   Return only: the outcome the callee settled with.
 * @property {string} [details]
 */

/**
 * @typedef {Object} Scenario
 * @property {string} id
 * @property {string} label
 * @property {InteractionModel[]} frames
 */

function participant(id, role, kind) {
	return { id, role, kind }
}

function callOperation(id, stack, source, destination, startedAt, details) {
	return { id, kind: 'call', stack, source, destination, startedAt, details: details ?? null }
}

function returnOperation(id, stack, source, destination, startedAt, settledAt, outcome, details) {
	return { id, kind: 'return', stack, source, destination, startedAt, settledAt, outcome, details: details ?? null }
}

function observeOperation(id, stack, source, destination, startedAt, details) {
	return { id, kind: 'observe', stack, source, destination, startedAt, details: details ?? null }
}

// A terminate is an instantaneous destructive close: a rewind tool in the active stack reverts a target node in a paused stack. Like observe it carries no settledAt/outcome of its own (settledAt === startedAt, outcome null), but unlike observe it closes the targeted call — popping the open call whose destination matches — so the node is removed immediately and no separate 'terminated' return is needed for that call. A terminate never hands off activity, so the active operation stays the interrupt's own call rather than the terminate.
function terminateOperation(id, stack, source, destination, startedAt, details) {
	return { id, kind: 'terminate', stack, source, destination, startedAt, details: details ?? null }
}

// Builds the full Operation list for the first `count` specs by replaying them. A call is in_flight only while it is the innermost still-open call on its stack: once a nested call appears on the same stack the outer call is settled at that nested call's startedAt (the callee delegated), and once its matching return appears it is settled at that return's startedAt. The return's outcome is never mirrored onto the call — the contract is "outcome is returns only", so a view that needs a call's eventual outcome pairs the call with its closing return rather than reading a duplicated field. This is what lets a single per-stack invariant ("at most one in_flight operation per stack") hold for nested chains, paused stacks, and reactivated legs alike.
function materializeOperations(specs, count) {
	const closingReturnByCallId = new Map()
	const openCallIdsByStack = new Map()
	const openCallSpecsByStack = new Map()
	for (let index = 0; index < count; index += 1) {
		const spec = specs[index]
		if (spec.kind === 'call') {
			let openChain = openCallIdsByStack.get(spec.stack)
			let openSpecChain = openCallSpecsByStack.get(spec.stack)
			if (openChain === undefined) {
				openChain = []
				openCallIdsByStack.set(spec.stack, openChain)
			}
			if (openSpecChain === undefined) {
				openSpecChain = []
				openCallSpecsByStack.set(spec.stack, openSpecChain)
			}
			openChain.push(spec.id)
			openSpecChain.push(spec)
		} else if (spec.kind === 'return') {
			const openChain = openCallIdsByStack.get(spec.stack)
			const openSpecChain = openCallSpecsByStack.get(spec.stack)
			if (openChain !== undefined && openChain.length > 0) {
				openChain.pop()
			}
			if (openSpecChain !== undefined && openSpecChain.length > 0) {
				const callSpec = openSpecChain.pop()
				if (callSpec !== undefined) closingReturnByCallId.set(callSpec.id, { settledAt: spec.startedAt, outcome: spec.outcome })
			}
		} else if (spec.kind === 'terminate') {
			// A terminate closes the targeted call (the open call whose destination it reverts) without a return carrying the killed result, so the call's lifecycle flips to settled and the chain pops immediately. Matching by destination across every stack mirrors openCallsByStack: a terminate's destination lives in a paused stack while the terminate itself is logged on the active stack.
			for (const openSpecChain of openCallSpecsByStack.values()) {
				let popped = false
				for (let chainIndex = openSpecChain.length - 1; chainIndex >= 0; chainIndex -= 1) {
					const callSpec = openSpecChain[chainIndex]
					if (callSpec === undefined) continue
					if (callSpec.destination === spec.destination) {
						openSpecChain.splice(chainIndex, 1)
						closingReturnByCallId.set(callSpec.id, { settledAt: spec.startedAt, outcome: 'terminated' })
						popped = true
						break
					}
				}
				if (popped) break
			}
		}
	}
	// innermostOpenCallByStack must be derived from the surviving open-chain ids (terminate may have popped the innermost), not the spec chain, so a terminate that closed a stack's innermost call no longer reports that call as innermost.
	const innermostOpenCallByStack = new Map()
	for (const [stackId, openChain] of openCallIdsByStack) {
		// The ids chain may carry an id whose spec was popped by a terminate without a corresponding return; reconcile against the surviving specs so only genuinely-open calls remain innermost.
		const survivingSpecChain = openCallSpecsByStack.get(stackId) ?? []
		for (let i = openChain.length - 1; i >= 0; i -= 1) {
			const id = openChain[i]
			if (id === undefined) continue
			const stillOpen = survivingSpecChain.some((s) => s.id === id)
			if (stillOpen) {
				innermostOpenCallByStack.set(stackId, id)
				break
			}
		}
	}
	// A call that is still open but no longer innermost was settled by delegation: its settledAt is the startedAt of the next operation to land on its stack (the nested call that took over).
	const delegationStartedAtByCallId = new Map()
	for (let index = 0; index < count; index += 1) {
		const spec = specs[index]
		if (spec.kind !== 'call') continue
		for (let next = index + 1; next < count; next += 1) {
			if (specs[next].stack === spec.stack) {
				delegationStartedAtByCallId.set(spec.id, specs[next].startedAt)
				break
			}
		}
	}
	const operations = []
	for (let index = 0; index < count; index += 1) {
		const spec = specs[index]
		if (spec.kind === 'call') {
			const closingReturn = closingReturnByCallId.get(spec.id)
			let settledAt = null
			let lifecycle = 'in_flight'
			if (closingReturn !== undefined) {
				settledAt = closingReturn.settledAt
				lifecycle = 'settled'
			} else if (innermostOpenCallByStack.get(spec.stack) !== spec.id) {
				settledAt = delegationStartedAtByCallId.get(spec.id) ?? null
				lifecycle = 'settled'
			}
			operations.push({ id: spec.id, kind: 'call', stack: spec.stack, source: spec.source, destination: spec.destination, startedAt: spec.startedAt, settledAt, lifecycle, outcome: null, details: spec.details ?? null, metrics: null })
		} else if (spec.kind === 'return') {
			operations.push({ id: spec.id, kind: 'return', stack: spec.stack, source: spec.source, destination: spec.destination, startedAt: spec.startedAt, settledAt: spec.settledAt, lifecycle: 'settled', outcome: spec.outcome, details: spec.details ?? null, metrics: null })
		} else {
			// observe and terminate are both instantaneous references logged on the active stack: settledAt === startedAt, lifecycle settled, outcome null. Neither opens or closes a call, so neither participates in the open-chain bookkeeping above.
			operations.push({ id: spec.id, kind: spec.kind, stack: spec.stack, source: spec.source, destination: spec.destination, startedAt: spec.startedAt, settledAt: spec.startedAt, lifecycle: 'settled', outcome: null, details: spec.details ?? null, metrics: null })
		}
	}
	return operations
}

// Collects participants in chronological first-appearance order by scanning the frame's operations; the registry holds the full Participant objects so the lookup is a pure mapping from id to { role, kind }. The 'interrupt' pseudo-role therefore appears only on the frame where an interrupt's first call lands, matching the model's first-use rule.
function participantsInOrder(operations, registry) {
	const seen = new Set()
	const ordered = []
	for (const operation of operations) {
		for (const id of [operation.source, operation.destination]) {
			if (seen.has(id)) continue
			seen.add(id)
			const found = registry.get(id)
			if (found === undefined) throw new Error(`scenario references unknown participant id "${id}"`)
			ordered.push(found)
		}
	}
	return ordered
}

function isTerminalStatus(status) {
	return status === 'success' || status === 'error' || status === 'needs_clarification'
}

// Returns the index of the latest activity-affecting operation on the active stack (the model's "active operation"), or -1 when the active stack carries only observes/terminates. This is the single operation whose lifecycle a transit/working frame overrides; every earlier operation keeps the lifecycle the normal materialization derived, so paused stacks keep their genuinely in_flight operations and the model's single invariant holds.
function activeOperationIndex(operations) {
	if (operations.length === 0) return -1
	const activeStackId = operations[operations.length - 1].stack
	for (let index = operations.length - 1; index >= 0; index -= 1) {
		const operation = operations[index]
		if (operation.stack !== activeStackId) continue
		if (operation.kind === 'observe' || operation.kind === 'terminate') continue
		return index
	}
	return -1
}

// Materializes the first `count` specs under the normal lifecycle rules, then overrides the active operation's lifecycle to the requested phase. 'transit' forces the active operation in_flight (the call/return is traveling, so its line animates) and 'working' forces it settled (the call/return has arrived, so its line goes solid while its destination keeps pulsing). Sibling in_flight operations on the active stack are settled in BOTH phases, not just transit, because only the active operation is ever in_flight on the active stack: a return in transit animates its own return line, and a return's working frame leaves the caller's established call solid (not flowing) — the caller resumed but its call is no longer traveling. Paused stacks are never touched (their operations live on other stacks), so they keep their genuinely in_flight operations and the model's single invariant holds.
function materializeForPhase(specs, count, phase) {
	const operations = materializeOperations(specs, count)
	const activeIndex = activeOperationIndex(operations)
	if (activeIndex === -1) return operations
	const activeStackId = operations[activeIndex].stack
	return operations.map((operation, index) => {
		if (index === activeIndex) {
			if (phase === 'transit') return { ...operation, lifecycle: 'in_flight', settledAt: null }
			return { ...operation, lifecycle: 'settled', settledAt: operation.settledAt ?? operation.startedAt }
		}
		if (operation.stack !== activeStackId) return operation
		if (operation.lifecycle === 'in_flight') {
			return { ...operation, lifecycle: 'settled', settledAt: operation.settledAt ?? operation.startedAt }
		}
		return operation
	})
}

/**
 * @param {object} raw
 * @param {string} raw.id
 * @param {string} raw.label
 * @param {Participant[]} raw.participants
 * @param {OperationSpec[]} raw.operations
 * @param {RunStatus[]} raw.statuses
 * @returns {Scenario}
 */
function buildScenario(raw) {
	const registry = new Map(raw.participants.map((entry) => [entry.id, entry]))
	if (raw.operations.length === 0) throw new Error(`scenario "${raw.id}" has no operations`)
	if (raw.statuses.length !== raw.operations.length) throw new Error(`scenario "${raw.id}" statuses length does not match operations length`)
	const frames = []
	for (let index = 0; index < raw.operations.length; index += 1) {
		const spec = raw.operations[index]
		const count = index + 1
		const status = raw.statuses[index]
		const isLastSpec = index === raw.operations.length - 1
		// An observe or terminate is instantaneous, so it expands to a single frame that holds the prior active operation in its working phase (the call it peeked at or reverted is still being worked on); giving it its own transit/working pair would re-animate a line that should stay solid.
		if (spec.kind === 'observe' || spec.kind === 'terminate') {
			const operations = materializeForPhase(raw.operations, count, 'working')
			frames.push({ participants: participantsInOrder(operations, registry), operations, status })
			continue
		}
		// The terminal op has no working frame. The human (You) is the run's root and never emits an operation that would advance the final return to its working phase, so the See Result click stands in as the acknowledgment that settles the return: the transit frame carries the real terminal status so the CTA renders, and the return stays in_flight so its lingering leg (returner + response line) renders until the click departs it.
		if (isLastSpec && isTerminalStatus(status)) {
			const transitOperations = materializeForPhase(raw.operations, count, 'transit')
			frames.push({ participants: participantsInOrder(transitOperations, registry), operations: transitOperations, status })
			continue
		}
		// An ask_human call has no working frame. The call targets a human participant (the answerer), and a human never emits an operation that would advance the call to its working phase, so the user's answer click stands in as the acknowledgment that advances to the human_answer return. This is the same single-transit-frame rule the terminal op follows, but the run is not terminal here: the ask_human call persists in transit until the user answers rather than until a See Result click, and the frame carries the needs_clarification status so the Question affordance renders.
		if (spec.kind === 'call') {
			const destinationParticipant = registry.get(spec.destination)
			if (destinationParticipant !== undefined && destinationParticipant.kind === 'human') {
				const transitOperations = materializeForPhase(raw.operations, count, 'transit')
				frames.push({ participants: participantsInOrder(transitOperations, registry), operations: transitOperations, status })
				continue
			}
		}
		const transitOperations = materializeForPhase(raw.operations, count, 'transit')
		frames.push({ participants: participantsInOrder(transitOperations, registry), operations: transitOperations, status })
		const workingOperations = materializeForPhase(raw.operations, count, 'working')
		frames.push({ participants: participantsInOrder(workingOperations, registry), operations: workingOperations, status })
	}
	return { id: raw.id, label: raw.label, frames }
}

// Fills every frame's status with 'running' except the final frame, which carries the run's terminal status. Used by scenarios whose mid-run status is uniformly 'running'.
function runningThenTerminal(operationCount, terminalStatus) {
	const statuses = new Array(operationCount).fill('running')
	statuses[operationCount - 1] = terminalStatus
	return statuses
}

// Single-role completion: the human delegates directly to one role, the role returns, the run ends. Establishes the minimal frame pair against which every more elaborate scenario is a variation.
const singleRoleCompletion = {
	id: 'single-role-completion',
	label: 'Single-role completion',
	participants: [
		participant('you', 'human', 'human'),
		participant('coder', 'coder', 'role'),
	],
	operations: [
		callOperation('op1', 'root', 'you', 'coder', 't0'),
		returnOperation('op2', 'root', 'coder', 'you', 't1', 't2', 'success'),
	],
	statuses: runningThenTerminal(2, 'success'),
}

// Delegation chain: orchestrator hands to planner, planner to coder, coder to a tool, then the returns unwind to the human. Four-deep nesting exercises the call-chain projection and the in_flight handoff between nesting levels.
const delegationChain = {
	id: 'delegation-chain',
	label: 'Delegation chain',
	participants: [
		participant('you', 'human', 'human'),
		participant('orchestrator', 'orchestrator', 'role'),
		participant('planner', 'planner', 'role'),
		participant('coder', 'coder', 'role'),
		participant('readFile', 'read_file', 'tool'),
	],
	operations: [
		callOperation('op1', 'root', 'you', 'orchestrator', 't0'),
		callOperation('op2', 'root', 'orchestrator', 'planner', 't1'),
		callOperation('op3', 'root', 'planner', 'coder', 't2'),
		callOperation('op4', 'root', 'coder', 'readFile', 't3'),
		returnOperation('op5', 'root', 'readFile', 'coder', 't4', 't5', 'success'),
		returnOperation('op6', 'root', 'coder', 'planner', 't6', 't7', 'success'),
		returnOperation('op7', 'root', 'planner', 'orchestrator', 't8', 't9', 'success'),
		returnOperation('op8', 'root', 'orchestrator', 'you', 't10', 't11', 'success'),
	],
	statuses: runningThenTerminal(8, 'success'),
}

// Retry: the orchestrator delegates to a coder, the coder returns, the orchestrator re-delegates to a fresh coder instance. coder-1 and coder-2 are distinct Participant instances sharing role 'coder', exercising instance-per-invocation rather than a counter on the first node.
const retryWithFreshInstance = {
	id: 'retry-with-fresh-instance',
	label: 'Retry (fresh instance)',
	participants: [
		participant('you', 'human', 'human'),
		participant('orchestrator', 'orchestrator', 'role'),
		participant('coder-1', 'coder', 'role'),
		participant('coder-2', 'coder', 'role'),
	],
	operations: [
		callOperation('op1', 'root', 'you', 'orchestrator', 't0'),
		callOperation('op2', 'root', 'orchestrator', 'coder-1', 't1'),
		returnOperation('op3', 'root', 'coder-1', 'orchestrator', 't2', 't3', 'success'),
		callOperation('op4', 'root', 'orchestrator', 'coder-2', 't4'),
		returnOperation('op5', 'root', 'coder-2', 'orchestrator', 't5', 't6', 'success'),
		returnOperation('op6', 'root', 'orchestrator', 'you', 't7', 't8', 'success'),
	],
	statuses: runningThenTerminal(6, 'success'),
}

// Deep call tree: five levels of nesting (human to orchestrator to planner to coder to critic to a tool). Exceeds the four-deep delegation chain so the call-chain projection and the per-stack in_flight rule are visibly exercised one level further.
const deepCallTree = {
	id: 'deep-call-tree',
	label: 'Deep call tree',
	participants: [
		participant('you', 'human', 'human'),
		participant('orchestrator', 'orchestrator', 'role'),
		participant('planner', 'planner', 'role'),
		participant('coder', 'coder', 'role'),
		participant('critic', 'critic', 'role'),
		participant('readFile', 'read_file', 'tool'),
	],
	operations: [
		callOperation('op1', 'root', 'you', 'orchestrator', 't0'),
		callOperation('op2', 'root', 'orchestrator', 'planner', 't1'),
		callOperation('op3', 'root', 'planner', 'coder', 't2'),
		callOperation('op4', 'root', 'coder', 'critic', 't3'),
		callOperation('op5', 'root', 'critic', 'readFile', 't4'),
		returnOperation('op6', 'root', 'readFile', 'critic', 't5', 't6', 'success'),
		returnOperation('op7', 'root', 'critic', 'coder', 't7', 't8', 'success'),
		returnOperation('op8', 'root', 'coder', 'planner', 't9', 't10', 'success'),
		returnOperation('op9', 'root', 'planner', 'orchestrator', 't11', 't12', 'success'),
		returnOperation('op10', 'root', 'orchestrator', 'you', 't13', 't14', 'success'),
	],
	statuses: runningThenTerminal(10, 'success'),
}

// Pending question (ask_human): the orchestrator asks the human a question via a call that targets a DISTINCT human answerer instance — instance-per-invocation for human, like coder-1/coder-2 — rather than the root 'you' (the task submitter, who is never the target of a question). The ask_human call persists in transit (a single transit frame, no working frame) until the user answers, then the human_answer return closes the call and turns the answerer green, and the run completes with a terminal return to the root 'you'.
const pendingQuestion = {
	id: 'pending-question',
	label: 'Pending question',
	participants: [
		participant('you', 'human', 'human'),
		participant('orchestrator', 'orchestrator', 'role'),
		participant('you-answerer', 'human', 'human'),
	],
	operations: [
		callOperation('op1', 'root', 'you', 'orchestrator', 't0'),
		callOperation('op2', 'root', 'orchestrator', 'you-answerer', 't1', 'Which testing framework should I use?'),
		returnOperation('op3', 'root', 'you-answerer', 'orchestrator', 't2', 't3', 'success'),
		returnOperation('op4', 'root', 'orchestrator', 'you', 't4', 't5', 'success'),
	],
	statuses: ['running', 'needs_clarification', 'running', 'success'],
}

// Interrupt (detected loop): a coder is mid-flight when an Interrupt instance spawns a fresh stack rooted at the loop detector. The detector calls a tool, the tool observes into the paused coder stack and returns to the detector, the detector returns, and the coder stack resumes. The observe crosses stacks (source in the active interrupt stack, destination in the paused root) and never enters a call chain.
const detectedLoopInterrupt = {
	id: 'detected-loop-interrupt',
	label: 'Interrupt (detected loop)',
	participants: [
		participant('you', 'human', 'human'),
		participant('orchestrator', 'orchestrator', 'role'),
		participant('coder', 'coder', 'role'),
		participant('interrupt-1', 'interrupt', 'interrupt'),
		participant('loopDetector', 'loop_detector', 'role'),
		participant('readMessageWindow', 'read_message_window', 'tool'),
		participant('readFile', 'read_file', 'tool'),
	],
	operations: [
		callOperation('op1', 'root', 'you', 'orchestrator', 't0'),
		callOperation('op2', 'root', 'orchestrator', 'coder', 't1'),
		callOperation('op3', 'interrupt-stack', 'interrupt-1', 'loopDetector', 't2'),
		callOperation('op4', 'interrupt-stack', 'loopDetector', 'readMessageWindow', 't3'),
		// The tool reads the looping role's history: the observe's source is the tool participant, not the loop_detector agent, mirroring the backend where the agent calls a tool and the tool does the reading.
		observeOperation('op5', 'interrupt-stack', 'readMessageWindow', 'coder', 't4', 'peek at the looping coder'),
		returnOperation('op6', 'interrupt-stack', 'readMessageWindow', 'loopDetector', 't5', 't6', 'success'),
		returnOperation('op7', 'interrupt-stack', 'loopDetector', 'interrupt-1', 't7', 't8', 'success'),
		callOperation('op8', 'root', 'coder', 'readFile', 't9'),
		returnOperation('op9', 'root', 'readFile', 'coder', 't10', 't11', 'success'),
		returnOperation('op10', 'root', 'coder', 'orchestrator', 't12', 't13', 'success'),
		returnOperation('op11', 'root', 'orchestrator', 'you', 't14', 't15', 'success'),
	],
	statuses: runningThenTerminal(11, 'success'),
}

// Nested interrupt: an interrupt preempts an interrupt. Three stacks (root, interrupt-1, interrupt-2) briefly coexist with open calls before the innermost resolves, then the next, then the root. Confirms an interrupt is itself preemptable and each gets its own stack id. Each interrupt calls its own fresh loop_detector instance (instance-per-invocation, mirroring coder-1/coder-2), so the two simultaneously-open interrupt stacks carry distinct participants and the active-node highlight lights up only the active stack's detector rather than both.
const nestedInterrupt = {
	id: 'nested-interrupt',
	label: 'Nested interrupt',
	participants: [
		participant('you', 'human', 'human'),
		participant('orchestrator', 'orchestrator', 'role'),
		participant('coder', 'coder', 'role'),
		participant('interrupt-1', 'interrupt', 'interrupt'),
		participant('interrupt-2', 'interrupt', 'interrupt'),
		participant('loopDetector-1', 'loop_detector', 'role'),
		participant('loopDetector-2', 'loop_detector', 'role'),
	],
	operations: [
		callOperation('op1', 'root', 'you', 'orchestrator', 't0'),
		callOperation('op2', 'root', 'orchestrator', 'coder', 't1'),
		callOperation('op3', 'interrupt-1-stack', 'interrupt-1', 'loopDetector-1', 't2'),
		callOperation('op4', 'interrupt-2-stack', 'interrupt-2', 'loopDetector-2', 't3'),
		returnOperation('op5', 'interrupt-2-stack', 'loopDetector-2', 'interrupt-2', 't4', 't5', 'success'),
		returnOperation('op6', 'interrupt-1-stack', 'loopDetector-1', 'interrupt-1', 't6', 't7', 'success'),
		returnOperation('op7', 'root', 'coder', 'orchestrator', 't8', 't9', 'success'),
		returnOperation('op8', 'root', 'orchestrator', 'you', 't10', 't11', 'success'),
	],
	statuses: runningThenTerminal(8, 'success'),
}

// Rewind fate: an interrupt's loop_detector calls a rewind tool, the tool emits a terminate op reverting the paused-stack target (which closes the call immediately, removing the node), the tool returns, the loop_detector returns, and the ancestor gets control and calls a fresh coder-2 instance. A second interrupt preempts mid-rewind so the rewind fate is observable on a paused stack.
//
// The act of reverting is the rewind tool's terminate ops, not a terminated outcome on a return: the operator was explicit that "it will be a tool that rewinds other rows, not the loop detector agent itself", so the loop_detector calls the tool, the tool terminates the target (source = the tool, destination = the target node), then the tool returns success to the loop_detector. The terminate op closes the targeted call immediately, so no separate terminated return is needed for that call — the node is removed right away.
const rewindFate = {
	id: 'rewind-fate',
	label: 'Rewind fate',
	participants: [
		participant('you', 'human', 'human'),
		participant('orchestrator', 'orchestrator', 'role'),
		participant('coder', 'coder', 'role'),
		participant('coder-2', 'coder', 'role'),
		participant('interrupt-1', 'interrupt', 'interrupt'),
		participant('interrupt-2', 'interrupt', 'interrupt'),
		participant('loopDetector', 'loop_detector', 'role'),
		participant('rewindStack', 'rewind_stack', 'tool'),
	],
	operations: [
		callOperation('op1', 'root', 'you', 'orchestrator', 't0'),
		callOperation('op2', 'root', 'orchestrator', 'coder', 't1'),
		callOperation('op3', 'interrupt-1-stack', 'interrupt-1', 'loopDetector', 't2'),
		// The loop_detector calls the rewind tool; the tool, not the agent, performs the reverts.
		callOperation('op4', 'interrupt-1-stack', 'loopDetector', 'rewindStack', 't3'),
		// The tool reverts the looping coder: source is the tool participant, destination is the target node in the paused root stack. The terminate closes the call immediately, so the coder node is removed right away and no separate terminated return is needed.
		terminateOperation('op5', 'interrupt-1-stack', 'rewindStack', 'coder', 't4', 'revert the looping coder'),
		returnOperation('op6', 'interrupt-1-stack', 'rewindStack', 'loopDetector', 't5', 't6', 'success'),
		returnOperation('op7', 'interrupt-1-stack', 'loopDetector', 'interrupt-1', 't7', 't8', 'success'),
		callOperation('op8', 'root', 'orchestrator', 'coder-2', 't9'),
		callOperation('op9', 'interrupt-2-stack', 'interrupt-2', 'loopDetector', 't10'),
		returnOperation('op10', 'interrupt-2-stack', 'loopDetector', 'interrupt-2', 't11', 't12', 'success'),
		returnOperation('op11', 'root', 'coder-2', 'orchestrator', 't13', 't14', 'success'),
		returnOperation('op12', 'root', 'orchestrator', 'you', 't15', 't16', 'success'),
	],
	statuses: runningThenTerminal(12, 'success'),
}

// Deeper nested interrupt: three stacks (root, interrupt-1, interrupt-2) coexist with open calls while the innermost runs. Each interrupt calls its own fresh loop_detector instance (instance-per-invocation, like every role), and each loop_detector in turn calls its own fresh read_message_window instance, so the two simultaneously-open interrupt stacks carry distinct participants and the observe's source (the tool) is unambiguous. The inner interrupt's tool observes the outermost paused stack across the middle row, exercising a non-adjacent observe line. Each paused stack carries an in_flight call that must render frozen. Resolving the inner stack resumes the middle one, which then resumes the root — the active-stack row reorders inward as stacks close.
const nestedInterruptDeep = {
	id: 'nested-interrupt-deep',
	label: 'Nested interrupt (deep, three stacks)',
	participants: [
		participant('you', 'human', 'human'),
		participant('orchestrator', 'orchestrator', 'role'),
		participant('coder', 'coder', 'role'),
		participant('interrupt-1', 'interrupt', 'interrupt'),
		participant('interrupt-2', 'interrupt', 'interrupt'),
		participant('loopDetector-1', 'loop_detector', 'role'),
		participant('loopDetector-2', 'loop_detector', 'role'),
		participant('readMessageWindow-1', 'read_message_window', 'tool'),
		participant('readMessageWindow-2', 'read_message_window', 'tool'),
		participant('readFile', 'read_file', 'tool'),
	],
	operations: [
		callOperation('op1', 'root', 'you', 'orchestrator', 't0'),
		callOperation('op2', 'root', 'orchestrator', 'coder', 't1'),
		callOperation('op3', 'interrupt-1-stack', 'interrupt-1', 'loopDetector-1', 't2'),
		callOperation('op4', 'interrupt-1-stack', 'loopDetector-1', 'readMessageWindow-1', 't3'),
		callOperation('op5', 'interrupt-2-stack', 'interrupt-2', 'loopDetector-2', 't4'),
		callOperation('op6', 'interrupt-2-stack', 'loopDetector-2', 'readMessageWindow-2', 't5'),
		// The observe's source is the tool (readMessageWindow-2), not the loop_detector agent: the agent calls the tool and the tool reads the target role's history.
		observeOperation('op7', 'interrupt-2-stack', 'readMessageWindow-2', 'coder', 't6', 'peek at the outermost looping coder across the middle stack'),
		returnOperation('op8', 'interrupt-2-stack', 'readMessageWindow-2', 'loopDetector-2', 't7', 't8', 'success'),
		returnOperation('op9', 'interrupt-2-stack', 'loopDetector-2', 'interrupt-2', 't9', 't10', 'success'),
		returnOperation('op10', 'interrupt-1-stack', 'readMessageWindow-1', 'loopDetector-1', 't11', 't12', 'success'),
		returnOperation('op11', 'interrupt-1-stack', 'loopDetector-1', 'interrupt-1', 't13', 't14', 'success'),
		callOperation('op12', 'root', 'coder', 'readFile', 't15'),
		returnOperation('op13', 'root', 'readFile', 'coder', 't16', 't17', 'success'),
		returnOperation('op14', 'root', 'coder', 'orchestrator', 't18', 't19', 'success'),
		returnOperation('op15', 'root', 'orchestrator', 'you', 't20', 't21', 'success'),
	],
	statuses: runningThenTerminal(15, 'success'),
}

// Rewind whose tool terminates multiple children (coder, then planner) before the ancestor's fresh call, then a normal nested call after the rewind, then a re-pause mid-flight. The loop_detector calls the rewind tool, the tool emits one terminate per reverted node (each sourced at the tool), the terminate closes each targeted call immediately (removing the node right away), then the tool returns success, the loop_detector returns, and the ancestor (orchestrator) gets control and calls a fresh coder-2. The mid-rewind preemption (interrupt-2) leaves the root paused while the rewind is in progress. The post-rewind re-pause (interrupt-3) leaves the root paused mid-normal-operation past the rewind.
const rewindMultiTerminate = {
	id: 'rewind-multi-terminate',
	label: 'Rewind (multi-terminate, mixed phase)',
	participants: [
		participant('you', 'human', 'human'),
		participant('orchestrator', 'orchestrator', 'role'),
		participant('planner', 'planner', 'role'),
		participant('coder', 'coder', 'role'),
		participant('coder-2', 'coder', 'role'),
		participant('interrupt-1', 'interrupt', 'interrupt'),
		participant('interrupt-2', 'interrupt', 'interrupt'),
		participant('interrupt-3', 'interrupt', 'interrupt'),
		participant('loopDetector', 'loop_detector', 'role'),
		participant('rewindStack', 'rewind_stack', 'tool'),
		participant('readFile', 'read_file', 'tool'),
	],
	operations: [
		callOperation('op1', 'root', 'you', 'orchestrator', 't0'),
		callOperation('op2', 'root', 'orchestrator', 'planner', 't1'),
		callOperation('op3', 'root', 'planner', 'coder', 't2'),
		callOperation('op4', 'interrupt-1-stack', 'interrupt-1', 'loopDetector', 't3'),
		// The loop_detector calls the rewind tool; the tool, not the agent, performs the reverts.
		callOperation('op5', 'interrupt-1-stack', 'loopDetector', 'rewindStack', 't4'),
		// The tool reverts both paused-stack targets: one terminate op per reverted node, each sourced at the tool. Each terminate closes the targeted call immediately, so both nodes are removed right away and no separate terminated returns are needed.
		terminateOperation('op6', 'interrupt-1-stack', 'rewindStack', 'coder', 't5', 'revert the looping coder'),
		terminateOperation('op7', 'interrupt-1-stack', 'rewindStack', 'planner', 't6', 'revert the planner that delegated to it'),
		returnOperation('op8', 'interrupt-1-stack', 'rewindStack', 'loopDetector', 't7', 't8', 'success'),
		returnOperation('op9', 'interrupt-1-stack', 'loopDetector', 'interrupt-1', 't9', 't10', 'success'),
		callOperation('op10', 'interrupt-2-stack', 'interrupt-2', 'loopDetector', 't11'),
		returnOperation('op11', 'interrupt-2-stack', 'loopDetector', 'interrupt-2', 't12', 't13', 'success'),
		callOperation('op12', 'root', 'orchestrator', 'coder-2', 't14'),
		callOperation('op13', 'root', 'coder-2', 'readFile', 't15'),
		callOperation('op14', 'interrupt-3-stack', 'interrupt-3', 'loopDetector', 't16'),
		returnOperation('op15', 'interrupt-3-stack', 'loopDetector', 'interrupt-3', 't17', 't18', 'success'),
		returnOperation('op16', 'root', 'readFile', 'coder-2', 't19', 't20', 'success'),
		returnOperation('op17', 'root', 'coder-2', 'orchestrator', 't21', 't22', 'success'),
		returnOperation('op18', 'root', 'orchestrator', 'you', 't23', 't24', 'success'),
	],
	statuses: runningThenTerminal(18, 'success'),
}

// Terminate fate: an interrupt's loop_detector calls a terminate_task tool, which discards the whole task by emitting a terminate op targeting each node on the root stack (coder, then orchestrator). Each terminate closes the targeted call immediately, removing the node right away; no separate terminated returns are needed for the killed calls. After the terminates, the root stack has no open calls and the run ends cleanly (the tool returns success to the loop_detector, which returns to the interrupt). The model's RunStatus has no 'terminated' value, so a terminated run maps to 'success' (the run ended without erroring).
const terminateFate = {
	id: 'terminate-fate',
	label: 'Terminate fate',
	participants: [
		participant('you', 'human', 'human'),
		participant('orchestrator', 'orchestrator', 'role'),
		participant('coder', 'coder', 'role'),
		participant('interrupt-1', 'interrupt', 'interrupt'),
		participant('loopDetector', 'loop_detector', 'role'),
		participant('terminateTask', 'terminate_task', 'tool'),
	],
	operations: [
		callOperation('op1', 'root', 'you', 'orchestrator', 't0'),
		callOperation('op2', 'root', 'orchestrator', 'coder', 't1'),
		callOperation('op3', 'interrupt-1-stack', 'interrupt-1', 'loopDetector', 't2'),
		// The loop_detector calls the terminate_task tool; the tool, not the agent, performs the discard.
		callOperation('op4', 'interrupt-1-stack', 'loopDetector', 'terminateTask', 't3'),
		// The tool discards the whole task: one terminate op per node on the root stack, each sourced at the tool. Each terminate closes the targeted call immediately so the node is removed right away and no separate terminated return is needed.
		terminateOperation('op5', 'interrupt-1-stack', 'terminateTask', 'coder', 't4', 'discard the looping coder'),
		terminateOperation('op6', 'interrupt-1-stack', 'terminateTask', 'orchestrator', 't5', 'discard the orchestrator'),
		returnOperation('op7', 'interrupt-1-stack', 'terminateTask', 'loopDetector', 't6', 't7', 'success'),
		returnOperation('op8', 'interrupt-1-stack', 'loopDetector', 'interrupt-1', 't8', 't9', 'success'),
	],
	statuses: runningThenTerminal(8, 'success'),
}

// Error: a role returns with outcome 'error', and the run ends in the error status. The error outcome lives on the return only; a view reading the call chain derives the failed leg by pairing the call with its closing return, not by reading an outcome off the call.
const errorReturn = {
	id: 'error-return',
	label: 'Error',
	participants: [
		participant('you', 'human', 'human'),
		participant('orchestrator', 'orchestrator', 'role'),
		participant('coder', 'coder', 'role'),
	],
	operations: [
		callOperation('op1', 'root', 'you', 'orchestrator', 't0'),
		callOperation('op2', 'root', 'orchestrator', 'coder', 't1'),
		returnOperation('op3', 'root', 'coder', 'orchestrator', 't2', 't3', 'error'),
		returnOperation('op4', 'root', 'orchestrator', 'you', 't4', 't5', 'error'),
	],
	statuses: runningThenTerminal(4, 'error'),
}

const rawScenarios = [
	singleRoleCompletion,
	delegationChain,
	retryWithFreshInstance,
	deepCallTree,
	pendingQuestion,
	detectedLoopInterrupt,
	nestedInterrupt,
	nestedInterruptDeep,
	rewindFate,
	rewindMultiTerminate,
	terminateFate,
	errorReturn,
]

/**
 * The ordered demo scenarios, each materialized into a full InteractionModel frame sequence.
 *
 * @type {Scenario[]}
 */
export const scenarios = rawScenarios.map(buildScenario)

// The complete role and tool inventory the demo guild defines statically. The guild config lists every role up front — a run reveals which get called over time, so the sequence view must show every guild role as a column from frame 0 rather than growing the column set as participants first appear (peeking at a future frame to know which roles will be called would defeat the model's "the run reveals what happens" contract). A column may therefore carry no messages for an entire scenario; that is a guild role the run simply did not invoke. The 'human' and 'tools' columns are added by the view (human always present, tools collapsing every tool-kind participant), so this list carries only the real roles and tools.
export const GUILD_PARTICIPANTS = [
	participant('guild:orchestrator', 'orchestrator', 'role'),
	participant('guild:planner', 'planner', 'role'),
	participant('guild:coder', 'coder', 'role'),
	participant('guild:critic', 'critic', 'role'),
	participant('guild:loopDetector', 'loop_detector', 'role'),
	participant('guild:readFile', 'read_file', 'tool'),
	participant('guild:readMessageWindow', 'read_message_window', 'tool'),
	participant('guild:rewindStack', 'rewind_stack', 'tool'),
]
