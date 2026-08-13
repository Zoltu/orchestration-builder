
import type { PendingQuestion } from '../executor/human-backend.js'
import { isObject, isRunMeta } from '../executor/validation.js'
import type { EffortLevel, ExecutorConfig, GuildConfig, LogEvent, ResultCard, RunMeta, ToolManifest, HumanFacingText, VisualizationConfig } from '../executor/types.js'
import type { ProjectSettings, RunSnapshotRaw } from '../executor/persistence.js'

export interface RunSnapshot {
	meta: RunMeta | null
	logEvents: LogEvent[]
}

export function parseRunMeta(metaText: string | null): RunMeta | null {
	if (metaText === null) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(metaText)
	} catch {
		return null
	}
	return isRunMeta(parsed) ? parsed : null
}

export function parseLogEvents(logText: string): LogEvent[] {
	const events: LogEvent[] = []
	for (const line of logText.split('\n')) {
		if (line === '') continue
		let parsed: unknown
		try {
			parsed = JSON.parse(line)
		} catch {
			continue
		}
		if (!isObject(parsed)) continue
		if (typeof parsed.timestamp !== 'string') continue
		if (typeof parsed.type !== 'string') continue
		events.push({ timestamp: parsed.timestamp, type: parsed.type, payload: parsed.payload })
	}
	return events
}

export function parseRunSnapshot(raw: RunSnapshotRaw): RunSnapshot {
	return {
		meta: parseRunMeta(raw.metaText),
		logEvents: parseLogEvents(raw.logText),
	}
}

function roleOf(payload: unknown): string | null {
	if (!isObject(payload)) return null
	if (typeof payload.role !== 'string') return null
	return payload.role
}

function toolOf(payload: unknown): string | null {
	if (!isObject(payload)) return null
	if (typeof payload.tool !== 'string') return null
	return payload.tool
}

function stringField(payload: unknown, field: string): string | null {
	if (!isObject(payload)) return null
	const value = payload[field]
	return typeof value === 'string' ? value : null
}

function numberField(payload: unknown, field: string): number | null {
	if (!isObject(payload)) return null
	const value = payload[field]
	return typeof value === 'number' ? value : null
}

function withRole(role: string | null, action: string): string {
	return role === null ? action : `${role} · ${action}`
}

// The top frame of a stack, or undefined when the stack is empty. Keeps stack-walking code honest about the empty case without a non-null assertion.
function topOf<T>(stack: T[]): T | undefined {
	return stack.length > 0 ? stack[stack.length - 1] : undefined
}

