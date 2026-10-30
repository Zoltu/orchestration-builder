// InteractionModel — the shared timeline both views read.
//
// The model is a chronologically ordered list of operations (calls, returns, observes, terminates) over a set of participants, plus a run status. It is neither a current-state graph nor an event stream: every "what is happening right now" question the two views need is answered by a pure helper over this list, so they never answer it independently and never drift.
//
// The single invariant the helpers encode: at most one operation is in flight in the active stack; observe and terminate never affect activity. The active stack is the stack of the latest operation, with two refinements: a freshly preempted stack (pushed by an interrupt, carrying no operations yet — the preemption itself is the latest activity) is active on arrival, and a resolved stack (its root call has returned) yields activity to the innermost stack still carrying open work, staying active only when no stack carries open work. The active participant is the destination of the active stack's current focus: an in-flight return's destination while its response leg travels, else the innermost open call's destination, else the stack's root when the stack has no operations yet. Every other stack that still carries open calls is paused — its in-flight operations stay in flight (the model never flips lifecycle on pause) and its lines do not animate.
//
// Interrupts spawn fresh call stacks rooted at a fresh Interrupt participant instance (instance-per-interrupt, like every role). A paused stack's fate (resuming / rewinding / terminating / terminated / active) is read off its own operations after the preemption point, never stored as a field — see fateOf.
//
// Invocations are keyed by identity: a call is open until a return names the same callId, parent links follow parentCallId, and callChainOf is the path from the stack root to the most recently started open leaf (siblings stay out of it, while openInvocationsOf returns them all). A model whose operations lack ids is malformed, not an older shape with different semantics.
//
// The module is browser-pure TypeScript (served statically and imported by the view modules) and imports nothing. The exported types are the contract the server-side adapter (source/web/interaction-model-adapter.ts) and the view modules' tests consume.
//
// The model carries no detail bodies: an operation's per-call markdown (task text, tool arguments/results, summaries) is fetched on demand from the run's details endpoint when the inspector opens, not shipped with every polled frame.

// 'human' is the You root and 'interrupt' is a per-interrupt root — both pseudo-roles. 'role' and 'tool' are real invocations.
export type ParticipantKind = 'human' | 'interrupt' | 'role' | 'tool'

// 'call'/'return' hand off activity between participants; 'observe' is a read-only cross-stack reference; 'terminate' is a destructive close where a tool reverts a target node — it pops the targeted open call (so the node is removed immediately and no separate 'terminated' return is needed for that call) but never hands off activity, so the active operation stays the interrupt's own call rather than the terminate. observe never affects activity and never enters a call chain; terminate affects call-chain structure but not activity.
export type OperationKind = 'call' | 'return' | 'observe' | 'terminate'

export type OperationLifecycle = 'in_flight' | 'settled'

// Only 'return' operations carry an outcome; a 'call' is null until it settles, and 'observe' and 'terminate' are always null.
export type OperationOutcome = 'success' | 'error' | 'terminated'

// Mirrors the executor RunMeta status with an 'unknown' fallback for a malformed or absent meta read.
export type RunStatus = 'running' | 'suspended' | 'success' | 'error' | 'needs_clarification' | 'interrupted' | 'unknown'

// The cause of a suspended pause, mirroring the executor's SuspensionCategory. The UI renders fixed copy per category and never the provider's endpoint, credentials, model, or response body.
export type SuspensionCategory = 'transient' | 'billing' | 'auth' | 'request_rejected' | 'unknown'

export type ResumePolicy = 'auto' | 'operator'

// The operator-safe suspension record a suspended run meta carries. `message` is platform-authored; the pause card uses the category's fixed copy instead of rendering provider detail.
export interface SuspensionRecord {
	category: SuspensionCategory
	resumePolicy: ResumePolicy
	message: string
	suspendedAt: string
	autoResumeAfter?: string
	resumeAttempts?: number
}

// The operator-initiated pause record a suspended run meta carries instead of a suspension. `message` is platform-authored; the pause card uses fixed operator copy rather than this field.
export interface OperatorPauseRecord {
	message: string
	pausedAt: string
}

export interface Participant {
	// Instance-scoped, unique per invocation — the flow-view node key. A role invoked twice carries two participants with distinct ids.
	id: string
	// The role or tool name; 'human' for the You root and 'interrupt' for interrupt roots. The sequence-view column key.
	role: string
	kind: ParticipantKind
	// The executor's role-instance id (a `role_start` payload's `roleId`, e.g. "coder-1-2"), carried by 'role'-kind participants when the producer supplies it. This is the identity the LLM-turn inspector scopes to, so a view click-through can map a flow participant to its transcript instance. Absent on pseudo-roles and tools (the log carries no instance ids for them) and on hand-authored models.
	roleId?: string
}

