// Label localization resolver over a guild config.
//
// The InteractionModel carries only role/kind identifiers — no prose. This module resolves short display prose for the views from a config shaped like the one `GET /api/config` returns: participant labels (read from the guild's role.label / tool.humanLabel, plus the visualization section's pseudoRoleLabels for the human/interrupt/tools pseudo-roles), and operation templates (read from the visualization section's operationTemplates and genericOperationTemplates).
//
// Three tiers serve different audiences: 'playful' is playful (children/playful users) and may sacrifice precision, 'friendly' is informative-but-imprecise for non-technical users, 'detailed' is precise for technical users. A tier toggle in the harness swaps which tier the views render without touching the model — a view concern, like locale switching. The per-call 'details' markdown on each Operation is runtime data the adapter formats, not localization, so it is untouched here.
//
// The fallback chain is detailed → friendly → playful: when a guild author omits the requested tier, the resolver walks toward less-precise tiers rather than producing empty prose, and a participant with no entry at all falls back to the title-cased role name. The factory closes over the config; the resolvers are pure functions over it.
//
// The module is browser-pure JS (served statically and imported by the view modules) and imports nothing. JSDoc typedefs carry the shapes the TS tests assert against, mirroring the sibling interaction-model.js convention.

/**
 * @typedef {'playful' | 'friendly' | 'detailed'} LabelTier
 *   'playful' is playful and may sacrifice precision; 'friendly' is informative for non-technical users; 'detailed' is precise for technical users.
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
 * @property {string} [playful]
 * @property {string} [friendly]
 * @property {string} [detailed]
 *   A label entry may omit any tier; the resolver falls back detailed → friendly → playful when the requested tier is absent.
 */

/**
 * @typedef {Object} LabelConfig
 *   The shape produced by `GET /api/config`: role and tool labels the frontend already loads, plus the visualization section the guild owns for pseudo-role and operation-template localization.
 * @property {Record<string, { label?: TieredLabel, workingLabel?: TieredLabel }>} roles
 *   Role definitions keyed by name; `label` is the participant label and `workingLabel` is the active/working-state text (with a `{participant}` placeholder) read by `resolveWorkingLabel`.
 * @property {Record<string, { humanLabel?: TieredLabel, humanCallLabel?: TieredLabel, humanWorkingLabel?: TieredLabel }>} tools
 *   Tool manifests keyed by name; `humanLabel` is the participant label, `humanCallLabel` is the per-tool call-operation template (with `{source}` and optionally `{destination}`) overriding the generic role->tool / interrupt->tool template, and `humanWorkingLabel` is the per-tool working-state template (with `{participant}` optionally) overriding the generic tool working template.
 * @property {{ pseudoRoleLabels: Record<string, TieredLabel>, operationTemplates: Record<'call' | 'return' | 'observe' | 'terminate', Record<string, TieredLabel>>, genericOperationTemplates: Record<'call' | 'return' | 'observe' | 'terminate', TieredLabel>, workingTemplates?: Record<string, TieredLabel> }} [visualization]
 *   `workingTemplates` is a generic per-participant-kind fallback (keyed by kind: 'role', 'tool') used when a role/tool has no per-entry working label.
 */

// Ordered from most-precise to least-precise so the fallback walk goes toward less-precise tiers: a missing 'detailed' falls to 'friendly', a missing 'friendly' falls to 'playful', and a missing 'playful' has nothing less-precise to fall to (the caller supplies an ultimate fallback).
const TIER_FALLBACK_ORDER = ['detailed', 'friendly', 'playful']

// Operation templates interpolate the resolved participant labels of their source and destination via these placeholders, keeping the registry pure data and the interpolation a single replace in the resolver.
const SOURCE_PLACEHOLDER = '{source}'
const DESTINATION_PLACEHOLDER = '{destination}'

// Working-state templates interpolate the resolved label of the working participant (the destination of a settled call) via this placeholder, so the per-role working text reads "{participant} is planning" / "Receiving tokens from {participant}" without the resolver knowing the frame.
const PARTICIPANT_PLACEHOLDER = '{participant}'

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
 * Builds a label resolver over the given config. Real roles read their tiered labels from `roles[name].label`, real tools from `tools[name].humanLabel`, and the human/interrupt/tools pseudo-roles read from `visualization.pseudoRoleLabels`. A participant whose role has no entry at all falls back to the title-cased role name; a tool with no humanLabel falls back to its raw name (already what the participant carries). The visualization section is optional so a minimal guild without operation templates still resolves participant labels — the operation resolver then throws on a missing template, surfacing the misconfiguration rather than rendering empty prose.
 *
 * @param {LabelConfig} config
 * @returns {{ resolveParticipantLabel: (participant: Participant, tier: LabelTier) => string, resolveOperationLabel: (operation: Operation, participants: Participant[], tier: LabelTier) => string, resolveWorkingLabel: (participant: Participant, tier: LabelTier) => string | null }}
 */