export function formatLogEvent(event: LogEvent): string {
	const payload = event.payload
	const role = roleOf(payload)

	switch (event.type) {
		case 'llm_call':
			return withRole(role, 'llm call')
		case 'tool_call':
			return withRole(role, stringField(payload, 'tool') ?? 'tool call')
		case 'tool_result': {
			const tool = stringField(payload, 'tool')
			const kind = stringField(payload, 'kind')
			return withRole(role, `${tool ?? 'tool'} result${kind !== null ? ` (${kind})` : ''}`)
		}
		case 'role_finished': {
			const status = stringField(payload, 'status')
			const statusPart = status !== null ? ` (${status})` : ''
			// Status only: the role's full summary text can be long multi-line model prose and would inflate the one-line log row. The full summary and structured error are carried as paired detail sections (see formatLogDetailSections) so a reviewer reaches them via the raw toggle, not by widening the log line.
			return withRole(role, `finished${statusPart}`)
		}
		case 'implicit_finish':
			return withRole(role, 'finished (implicit)')
		case 'llm_unavailable':
			return withRole(role, 'llm unavailable')
		case 'context_budget_exceeded':
			return withRole(role, 'context budget exceeded')
		case 'context_compacted':
			return withRole(role, 'context compacted by platform')
		case 'context_pressure':
			return withRole(role, 'context pressure — handoff notice sent')
		case 'role_budget_exceeded':
			return withRole(role, 'role budget exceeded')
		case 'global_budget_exceeded':
			return withRole(role, 'global budget exceeded')
		case 'unknown_tool': {
			const tool = stringField(payload, 'tool')
			return withRole(role, `unknown tool${tool !== null ? ` (${tool})` : ''}`)
		}
		case 'invalid_tool_call': {
			const tool = stringField(payload, 'tool')
			return withRole(role, `invalid tool call${tool !== null ? ` (${tool})` : ''}`)
		}
		case 'depth_exceeded': {
			const parent = stringField(payload, 'parent')
			const child = stringField(payload, 'child')
			const depth = numberField(payload, 'depth')
			return withRole(parent, `depth exceeded (${child ?? 'child'} at depth ${depth ?? '?'})`)
		}
		case 'role_not_found': {
			const parent = stringField(payload, 'parent')
			const roleName = stringField(payload, 'roleName')
			return withRole(parent ?? role, `role not found${roleName !== null ? ` (${roleName})` : ''}`)
		}
		case 'role_start':
			return withRole(role, 'role start')
		case 'effort_set': {
			const effort = stringField(payload, 'effort')
			return effort === null ? 'effort set' : `effort set (${effort})`
		}
		case 'agent_call': {
			const parent = stringField(payload, 'parent')
			const child = stringField(payload, 'child')
			return withRole(parent ?? role, `agent call${child !== null ? ` → ${child}` : ''}`)
		}
		case 'interrupt': {
			const handler = stringField(payload, 'handler')
			const target = stringField(payload, 'target')
			return handler !== null && target !== null ? `interrupt (${handler} on ${target})` : 'interrupt'
		}
		case 'interrupt_resolved': {
			const action = stringField(payload, 'action')
			const target = stringField(payload, 'target')
			return action !== null && target !== null ? `interrupt resolved (${action} on ${target})` : 'interrupt resolved'
		}
		case 'observe': {
			const details = stringField(payload, 'details')
			return withRole(role, `observe${details !== null ? ` (${details})` : ''}`)
		}
		case 'operator_notice':
			return withRole(role, 'operator notice')
		case 'inquiry_dropped': {
			const reason = stringField(payload, 'reason')
			return reason !== null ? `inquiry dropped (${reason})` : 'inquiry dropped'
		}
		// Never emitted anymore; kept so historical logs still read sensibly.
		case 'operator_inquiry':
			return withRole(role, 'operator inquiry')
		case 'plan_modification':
			return withRole(role, 'operator plan modification')
		default:
			return role === null ? event.type : `${event.type} · ${role}`
	}
}

export interface RoleActivity {
	role: string
	firstSeen: string
	lastSeen: string
	eventCount: number
	llmCalls: number
	toolCalls: number
	// The last few distinct tools the role called, most-recent-last, capped at 3. Distinct because a tight loop on one tool would otherwise fill the list with repeats and hide what else the role touched.
	recentTools: string[]
	lastPromptTokens: number | null
}

export function deriveRoleActivity(logEvents: LogEvent[]): RoleActivity[] {
	// A Map preserves first-seen insertion order, so the activity list comes out in the order roles first appeared with no separate ordering bookkeeping.
	const byRole = new Map<string, RoleActivity>()
	for (const event of logEvents) {
		const role = roleOf(event.payload)
		if (role === null) continue
		let entry = byRole.get(role)
		if (entry === undefined) {
			entry = {
				role,
				firstSeen: event.timestamp,
				lastSeen: event.timestamp,
				eventCount: 0,
				llmCalls: 0,
				toolCalls: 0,
				recentTools: [],
				lastPromptTokens: null,
			}
			byRole.set(role, entry)
		}
		entry.lastSeen = event.timestamp
		entry.eventCount++
		if (event.type === 'llm_call') {
			entry.llmCalls++
			// Each llm_call with usage refreshes the role's last-seen context window size, so the panel reflects the live prompt footprint rather than a run total.
			const usage = usageOf(event.payload)
			if (usage !== null) entry.lastPromptTokens = usage.promptTokens
		}
		if (event.type === 'tool_call') {
			entry.toolCalls++
			const tool = toolOf(event.payload)
			if (tool !== null) {
				// Move the tool to the most-recent position (removing any earlier occurrence) and cap at the last 3 distinct, so the list reflects recency rather than first-use order.
				const existing = entry.recentTools.indexOf(tool)
				if (existing >= 0) entry.recentTools.splice(existing, 1)
				entry.recentTools.push(tool)
				if (entry.recentTools.length > 3) entry.recentTools.shift()
			}
		}
	}
	return Array.from(byRole.values())
}

export interface RoleTreeNode {
	role: string
	depth: number
	parent: string | null
	// Terminal status from the matching role_finished event, or null when the role is still in progress or its finish event is absent.
	status: string | null
	summary: string | null
	active: boolean
	children: RoleTreeNode[]
}

