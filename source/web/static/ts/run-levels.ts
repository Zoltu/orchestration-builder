// The display vocabulary for the effort and involvement channels. The wire strings are the contract (see docs/reference.md "Effort channel" and "Involvement channel"): state, API bodies, and run metadata carry them verbatim, so there is no mapping table — display capitalization is a UI concern only and the executor never reads it. The per-option descriptions are the single copy of what each level means; every selector and badge renders from these lists.

export type EffortLevel = 'quick' | 'standard' | 'thorough'
export type InvolvementLevel = 'autonomous' | 'early-engagement' | 'collaborative'

export const DEFAULT_EFFORT: EffortLevel = 'standard'
export const EFFORT_OPTIONS: { value: EffortLevel; description: string; recommended?: boolean }[] = [
	{ value: 'quick', description: 'The fastest, lightest pass. Good for small fixes and simple tasks.' },
	{ value: 'standard', description: 'Careful work at a reasonable pace. The right choice for most tasks.', recommended: true },
	{ value: 'thorough', description: 'The slowest, most meticulous pass. Best for large or important projects.' },
]

export function isEffort(value: unknown): value is EffortLevel {
	return EFFORT_OPTIONS.some((option) => option.value === value)
}

export function effortLabel(effort: unknown): string {
	if (!isEffort(effort)) return '—'
	return effort.charAt(0).toUpperCase() + effort.slice(1)
}

export function effortDescription(effort: unknown): string {
	const option = EFFORT_OPTIONS.find((entry) => entry.value === effort)
	return option !== undefined ? option.description : ''
}

export const DEFAULT_INVOLVEMENT: InvolvementLevel = 'early-engagement'
export const INVOLVEMENT_OPTIONS: { value: InvolvementLevel; description: string }[] = [
	{ value: 'autonomous', description: 'Makes reasonable choices and works without checking in.' },
	{ value: 'early-engagement', description: 'Clarifies up front, then works on its own.' },
	{ value: 'collaborative', description: 'Checks in with you as it goes.' },
]

export function isInvolvement(value: unknown): value is InvolvementLevel {
	return INVOLVEMENT_OPTIONS.some((option) => option.value === value)
}

export function involvementLabel(involvement: unknown): string {
	if (!isInvolvement(involvement)) return '—'
	return involvement === 'early-engagement' ? 'Early engagement' : involvement.charAt(0).toUpperCase() + involvement.slice(1)
}

export function involvementDescription(involvement: unknown): string {
	const option = INVOLVEMENT_OPTIONS.find((entry) => entry.value === involvement)
	return option !== undefined ? option.description : ''
}

export interface RunLevelSource {
	runId: string | null
	effort: string | null
	involvement: string | null
}

export interface RunLevelSelection {
	effort: EffortLevel | null
	involvement: InvolvementLevel | null
}

// Sources are matched to the selected run before they contribute, so a level from another run can never leak in; an invalid level is treated as absent and falls through to the next source.
export function selectRunLevels(selectedRunId: string | null, view: RunLevelSource | null, summaries: readonly RunLevelSource[], threadRun: RunLevelSource | null): RunLevelSelection {
	if (selectedRunId === null || selectedRunId === '') return { effort: null, involvement: null }
	const candidates: RunLevelSource[] = []
	if (view !== null && view.runId === selectedRunId) candidates.push(view)
	const matchingSummary = summaries.find((summary) => summary.runId === selectedRunId)
	if (matchingSummary !== undefined) candidates.push(matchingSummary)
	if (threadRun !== null && threadRun.runId === selectedRunId) candidates.push(threadRun)
	let effort: EffortLevel | null = null
	let involvement: InvolvementLevel | null = null
	for (const candidate of candidates) {
		if (effort === null && isEffort(candidate.effort)) effort = candidate.effort
		if (involvement === null && isInvolvement(candidate.involvement)) involvement = candidate.involvement
	}
	return { effort, involvement }
}
