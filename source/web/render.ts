// View rendering for the web API. Log parsing and derivation live in the run-log modules, which this module imports and consumes.

import type { PendingQuestion } from '../executor/human-backend.js'
import type { DeploymentConfig, EffortLevel, ExecutorConfig, GuildConfig, InvolvementLevel, LogLevel, OperatorPauseRecord, ResultCard, RunMeta, SuspensionRecord, ToolManifest, HumanFacingText, VisualizationConfig } from '../executor/types.js'
import type { HealthView } from '../executor/index.js'
import type { ProjectSettings } from '../executor/persistence.js'
import { deriveBudgets, deriveCurrentActivity, deriveInterruptHistory, deriveQuestionHistory, deriveRoleActivity, deriveRoleTree } from '../run-log/derive/index.js'
import type { Budgets, CurrentActivity, InterruptHistoryEntry, QuestionHistoryEntry, RoleActivity, RoleTreeNode } from '../run-log/derive/index.js'
import { toRecentLogEntry } from '../run-log/format/index.js'
import type { RecentLogEntry } from '../run-log/format/index.js'
import type { RunSnapshot } from '../run-log/index.js'
import type { BuildInfo } from './build-info.js'

export interface RunView {
	status: RunMeta['status'] | 'unknown'
	runId: string | null
	task: string | null
	effort: EffortLevel | null
	involvement: InvolvementLevel | null
	startTime: string | null
	endTime: string | null
	result: ResultCard | null
	error: NonNullable<RunMeta['error']> | null
	// Present only while the run is suspended by a provider failure; the pause card renders its category copy and suspendedAt, never a result card.
	suspension: SuspensionRecord | null
	// Present only while the run is operator-paused; the paused card renders fixed operator-pause copy and pausedAt, not the stored pause.message.
	pause: OperatorPauseRecord | null
	// The coarse provider health snapshot carried by the run view; the client may render it without a separate health poll. Never contains endpoint, credential, model, header, request, or provider body.
	providerHealth: HealthView | null
	// The prior run's id when this run continues one (meta.continuesFrom), else null; the client renders the run view's lineage line from it.
	continuesFrom: string | null
	// Whether the operator can explicitly resume this run from its checkpoint: an error terminal or a suspended pause plus a checkpoint file on disk (the caller stats for it). False for every other status and when the checkpoint is gone.
	resumable: boolean
	// The run's raw plan Markdown (plan.md), read per request by the caller; never derived from the cached snapshot, which carries only meta and log text.
	plan: string | null
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
	// The raw plan Markdown the caller read for this run; omitted (absent document) and null both mean "no plan".
	plan?: string | null
	// Whether a checkpoint file exists for this run, read per request by the caller; omitted reads as false.
	checkpointExists?: boolean
	// The coarse provider health snapshot the caller read for this request; omitted reads as absent.
	providerHealth?: HealthView | null
}

export function renderRunView(snapshot: RunSnapshot, options: RenderRunViewOptions): RunView {
	const meta = snapshot.meta
	// recentLog is the last maxLogLines events carrying their log-wide indices, so a client can
	// page back or fetch a row's detail through the window endpoint without recomputing offsets.
	const recentStart = Math.max(0, snapshot.logEvents.length - options.maxLogLines)
	const recentLog: RecentLogEntry[] = snapshot.logEvents.slice(recentStart).map((event, position) => toRecentLogEntry(event, recentStart + position))
	return {
		status: meta === null ? 'unknown' : meta.status,
		runId: meta === null ? null : meta.runId,
		task: meta === null ? null : meta.task,
		effort: meta === null ? null : (meta.effort ?? null),
		involvement: meta === null ? null : (meta.involvement ?? null),
		startTime: meta === null ? null : meta.startTime,
		endTime: meta === null ? null : (meta.endTime ?? null),
		result: meta === null ? null : (meta.result ?? null),
		error: meta === null ? null : (meta.error ?? null),
		suspension: meta === null ? null : (meta.suspension ?? null),
		pause: meta === null ? null : (meta.pause ?? null),
		providerHealth: options.providerHealth ?? null,
		continuesFrom: meta === null ? null : (meta.continuesFrom ?? null),
		resumable: meta !== null && (meta.status === 'error' || meta.status === 'suspended') && options.checkpointExists === true,
		plan: options.plan ?? null,
		roles: deriveRoleActivity(snapshot.logEvents),
		roleTree: deriveRoleTree(snapshot.logEvents),
		recentLog,
		currentActivity: deriveCurrentActivity(snapshot.logEvents),
		questionHistory: deriveQuestionHistory(snapshot.logEvents),
		interrupts: deriveInterruptHistory(snapshot.logEvents),
		budgets: deriveBudgets(snapshot.logEvents, meta),
	}
}

export interface RunSummary {
	runId: string
	status: RunMeta['status'] | 'unknown'
	task: string | null
	effort: EffortLevel | null
	involvement: InvolvementLevel | null
	startTime: string | null
	endTime: string | null
	// The result card and run-level error ride along so the history view's expanded rows can browse outcomes without a per-run fetch; both already live in meta.json, so this is a passthrough, not a derivation.
	result: ResultCard | null
	error: NonNullable<RunMeta['error']> | null
	// The prior run's id when this run continues one (meta.continuesFrom), else null; history renders the summary's lineage line from it.
	continuesFrom: string | null
	// Present only while the run is suspended, so history rows and the banner can render the pause without a per-run fetch.
	suspension: SuspensionRecord | null
	// Present only while the run is operator-paused, alongside suspension for provider pauses.
	pause: OperatorPauseRecord | null
	// The LLM-generated one-line summary (summary.txt), when the summarizer has produced one; the client prefers it over the task first line and falls back when absent.
	summary: string | null
}

export function renderRunSummary(runId: string, meta: RunMeta | null, summary: string | null): RunSummary {
	return {
		runId,
		status: meta === null ? 'unknown' : meta.status,
		task: meta === null ? null : meta.task,
		effort: meta === null ? null : (meta.effort ?? null),
		involvement: meta === null ? null : (meta.involvement ?? null),
		startTime: meta === null ? null : meta.startTime,
		endTime: meta === null ? null : (meta.endTime ?? null),
		result: meta === null ? null : (meta.result ?? null),
		error: meta === null ? null : (meta.error ?? null),
		continuesFrom: meta === null ? null : (meta.continuesFrom ?? null),
		suspension: meta === null ? null : (meta.suspension ?? null),
		pause: meta === null ? null : (meta.pause ?? null),
		summary,
	}
}

export interface ProjectSettingsView {
	effort: EffortLevel | null
	involvement: InvolvementLevel | null
	logLevel: LogLevel | null
}

export function renderProjectSettings(settings: ProjectSettings): ProjectSettingsView {
	return { effort: settings.effort ?? null, involvement: settings.involvement ?? null, logLevel: settings.logLevel ?? null }
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
	// The baked image build identifier, or null when the process runs without one (a source checkout).
	build: BuildInfo | null
}

export function renderConfig(config: GuildConfig, deployment: DeploymentConfig, tools: Record<string, ToolManifest>, build: BuildInfo | null): GuildConfigView {
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
		model: { name: deployment.model.name, contextWindow: deployment.model.contextWindow },
		executor: deployment.executor,
		entryRole: config.entryRole,
		roles,
		tools: toolsView,
		build,
	}
	if (config.visualization !== undefined) view.visualization = config.visualization
	return view
}
