// Data-validity gate for the shipped Guild (guild/), the deployment file (deployment/), the benchmark suite (benchmarks/), and the web client's inlined favicon (source/web/static/): loads every role prompt, tool manifest, and eval file and checks structural and cross-referential consistency, including that the manifest signatures match the handler tables they dispatch to.
// This reads the repo's data files by design, so it lives outside `bun test` (which runs purely in-memory). Run it via `bun run validate-data` after editing the Guild, the deployment, or the suite; it is also the data gate for image builds.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseEvalConfig, type EvalConfig } from '../benchmarks/validation.js'
import { createBuiltInToolHandlers } from '../executor/builtin-tools.js'
import { ERROR_KINDS } from '../executor/errors.js'
import { createGuildLoader, type LoadedGuildFiles } from '../executor/loader.js'
import { LOG_FILE_NAME } from '../executor/persistence.js'
import { createRunParkTracker } from '../executor/park-state.js'
import { createRoleRegistry } from '../executor/role-registry.js'
import { createToolHandlers } from '../executor/tools.js'
import { createPlanToolHandlers } from '../executor/tools/plan.js'
import { createRunLogToolHandlers } from '../executor/tools/run-log.js'
import type { HumanFacingText, ToolManifest } from '../executor/types.js'
import { isNonEmptyStringArray, validateToolManifest } from '../executor/validation.js'
import { faviconHref } from '../web/static/favicon.js'

const repoRoot = path.resolve(import.meta.dir, '..', '..')
const guildDir = path.join(repoRoot, 'guild')
const deploymentPath = path.join(repoRoot, 'deployment', 'deployment.json')
const manifestDir = path.join(guildDir, 'tools')
const benchmarksDir = path.join(repoRoot, 'benchmarks')
const indexHtmlPath = path.join(repoRoot, 'source', 'web', 'static', 'index.html')

const failures: string[] = []