export function createLabelResolver(config) {
	const roles = config.roles ?? {}
	const tools = config.tools ?? {}
	const visualization = config.visualization
	const pseudoRoleLabels = visualization?.pseudoRoleLabels ?? {}
	const operationTemplates = visualization?.operationTemplates
	const genericOperationTemplates = visualization?.genericOperationTemplates
	const workingTemplates = visualization?.workingTemplates

	// Looks up a participant by id in the frame's participant list. A missing id is a model contract violation (every operation endpoint must reference a known participant); failing fast surfaces it rather than rendering a label against undefined.
	function findParticipant(participants, participantId) {
		const found = participants.find((participant) => participant.id === participantId)
		if (found === undefined) throw new Error(`operation references unknown participant id "${participantId}"`)
		return found
	}

	// Resolves a single participant's tiered label entry, consulting the guild's role/tool label and the pseudo-role table in turn. A role participant resolves against roles[role].label; a tool participant against tools[role].humanLabel; the human/interrupt/tools pseudo-roles against visualization.pseudoRoleLabels. A role/tool with no entry returns undefined so the resolver can fall back through the chain and ultimately to the title-cased name (participant) or the raw identifier (the technical tier's natural form).
	function entryForParticipant(participant) {
		if (participant.kind === 'role') {
			const role = roles[participant.role]
			return role !== undefined ? role.label : undefined
		}
		if (participant.kind === 'tool') {
			const tool = tools[participant.role]
			return tool !== undefined ? tool.humanLabel : undefined
		}
		return pseudoRoleLabels[participant.role]
	}

	function interpolate(template, sourceLabel, destinationLabel) {
		return template.split(SOURCE_PLACEHOLDER).join(sourceLabel).split(DESTINATION_PLACEHOLDER).join(destinationLabel)
	}

	function resolveParticipantLabel(participant, tier) {
		const entry = entryForParticipant(participant)
		const resolved = pickTier(entry, tier)
		if (resolved !== null) return resolved
		return titleCaseRole(participant.role)
	}

	function resolveOperationLabel(operation, participants, tier) {
		const source = findParticipant(participants, operation.source)
		const destination = findParticipant(participants, operation.destination)
		const sourceLabel = resolveParticipantLabel(source, tier)
		const destinationLabel = resolveParticipantLabel(destination, tier)
		if (operationTemplates === undefined || genericOperationTemplates === undefined) {
			throw new Error(`no operation template for kind "${operation.kind}" at tier "${tier}" (visualization section missing)`)
		}
		// A call to a tool may carry a per-tool call template (humanCallLabel) that overrides the generic role->tool / interrupt->tool template, so each tool can phrase its own invocation ("getting a book off the shelf" for read_file vs "picking up the pen" for write_file) rather than sharing one "grabbing the {destination} gadget" template. The per-tool template uses {source} (and optionally {destination}); when absent the discriminator → generic chain applies.
		if (operation.kind === 'call' && destination.kind === 'tool') {
			const tool = tools[destination.role]
			const toolCallTemplate = tool !== undefined ? pickTier(tool.humanCallLabel, tier) : null
			if (toolCallTemplate !== null) {
				return interpolate(toolCallTemplate, sourceLabel, destinationLabel)
			}
		}
		const byDiscriminator = operationTemplates[operation.kind]
		const specific = byDiscriminator[`${source.kind}->${destination.kind}`]
		const resolved = pickTier(specific, tier)
		const template = resolved ?? pickTier(genericOperationTemplates[operation.kind], tier)
		if (template === null) throw new Error(`no operation template for kind "${operation.kind}" at tier "${tier}"`)
		return interpolate(template, sourceLabel, destinationLabel)
	}

	// Resolves the active/working-state text for a participant — the destination of a settled call, who is now doing its own work rather than being called. A per-role workingLabel (or a per-tool humanWorkingLabel) is consulted first; when absent the generic per-kind fallback in visualization.workingTemplates is used; when that too is absent the resolver returns null so the caller (deriveNowCaption) can fall back to the operation label. The {participant} placeholder interpolates to the participant's own label at the chosen tier, so "Receiving tokens from {participant}" reads "Receiving tokens from Coder" at the detailed tier and "{participant} is planning" reads "Planner is planning" at the friendly tier.
	function resolveWorkingLabel(participant, tier) {
		let entry
		if (participant.kind === 'role') {
			const role = roles[participant.role]
			entry = role !== undefined ? role.workingLabel : undefined
		} else if (participant.kind === 'tool') {
			const tool = tools[participant.role]
			entry = tool !== undefined ? tool.humanWorkingLabel : undefined
		}
		if (entry === undefined && workingTemplates !== undefined) {
			entry = workingTemplates[participant.kind]
		}
		const template = pickTier(entry, tier)
		if (template === null) return null
		const participantLabel = resolveParticipantLabel(participant, tier)
		return template.split(PARTICIPANT_PLACEHOLDER).join(participantLabel)
	}

	return { resolveParticipantLabel, resolveOperationLabel, resolveWorkingLabel }
}
