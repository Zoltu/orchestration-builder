// Label localization registry + tier resolver.
//
// The InteractionModel carries only role/kind identifiers — no prose. This module is the single source of short display prose for the views: a participant-label table keyed by role/kind, an operation-label table keyed by kind plus a source-kind→destination-kind discriminator, and a resolver that interpolates source/destination participant labels into the chosen operation template.
//
// Three tiers serve different audiences: 'fun' is playful (children/playful users) and may sacrifice precision, 'helpful' is informative-but-imprecise for non-technical users, 'detailed' is precise for technical users. A tier toggle in the harness swaps which tier the views render without touching the model — a view concern, like locale switching. The per-call 'details' markdown on each Operation is runtime data the adapter formats, not localization, so it is untouched here.
//
// The fallback chain is detailed → helpful → fun: when a guild author omits the requested tier, the resolver walks toward less-precise tiers rather than producing empty prose, and a participant with no entry at all falls back to the title-cased role name. The registry is a data literal; the resolver is a small pure function over it.
//
// The module is browser-pure JS (served statically and imported by the view modules) and imports nothing. JSDoc typedefs carry the shapes the TS tests assert against, mirroring the sibling interaction-model.js convention.

/**
 * @typedef {'fun' | 'helpful' | 'detailed'} LabelTier
 *   'fun' is playful and may sacrifice precision; 'helpful' is informative for non-technical users; 'detailed' is precise for technical users.
 */

/**
 * @typedef {Object} Participant
 * @property {string} id
 * @property {string} role
 * @property {'human' | 'interrupt' | 'role' | 'tool'} kind
 */

/**
 * @typedef {Object} Operation
 * @property {string} id
 * @property {'call' | 'return' | 'observe' | 'terminate'} kind
 * @property {string} stack
 * @property {string} source
 * @property {string} destination
 * @property {string} startedAt
 * @property {string | null} settledAt
 * @property {'in_flight' | 'settled'} lifecycle
 * @property {'success' | 'error' | 'terminated' | null} outcome
 * @property {string | null} details
 * @property {Object | null} metrics
 */

/**
 * @typedef {Object} TieredLabel
 * @property {string} [fun]
 * @property {string} [helpful]
 * @property {string} [detailed]
 *   A label entry may omit any tier; the resolver falls back detailed → helpful → fun when the requested tier is absent.
 */

// Ordered from most-precise to least-precise so the fallback walk goes toward less-precise tiers: a missing 'detailed' falls to 'helpful', a missing 'helpful' falls to 'fun', and a missing 'fun' has nothing less-precise to fall to (the caller supplies an ultimate fallback).
const TIER_FALLBACK_ORDER = ['detailed', 'helpful', 'fun']

// Operation templates interpolate the resolved participant labels of their source and destination via these placeholders, keeping the registry pure data and the interpolation a single replace in the resolver.
const SOURCE_PLACEHOLDER = '{source}'
const DESTINATION_PLACEHOLDER = '{destination}'

/**
 * Participant labels keyed by role. The demo guild's roles (orchestrator, planner, coder, critic, context_manager, recovery) and tools plus the loop_detector role used by the demo scenarios are all seeded here, alongside the 'human' and 'interrupt' pseudo-roles. 'fun' entries are deliberately playful (chef/baker-style for playful users); 'detailed' entries are precise identifiers for technical users.
 *
 * Roles and the 'human' pseudo-role carry all three tiers. Tools and the 'interrupt' pseudo-role ship only {fun, detailed}: a tool or pseudo-role name has no informative-but-imprecise middle voice distinct from the playful one, so the 'helpful' tier falls back to 'fun' for them, while a role like 'orchestrator' does have a plain informative name worth its own 'helpful' value.
 *
 * @type {Record<string, TieredLabel>}
 */
