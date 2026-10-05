// Label localization resolver over a guild config.
//
// The InteractionModel carries only role/kind identifiers — no prose. This module resolves short display prose for the views from a config shaped like the one `GET /api/config` returns: participant labels (read from the guild's role.label / tool.humanLabel, plus the visualization section's pseudoRoleLabels for the human/interrupt/tools pseudo-roles), and operation templates (read from the visualization section's operationTemplates and genericOperationTemplates).
//
// Three tiers serve different audiences: 'whimsical' is whimsical and may sacrifice precision, 'friendly' is informative-but-imprecise for non-technical users, 'detailed' is precise for technical users and troubleshooters, naming raw role/tool ids, participant kinds, the call stack, and return outcomes. A tier toggle in the harness swaps which tier the views render without touching the model — a view concern, like locale switching. Per-call detail markdown is not model data at all: it is fetched on demand by the inspector, so localization never touches it.
//
// Every tiered field is a list of strings. Identity surfaces (node boxes, top-bar slots, sequence-diagram column headers) read index 0 so a participant's name stays stable for its whole lifetime; activity surfaces (the now-caption's operation and working labels) pick `list[seed % list.length]` so the whimsical tier rotates between operations while staying fixed within one. detailed and friendly lists usually hold a single phrase; whimsical lists hold several. The seed is a deterministic hash of the operation id (hashString), so the same operation resolves the same phrase across re-renders and re-runs while different operations pick different phrases. The resolver is a pure function of (config, participant/operation, tier, seed); it holds no state, so tests pass a fixed seed and are deterministic.
//
// The fallback chain is detailed → friendly → whimsical: when a guild author omits the requested tier, the resolver walks toward less-precise tiers (returning the first non-empty list) rather than producing empty prose, and a participant with no entry at all falls back to the title-cased role name. The factory closes over the config; the resolvers are pure functions over it.
//
// The module is browser-pure TypeScript (served statically and imported by the view modules) and imports nothing.

export type LabelTier = 'whimsical' | 'friendly' | 'detailed'

export interface Participant {
	id: string
	role: string
	kind: 'human' | 'interrupt' | 'role' | 'tool'
}

export interface Operation {
	id: string
	kind: 'call' | 'return' | 'observe' | 'terminate'
	stack: string
	source: string
	destination: string
	startedAt: string
	settledAt: string | null
	lifecycle: 'in_flight' | 'settled'
	outcome: 'success' | 'error' | 'terminated' | null
	metrics: object | null
}

export interface TieredLabel {
	whimsical?: string[]
	friendly?: string[]
	detailed?: string[]
}

// `roles` and `tools` are optional because the resolver tolerates a config that carries neither table (the factory defaults both to empty, so pseudo-role labels alone still resolve).
export interface LabelConfig {
	roles?: Record<string, { label?: TieredLabel; workingLabel?: TieredLabel }>
	tools?: Record<string, { humanLabel?: TieredLabel; humanCallLabel?: TieredLabel; humanWorkingLabel?: TieredLabel }>
	visualization?: {
		pseudoRoleLabels: Record<string, TieredLabel>
		operationTemplates: Record<'call' | 'return' | 'observe' | 'terminate', Record<string, TieredLabel>>
		genericOperationTemplates: Record<'call' | 'return' | 'observe' | 'terminate', TieredLabel>
		workingTemplates?: Record<string, TieredLabel>
	}
}

export interface LabelResolver {
	resolveParticipantLabel(participant: Participant, tier: LabelTier): string
	resolveOperationLabel(operation: Operation, participants: Participant[], tier: LabelTier, seed: number): string
	resolveWorkingLabel(participant: Participant, tier: LabelTier, seed: number): string | null
	hashString(value: string): number
}

// Ordered from most-precise to least-precise so the fallback walk goes toward less-precise tiers: a missing 'detailed' falls to 'friendly', a missing 'friendly' falls to 'whimsical', and a missing 'whimsical' has nothing less-precise to fall to (the caller supplies an ultimate fallback).
const TIER_FALLBACK_ORDER: readonly LabelTier[] = ['detailed', 'friendly', 'whimsical']

// The tier values the label-tier toggle offers, in toggle order. The resolver treats a tier as opaque (it falls back through TIER_FALLBACK_ORDER); this list exists so both clients validate and render the same set rather than each declaring its own copy.
export const TIER_VALUES: readonly LabelTier[] = ['whimsical', 'friendly', 'detailed']

export function isLabelTier(value: unknown): value is LabelTier {
	for (const candidate of TIER_VALUES) {
		if (value === candidate) return true
	}
	return false
}