export interface OperationMetrics {
	// The invocation's total token bill (prompt + completion, the cached subset included). Null until a usage report folds into the call: a tool call, an ask_human call, or an agent call whose endpoint answered without usage carries null, never a fabricated zero — while a reported {0, 0} is endpoint data and stays numeric (source/executor/types.ts LlmUsagePayload).
	tokens: number | null
	// The full prompt bill; null under the same never-reported rule as tokens.
	promptTokens: number | null
	completionTokens: number | null
	// The prompt share the endpoint served from its prompt cache — a subset of promptTokens, never an additive bucket. Null until a usage that reports it folds in (the backend omits the field when unreported).
	cachedPromptTokens: number | null
	// The invocation's current context window size: the LAST LLM turn's promptTokens, overwriting on every folded usage — an assignment, not a sum, matching the executor's per-role lastPromptTokens (source/executor/engine.ts). Null under the same never-reported rule as the counters above.
	lastPromptTokens: number | null
	// Call start → matching return, or, on a terminal run, start → the run's stored end for a call that never returned (so a finished run's elapsed is frozen). Null while the invocation is still open on a non-terminal run: the server cannot report a clock-independent moving value, so the client fills it in from its own clock (withLiveElapsed). Also null on hand-authored models that carry no metrics.
	elapsedSeconds: number | null
}

export interface Operation {
	id: string
	kind: OperationKind
	// The stable invocation identity. Calls and their closing returns share it, so a return closes exactly the call it names rather than the most recent open call. Observe and terminate affect no invocation, so they carry their own operation id here.
	callId: string
	// The invocation that caused this call (the log's parentCallId field). Calls only; a root call has none.
	parentCallId?: string
	// The call-stack id this operation belongs to. The active stack is the stack of the latest operation.
	stack: string
	// The participant id the operation originates from. For 'observe' and 'terminate' this may sit in a different (active) stack than destination — a tool in the active stack reaches across into a paused stack.
	source: string
	// The participant id the operation is addressed to. Never equals source for 'call'/'return'.
	destination: string
	startedAt: string
	// null while in_flight; equals startedAt for 'observe' and 'terminate' because both are instantaneous.
	settledAt: string | null
	lifecycle: OperationLifecycle
	// Set on 'return' only; null for 'call', 'observe', and 'terminate'.
	outcome: OperationOutcome | null
	metrics: OperationMetrics | null
}

export interface StackRecord {
	id: string
	// The stack's root participant id (the You root or an Interrupt instance).
	root: string
}

export interface InteractionModel {
	// Chronological first-appearance order.
	participants: Participant[]
	// Chronological; the index is the sequence-view row.
	operations: Operation[]
	status: RunStatus
	// The operator pause record when the suspended status is an operator pause; absent or null for provider suspensions and every non-suspended status.
	pause?: OperatorPauseRecord | null
	// Stack roots in push order (oldest first), emitted by producers that track stack pushes (the backend adapter). A freshly preempted stack has no operations yet, so operations alone cannot name it. When absent (hand-authored models), the helpers derive stack structure from operations and a zero-operation stack renders nothing.
	stacks?: StackRecord[]
}

// isTerminalStatus keeps its `string` parameter on purpose: every caller hands it an unvalidated status string (a polled summary's status field, a scenario status), never a value proven to be a RunStatus.
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['success', 'error', 'needs_clarification', 'interrupted'])

// Returns whether a run status is terminal — the run will produce no more activity, so clients stop polling it and the result affordance may open. Shared by every client surface (product client, dev harness, view modules) so the terminal set is defined once, next to the RunStatus type it reads.
export function isTerminalStatus(status: string): boolean {
	return TERMINAL_STATUSES.has(status)
}

// A suspended run is a durable pause, not a terminal outcome: it has a resume/terminate path and no result card. Keeping this distinct from isTerminalStatus keeps result surfaces from treating a pause as a finished run.
export function isSuspendedStatus(status: string): boolean {
	return status === 'suspended'
}

// Only a running run has live activity (tokens, flow motion, a per-run stream). A pause, a terminal outcome, and the unknown shape all read as not live here.
export function isLiveStatus(status: string): boolean {
	return status === 'running'
}