export function deriveRoleTree(logEvents: LogEvent[]): RoleTreeNode[] | null {
	let sawTreeEvent = false
	for (const event of logEvents) {
		if (event.type === 'role_start' || event.type === 'role_finished' || event.type === 'agent_call') {
			sawTreeEvent = true
			break
		}
	}
	if (!sawTreeEvent) return null

	const roots: RoleTreeNode[] = []
	// The active path: top is the deepest in-flight role. A role_start pushes; a role_finished pops the matching entry and records its status.
	const stack: RoleTreeNode[] = []

	for (const event of logEvents) {
		if (event.type === 'role_start') {
			const payload = event.payload
			if (!isObject(payload)) continue
			const roleValue = payload['role']
			if (typeof roleValue !== 'string') continue
			const depthValue = payload['depth']
			const depth = typeof depthValue === 'number' ? depthValue : 0
			const parentRole = topOf(stack)?.role ?? null
			const node: RoleTreeNode = {
				role: roleValue,
				depth,
				parent: parentRole,
				status: null,
				summary: null,
				active: false,
				children: [],
			}
			const parentNode = topOf(stack)
			if (parentNode !== undefined) {
				parentNode.children.push(node)
			} else {
				roots.push(node)
			}
			stack.push(node)
		} else if (event.type === 'role_finished') {
			const payload = event.payload
			if (!isObject(payload)) continue
			const roleValue = payload['role']
			if (typeof roleValue !== 'string') continue
			const statusValue = payload['status']
			const status = typeof statusValue === 'string' ? statusValue : null
			const summaryValue = payload['summary']
			const summary = typeof summaryValue === 'string' ? summaryValue : null
			// Find the topmost in-flight entry for this role. In a well-formed depth-first log the top of the stack matches; a partial log (torn read mid-write) may have skipped a child's finish, so we search down and pop the abandoned children too rather than crash.
			let matchIndex = -1
			for (let i = stack.length - 1; i >= 0; i--) {
				if (stack[i]?.role === roleValue) {
					matchIndex = i
					break
				}
			}
			const matched = matchIndex >= 0 ? stack[matchIndex] : undefined
			if (matched === undefined) continue
			matched.status = status
			matched.summary = summary
			stack.length = matchIndex
		}
	}

	// The active invocation is the deepest in-flight role (the stack top): the one currently executing. A waiting parent is in-flight but suspended, so it must not pulse.
	const activeNode = topOf(stack)
	if (activeNode !== undefined) activeNode.active = true
	return roots
}

export interface LogDetailSection {
	label: string
	content: unknown
}

export interface RecentLogEntry {
	timestamp: string
	type: string
	summary: string
	payload: unknown
	detailSections: LogDetailSection[] | null
}

export function toRecentLogEntry(event: LogEvent): RecentLogEntry {
	return {
		timestamp: event.timestamp,
		type: event.type,
		summary: formatLogEvent(event),
		payload: event.payload,
		detailSections: formatLogDetailSections(event),
	}
}

export function formatLogDetailSections(event: LogEvent): LogDetailSection[] | null {
	const payload = event.payload
	if (!isObject(payload)) return null
	if (event.type === 'llm_call') {
		const sections: LogDetailSection[] = []
		const sent = payload['sent']
		if (Array.isArray(sent)) sections.push({ label: 'sent', content: sent })
		const received = payload['received']
		if (isObject(received)) sections.push({ label: 'received', content: received })
		const finishReason = payload['finishReason']
		if (typeof finishReason === 'string') sections.push({ label: 'finish reason', content: finishReason })
		const usage = payload['usage']
		if (isObject(usage)) sections.push({ label: 'usage', content: usage })
		return sections.length > 0 ? sections : null
	}
	if (event.type === 'tool_call' || event.type === 'tool_result') {
		const sections: LogDetailSection[] = []
		const argumentsValue = payload['arguments']
		if (typeof argumentsValue === 'string') sections.push({ label: 'arguments', content: argumentsValue })
		const result = payload['result']
		if (isObject(result)) sections.push({ label: 'result', content: result })
		return sections.length > 0 ? sections : null
	}
	if (event.type === 'role_finished') {
		const sections: LogDetailSection[] = []
		const summary = payload['summary']
		if (typeof summary === 'string') sections.push({ label: 'summary', content: summary })
		const error = payload['error']
		if (isObject(error)) sections.push({ label: 'error', content: error })
		return sections.length > 0 ? sections : null
	}
	return null
}

export interface PaginatedLog {
	events: LogEvent[]
	total: number
	offset: number
	limit: number
}