function check(condition: boolean, message: string): void {
	if (!condition) failures.push(message)
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function checkSameSet(label: string, actual: ReadonlySet<string>, expected: ReadonlySet<string>): void {
	const missing = [...expected].filter((name) => !actual.has(name))
	const extra = [...actual].filter((name) => !expected.has(name))
	check(missing.length === 0 && extra.length === 0, `${label}: missing [${missing.join(', ') || 'none'}], extra [${extra.join(', ') || 'none'}]`)
}

// detailed is required; whimsical and friendly are optional but must be non-empty when present (the shape itself is already enforced by the loader's validation — this guards presence and non-emptiness).
function checkTieredText(label: string, value: HumanFacingText | undefined): void {
	if (value === undefined) {
		failures.push(`${label}: missing`)
		return
	}
	check(isNonEmptyStringArray(value.detailed), `${label}.detailed: expected a non-empty string array`)
	if (value.whimsical !== undefined) check(isNonEmptyStringArray(value.whimsical), `${label}.whimsical: expected a non-empty string array`)
	if (value.friendly !== undefined) check(isNonEmptyStringArray(value.friendly), `${label}.friendly: expected a non-empty string array`)
}

// All three tiers are required, and the whimsical list needs more than one phrase so captions rotate instead of repeating.
function checkRotatingTieredText(label: string, value: HumanFacingText | undefined): void {
	if (value === undefined) {
		failures.push(`${label}: missing`)
		return
	}
	check(isNonEmptyStringArray(value.detailed), `${label}.detailed: expected a non-empty string array`)
	check(isNonEmptyStringArray(value.friendly), `${label}.friendly: expected a non-empty string array`)
	check(isNonEmptyStringArray(value.whimsical) && value.whimsical.length > 1, `${label}.whimsical: expected more than one phrase`)
}

const expectedRoles = [
	'orchestrator', 'planner', 'coder', 'researcher',
	'architecture_lead', 'architecture_reviewer',
	'style_lead', 'style_reviewer',
	'security_lead', 'security_reviewer',
	'acceptance_lead', 'acceptance_reviewer',
	'context_manager', 'recovery', 'loop_detector', 'inquiry_responder',
] as const

const expectedToolNames = new Set([
	'agent', 'finish', 'context_info', 'edit_context', 'ask_human',
	'list_directory', 'glob_files', 'read_file', 'read_file_partial', 'search_text', 'write_file', 'read_plan', 'write_plan', 'fetch_url', 'typecheck', 'test',
	'run_shell', 'repo_map', 'web_search',
	'read_run_log', 'search_run_log',
	'trigger_interrupt', 'list_role_messages', 'read_message_window', 'search_role_blocks', 'recent_role_tool_calls',
])

const nativeToolNames = new Set(['list_directory', 'glob_files', 'read_file', 'read_file_partial', 'search_text', 'write_file', 'read_plan', 'write_plan', 'read_run_log', 'search_run_log', 'fetch_url', 'typecheck', 'test', 'run_shell', 'repo_map', 'web_search'])

const builtInToolNames = new Set(['agent', 'finish', 'context_info', 'edit_context', 'ask_human', 'trigger_interrupt', 'list_role_messages', 'read_message_window', 'search_role_blocks', 'recent_role_tool_calls'])

interface ExpectedSignature {
	file: string
	required: string[]
	properties: string[]
	// Optional per-property JSON-schema type pins (checked by validateToolManifest) so a property whose type drifts fails the gate, not just one whose name or presence drifts.
	propertyTypes?: Record<string, string>
}

const expectedSignatures: ExpectedSignature[] = [
	{ file: 'list_directory.json', required: [], properties: ['path'] },
	{ file: 'glob_files.json', required: ['pattern'], properties: ['pattern', 'exclude'] },
	{ file: 'read_file.json', required: ['path'], properties: ['path'] },
	{ file: 'read_file_partial.json', required: ['path', 'offset', 'limit'], properties: ['path', 'offset', 'limit'] },
	{ file: 'search_text.json', required: ['pattern'], properties: ['pattern', 'paths'] },
	{ file: 'write_file.json', required: ['path', 'content'], properties: ['path', 'content'] },
	{ file: 'read_plan.json', required: [], properties: ['runId'] },
	{ file: 'write_plan.json', required: ['content'], properties: ['content'] },
	{ file: 'read_run_log.json', required: [], properties: ['offset', 'limit'] },
	{ file: 'search_run_log.json', required: ['query'], properties: ['query', 'type', 'limit'] },
	{ file: 'fetch_url.json', required: ['url'], properties: ['url', 'method'] },
	{ file: 'web_search.json', required: ['query'], properties: ['query', 'limit'] },
	{ file: 'repo_map.json', required: [], properties: ['path'] },
	{ file: 'typecheck.json', required: ['commands'], properties: ['commands', 'timeoutSeconds'], propertyTypes: { commands: 'array', timeoutSeconds: 'number' } },
	{ file: 'test.json', required: ['commands'], properties: ['commands', 'timeoutSeconds'], propertyTypes: { commands: 'array', timeoutSeconds: 'number' } },
	{ file: 'run_shell.json', required: ['command'], properties: ['command', 'timeoutSeconds'] },
	{ file: 'trigger_interrupt.json', required: ['targetRole', 'action', 'reason'], properties: ['targetRole', 'action', 'reason'] },
	{ file: 'list_role_messages.json', required: ['targetRole'], properties: ['targetRole'] },
	{ file: 'read_message_window.json', required: ['targetRole', 'index', 'field', 'start', 'end'], properties: ['targetRole', 'index', 'field', 'start', 'end'] },
	{ file: 'search_role_blocks.json', required: ['targetRole', 'pattern'], properties: ['targetRole', 'pattern', 'kind', 'field', 'maxMatches'] },
	{ file: 'recent_role_tool_calls.json', required: ['targetRole'], properties: ['targetRole', 'limit'] },
	{ file: 'agent.json', required: ['role', 'task'], properties: ['role', 'task'] },
	{ file: 'finish.json', required: ['status', 'summary'], properties: ['status', 'summary', 'artifacts', 'error'] },
	{ file: 'context_info.json', required: [], properties: ['targetRole'] },
	{ file: 'edit_context.json', required: ['operations'], properties: ['operations', 'targetRole'] },
	{ file: 'ask_human.json', required: ['question'], properties: ['question', 'context'] },
]

function loadGuildData(): LoadedGuildFiles | null {
	try {
		return createGuildLoader(deploymentPath)(guildDir)
	} catch (error) {
		failures.push(`guild: ${errorMessage(error)}`)
		return null
	}
}

function checkGuild(loaded: LoadedGuildFiles): void {
	const config = loaded.config
	const deployment = loaded.deployment
	check(config.entryRole === 'orchestrator', `guild: entryRole must be "orchestrator" (got "${config.entryRole}")`)
	for (const role of expectedRoles) {
		check(config.roles[role] !== undefined, `guild: missing role "${role}"`)
		const prompt = loaded.prompts[role]
		check(typeof prompt === 'string' && prompt.length > 0, `guild: role "${role}" has an empty or missing system prompt`)
	}

	checkSameSet('guild: declared tool manifests', new Set(Object.keys(loaded.tools)), expectedToolNames)
	check(config.tools.length === expectedToolNames.size, `guild: tools list has ${config.tools.length} entries, expected ${expectedToolNames.size}`)
	for (const [name, role] of Object.entries(config.roles)) {
		for (const toolName of role.tools) {
			check(expectedToolNames.has(toolName), `guild: role "${name}" references undeclared tool "${toolName}"`)
		}
	}

	const orchestrator = config.roles[config.entryRole]
	if (orchestrator === undefined) {
		failures.push('guild: entry role is not declared in roles')
	} else {
		for (const tool of ['agent', 'finish', 'ask_human']) {
			check(orchestrator.tools.includes(tool), `guild: orchestrator must hold "${tool}"`)
		}
	}
	const orchestratorPrompt = (loaded.prompts['orchestrator'] ?? '').toLowerCase()
	check(orchestratorPrompt.includes('clarifying'), 'guild: orchestrator prompt lacks clarifying-question guidance')
	check(orchestratorPrompt.includes('ask_human'), 'guild: orchestrator prompt does not mention ask_human')

	// These roles scale their behavior to the run's effort tier, so each prompt must name all three tier modes.
	for (const role of ['orchestrator', 'planner', 'coder', 'researcher', 'architecture_lead', 'style_lead', 'security_lead', 'acceptance_lead']) {
		const prompt = (loaded.prompts[role] ?? '').toLowerCase()
		for (const tier of ['quick mode', 'standard mode', 'thorough mode']) {
			check(prompt.includes(tier), `guild: role "${role}" prompt lacks the "${tier}" tier`)
		}
	}

	const recoveryPrompt = (loaded.prompts['recovery'] ?? '').toLowerCase()
	for (const kind of ERROR_KINDS) {
		check(recoveryPrompt.includes(kind), `guild: recovery prompt does not cover error kind "${kind}"`)
	}

	for (const role of expectedRoles) {
		if (!role.endsWith('_lead')) continue
		const lead = config.roles[role]
		if (lead === undefined) continue
		check(lead.tools.includes('agent'), `guild: lead "${role}" must delegate (agent)`)
		check(lead.tools.includes('finish'), `guild: lead "${role}" must hold "finish"`)
		check(!lead.tools.includes('write_file') && !lead.tools.includes('read_file'), `guild: lead "${role}" must not hold workspace tools`)
	}
	for (const role of expectedRoles) {
		if (!role.endsWith('_reviewer')) continue
		const reviewer = config.roles[role]
		if (reviewer === undefined) continue
		check(!reviewer.tools.includes('agent'), `guild: reviewer "${role}" must not delegate`)
		check(!reviewer.tools.includes('write_file'), `guild: reviewer "${role}" must be read-only`)
		check(reviewer.tools.includes('read_file'), `guild: reviewer "${role}" must hold "read_file"`)
		// The shared reviewer contract: severity tags and the compact-digest return.
		const prompt = (loaded.prompts[role] ?? '').toLowerCase()
		check(prompt.includes('blocking'), `guild: reviewer "${role}" prompt lacks the "blocking" severity tag`)
		check(prompt.includes('suggestion'), `guild: reviewer "${role}" prompt lacks the "suggestion" severity tag`)
	}

	const detector = config.roles['loop_detector']
	if (detector === undefined) {
		failures.push('guild: missing role "loop_detector"')
	} else {
		// The handler inspects (read-only), decides (trigger_interrupt), and finishes — it cannot delegate or touch the workspace.
		for (const tool of ['list_role_messages', 'read_message_window', 'search_role_blocks', 'recent_role_tool_calls', 'trigger_interrupt', 'finish']) {
			check(detector.tools.includes(tool), `guild: loop_detector must hold "${tool}"`)
		}
		check(!detector.tools.includes('agent') && !detector.tools.includes('write_file'), 'guild: loop_detector must not delegate or touch the workspace')
	}
	const contextManager = config.roles['context_manager']
	if (contextManager === undefined) {
		failures.push('guild: missing role "context_manager"')
	} else {
		// The compaction handler inspects the suspended target (read-only), prunes it (context tools), and finishes — it cannot delegate or touch the workspace.
		for (const tool of ['context_info', 'edit_context', 'list_role_messages', 'read_message_window', 'search_role_blocks', 'recent_role_tool_calls', 'finish']) {
			check(contextManager.tools.includes(tool), `guild: context_manager must hold "${tool}"`)
		}
		check(!contextManager.tools.includes('agent') && !contextManager.tools.includes('write_file'), 'guild: context_manager must not delegate or touch the workspace')
	}
	const researcher = config.roles['researcher']
	if (researcher === undefined) {
		failures.push('guild: missing role "researcher"')
	} else {
		// The researcher is a read-only leaf: it digests broad exploration into compact briefs and cannot delegate, mutate, or run checkers.
		checkSameSet('guild: researcher tools', new Set(researcher.tools), new Set(['list_directory', 'glob_files', 'read_file', 'read_file_partial', 'search_text', 'repo_map', 'web_search', 'fetch_url', 'finish']))
		const prompt = (loaded.prompts['researcher'] ?? '').toLowerCase()
		check(prompt.includes('brief'), 'guild: researcher prompt lacks the compact-brief contract')
		check(prompt.includes('cite'), 'guild: researcher prompt lacks the cite-your-sources guidance')
	}
	// The run-log tools expose every role's full conversations, so they must stay exclusive to the inquiry handler — the one read-only, handler-only role the platform invokes for operator questions.
	for (const [name, role] of Object.entries(config.roles)) {
		for (const runLogTool of ['read_run_log', 'search_run_log']) {
			check(role.tools.includes(runLogTool) === (name === 'inquiry_responder'), `guild: run-log tool "${runLogTool}" must be held only by "inquiry_responder" (found on "${name}")`)
		}
	}
	check(deployment.executor.contextHandlerRole === 'context_manager', `deployment: executor.contextHandlerRole must be "context_manager" (got "${deployment.executor.contextHandlerRole ?? 'undefined'}")`)
	const triggers = deployment.executor.interruptTriggers
	if (triggers === undefined) {
		failures.push('deployment: executor.interruptTriggers missing')
	} else {
		check(triggers.handlerRole === 'loop_detector', `deployment: interrupt handler must be "loop_detector" (got "${triggers.handlerRole}")`)
		check(triggers.everyToolCalls > 0, 'deployment: interruptTriggers.everyToolCalls must be positive')
		check(triggers.everyTokens > 0, 'deployment: interruptTriggers.everyTokens must be positive')
	}
	check(deployment.model.apiBase.length > 0, 'deployment: model.apiBase must not be empty')

	check(deployment.executor.maxAgentDepth >= 8, 'deployment: maxAgentDepth must be at least 8 for long-horizon runs')
	check(deployment.executor.defaultToolTimeoutSeconds > 0, 'deployment: defaultToolTimeoutSeconds must be positive')
	check(deployment.executor.maxCompactionAttempts > 0, 'deployment: maxCompactionAttempts must be positive')
	check(deployment.contextPolicy.maxToolOutputChars > 0, 'deployment: contextPolicy.maxToolOutputChars must be positive')

	for (const [name, role] of Object.entries(config.roles)) {
		checkTieredText(`guild: role "${name}" label`, role.label)
		checkTieredText(`guild: role "${name}" description`, role.description)
		checkRotatingTieredText(`guild: role "${name}" workingLabel`, role.workingLabel)
	}
	const workingTemplates = config.visualization?.workingTemplates
	if (workingTemplates === undefined) {
		failures.push('guild: visualization.workingTemplates missing')
	} else {
		checkTieredText('guild: visualization workingTemplates.role', workingTemplates['role'])
		checkTieredText('guild: visualization workingTemplates.tool', workingTemplates['tool'])
	}
	for (const [name, tool] of Object.entries(loaded.tools)) {
		checkTieredText(`guild: tool "${name}" humanLabel`, tool.humanLabel)
		checkTieredText(`guild: tool "${name}" humanDescription`, tool.humanDescription)
		checkRotatingTieredText(`guild: tool "${name}" humanCallLabel`, tool.humanCallLabel)
		checkRotatingTieredText(`guild: tool "${name}" humanWorkingLabel`, tool.humanWorkingLabel)
	}
}

function loadManifest(signature: ExpectedSignature): ToolManifest | null {
	const file = signature.file
	const filePath = path.join(manifestDir, file)
	if (!fs.existsSync(filePath)) {
		failures.push(`guild/tools: missing manifest "${file}"`)
		return null
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
	} catch (error) {
		failures.push(`guild/tools/${file}: unreadable — ${errorMessage(error)}`)
		return null
	}
	try {
		validateToolManifest(parsed, signature.propertyTypes)
	} catch (error) {
		failures.push(`guild/tools/${file}: ${errorMessage(error)}`)
		return null
	}
	return parsed
}

function checkManifests(): void {
	if (!fs.existsSync(manifestDir)) {
		failures.push('guild/tools: directory missing')
		return
	}
	checkSameSet('guild/tools: manifest files', new Set(fs.readdirSync(manifestDir)), new Set(expectedSignatures.map((s) => s.file)))

	const manifests: ToolManifest[] = []
	for (const signature of expectedSignatures) {
		const manifest = loadManifest(signature)
		if (manifest === null) continue
		manifests.push(manifest)
		checkSameSet(`guild/tools/${signature.file}: required parameters`, new Set(manifest.parameters.required ?? []), new Set(signature.required))
		checkSameSet(`guild/tools/${signature.file}: declared properties`, new Set(Object.keys(manifest.parameters.properties ?? {})), new Set(signature.properties))
	}
	const manifestNames = manifests.map((m) => m.name)
	const duplicateNames = manifestNames.filter((name, index) => manifestNames.indexOf(name) !== index)
	check(new Set(manifestNames).size === manifestNames.length, `guild/tools: duplicate manifest names: ${[...new Set(duplicateNames)].join(', ')}`)

	// Plan and run-log handlers close over their run's directory (they are bound per run in the server), so the gate constructs them over fixture bindings it never invokes, solely to compare the full native handler table.
	const nativeHandlers = {
		...createToolHandlers({ workspaceRoot: manifestDir, defaultToolTimeoutSeconds: 30 }),
		...createPlanToolHandlers({ runsBaseDir: manifestDir, runId: 'run-19700101-000000', workspaceRoot: repoRoot }),
		...createRunLogToolHandlers({ logPath: path.join(manifestDir, LOG_FILE_NAME) }),
	}
	checkSameSet('native tool handler table', new Set(Object.keys(nativeHandlers)), nativeToolNames)
	// Shape-only fixture: the handlers are compared by name and never invoked, so the guild stub only has to type-check.
	const builtInHandlers = createBuiltInToolHandlers({
		spawnAgent: async () => ({ status: 'success', summary: '' }),
		roleState: {
			history: [],
			lastPromptTokens: 0,
			recentCompactionPromptTokens: [],
			recentToolCalls: [],
			toolCallCount: 0,
			generatedTokens: 0,
			contextExceededAttempts: 0,
			loopCheckToolCallWatermark: 0,
			loopCheckTokenWatermark: 0,
		},
		humanBackend: { ask: async () => '' },
		loadedGuild: {
			config: { entryRole: '', roles: {}, tools: [] },
			deployment: {
				model: { name: '', apiBase: '', contextWindow: 1000, generation: {} },
				executor: { maxAgentDepth: 8, defaultToolTimeoutSeconds: 30, maxCompactionAttempts: 5 },
				contextPolicy: { maxToolOutputChars: 4000 },
			},
			prompts: {},
			tools: {},
		},
		roleRegistry: createRoleRegistry(),
		ownRoleId: 'fixture-0-0',
		appendLog: () => undefined,
		parkTracker: createRunParkTracker(),
	})
	checkSameSet('built-in tool handler table', new Set(Object.keys(builtInHandlers)), builtInToolNames)
	for (const manifest of manifests) {
		if (nativeToolNames.has(manifest.name)) check(manifest.name in nativeHandlers, `guild/tools: native handler missing for "${manifest.name}"`)
		if (builtInToolNames.has(manifest.name)) check(manifest.name in builtInHandlers, `guild/tools: built-in handler missing for "${manifest.name}"`)
	}
}

function checkBenchmarks(): void {
	if (!fs.existsSync(benchmarksDir)) {
		failures.push('benchmarks: directory missing')
		return
	}
	const names = fs.readdirSync(benchmarksDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()
	check(names.length >= 5, `benchmarks: expected at least 5 benchmarks (smoke plus quick-fix), found ${names.length}`)
	check(names.includes('hello_001'), 'benchmarks: missing the hello_001 smoke benchmark')

	const configs = new Map<string, EvalConfig>()
	for (const name of names) {
		const evalPath = path.join(benchmarksDir, name, 'eval.json')
		if (!fs.existsSync(evalPath)) {
			failures.push(`benchmarks/${name}: eval.json missing`)
			continue
		}
		let config: EvalConfig
		try {
			config = parseEvalConfig(JSON.parse(fs.readFileSync(evalPath, 'utf8')))
		} catch (error) {
			failures.push(`benchmarks/${name}/eval.json: ${errorMessage(error)}`)
			continue
		}
		configs.set(name, config)
		check(config.taskType.length > 0, `benchmarks/${name}: taskType is empty`)
		check(config.description.length > 0, `benchmarks/${name}: description is empty`)
		check(config.validation.command.length > 0, `benchmarks/${name}: validation.command is empty`)
		const readmePath = path.join(benchmarksDir, name, 'README.md')
		if (!fs.existsSync(readmePath)) {
			failures.push(`benchmarks/${name}: README.md (the task description) missing`)
			continue
		}
		check(fs.readFileSync(readmePath, 'utf8').trim().length > 0, `benchmarks/${name}: README.md is empty`)
	}

	const medium = names.filter((name) => configs.get(name)?.taskType === 'medium').sort()
	check(medium.length >= 2, `benchmarks: expected at least two medium benchmarks, found ${medium.length}`)
	for (const name of ['add_cli_flag', 'feature_add_endpoint', 'refactor_extract_module']) {
		check(medium.includes(name), `benchmarks: missing medium benchmark "${name}"`)
	}
	const large = names.filter((name) => configs.get(name)?.taskType === 'large').sort()
	check(large.length >= 1, 'benchmarks: expected at least one large benchmark')
	check(large.includes('project_todo_cli'), 'benchmarks: missing large benchmark "project_todo_cli"')
}

// The index.html icon href hand-duplicates faviconHref('complete'), and the two can silently drift; pinning them here keeps the inline default and the JS module from diverging (the module comment in source/web/static/favicon.js documents the pairing).
function checkIndexHtmlFavicon(): void {
	if (!fs.existsSync(indexHtmlPath)) {
		failures.push('source/web/static: index.html missing')
		return
	}
	const iconMatch = fs.readFileSync(indexHtmlPath, 'utf8').match(/<link rel="icon" href="([^"]+)"/)
	if (iconMatch === null) {
		failures.push('source/web/static/index.html: <link rel="icon"> not found')
		return
	}
	const iconHref = iconMatch[1]
	if (iconHref === undefined) {
		failures.push('source/web/static/index.html: <link rel="icon"> has no href')
		return
	}
	const expectedHref = faviconHref('complete')
	check(iconHref === expectedHref, `source/web/static/index.html: the <link rel="icon"> href does not match faviconHref('complete') from source/web/static/favicon.js — regenerate it from favicon.js`)
}

const loaded = loadGuildData()
if (loaded !== null) checkGuild(loaded)
checkManifests()
checkBenchmarks()
checkIndexHtmlFavicon()

if (failures.length > 0) {
	for (const failure of failures) console.error(`validate-data: FAIL ${failure}`)
	console.error(`validate-data: ${failures.length} failure(s)`)
	process.exitCode = 1
} else {
	console.log(`validate-data: OK (guild: ${expectedRoles.length} roles, ${expectedSignatures.length} tool manifests; deployment: valid; benchmarks: suite valid)`)
}