// A run whose per-run poll and stream may stop while the run-list, queue, and health polls continue: terminal outcomes and the suspended pause. A null status (a just-selected run whose first read has not landed) is not settled.
export function isSettledForPolling(status: string): boolean {
	return isTerminalStatus(status) || isSuspendedStatus(status)
}

interface DerivedStack {
	chains: Map<string, Operation[]> | undefined
	active: string | undefined
	stackIds: string[] | undefined
	records: StackRecord[] | undefined
	callMetrics: Map<string, OperationMetrics> | undefined
	identityGraph: IdentityGraph | undefined
}

// The id-keyed model: the open calls per stack (siblings included), the active path per stack (root to the most recently started open leaf, following parentCallId), and the call lookup the path walk needs. Built once per model.
interface IdentityGraph {
	openByStack: Map<string, Operation[]>
	chainByStack: Map<string, Operation[]>
	callByKey: Map<string, Operation>
	parentOfKey: Map<string, string | undefined>
	indexByKey: Map<string, number>
	ignoredReturnIds: Set<string>
}

// The helpers re-derive the same whole-model structures (the open-call graph, the derived stack records, the active stack, the row list) several times per poll; the model object is never mutated in place and is replaced only when its data changes, so an unchanged poll keeps the same object by reference and a WeakMap keyed on model identity caches each structure on first request: every helper reads the same derivation instead of replaying the operation list per call, and an entry is dropped with its model on run switch. The undefined slots mean "not derived yet"; a cached value is never mutated afterwards, so readers may hold it without copying.
const derivedByModel = new WeakMap<object, DerivedStack>()

function derivedOf(model: InteractionModel): DerivedStack {
	let derived = derivedByModel.get(model)
	if (derived !== undefined) return derived
	derived = { chains: undefined, active: undefined, stackIds: undefined, records: undefined, callMetrics: undefined, identityGraph: undefined }
	derivedByModel.set(model, derived)
	return derived
}

function removeOpenCall(openCalls: Operation[], callId: string): void {
	const index = openCalls.findIndex((call) => call.callId === callId)
	if (index >= 0) openCalls.splice(index, 1)
}

// Builds the id-keyed open-call tree and the active path per stack. A call is open while no return carries its callId; the first return wins, so a duplicate terminal is ignored. A terminate removes the call whose destination it targets. The active path starts at the most recently started open leaf (an open call with no open child) and walks parentCallId back to the stack root, so siblings never enter it.
function identityGraphOf(model: InteractionModel): IdentityGraph {
	const derived = derivedOf(model)
	if (derived.identityGraph !== undefined) return derived.identityGraph
	const openByStack = new Map<string, Operation[]>()
	const callByKey = new Map<string, Operation>()
	const parentOfKey = new Map<string, string | undefined>()
	const callIndexByKey = new Map<string, number>()
	const closedKeys = new Set<string>()
	const ignoredReturnIds = new Set<string>()
	model.operations.forEach((operation, index) => {
		if (operation.kind === 'call') {
			const key = operation.callId
			// A duplicate start for the same callId is ignored: the first start owns the invocation.
			if (callByKey.has(key)) return
			callByKey.set(key, operation)
			callIndexByKey.set(key, index)
			parentOfKey.set(key, operation.parentCallId)
			if (closedKeys.has(key)) return
			let open = openByStack.get(operation.stack)
			if (open === undefined) {
				open = []
				openByStack.set(operation.stack, open)
			}
			open.push(operation)
			return
		}
		if (operation.kind === 'return') {
			if (closedKeys.has(operation.callId)) {
				ignoredReturnIds.add(operation.id)
				return
			}
			closedKeys.add(operation.callId)
			const call = callByKey.get(operation.callId)
			if (call === undefined) return
			let open = openByStack.get(call.stack)
			if (open === undefined) {
				open = []
				openByStack.set(call.stack, open)
			}
			removeOpenCall(open, operation.callId)
			return
		}
		if (operation.kind === 'terminate') {
			for (const open of openByStack.values()) {
				let removed = false
				for (let candidateIndex = open.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
					const candidate = open[candidateIndex]
					if (candidate === undefined) continue
					if (candidate.destination !== operation.destination) continue
					open.splice(candidateIndex, 1)
					removed = true
					break
				}
				if (removed) break
			}
		}
	})
	const chainByStack = new Map<string, Operation[]>()
	for (const [stackId, openCalls] of openByStack) {
		chainByStack.set(stackId, activeChainOfStack(stackId, openCalls, callByKey, parentOfKey, callIndexByKey))
	}
	const graph: IdentityGraph = { openByStack, chainByStack, callByKey, parentOfKey, indexByKey: callIndexByKey, ignoredReturnIds }
	derived.identityGraph = graph
	return graph
}