// Returns a page of log events as a slice of the full event list, plus the paging metadata a UI needs to drive "load earlier" and report counts.
// An offset past the end yields an empty page with the correct total rather than clamping silently, so the UI can stop offering more once offset 0 is reached.
export function paginateLogEvents(events: LogEvent[], options: { offset: number, limit: number }): PaginatedLog {
	const offset = options.offset
	const limit = options.limit
	const total = events.length
	const page = offset >= total ? [] : events.slice(offset, offset + limit)
	return { events: page, total, offset, limit }
}

// Renders the full log as plain text, one event per line, for export.
// Each line is tab-separated: timestamp, type, then the readable summary from formatLogEvent, so the export mirrors exactly what the on-screen log shows.
export function formatLogAsText(events: LogEvent[]): string {
	return events.map((event) => `${event.timestamp}\t${event.type}\t${formatLogEvent(event)}`).join('\n')
}

export interface CurrentActivity {
	role: string | null
	summary: string
}

export interface TokenUsage {
	promptTokens: number
	cachedPromptTokens: number
	completionTokens: number
	totalTokens: number
}

export interface Budgets {
	elapsedSeconds: number
	toolCalls: number
	tokensUsed: number | null
	tokenBreakdown: TokenUsage | null
}

function usageOf(payload: unknown): { promptTokens: number; completionTokens: number; cachedPromptTokens: number; totalTokens: number } | null {
	if (!isObject(payload)) return null
	const usage = payload['usage']
	if (!isObject(usage)) return null
	const total = usage['totalTokens']
	const prompt = usage['promptTokens']
	const completion = usage['completionTokens']
	const cached = usage['cachedPromptTokens']

	const hasPromptCompletion = typeof prompt === 'number' && typeof completion === 'number'
	if (typeof total !== 'number' && !hasPromptCompletion) return null

	const promptTokens = typeof prompt === 'number' ? prompt : 0
	const completionTokens = typeof completion === 'number' ? completion : 0
	const cachedPromptTokens = typeof cached === 'number' ? cached : 0
	const totalTokens = typeof total === 'number' ? total : promptTokens + completionTokens
	return { promptTokens, completionTokens, cachedPromptTokens, totalTokens }
}

export function deriveBudgets(logEvents: LogEvent[], meta: RunMeta | null, now: string): Budgets {
	const startTime = meta !== null ? meta.startTime : (logEvents[0]?.timestamp ?? null)
	const endTime = meta !== null && meta.endTime !== undefined ? meta.endTime : now

	let elapsedSeconds = 0
	if (startTime !== null) {
		const startMs = Date.parse(startTime)
		const endMs = Date.parse(endTime)
		if (!Number.isNaN(startMs) && !Number.isNaN(endMs)) {
			elapsedSeconds = Math.max(0, Math.round((endMs - startMs) / 1000))
		}
	}

	let toolCalls = 0
	let sawUsage = false
	let promptSum = 0
	let cachedSum = 0
	let completionSum = 0
	let totalSum = 0
	for (const event of logEvents) {
		if (event.type === 'tool_call') toolCalls++
		if (event.type === 'llm_call') {
			const usage = usageOf(event.payload)
			if (usage !== null) {
				sawUsage = true
				promptSum += usage.promptTokens
				cachedSum += usage.cachedPromptTokens
				completionSum += usage.completionTokens
				totalSum += usage.totalTokens
			}
		}
	}

	return {
		elapsedSeconds,
		toolCalls,
		tokensUsed: sawUsage ? totalSum : null,
		tokenBreakdown: sawUsage ? { promptTokens: promptSum, cachedPromptTokens: cachedSum, completionTokens: completionSum, totalTokens: totalSum } : null,
	}
}

export interface QuestionHistoryEntry {
	id: string | null
	question: string
	context?: string
	askedAt: string
	answer?: string
	answeredAt?: string
}

export function deriveQuestionHistory(logEvents: LogEvent[]): QuestionHistoryEntry[] {
	const entries: QuestionHistoryEntry[] = []
	const indexById = new Map<string, number>()

	for (const event of logEvents) {
		const payload = event.payload
		if (!isObject(payload)) continue

		if (event.type === 'ask_human') {
			const question = stringField(payload, 'question')
			if (question === null) continue
			const id = stringField(payload, 'id')
			const context = stringField(payload, 'context')
			const entry: QuestionHistoryEntry = {
				id,
				question,
				askedAt: event.timestamp,
				...(context !== null ? { context } : {}),
			}
			const index = entries.length
			entries.push(entry)
			if (id !== null && !indexById.has(id)) indexById.set(id, index)
		} else if (event.type === 'human_answer') {
			const id = stringField(payload, 'id')
			if (id === null) continue
			const answer = stringField(payload, 'answer')
			if (answer === null) continue
			const index = indexById.get(id)
			if (index === undefined) continue
			const entry = entries[index]
			if (entry === undefined) continue
			entry.answer = answer
			entry.answeredAt = event.timestamp
		}
	}
	return entries
}