// A deterministic 32-bit hash of a string, used as the rotation seed for activity labels so the whimsical tier picks a stable phrase per operation (the same operation resolves the same phrase across re-renders) while different operations pick different phrases. Pure and stateless: tests pass a fixed seed and are deterministic, and re-running a scenario shows the same sequence.
export function hashString(value: string): number {
	let hash = 0
	for (let index = 0; index < value.length; index += 1) {
		hash = (Math.imul(hash, 31) + value.charCodeAt(index)) | 0
	}
	return Math.abs(hash)
}

// Walks the fallback chain from the requested tier toward less-precise tiers and returns the first present non-empty list, or null when none of the three tiers is present. The caller supplies the ultimate fallback so participant and operation resolution can each choose their own (title-cased role name vs. the generic per-kind template).
function pickTierList(entry: TieredLabel | undefined, tier: LabelTier): string[] | null {
	if (entry === undefined) return null
	const startIndex = TIER_FALLBACK_ORDER.indexOf(tier)
	for (let index = startIndex; index < TIER_FALLBACK_ORDER.length; index += 1) {
		const tierName = TIER_FALLBACK_ORDER[index]
		if (tierName === undefined) continue
		const value = entry[tierName]
		if (Array.isArray(value) && value.length > 0) return value
	}
	return null
}