function activeChainOfStack(stackId: string, openCalls: Operation[], callByKey: Map<string, Operation>, parentOfKey: Map<string, string | undefined>, callIndexByKey: Map<string, number>): Operation[] {
	const openKeys = new Set(openCalls.map((call) => call.callId))
	let active: Operation | undefined
	let activeIndex = -1
	for (const call of openCalls) {
		const key = call.callId
		let hasOpenChild = false
		for (const candidateKey of openKeys) {
			if (parentOfKey.get(candidateKey) === key) {
				hasOpenChild = true
				break
			}
		}
		if (hasOpenChild) continue
		const index = callIndexByKey.get(key) ?? -1
		if (index <= activeIndex) continue
		active = call
		activeIndex = index
	}
	// A cycle or malformed tree can leave every open call with a child; the latest open call is still the most useful focus.
	if (active === undefined) active = openCalls[openCalls.length - 1]
	if (active === undefined) return []
	const chain: Operation[] = []
	const seen = new Set<string>()
	let current: Operation | undefined = active
	while (current !== undefined) {
		const key = current.callId
		if (seen.has(key)) break
		seen.add(key)
		chain.push(current)
		const parentKey = parentOfKey.get(key)
		if (parentKey === undefined) break
		// A closed parent is not part of the open path: stop rather than carrying a stale ancestor into the chain.
		if (!openKeys.has(parentKey)) break
		const parent = callByKey.get(parentKey)
		if (parent === undefined || parent.stack !== stackId) break
		current = parent
	}
	return chain.reverse()
}

// The stack records the helpers read: the model's own records when present, else a derivation from operations (first-appearance order; the root is the stack's first operation's source, which for any well-formed model is its root call's source). A zero-operation stack exists only in the model's own records — operations cannot name it.
function stackRecordsOf(model: InteractionModel): StackRecord[] {
	if (model.stacks !== undefined) return model.stacks
	const derived = derivedOf(model)
	if (derived.records !== undefined) return derived.records
	const records: StackRecord[] = []
	const seen = new Set<string>()
	for (const operation of model.operations) {
		if (seen.has(operation.stack)) continue
		seen.add(operation.stack)
		records.push({ id: operation.stack, root: operation.source })
	}
	derived.records = records
	return records
}

function stackRecordOf(model: InteractionModel, stackId: string): StackRecord | undefined {
	for (const record of stackRecordsOf(model)) {
		if (record.id === stackId) return record
	}
	return undefined
}

// Returns the active stack id, or null for a model with no operations. The active stack is the stack of the latest operation, whatever its kind — so an observe or terminate logged on a paused stack does not steal activity — with two refinements: a freshly preempted stack (the newest stack record carries no operations yet; the preemption itself is the latest activity) is active on arrival, and a resolved stack (its open chain is empty because its root call has returned) yields activity to the innermost stack still carrying open work, staying active only when no stack carries open work (its final return's destination remains the focus).
export function activeStack(model: InteractionModel): string | null {
	if (model.operations.length === 0) return null
	const derived = derivedOf(model)
	if (derived.active !== undefined) return derived.active
	derived.active = computeActiveStack(model)
	return derived.active
}

// The body of activeStack, run at most once per model; the caller guarantees a non-empty operation list.
function computeActiveStack(model: InteractionModel): string {
	const records = stackRecordsOf(model)
	const newest = records[records.length - 1]
	if (newest !== undefined && !model.operations.some((operation) => operation.stack === newest.id)) {
		return newest.id
	}
	const latestOperation = model.operations[model.operations.length - 1]
	if (latestOperation === undefined) throw new Error('activeStack invariant violated: the operation list is empty')
	const candidate = latestOperation.stack
	const chains = openCallsByStack(model)
	const candidateChain = chains.get(candidate)
	if (candidateChain === undefined || candidateChain.length > 0) return candidate
	for (let index = records.length - 1; index >= 0; index -= 1) {
		const record = records[index]
		if (record === undefined) continue
		const chain = chains.get(record.id)
		if (chain !== undefined && chain.length > 0) return record.id
	}
	return candidate
}