export interface InterruptInquiryEntry {
	kind: 'inquiry'
	askedAt: string
	role: string | null
	message: string
	answer: string | null
	answeredAt: string | null
	// Set when the handler's resolution was not a clean answer (a failure or an empty summary), so the UI stops offering "waiting".
	ended: boolean
}

export interface InterruptPlanModEntry {
	kind: 'plan_modification'
	askedAt: string
	message: string
	target: string | null
	targetRole: string | null
	aborted: string[]
}

export type InterruptHistoryEntry = InterruptInquiryEntry | InterruptPlanModEntry

// Pairs each operator inquiry with the handler's resolution: an inquiry-triggered interrupt opens an entry against the handler role, and the matching interrupt_resolved closes it — an 'answered' action with a non-empty summary sets the answer, anything else (a failure or an empty summary) marks the entry ended so the UI stops offering "waiting". Inquiries resolve strictly in arrival order (the executor handles them sequentially, never concurrently), so a single FIFO queue pairs each resolution with the oldest unanswered entry; a resolution with none waiting is skipped. Plan modifications have no reply to pair — their delivery and abort outcome are on the event itself.
export function deriveInterruptHistory(logEvents: LogEvent[]): InterruptHistoryEntry[] {
	const entries: InterruptHistoryEntry[] = []
	const unanswered: InterruptInquiryEntry[] = []

	for (const event of logEvents) {
		const payload = event.payload
		if (!isObject(payload)) continue

		if (event.type === 'interrupt' && stringField(payload, 'trigger') === 'inquiry') {
			const message = stringField(payload, 'message')
			if (message === null) continue
			const entry: InterruptInquiryEntry = { kind: 'inquiry', askedAt: event.timestamp, role: stringField(payload, 'handler'), message, answer: null, answeredAt: null, ended: false }
			entries.push(entry)
			unanswered.push(entry)
			continue
		}
		if (event.type === 'interrupt_resolved' && stringField(payload, 'trigger') === 'inquiry') {
			const entry = unanswered.shift()
			if (entry === undefined) continue
			const summary = stringField(payload, 'summary')
			if (stringField(payload, 'action') === 'answered' && summary !== null && summary !== '') {
				entry.answer = summary
				entry.answeredAt = event.timestamp
			} else {
				entry.ended = true
			}
			continue
		}
		if (event.type === 'plan_modification') {
			const message = stringField(payload, 'message')
			if (message === null) continue
			const abortedRaw = payload['aborted']
			const aborted = Array.isArray(abortedRaw) ? abortedRaw.filter((item): item is string => typeof item === 'string') : []
			entries.push({ kind: 'plan_modification', askedAt: event.timestamp, message, target: stringField(payload, 'target'), targetRole: stringField(payload, 'targetRole'), aborted })
			continue
		}
	}
	return entries
}

export interface RunView {
	status: RunMeta['status'] | 'unknown'
	runId: string | null
	task: string | null
	effort: EffortLevel | null
	startTime: string | null
	endTime: string | null
	result: ResultCard | null
	error: NonNullable<RunMeta['error']> | null
	roles: RoleActivity[]
	roleTree: RoleTreeNode[] | null
	recentLog: RecentLogEntry[]
	currentActivity: CurrentActivity | null
	questionHistory: QuestionHistoryEntry[]
	interrupts: InterruptHistoryEntry[]
	budgets: Budgets
}

export interface RenderRunViewOptions {
	maxLogLines: number
	now: string
}