// Title-cases a role identifier by splitting on underscores and capitalizing each word, so an unseeded role like 'read_file' renders as 'Read File' rather than 'read_file' or 'Read_file'.
function titleCaseRole(role: string): string {
	return role
		.split('_')
		.map((word) => (word.length === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
		.join(' ')
}

// Substitutes every `{name}` placeholder in the template with the matching value from `replacements`, leaving any unknown placeholder intact so a typo surfaces as a literal token rather than vanishing silently. A single regex pass makes substitution order-independent — `{source}` cannot accidentally eat the `source` half of `{sourceRole}`.
function applyPlaceholders(template: string, replacements: Record<string, string>): string {
	return template.replace(/\{(\w+)\}/g, (match, name) => {
		if (Object.prototype.hasOwnProperty.call(replacements, name)) {
			const value = replacements[name]
			return value === null || value === undefined ? '' : String(value)
		}
		return match
	})
}

// Selects the phrase the seed rotates to within a tier list. The index is taken modulo the list length, so it is in range by construction — the throw surfaces an invariant violation (a bad seed or a corrupted list arriving from the plain-JS view callers) rather than rendering empty prose.
function rotatedPhrase(list: string[], seed: number, description: string): string {
	const index = seed % list.length
	const phrase = list[index]
	if (phrase === undefined) throw new Error(`${description}: seed ${seed} picked index ${index} outside a ${list.length}-phrase list`)
	return phrase
}

// Builds a label resolver over the given config. Real roles read their tiered labels from `roles[name].label`, real tools from `tools[name].humanLabel`, and the human/interrupt/tools pseudo-roles read from `visualization.pseudoRoleLabels`. A participant whose role has no entry at all falls back to the title-cased role name; a tool with no humanLabel falls back to its raw name (already what the participant carries). The visualization section is optional so a minimal guild without operation templates still resolves participant labels — the operation resolver then throws on a missing template, surfacing the misconfiguration rather than rendering empty prose.
//
// The returned object also exposes `hashString` so the three call sites that seed rotation (the now-caption, the demo tooltip/debug text, and the sequence-diagram message rows) read the seed off the same label surface they already receive, without each reaching for a separate import.
export function createLabelResolver(config: LabelConfig): LabelResolver {
	const roles = config.roles ?? {}
	const tools = config.tools ?? {}
	const visualization = config.visualization
	const pseudoRoleLabels = visualization?.pseudoRoleLabels ?? {}
	const operationTemplates = visualization?.operationTemplates
	const genericOperationTemplates = visualization?.genericOperationTemplates
	const workingTemplates = visualization?.workingTemplates

	// Looks up a participant by id in the frame's participant list. A missing id is a model contract violation (every operation endpoint must reference a known participant); failing fast surfaces it rather than rendering a label against undefined.
	function findParticipant(participants: Participant[], participantId: string): Participant {
		const found = participants.find((participant) => participant.id === participantId)
		if (found === undefined) throw new Error(`operation references unknown participant id "${participantId}"`)
		return found
	}

	// Resolves a single participant's tiered label entry, consulting the guild's role/tool label and the pseudo-role table in turn. A role participant resolves against roles[role].label; a tool participant against tools[role].humanLabel; the human/interrupt/tools pseudo-roles against visualization.pseudoRoleLabels. A role/tool with no entry returns undefined so the resolver can fall back through the chain and ultimately to the title-cased name.
	function entryForParticipant(participant: Participant): TieredLabel | undefined {
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

	// Identity surfaces (node boxes, top-bar slots, sequence-diagram column headers) read index 0 so a participant's name stays stable for its whole lifetime; rotation is reserved for activity surfaces.
	function resolveParticipantLabel(participant: Participant, tier: LabelTier): string {
		const entry = entryForParticipant(participant)
		const list = pickTierList(entry, tier)
		if (list !== null) return list[0] ?? titleCaseRole(participant.role)
		return titleCaseRole(participant.role)
	}

	// Builds the placeholder map for an operation template. `{source}`/`{destination}` resolve to the participants' tiered labels (index 0); the raw-id, kind, stack, and outcome placeholders carry the troubleshooting detail the detailed tier names and the friendly/whimsical tiers leave out.
	function operationReplacements(operation: Operation, source: Participant, destination: Participant, tier: LabelTier): Record<string, string> {
		return {
			source: resolveParticipantLabel(source, tier),
			destination: resolveParticipantLabel(destination, tier),
			sourceRole: source.role,
			destinationRole: destination.role,
			sourceKind: source.kind,
			destinationKind: destination.kind,
			stack: operation.stack,
			outcome: operation.outcome ?? '',
		}
	}

	function resolveOperationLabel(operation: Operation, participants: Participant[], tier: LabelTier, seed: number): string {
		const source = findParticipant(participants, operation.source)
		const destination = findParticipant(participants, operation.destination)
		if (operationTemplates === undefined || genericOperationTemplates === undefined) {
			throw new Error(`no operation template for kind "${operation.kind}" at tier "${tier}" (visualization section missing)`)
		}
		const replacements = operationReplacements(operation, source, destination, tier)
		// A call to a tool may carry a per-tool call template (humanCallLabel) that overrides the generic role->tool / interrupt->tool template, so each tool can phrase its own invocation ("getting a book off the shelf" for read_file vs "picking up the pen" for write_file) rather than sharing one "grabbing the {destination} gadget" template. The per-tool list is rotated by the seed so a tool called repeatedly still varies in the whimsical tier.
		if (operation.kind === 'call' && destination.kind === 'tool') {
			const tool = tools[destination.role]
			const toolCallList = tool !== undefined ? pickTierList(tool.humanCallLabel, tier) : null
			if (toolCallList !== null) {
				return applyPlaceholders(rotatedPhrase(toolCallList, seed, `call template for tool "${destination.role}" at tier "${tier}"`), replacements)
			}
		}
		const byDiscriminator = operationTemplates[operation.kind]
		const specific = byDiscriminator[`${source.kind}->${destination.kind}`]
		const specificList = pickTierList(specific, tier)
		const genericList = pickTierList(genericOperationTemplates[operation.kind], tier)
		const list = specificList ?? genericList
		if (list === null) throw new Error(`no operation template for kind "${operation.kind}" at tier "${tier}"`)
		return applyPlaceholders(rotatedPhrase(list, seed, `operation template for kind "${operation.kind}" at tier "${tier}"`), replacements)
	}

	// Resolves the active/working-state text for a participant — the destination of a settled call, who is now doing its own work rather than being called. A per-role workingLabel (or a per-tool humanWorkingLabel) is consulted first; when absent the generic per-kind fallback in visualization.workingTemplates is used; when that too is absent the resolver returns null so the caller (deriveNowCaption) can fall back to the operation label. The `{participant}` placeholder interpolates to the participant's own label at the chosen tier; `{participantRole}`, `{participantKind}`, and `{participantId}` carry the raw troubleshooting detail. The list is rotated by the seed so the whimsical tier varies between operations.
	function resolveWorkingLabel(participant: Participant, tier: LabelTier, seed: number): string | null {
		let entry: TieredLabel | undefined
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
		const list = pickTierList(entry, tier)
		if (list === null) return null
		const replacements = {
			participant: resolveParticipantLabel(participant, tier),
			participantRole: participant.role,
			participantKind: participant.kind,
			participantId: participant.id,
		}
		return applyPlaceholders(rotatedPhrase(list, seed, `working label for kind "${participant.kind}" at tier "${tier}"`), replacements)
	}

	return { resolveParticipantLabel, resolveOperationLabel, resolveWorkingLabel, hashString }
}