// Returns the operation the active stack is currently focused on: the active stack's latest call or return — its destination is the focus (the caller while a return leg travels or has just landed, the current worker otherwise) — or null when the active stack carries no call or return at all (a freshly preempted stack with no operations yet, or a stack whose only operations are observes/terminates). When the latest activity operation is a call that is no longer open (killed by a terminate or abandoned by a torn read), the live innermost open call is the focus instead of the dead call. This is the single "what is in flight right now" answer both views read: the model invariant guarantees at most one in-flight operation per stack, so the focused operation is exactly the operation whose line animates (when in_flight) and whose destination pulses. 'observe' and 'terminate' are skipped because neither affects activity — a terminate closes a call but does not hand the active role to anyone.
export function activeOperation(model: InteractionModel): Operation | null {
	const stack = activeStack(model)
	if (stack === null) return null
	// The open chain is independent of where the scan below stops, so it is read once from the memoized graph and the scan selects against it, instead of rebuilding the chain for every candidate.
	const chain = callChainOf(model, stack)
	const graph = identityGraphOf(model)
	const chainCallIds = new Set<string>()
	for (const call of chain) chainCallIds.add(call.callId)
	const activeLeaf = chain[chain.length - 1]
	const activeLeafIndex = activeLeaf === undefined ? -1 : (graph.indexByKey.get(activeLeaf.callId) ?? -1)
	for (let index = model.operations.length - 1; index >= 0; index -= 1) {
		const operation = model.operations[index]
		if (operation === undefined) continue
		if (operation.stack !== stack) continue
		if (operation.kind === 'observe' || operation.kind === 'terminate') continue
		if (operation.kind === 'return') {
			if (graph.ignoredReturnIds.has(operation.id)) continue
			const callId = operation.callId
			// A return focuses the active path when it closed the path itself, the root, or the leaf the path just moved back from (a call started after the now-active leaf). An unrelated sibling that started earlier stays out of focus.
			if (chainCallIds.has(callId)) return operation
			if (chain.length === 0) return operation
			const closed = graph.callByKey.get(callId)
			const closedIndex = graph.indexByKey.get(callId) ?? -1
			if (closed === undefined) continue
			if (closedIndex > activeLeafIndex) return operation
			continue
		}
		for (const call of chain) {
			if (call.id === operation.id) return operation
		}
	}
	return chain[chain.length - 1] ?? null
}

// Returns the destination of the active stack's current focus (see activeOperation), or null when there is no active stack. A freshly preempted stack has no call or return yet: its root is the current worker while the preempting party readies its first act.
export function activeParticipant(model: InteractionModel): string | null {
	const operation = activeOperation(model)
	if (operation !== null) return operation.destination
	const stack = activeStack(model)
	if (stack === null) return null
	const record = stackRecordOf(model, stack)
	return record === undefined ? null : record.root
}

// Returns the open calls per stack id. A call is open while no return names its callId, siblings stay siblings, and a terminate removes the call whose destination it targets. A return closes a call regardless of outcome, so the chain reflects "still open" rather than "still succeeding". 'observe' is ignored — it never enters a call chain.
function openCallsByStack(model: InteractionModel): Map<string, Operation[]> {
	const derived = derivedOf(model)
	if (derived.chains !== undefined) return derived.chains
	derived.chains = identityGraphOf(model).openByStack
	return derived.chains
}

// The latest activity-affecting operation on a stack (a 'call' or 'return'), or undefined when the stack carries only observes/terminates (or nothing). stacksOf uses this to detect a lingering in_flight return leg on an otherwise-empty stack, and the flow view's row projection uses the same rule to decide whether the stack still renders a row. observe and terminate are skipped because neither affects activity, so an operation of theirs logged after an in_flight return must not hide the lingering return leg (a terminate closes its own targeted call but does not settle the active stack's in_flight return).
function latestActivityOperationOnStack(model: InteractionModel, stackId: string): Operation | undefined {
	const ignoredReturns = identityGraphOf(model).ignoredReturnIds
	for (let index = model.operations.length - 1; index >= 0; index -= 1) {
		const operation = model.operations[index]
		if (operation === undefined) continue
		if (operation.stack !== stackId) continue
		if (operation.kind === 'observe' || operation.kind === 'terminate') continue
		if (ignoredReturns.has(operation.id)) continue
		return operation
	}
	return undefined
}

