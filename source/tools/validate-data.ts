// Data-validity gate for the shipped Guild (guild/) and the benchmark suite (benchmarks/): loads every role prompt, tool manifest, and eval file and checks structural and cross-referential consistency, including that the manifest signatures match the handler tables they dispatch to.
// This reads the repo's data files by design, so it lives outside `bun test` (which runs purely in-memory). Run it via `bun run validate-data` after editing the Guild or the suite; it is also the data gate for image builds.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseEvalConfig, type EvalConfig } from '../benchmarks/validation.js'
import { createBuiltInToolHandlers } from '../executor/builtin-tools.js'
import { ERROR_KINDS } from '../executor/errors.js'
import { createGuildLoader, type LoadedGuild } from '../executor/loader.js'
import { createRoleRegistry } from '../executor/role-registry.js'
import { createToolHandlers } from '../executor/tools.js'
import type { HumanFacingText, ToolManifest } from '../executor/types.js'
import { validateToolManifest } from '../executor/validation.js'

const repoRoot = path.resolve(import.meta.dir, '..', '..')
const guildDir = path.join(repoRoot, 'guild')
const manifestDir = path.join(guildDir, 'tools')
const benchmarksDir = path.join(repoRoot, 'benchmarks')

const failures: string[] = []

function check(condition: boolean, message: string): void {
	if (!condition) failures.push(message)
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function isNonEmptyStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string')
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
	'orchestrator', 'planner', 'coder',
	'architecture_lead', 'architecture_reviewer',
	'style_lead', 'style_reviewer',
	'security_lead', 'security_reviewer',
	'acceptance_lead', 'acceptance_reviewer',
	'context_manager', 'recovery', 'loop_detector',
] as const

const expectedToolNames = new Set([
	'agent', 'finish', 'context_info', 'edit_context', 'ask_human',
	'list_directory', 'glob_files', 'read_file', 'read_file_partial', 'search_text', 'write_file', 'fetch_url', 'typecheck', 'test',
	'run_shell',
	'trigger_interrupt', 'list_role_messages', 'read_message_window', 'search_role_blocks', 'recent_role_tool_calls',
])

const nativeToolNames = new Set(['list_directory', 'glob_files', 'read_file', 'read_file_partial', 'search_text', 'write_file', 'fetch_url', 'typecheck', 'test', 'run_shell'])

const builtInToolNames = new Set(['agent', 'finish', 'context_info', 'edit_context', 'ask_human', 'trigger_interrupt', 'list_role_messages', 'read_message_window', 'search_role_blocks', 'recent_role_tool_calls'])

interface ExpectedSignature {
	file: string
	required: string[]
	properties: string[]
}

const expectedSignatures: ExpectedSignature[] = [
	{ file: 'list_directory.json', required: [], properties: ['path'] },
	{ file: 'glob_files.json', required: ['pattern'], properties: ['pattern'] },
	{ file: 'read_file.json', required: ['path'], properties: ['path'] },
	{ file: 'read_file_partial.json', required: ['path', 'offset', 'limit'], properties: ['path', 'offset', 'limit'] },
	{ file: 'search_text.json', required: ['pattern'], properties: ['pattern', 'paths'] },
	{ file: 'write_file.json', required: ['path', 'content'], properties: ['path', 'content'] },
	{ file: 'fetch_url.json', required: ['url'], properties: ['url'] },
	{ file: 'typecheck.json', required: [], properties: ['timeoutSeconds'] },
	{ file: 'test.json', required: [], properties: ['timeoutSeconds'] },
	{ file: 'run_shell.json', required: ['command'], properties: ['command', 'timeoutSeconds'] },
	{ file: 'trigger_interrupt.json', required: ['targetRole', 'action', 'reason'], properties: ['targetRole', 'action', 'reason'] },
	{ file: 'list_role_messages.json', required: ['targetRole'], properties: ['targetRole'] },
	{ file: 'read_message_window.json', required: ['targetRole', 'index', 'field', 'start', 'end'], properties: ['targetRole', 'index', 'field', 'start', 'end'] },
	{ file: 'search_role_blocks.json', required: ['targetRole', 'pattern'], properties: ['targetRole', 'pattern', 'kind', 'field', 'maxMatches'] },
	{ file: 'recent_role_tool_calls.json', required: ['targetRole'], properties: ['targetRole', 'limit'] },
	{ file: 'agent.json', required: ['role', 'task'], properties: ['role', 'task'] },
	{ file: 'finish.json', required: ['status', 'summary'], properties: ['status', 'summary', 'artifacts', 'error'] },
	{ file: 'context_info.json', required: [], properties: [] },
	{ file: 'edit_context.json', required: ['operations'], properties: ['operations'] },
	{ file: 'ask_human.json', required: ['question'], properties: ['question', 'context'] },
]