const participantLabels = {
	human: { fun: 'You', helpful: 'You', detailed: 'You (human)' },
	interrupt: { fun: 'The Doorbell', detailed: 'interrupt (pseudo-role)' },
	// The shared "tools" column collapses every tool participant into one lifeline, so it has no single participant to resolve against; this entry gives the column a localized header the same registry every other column reads.
	tools: { fun: 'The Toolbelt', helpful: 'Tools', detailed: 'tools' },

	orchestrator: { fun: 'The Conductor', helpful: 'Orchestrator', detailed: 'orchestrator' },
	planner: { fun: 'The Mapmaker', helpful: 'Planner', detailed: 'planner' },
	coder: { fun: 'The Builder', helpful: 'Coder', detailed: 'coder' },
	critic: { fun: 'The Nitpicker', helpful: 'Critic', detailed: 'critic' },
	context_manager: { fun: 'The Librarian', helpful: 'Context Manager', detailed: 'context_manager' },
	// 'detailed' is deliberately omitted to document the detailed → helpful fallback: a guild author who ships only the playful and informative tiers still gets a readable line at the technical tier.
	recovery: { fun: 'The Fixer', helpful: 'Recovery' },
	// 'detailed' is omitted on top of the tool-default 'helpful' omission, so requesting 'detailed' walks the full chain detailed → helpful → fun and lands on 'fun', proving the resolver walks past every absent tier rather than stopping at the first gap.
	edit_context: { fun: 'The Memory Editor' },
	loop_detector: { fun: 'The Loop Sniffer', helpful: 'Loop Detector', detailed: 'loop_detector' },

	agent: { fun: 'The Errand Runner', detailed: 'agent (tool)' },
	finish: { fun: 'The Finish Line', detailed: 'finish (tool)' },
	ask_human: { fun: 'The Question Box', detailed: 'ask_human (tool)' },
	list_directory: { fun: 'The Folder Peek', detailed: 'list_directory (tool)' },
	glob_files: { fun: 'The File Hunt', detailed: 'glob_files (tool)' },
	read_file: { fun: 'The Page Turner', detailed: 'read_file (tool)' },
	read_file_partial: { fun: 'The Snippet Grabber', detailed: 'read_file_partial (tool)' },
	search_text: { fun: 'The Word Hound', detailed: 'search_text (tool)' },
	write_file: { fun: 'The Scribe', detailed: 'write_file (tool)' },
	fetch_url: { fun: 'The Web Wanderer', detailed: 'fetch_url (tool)' },
	typecheck: { fun: 'The Grammar Grader', detailed: 'typecheck (tool)' },
	test: { fun: 'The Prover', detailed: 'test (tool)' },
	read_message_window: { fun: 'The Message Snoop', detailed: 'read_message_window (tool)' },
	context_info: { fun: 'The Memory Peek', detailed: 'context_info (tool)' },
	// The rewind tool the loop_detector invokes to revert looping rows; ships only {fun, detailed} like every tool, so the helpful tier falls back to the playful one.
	rewind_stack: { fun: 'The Rewinder', detailed: 'rewind_stack (tool)' },
	terminate_task: { fun: 'The Eraser', detailed: 'terminate_task (tool)' },
}

// Operation templates keyed by kind, then by a `${sourceKind}->${destinationKind}` discriminator built from the participants the operation spans. Each entry interpolates {source} and {destination} with the resolved participant labels at the chosen tier, so the model never carries display prose. Discriminators cover every combination the demo scenarios produce; an unmatched discriminator falls back to the per-kind generic entry below.
/**
 * @type {Record<'call' | 'return' | 'observe' | 'terminate', Record<string, TieredLabel>>}
 */
const operationLabels = {
	call: {
		'human->role': { fun: '{source} hand the quest to {destination}', helpful: '{source} ask {destination} to start', detailed: 'call {source} → {destination}' },
		'role->role': { fun: '{source} pass the baton to {destination}', helpful: '{source} delegate to {destination}', detailed: 'call {source} → {destination}' },
		'role->tool': { fun: '{source} grab the {destination} gadget', helpful: '{source} use {destination}', detailed: '{source} invoked tool {destination}' },
		'role->human': { fun: '{source} tug {destination}\'s sleeve with a question', helpful: '{source} ask {destination} for input', detailed: '{source} requested human input from {destination}' },
		'interrupt->role': { fun: '{source} butt in on {destination}', helpful: '{source} interrupt {destination}', detailed: '{source} preempted {destination}' },
		'interrupt->tool': { fun: '{source} grab the {destination} gadget', helpful: '{source} use {destination}', detailed: '{source} invoked tool {destination}' },
	},
	return: {
		'role->role': { fun: '{source} give {destination} a thumbs-up', helpful: '{source} return to {destination}', detailed: 'return {source} → {destination}' },
		'tool->role': { fun: '{source} report back to {destination}', helpful: '{source} return result to {destination}', detailed: 'tool {source} returned to {destination}' },
		'role->human': { fun: '{source} report the answer to {destination}', helpful: '{source} return to {destination}', detailed: 'return {source} → {destination}' },
		'role->interrupt': { fun: '{source} wrap up for {destination}', helpful: '{source} return to {destination}', detailed: 'return {source} → {destination}' },
		'tool->interrupt': { fun: '{source} report back to {destination}', helpful: '{source} return result to {destination}', detailed: 'tool {source} returned to {destination}' },
	},
	observe: {
		'role->role': { fun: '{source} peek at {destination}', helpful: '{source} observe {destination}', detailed: 'observe {source} → {destination}' },
	},
	terminate: {
		// A rewind tool reverts a target node in a paused stack; the source is the tool and the destination is the target role, so 'tool->role' is the only discriminator the demo scenarios produce.
		'tool->role': { fun: '{source} zap {destination}', helpful: '{source} rewind {destination}', detailed: 'terminate {source} → {destination}' },
	},
}