// Returns the stack ids that still render a row in push order (oldest first). Rows never reorder as activity moves — the main run stays the top row and each preempting interrupt stays below it in preemption order; the active stack is conveyed by the pulsing node and marching lines, not by row position. A stack renders a row while it carries an open call, or — once its chain is empty — while its latest activity-affecting operation is an in_flight return (a lingering response leg the view draws until the return settles). A freshly preempted stack — pushed by an interrupt but carrying no operations yet — also renders a row holding just its root; operations alone cannot name such a stack, so only stack records reveal it (a producer that does not emit records renders nothing for it).
export function stacksOf(model: InteractionModel): string[] {
	const derived = derivedOf(model)
	if (derived.stackIds !== undefined) return derived.stackIds
	const chains = openCallsByStack(model)
	const records = stackRecordsOf(model)
	const orderByStack = new Map<string, number>()
	records.forEach((record, index) => orderByStack.set(record.id, index))
	const open: string[] = []
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
	derived.stackIds = open
	return open
}

// Returns the active call path of a stack in call order (outermost first): the path from the stack root to the most recently started open leaf, following parentCallId, so siblings are excluded even while open. Calls whose return has already appeared are absent, as are calls closed by a terminate. 'observe' never appears here.
export function callChainOf(model: InteractionModel, stackId: string): Operation[] {
	const chain = identityGraphOf(model).chainByStack.get(stackId)
	if (chain === undefined) return []
	return chain.slice()
}

// Returns every open call on a stack in start order, siblings included. The flow view renders these (a sibling is a real node beside its parent's other children, not an ancestor of the next call); callChainOf remains the narrower active path.
export function openInvocationsOf(model: InteractionModel, stackId: string): Operation[] {
	const calls = openCallsByStack(model).get(stackId)
	if (calls === undefined) return []
	return calls.slice()
}

// Sums the per-call metrics by destination participant id — the callee's own cost for each invocation. The backend adapter attaches metrics to call operations only (a call's metrics accumulate its destination's LLM spend while the call is open, discarded retry attempts included) and carries none on returns, so every per-participant cost read — flow-node cost lines, the top-bar strip, the role tooltips — reads the incoming call, never the return, and a read that pairs both would double count. Each adapter call targets a distinct participant instance (instance-per-invocation), so the map holds one entry per participant in practice; the sum keeps hand-authored models that point several calls at one participant honest. Each counter sums its non-null contributions and stays null when no call reported that counter — except lastPromptTokens, whose assignment semantics take the latest reported value (the destination's current context window size), never a sum.
export function callMetricsByDestination(model: InteractionModel): Map<string, OperationMetrics> {
	const derived = derivedOf(model)
	if (derived.callMetrics !== undefined) return derived.callMetrics
	const metrics = new Map<string, OperationMetrics>()
	for (const operation of model.operations) {
		if (operation.kind !== 'call') continue
		const contribution = operation.metrics
		if (contribution === null) continue
		const accumulated = metrics.get(operation.destination)
		metrics.set(operation.destination, {
			tokens: sumCounter(accumulated?.tokens, contribution.tokens),
			promptTokens: sumCounter(accumulated?.promptTokens, contribution.promptTokens),
			completionTokens: sumCounter(accumulated?.completionTokens, contribution.completionTokens),
			cachedPromptTokens: sumCounter(accumulated?.cachedPromptTokens, contribution.cachedPromptTokens),
			lastPromptTokens: latestCounter(accumulated?.lastPromptTokens, contribution.lastPromptTokens),
			elapsedSeconds: sumCounter(accumulated?.elapsedSeconds, contribution.elapsedSeconds),
		})
	}
	derived.callMetrics = metrics
	return metrics
}

function sumCounter(accumulated: number | null | undefined, contribution: number | null): number | null {
	if (contribution === null) return accumulated ?? null
	return (accumulated ?? 0) + contribution
}

// The assignment counterpart of sumCounter for lastPromptTokens: operations fold in chronological order, so a reported contribution overwrites whatever earlier calls reported and a null contribution leaves the latest reported value standing.
function latestCounter(accumulated: number | null | undefined, contribution: number | null): number | null {
	if (contribution !== null) return contribution
	return accumulated ?? null
}

// The whole seconds between an ISO timestamp and a caller-supplied now (epoch milliseconds), rounded like the server's settled-span arithmetic and clamped at 0 so a client clock behind the server never yields a negative duration. Null when the timestamp does not parse.
export function secondsBetweenIso(timestamp: string, nowMs: number): number | null {
	const then = Date.parse(timestamp)
	if (Number.isNaN(then)) return null
	return Math.max(0, Math.round((nowMs - then) / 1000))
}