function loadGuildData(): LoadedGuild | null {
	try {
		return createGuildLoader()(guildDir)
	} catch (error) {
		failures.push(`guild: ${errorMessage(error)}`)
		return null
	}
}

function checkGuild(loaded: LoadedGuild): void {
	const config = loaded.config
	check(config.schemaVersion === 1, 'guild: schemaVersion must be 1')
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
	const triggers = config.executor.interruptTriggers
	if (triggers === undefined) {
		failures.push('guild: executor.interruptTriggers missing')
	} else {
		check(triggers.handlerRole === 'loop_detector', `guild: interrupt handler must be "loop_detector" (got "${triggers.handlerRole}")`)
		check(triggers.everyToolCalls > 0, 'guild: interruptTriggers.everyToolCalls must be positive')
		check(triggers.everyTokens > 0, 'guild: interruptTriggers.everyTokens must be positive')
		check(config.roles[triggers.handlerRole] !== undefined, `guild: interrupt handler role "${triggers.handlerRole}" is not declared`)
		if (triggers.planOwnerRole !== undefined) {
			check(config.roles[triggers.planOwnerRole] !== undefined, `guild: plan owner role "${triggers.planOwnerRole}" is not declared`)
		}
	}

	check(config.executor.maxAgentDepth >= 8, 'guild: maxAgentDepth must be at least 8 for long-horizon runs')
	check(config.executor.defaultToolTimeoutSeconds > 0, 'guild: defaultToolTimeoutSeconds must be positive')
	check(config.executor.maxCompactionAttempts > 0, 'guild: maxCompactionAttempts must be positive')
	check(config.contextPolicy.maxToolOutputChars > 0, 'guild: contextPolicy.maxToolOutputChars must be positive')

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

function loadManifest(file: string): ToolManifest | null {
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
		validateToolManifest(parsed)
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
		const manifest = loadManifest(signature.file)
		if (manifest === null) continue
		manifests.push(manifest)
		checkSameSet(`guild/tools/${signature.file}: required parameters`, new Set(manifest.parameters.required ?? []), new Set(signature.required))
		checkSameSet(`guild/tools/${signature.file}: declared properties`, new Set(Object.keys(manifest.parameters.properties ?? {})), new Set(signature.properties))
	}
	const manifestNames = manifests.map((m) => m.name)
	const duplicateNames = manifestNames.filter((name, index) => manifestNames.indexOf(name) !== index)
	check(new Set(manifestNames).size === manifestNames.length, `guild/tools: duplicate manifest names: ${[...new Set(duplicateNames)].join(', ')}`)

	const nativeHandlers = createToolHandlers({ workspaceRoot: manifestDir, defaultToolTimeoutSeconds: 30 })
	checkSameSet('native tool handler table', new Set(Object.keys(nativeHandlers)), nativeToolNames)
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
		contextWindow: 1000,
		roleRegistry: createRoleRegistry(),
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

const loaded = loadGuildData()
if (loaded !== null) checkGuild(loaded)
checkManifests()
checkBenchmarks()

if (failures.length > 0) {
	for (const failure of failures) console.error(`validate-data: FAIL ${failure}`)
	console.error(`validate-data: ${failures.length} failure(s)`)
	process.exitCode = 1
} else {
	console.log(`validate-data: OK (guild: ${expectedRoles.length} roles, ${expectedSignatures.length} tool manifests; benchmarks: suite valid)`)
}