// Per-kind generic entries used when no discriminator matches, so an authored scenario that introduces an unseeded participant-kind pair still renders a readable line rather than empty prose.
/**
 * @type {Record<'call' | 'return' | 'observe' | 'terminate', TieredLabel>}
 */
const genericOperationLabels = {
	call: { fun: '{source} ring up {destination}', helpful: '{source} call {destination}', detailed: 'call {source} → {destination}' },
	return: { fun: '{source} report back to {destination}', helpful: '{source} return to {destination}', detailed: 'return {source} → {destination}' },
	observe: { fun: '{source} peek at {destination}', helpful: '{source} observe {destination}', detailed: 'observe {source} → {destination}' },
	terminate: { fun: '{source} zap {destination}', helpful: '{source} rewind {destination}', detailed: 'terminate {source} → {destination}' },
}

// Walks the fallback chain from the requested tier toward less-precise tiers and returns the first present value, or null when none of the three tiers is present. The caller supplies the ultimate fallback so participant and operation resolution can each choose their own (title-cased role name vs. the generic per-kind template).
function pickTier(entry, tier) {
	if (entry === undefined) return null
	const startIndex = TIER_FALLBACK_ORDER.indexOf(tier)
	for (let index = startIndex; index < TIER_FALLBACK_ORDER.length; index += 1) {
		const tierName = TIER_FALLBACK_ORDER[index]
		if (tierName === undefined) continue
		const value = entry[tierName]
		if (value !== undefined) return value
	}
	return null
}

// Title-cases a role identifier by splitting on underscores and capitalizing each word, so an unseeded role like 'read_file' renders as 'Read File' rather than 'read_file' or 'Read_file'.
function titleCaseRole(role) {
	return role
		.split('_')
		.map((word) => (word.length === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
		.join(' ')
}

/**
 * Resolves the short display label for a participant at the chosen tier. Falls back detailed → helpful → fun when the requested tier is absent, and returns the title-cased role name when no entry exists at all, so a guild author who omits a tier or role still gets a readable line.
 *
 * @param {Participant} participant
 * @param {LabelTier} tier
 * @returns {string}
 */
export function resolveParticipantLabel(participant, tier) {
	const entry = participantLabels[participant.role]
	const resolved = pickTier(entry, tier)
	if (resolved !== null) return resolved
	return titleCaseRole(participant.role)
}

// Looks up a participant by id in the frame's participant list. A missing id is a model contract violation (every operation endpoint must reference a known participant); failing fast surfaces it rather than rendering a label against undefined.
function findParticipant(participants, participantId) {
	const found = participants.find((participant) => participant.id === participantId)
	if (found === undefined) throw new Error(`operation references unknown participant id "${participantId}"`)
	return found
}

function interpolate(template, sourceLabel, destinationLabel) {
	return template.split(SOURCE_PLACEHOLDER).join(sourceLabel).split(DESTINATION_PLACEHOLDER).join(destinationLabel)
}

/**
 * Resolves the short display label for an operation at the chosen tier, interpolating the source and destination participant labels (resolved at the same tier) into the operation template. Falls back detailed → helpful → fun when the requested tier is absent, and falls back to the per-kind generic template when no discriminator matches, so an unseeded participant-kind combination still renders a readable line.
 *
 * @param {Operation} operation
 * @param {Participant[]} participants
 * @param {LabelTier} tier
 * @returns {string}
 */
export function resolveOperationLabel(operation, participants, tier) {
	const source = findParticipant(participants, operation.source)
	const destination = findParticipant(participants, operation.destination)
	const sourceLabel = resolveParticipantLabel(source, tier)
	const destinationLabel = resolveParticipantLabel(destination, tier)
	const byDiscriminator = operationLabels[operation.kind]
	const specific = byDiscriminator[`${source.kind}->${destination.kind}`]
	const resolved = pickTier(specific, tier)
	const template = resolved ?? pickTier(genericOperationLabels[operation.kind], tier)
	if (template === null) throw new Error(`no operation template for kind "${operation.kind}" at tier "${tier}"`)
	return interpolate(template, sourceLabel, destinationLabel)
}