// Returns a model whose call operations with a null elapsedSeconds carry the live span from their start to `nowMs`: the server leaves a running call's elapsedSeconds null because a clock-independent payload cannot report a moving value, so the client fills it here from its own clock, while a terminal run's calls already carry the stored span to the run's end and are left untouched. Only call operations are touched — returns never carry metrics (callMetricsByDestination's calls-only contract) — and a call that already reports a span keeps it. A model with nothing to fill is returned unchanged by reference, so the per-model memoization every view helper relies on survives each settled frame.
export function withLiveElapsed(model: InteractionModel, nowMs: number): InteractionModel {
	let changed = false
	const operations = model.operations.map((operation) => {
		if (operation.kind !== 'call') return operation
		const metrics = operation.metrics
		if (metrics === null || metrics.elapsedSeconds !== null) return operation
		const elapsedSeconds = secondsBetweenIso(operation.startedAt, nowMs)
		if (elapsedSeconds === null) return operation
		changed = true
		return { ...operation, metrics: { ...metrics, elapsedSeconds } }
	})
	if (!changed) return model
	return { ...model, operations }
}

// True when the stack is not the active stack and still carries open calls. A paused stack's in-flight operations stay in flight (the model never flips lifecycle on pause); this helper is the rule the view reads to freeze a paused stack's lines without touching the model.
export function isPaused(model: InteractionModel, stackId: string): boolean {
	if (activeStack(model) === stackId) return false
	const chain = openCallsByStack(model).get(stackId)
	return chain !== undefined && chain.length > 0
}

// The latest contiguous run of operations on a stack — the stack's current phase, ending at its most recent operation. For a paused stack this is the block it produced after the preempting stack's final return and before it was paused again; fateOf reads the fate off it. Observes are logged on the active stack, so they never split a paused stack's phase.
function latestContiguousBlockOnStack(model: InteractionModel, stackId: string): Operation[] {
	const operations = model.operations
	let endIndex = -1
	for (let index = operations.length - 1; index >= 0; index -= 1) {
		const operation = operations[index]
		if (operation !== undefined && operation.stack === stackId) {
			endIndex = index
			break
		}
	}
	if (endIndex === -1) return []
	let startIndex = endIndex
	for (let index = endIndex - 1; index >= 0; index -= 1) {
		const operation = operations[index]
		if (operation === undefined || operation.stack !== stackId) break
		startIndex = index
	}
	return operations.slice(startIndex, endIndex + 1)
}

// The fate of a stack, as fateOf returns it.
type StackFate = 'resuming' | 'rewinding' | 'terminating' | 'terminated' | 'active'

// Returns the fate of a stack, read off its own operations after the preemption point rather than stored as a field. The fates are:
// - 'active' — the stack is the active stack.
// - 'terminated' — the stack has no open calls remaining (fully closed).
// - 'resuming' — paused, and its current phase shows no in-progress teardown or rewind: either no terminated returns, or a rewind whose restart call has already been followed by normal work (the rewind completed and the stack resumed). A freshly paused stack with no post-preemption operations yet lands here too, since there is no evidence of termination.
// - 'terminating' — paused, and its current phase ends in terminated returns with no restart call after them (calls are being closed toward the root). A fresh teardown that began after a completed rewind (terminated returns in the post-restart tail) also lands here.
// - 'rewinding' — paused, and its current phase's latest operation is a rewind's restart call: a call immediately preceded by terminated returns, with no normal work following it yet. An ancestor restarted a leg after backing out, and the restart has not yet produced normal work. Once normal work follows the restart call, the rewind is complete and the stack reads 'resuming'.
//
// The rewind is identified by its restart call — the call that immediately follows a terminated return — and read off only the tail after the last such restart, so a stack that rewound and then resumed normal nested calls before being re-paused reads 'resuming' (the rewind is done) rather than 'rewinding'. Scanning the whole phase for "any terminated return plus any call" would let the rewind's terminated returns outweigh the later normal work and mislabel a completed rewind as in-progress.
export function fateOf(model: InteractionModel, stackId: string): StackFate {
	if (activeStack(model) === stackId) return 'active'
	if (callChainOf(model, stackId).length === 0) return 'terminated'
	const phase = latestContiguousBlockOnStack(model, stackId)
	let lastRestartIndex = -1
	let phaseHasTerminatedReturn = false
	for (let index = 0; index < phase.length; index += 1) {
		const operation = phase[index]
		if (operation === undefined) continue
		if (operation.kind === 'return' && operation.outcome === 'terminated') {
			phaseHasTerminatedReturn = true
		} else if (operation.kind === 'call' && index > 0) {
			const previous = phase[index - 1]
			if (previous !== undefined && previous.kind === 'return' && previous.outcome === 'terminated') lastRestartIndex = index
		}
	}
	if (lastRestartIndex === -1) {
		if (phaseHasTerminatedReturn) return 'terminating'
		return 'resuming'
	}
	if (lastRestartIndex === phase.length - 1) return 'rewinding'
	for (let index = lastRestartIndex + 1; index < phase.length; index += 1) {
		const operation = phase[index]
		if (operation !== undefined && operation.kind === 'return' && operation.outcome === 'terminated') return 'terminating'
	}
	return 'resuming'
}