export function renderRunView(snapshot: RunSnapshot, options: RenderRunViewOptions): RunView {
	const meta = snapshot.meta
	const recentEvents = snapshot.logEvents.slice(-options.maxLogLines)
	const recentLog: RecentLogEntry[] = recentEvents.map(toRecentLogEntry)
	const lastEvent = snapshot.logEvents.length > 0 ? snapshot.logEvents[snapshot.logEvents.length - 1] : null
	const currentActivity: CurrentActivity | null = lastEvent === null || lastEvent === undefined
		? null
		: { role: roleOf(lastEvent.payload), summary: formatLogEvent(lastEvent) }
	return {
		status: meta === null ? 'unknown' : meta.status,
		runId: meta === null ? null : meta.runId,
		task: meta === null ? null : meta.task,
		effort: meta === null ? null : (meta.effort ?? null),
		startTime: meta === null ? null : meta.startTime,
		endTime: meta === null ? null : (meta.endTime ?? null),
		result: meta === null ? null : (meta.result ?? null),
		error: meta === null ? null : (meta.error ?? null),
		roles: deriveRoleActivity(snapshot.logEvents),
		roleTree: deriveRoleTree(snapshot.logEvents),
		recentLog,
		currentActivity,
		questionHistory: deriveQuestionHistory(snapshot.logEvents),
		interrupts: deriveInterruptHistory(snapshot.logEvents),
		budgets: deriveBudgets(snapshot.logEvents, meta, options.now),
	}
}

export interface RunSummary {
	runId: string
	status: RunMeta['status'] | 'unknown'
	task: string | null
	effort: EffortLevel | null
	startTime: string | null
	endTime: string | null
	// The result card and run-level error ride along so the history view's expanded rows can browse outcomes without a per-run fetch; both already live in meta.json, so this is a passthrough, not a derivation.
	result: ResultCard | null
	error: NonNullable<RunMeta['error']> | null
	// The LLM-generated one-line summary (summary.txt), when the summarizer has produced one; the client prefers it over the task first line and falls back when absent.
	summary: string | null
}

export function renderRunSummary(runId: string, meta: RunMeta | null, summary: string | null): RunSummary {
	return {
		runId,
		status: meta === null ? 'unknown' : meta.status,
		task: meta === null ? null : meta.task,
		effort: meta === null ? null : (meta.effort ?? null),
		startTime: meta === null ? null : meta.startTime,
		endTime: meta === null ? null : (meta.endTime ?? null),
		result: meta === null ? null : (meta.result ?? null),
		error: meta === null ? null : (meta.error ?? null),
		summary,
	}
}

export interface ProjectSettingsView {
	effort: EffortLevel | null
}

export function renderProjectSettings(settings: ProjectSettings): ProjectSettingsView {
	return { effort: settings.effort ?? null }
}

export interface ApiQuestion {
	id: string
	question: string
	context?: string
	askedAt: string
}

export function renderPendingQuestions(questions: PendingQuestion[]): ApiQuestion[] {
	return questions.map((question) => {
		const shaped: ApiQuestion = {
			id: question.id,
			question: question.question,
			askedAt: question.askedAt,
		}
		if (question.context !== undefined) shaped.context = question.context
		return shaped
	})
}

export interface GuildConfigView {
	model: { name: string; contextWindow: number }
	executor: ExecutorConfig
	entryRole: string
	roles: Record<string, { tools: string[]; label?: HumanFacingText; description?: HumanFacingText; workingLabel?: HumanFacingText }>
	tools: Record<string, { humanLabel?: HumanFacingText; humanDescription?: HumanFacingText; humanCallLabel?: HumanFacingText; humanWorkingLabel?: HumanFacingText }>
	visualization?: VisualizationConfig
}

export function renderConfig(config: GuildConfig, tools: Record<string, ToolManifest>): GuildConfigView {
	const roles: Record<string, { tools: string[]; label?: HumanFacingText; description?: HumanFacingText; workingLabel?: HumanFacingText }> = {}
	for (const [name, role] of Object.entries(config.roles)) {
		roles[name] = {
			tools: role.tools,
			label: role.label,
			description: role.description,
			workingLabel: role.workingLabel,
		}
	}
	const toolsView: Record<string, { humanLabel?: HumanFacingText; humanDescription?: HumanFacingText; humanCallLabel?: HumanFacingText; humanWorkingLabel?: HumanFacingText }> = {}
	for (const [name, tool] of Object.entries(tools)) {
		toolsView[name] = {
			humanLabel: tool.humanLabel,
			humanDescription: tool.humanDescription,
			humanCallLabel: tool.humanCallLabel,
			humanWorkingLabel: tool.humanWorkingLabel,
		}
	}
	const view: GuildConfigView = {
		model: { name: config.model.name, contextWindow: config.model.contextWindow },
		executor: config.executor,
		entryRole: config.entryRole,
		roles,
		tools: toolsView,
	}
	if (config.visualization !== undefined) view.visualization = config.visualization
	return view
}