// Returns the observe operations in chronological order. An observe spans stacks — its source sits in the active stack and its destination in a paused stack — so the sequence view draws these as static cross-stack lines that never animate and never enter any call chain.
export function observesOf(model: InteractionModel): Operation[] {
	return model.operations.filter((operation) => operation.kind === 'observe')
}

// Returns the terminate operations in chronological order. A terminate is a destructive close: a rewind tool in the active stack reverts a target node in a paused stack, so the view draws a red dotted line from the tool to the target and an orange dotted border on the target for the single frame the terminate is the latest operation; the next frame the target is gone (the terminate closed its call). Like observe, a terminate spans stacks, never animates, and never affects activity — but unlike observe it closes the targeted call (pops it from the open chain) without handing activity to anyone, so the node is removed immediately and no separate 'terminated' return is needed for that call.
export function terminatesOf(model: InteractionModel): Operation[] {
	return model.operations.filter((operation) => operation.kind === 'terminate')
}

// --- Roles-only filter --------------------------------------------------------
// The sequence view's roles-only lens (the toggle next to the flow/sequence controls): a filtered copy of the model whose columns collapse to the agent roles plus the human, so the operator can read the delegation story without the tool traffic. Both shells (product client and dev harness) consume these helpers; the filter is a view lens, never a model mutation — the original model is untouched and the next filter-off render reads the full frame again.

// The participant kinds the roles-only filter keeps: 'role' (a real agent invocation) and 'human' (the You root and the asker/answerer instances — the human side of the story stays). The 'tool' kind and the 'interrupt' pseudo-role drop, so the sequence columns collapse to agent roles plus the human.
function isRolesOnlyKind(kind: ParticipantKind): boolean {
	return kind === 'role' || kind === 'human'
}

// Filters a participant list to the roles-only column set (agent roles plus the human), preserving order. Shared by the model filter below and by the callers that feed the sequence view its static guild participant inventory (whose tools would otherwise keep the tools column alive), so the kind rule lives in exactly one place. The array guard holds because the callers are plain-JS modules handing over whatever they hold.
export function rolesOnlyParticipants(participants: readonly Participant[]): Participant[] {
	if (!Array.isArray(participants)) return []
	return participants.filter((participant) => isRolesOnlyKind(participant.kind))
}

// Returns a filtered copy of the model for the sequence view's roles-only toggle: participants collapse to agent roles plus the human, and an operation survives only when every participant it references survives — a tool-sourced observe, a terminate, and every tool call/return leg drop with the tool column, while the agent↔agent and agent↔human call chains (including the ask_human exchange with its human answerer) stay readable. Stack records drop with their roots, keeping the filtered model internally consistent; the run status passes through untouched.
//
// The filter is a pure lens, not a projection the activity rule re-derives: the filtered model answers "what is happening right now" from its own surviving operations, so a hidden tool leg reads as a quiet role world — which is honest for a view that hides tool traffic. Filtering an already-filtered model is an identity (idempotence), so double-applying the toggle cannot corrupt a frame.
export function rolesOnlyModel(model: InteractionModel): InteractionModel {
	const participants = rolesOnlyParticipants(model.participants)
	const keptIds = new Set(participants.map((participant) => participant.id))
	const operations = model.operations.filter((operation) => keptIds.has(operation.source) && keptIds.has(operation.destination))
	const stacks = model.stacks === undefined ? undefined : model.stacks.filter((record) => keptIds.has(record.root))
	return { participants, operations, status: model.status, stacks }
}
