// Dev-only fixture data for the flow-graph visualization.
// Each scenario is a sequence of frames, and every frame is a full { config, runView, now } snapshot shaped exactly like the real /api/config and /api/runs/:id responses — plus the future human-facing label/description tiers on roles and tools that the guild schema will gain. The derivation functions consume these frames identically to the live API shape, so swapping in real data is a data-source change rather than a rewrite.
// This module is throwaway iteration scaffolding and is browser-pure (no imports): the dev playback harness loads it directly, and fixtures.test.ts validates every frame against the real RunView/config shape so a malformed fixture fails loudly instead of producing a confusing visual.
// The friendly labels here approximate what a guild author would write; the authoritative labels arrive with the guild schema's tiered label/description fields.

// Timestamps are derived from a fixed base so frames are deterministic and ordered; the playback harness and the shape tests never depend on the wall clock.
const BASE_MS = Date.parse('2026-06-26T09:00:00.000Z')
function t(seconds) {
	return new Date(BASE_MS + seconds * 1000).toISOString()
}

// A tiered label/description block: `detailed` is always present (the required tier); `friendly` and `playful` are optional tiers a guild author may omit.
function tier(detailed, friendly, playful) {
	const value = { detailed }
	if (friendly !== undefined) value.friendly = friendly
	if (playful !== undefined) value.playful = playful
	return value
}

// The mock /api/config response: the renderConfig output shape (model name + context window, executor budgets, entry role, per-role tool lists) extended with the future tiered `label`/`description` on each role and a `tools` map carrying `humanLabel`/`humanDescription` per tool. The guild is loaded once at startup and never mutated, so every frame shares this same config.
const mockConfig = {
	model: { name: 'qwen3.6:35b-a3b-q4_K_M', contextWindow: 262144 },
	executor: {
		maxAgentDepth: 8,
		defaultToolTimeoutSeconds: 30,
		maxCompactionAttempts: 5,
	},
	entryRole: 'orchestrator',
	roles: {
		orchestrator: {
			tools: ['agent', 'ask_human', 'finish'],
			label: tier('Orchestrator', 'The conductor', 'Air-traffic control for the guild'),
			description: tier('Decides which role to delegate to and assembles the final answer.', 'Picks the right specialist for each step and writes your answer.'),
		},
		planner: {
			tools: ['read_file', 'glob_files', 'search_text', 'finish'],
			label: tier('Planner', 'The planner', 'Sketches the map before the build'),
			description: tier('Reads the workspace and breaks the task into concrete steps.', 'Looks around and figures out the plan of attack.'),
		},
		coder: {
			tools: ['read_file', 'write_file', 'glob_files', 'search_text', 'typecheck', 'test', 'finish'],
			label: tier('Coder', 'The builder', 'Hands on the keyboard'),
			description: tier('Writes and edits files, then checks them with typecheck and tests.', 'Makes the changes, file by file.'),
		},
		critic: {
			tools: ['read_file', 'search_text', 'finish'],
			label: tier('Critic', 'The reviewer', 'Red team, one pass'),
			description: tier('Reviews the coder\u2019s work for mistakes before it ships.', 'Checks the work and calls out problems.'),
		},
		context_manager: {
			tools: ['edit_context', 'context_info', 'finish'],
			label: tier('Context manager', 'The librarian', 'Keeps the conversation tidy'),
			description: tier('Compacts a role\u2019s conversation when it nears the context window.', 'Trims the history so a long run keeps its train of thought.'),
		},
		recovery: {
			tools: ['read_file', 'search_text', 'agent', 'finish'],
			label: tier('Recovery', 'The fixer', 'Picks up the pieces'),
			description: tier('Takes over when a role errors and tries to recover the run.', 'Steps in when something goes wrong and gets the run back on track.'),
		},
		loop_detector: {
			tools: ['list_role_messages', 'read_message_window', 'search_role_blocks', 'recent_role_tool_calls', 'trigger_interrupt', 'finish'],
			label: tier('Loop detector', 'The watchdog', 'Spots a stuck run'),
			description: tier('Inspects a role\u2019s recent activity and interrupts when it detects a repetition loop.', 'Catches a run that is going in circles.'),
		},
	},
	tools: {
		agent: {
			humanLabel: tier('Delegate to a role', 'Hand off to a specialist'),
			humanDescription: tier('Asks another role to take over a sub-task.', 'Calls in another role to handle a piece of the work.'),
		},
		ask_human: {
			humanLabel: tier('Ask you a question', 'Check with you'),
			humanDescription: tier('Asks the human a clarifying question and waits for the answer.', 'Needs your input before continuing.'),
		},
		finish: {
			humanLabel: tier('Finish', 'Wrap up'),
			humanDescription: tier('Ends the current role and returns its result.', 'Done with this step.'),
		},
		read_file: {
			humanLabel: tier('Read a file', 'Open a file'),
			humanDescription: tier('Reads a file\u2019s full contents.', 'Looks inside a file.'),
		},
		write_file: {
			humanLabel: tier('Write a file', 'Save a file'),
			humanDescription: tier('Writes or overwrites a file.', 'Creates or updates a file.'),
		},
		glob_files: {
			humanLabel: tier('Find files by name', 'Search for files'),
			humanDescription: tier('Lists files matching a glob pattern.', 'Finds files by name pattern.'),
		},
		search_text: {
			humanLabel: tier('Search file contents', 'Search the code'),
			humanDescription: tier('Searches for a pattern across files.', 'Looks for text inside the files.'),
		},
		typecheck: {
			humanLabel: tier('Run the type checker', 'Type-check'),
			humanDescription: tier('Runs the workspace\u2019s type checker.', 'Catches type errors.'),
		},
		test: {
			humanLabel: tier('Run the tests', 'Run tests'),
			humanDescription: tier('Runs the workspace\u2019s test suite.', 'Runs the tests.'),
		},
		edit_context: {
			humanLabel: tier('Edit the conversation', 'Trim the history'),
			humanDescription: tier('Compacts or edits a role\u2019s message history.', 'Cuts down the conversation so it fits.'),
		},
		context_info: {
			humanLabel: tier('Inspect context usage', 'Check the context window'),
			humanDescription: tier('Reports how full a role\u2019s context window is.', 'Tells you how much room is left.'),
		},
		trigger_interrupt: {
			humanLabel: tier('Trigger an interrupt', 'Pull the fire alarm'),
			humanDescription: tier('Fires an interrupt that suspends the running role.', 'Stops a stuck run so it can be redirected.'),
		},
		list_role_messages: {
			humanLabel: tier('List a role\u2019s messages', 'Peek at a role\u2019s history'),
			humanDescription: tier('Lists the message windows of another role\u2019s conversation.', 'Sees what another role has been saying.'),
		},
		read_message_window: {
			humanLabel: tier('Read a message window', 'Read a slice of history'),
			humanDescription: tier('Reads a bounded window of messages from another role.', 'Looks at a chunk of another role\u2019s conversation.'),
		},
		search_role_blocks: {
			humanLabel: tier('Search a role\u2019s blocks', 'Search another role\u2019s thinking'),
			humanDescription: tier('Searches the content blocks of another role\u2019s messages.', 'Finds text in what another role said or thought.'),
		},
		recent_role_tool_calls: {
			humanLabel: tier('List recent tool calls', 'Check recent tool use'),
			humanDescription: tier('Lists another role\u2019s most recent tool calls.', 'Sees what tools another role has been calling.'),
		},
	},
}

// A larger guild config (~15 roles) for the large-guild stress scenario, so the static layout (which seeds from the config's role set) exercises a crowded graph. The tools map reuses the base config's tool metadata since the same tool surface applies.
const largeGuildConfig = {
	model: mockConfig.model,
	executor: mockConfig.executor,
	entryRole: 'orchestrator',
	roles: {
		orchestrator: { tools: ['agent', 'ask_human', 'finish'], label: tier('Orchestrator', 'The conductor'), description: tier('Decides which role to delegate to and assembles the final answer.') },
		planner: { tools: ['read_file', 'glob_files', 'search_text', 'finish'], label: tier('Planner', 'The planner'), description: tier('Reads the workspace and breaks the task into concrete steps.') },
		coder: { tools: ['read_file', 'write_file', 'glob_files', 'search_text', 'typecheck', 'test', 'finish'], label: tier('Coder', 'The builder'), description: tier('Writes and edits files, then checks them.') },
		critic: { tools: ['read_file', 'search_text', 'finish'], label: tier('Critic', 'The reviewer'), description: tier('Reviews the coder\u2019s work for mistakes.') },
		context_manager: { tools: ['edit_context', 'context_info', 'finish'], label: tier('Context manager', 'The librarian'), description: tier('Compacts a role\u2019s conversation when it nears the context window.') },
		recovery: { tools: ['read_file', 'search_text', 'agent', 'finish'], label: tier('Recovery', 'The fixer'), description: tier('Takes over when a role errors.') },
		researcher: { tools: ['read_file', 'glob_files', 'search_text', 'fetch_url', 'finish'], label: tier('Researcher', 'The scout'), description: tier('Gathers information from the workspace and the web.') },
		tester: { tools: ['read_file', 'write_file', 'test', 'finish'], label: tier('Tester', 'The QA engineer'), description: tier('Writes and runs tests for the new code.') },
		reviewer: { tools: ['read_file', 'search_text', 'finish'], label: tier('Reviewer', 'The code reviewer'), description: tier('Reviews a pull request for style and correctness.') },
		debugger: { tools: ['read_file', 'search_text', 'test', 'finish'], label: tier('Debugger', 'The detective'), description: tier('Tracks down the root cause of a failing test.') },
		documenter: { tools: ['read_file', 'write_file', 'glob_files', 'finish'], label: tier('Documenter', 'The tech writer'), description: tier('Writes documentation for the changes.') },
		refactorer: { tools: ['read_file', 'write_file', 'typecheck', 'test', 'finish'], label: tier('Refactorer', 'The cleaner'), description: tier('Restructures code without changing behavior.') },
		architect: { tools: ['read_file', 'glob_files', 'search_text', 'finish'], label: tier('Architect', 'The designer'), description: tier('Designs the module structure for a large feature.') },
		data_analyst: { tools: ['read_file', 'search_text', 'test', 'finish'], label: tier('Data analyst', 'The number cruncher'), description: tier('Analyzes data files and writes summary reports.') },
		security_auditor: { tools: ['read_file', 'search_text', 'glob_files', 'finish'], label: tier('Security auditor', 'The sentinel'), description: tier('Audits the changes for security issues.') },
	},
	tools: {
		...mockConfig.tools,
		fetch_url: {
			humanLabel: tier('Fetch a URL', 'Open a web page'),
			humanDescription: tier('Fetches the content of a URL.', 'Pulls down a web page to read.'),
		},
	},
}

// --- FlowModel builders -----------------------------------------------------
// The flow view is a render-only client: each frame carries a hand-authored `flowModel` shaped exactly like the future /api/runs/:id/flow endpoint response. The model is current-state, not history: the main area holds the active call-stack chain plus lingering response legs (a finished child or in-flight tool whose caller has not yet acted), and the top bar holds one node per role-type/tool-type/"You" that has ever run with cumulative stats. "Backwards always means return": a repeated role is a new node at the next column (a forward call edge), and the only right-to-left movement is a return edge.
// The friendly labels are resolved from the same config the frame carries, so the model's labels match the guild a real endpoint would read.

function roleLabel(role, config) {
	const entry = (config ?? mockConfig).roles[role]
	if (entry === undefined) return role
	return entry.label.friendly ?? entry.label.detailed ?? role
}

function toolLabel(tool, config) {
	const entry = (config ?? mockConfig).tools[tool]
	if (entry === undefined) return tool
	return entry.humanLabel.friendly ?? entry.humanLabel.detailed ?? tool
}

// A main-area node: `kind` distinguishes the root/child human ("you"), a role invocation, or a tool invocation. `column` is call depth (You = 0) and `row` is 0 for the single root (interrupts add rows). Per-invocation cost fields are part of the future-API shape and populated with plausible values so the view exercises them; the backend derivation that produces them for real is a later step.
function flowNode(p) {
	const node = {
		id: p.id,
		kind: p.kind,
		label: p.label,
		column: p.column,
		row: p.row ?? 0,
	}
	if (p.sublabel !== undefined) node.sublabel = p.sublabel
	if (p.status !== undefined) node.status = p.status
	if (p.active !== undefined) node.active = p.active
	if (p.counter !== undefined) node.counter = p.counter
	if (p.costTime !== undefined) node.costTime = p.costTime
	if (p.costTokens !== undefined) node.costTokens = p.costTokens
	return node
}

// A main-area edge. `kind` is 'call' (forward, left→right), 'return' (lingering response, right→left), or 'question' (an agent→You ask_human edge).
function flowEdge(from, to, kind) {
	return { from, to, kind }
}

// A top-bar history node: cumulative invocations plus optional cumulative cost and a terminal status so a failed role's slot reads at a glance.
function topBarNode(p) {
	const node = {
		id: p.id,
		kind: p.kind,
		label: p.label,
		invocations: p.invocations,
	}
	if (p.totalTime !== undefined) node.totalTime = p.totalTime
	if (p.totalTokens !== undefined) node.totalTokens = p.totalTokens
	if (p.status !== undefined) node.status = p.status
	return node
}

function flowModel(mainArea, topBar) {
	return { mainArea, topBar }
}

// --- RunView builders -------------------------------------------------------
// Each builder fills the full field set with sensible defaults so a frame only spells out what the scenario exercises; the shape test confirms every frame still conforms to the real RunView/config shape.

function tokenBreakdown(promptTokens, completionTokens, cachedPromptTokens) {
	return {
		promptTokens,
		cachedPromptTokens: cachedPromptTokens ?? 0,
		completionTokens,
		totalTokens: promptTokens + completionTokens,
	}
}

function budgets(p) {
	return {
		elapsedSeconds: p.elapsedSeconds ?? 0,
		toolCalls: p.toolCalls ?? 0,
		tokensUsed: p.tokensUsed ?? null,
		tokenBreakdown: p.tokenBreakdown ?? null,
	}
}

function roleActivity(p) {
	return {
		role: p.role,
		firstSeen: p.firstSeen,
		lastSeen: p.lastSeen,
		eventCount: p.eventCount ?? 0,
		llmCalls: p.llmCalls ?? 0,
		toolCalls: p.toolCalls ?? 0,
		recentTools: p.recentTools ?? [],
		lastPromptTokens: p.lastPromptTokens ?? null,
	}
}

function treeNode(p) {
	return {
		role: p.role,
		depth: p.depth ?? 0,
		parent: p.parent ?? null,
		status: p.status ?? null,
		summary: p.summary ?? null,
		active: p.active ?? false,
		children: p.children ?? [],
	}
}

function logEntry(p) {
	return {
		timestamp: p.timestamp,
		type: p.type,
		summary: p.summary,
		payload: p.payload,
		detailSections: p.detailSections ?? null,
	}
}

function question(p) {
	const entry = { id: p.id ?? null, question: p.question, askedAt: p.askedAt }
	if (p.context !== undefined) entry.context = p.context
	if (p.answer !== undefined) {
		entry.answer = p.answer
		entry.answeredAt = p.answeredAt
	}
	return entry
}

function runView(p) {
	return {
		status: p.status ?? 'unknown',
		runId: p.runId ?? null,
		task: p.task ?? null,
		effort: p.effort ?? null,
		startTime: p.startTime ?? null,
		endTime: p.endTime ?? null,
		result: p.result ?? null,
		error: p.error ?? null,
		roles: p.roles ?? [],
		roleTree: p.roleTree ?? null,
		recentLog: p.recentLog ?? [],
		currentActivity: p.currentActivity ?? null,
		questionHistory: p.questionHistory ?? [],
		budgets: p.budgets ?? budgets({}),
	}
}

// A frame pins a stable config alongside the per-frame run view and a `now` the elapsed-time derivation consumes; `now` advances with the frame so the cost strip reads naturally during playback. The config defaults to the base mock guild; scenarios that need a different guild shape (the large-guild stress case) pass their own.
function frame(runViewOverrides, nowSeconds, config) {
	// `config` and `flowModel` may be passed inline on the overrides object (the large-guild scenario keeps its per-frame data together this way); pulling them out here keeps them from leaking into the run-view builder as unknown fields.
	const { config: configInOverrides, flowModel: flowModelInOverrides, ...runViewFields } = runViewOverrides
	const configSnapshot = config ?? configInOverrides ?? mockConfig
	const frameSnapshot = { config: configSnapshot, runView: runView(runViewFields), now: t(nowSeconds) }
	if (flowModelInOverrides !== undefined) frameSnapshot.flowModel = flowModelInOverrides
	return frameSnapshot
}

// --- Scenarios --------------------------------------------------------------
// Each scenario steps through a run\u2019s progress so the animation has a timeline to play. The log-event taxonomy mirrors source/executor/types.ts (role_start, agent_call, llm_call, tool_call, tool_result, role_finished, ask_human, human_answer, effort_set).

const singleRoleInProgress = {
	id: 'single-role-in-progress',
	label: 'Single role in progress (planner thinking)',
	description: 'The entry role is mid-thought: no delegation yet, the planner node is the active path.',
	frames: [
		frame({
			status: 'unknown',
			task: 'Plan how to add a dark mode toggle to the settings page.',
			startTime: t(0),
			currentActivity: { role: 'planner', summary: 'planner \u00b7 role start' },
			roles: [roleActivity({ role: 'planner', firstSeen: t(1), lastSeen: t(1), eventCount: 1, llmCalls: 0 })],
			roleTree: [treeNode({ role: 'planner', depth: 0, active: true })],
			recentLog: [logEntry({ timestamp: t(1), type: 'role_start', summary: 'planner \u00b7 role start', payload: { role: 'planner', depth: 0, task: 'Plan how to add a dark mode toggle' } })],
			budgets: budgets({ elapsedSeconds: 2 }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 1, active: true, costTime: 2 })], edges: [flowEdge('you', 'planner', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1 })] },
			),
		}, 2),
		frame({
			status: 'unknown',
			task: 'Plan how to add a dark mode toggle to the settings page.',
			startTime: t(0),
			currentActivity: { role: 'planner', summary: 'planner \u00b7 llm call' },
			roles: [roleActivity({ role: 'planner', firstSeen: t(1), lastSeen: t(4), eventCount: 2, llmCalls: 1, lastPromptTokens: 4200 })],
			roleTree: [treeNode({ role: 'planner', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(1), type: 'role_start', summary: 'planner \u00b7 role start', payload: { role: 'planner', depth: 0, task: 'Plan how to add a dark mode toggle' } }),
				logEntry({ timestamp: t(4), type: 'llm_call', summary: 'planner \u00b7 llm call', payload: { role: 'planner', usage: { promptTokens: 4200, completionTokens: 180, totalTokens: 4380 } }, detailSections: [{ label: 'usage', content: { promptTokens: 4200, completionTokens: 180, totalTokens: 4380 } }] }),
			],
			budgets: budgets({ elapsedSeconds: 5, tokensUsed: 4380, tokenBreakdown: tokenBreakdown(4200, 180) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 1, active: true, costTime: 5, costTokens: 4380 })], edges: [flowEdge('you', 'planner', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 5, totalTokens: 4380 })] },
			),
		}, 5),
		frame({
			status: 'unknown',
			task: 'Plan how to add a dark mode toggle to the settings page.',
			startTime: t(0),
			currentActivity: { role: 'planner', summary: 'planner \u00b7 glob_files' },
			roles: [roleActivity({ role: 'planner', firstSeen: t(1), lastSeen: t(9), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['glob_files'], lastPromptTokens: 4200 })],
			roleTree: [treeNode({ role: 'planner', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(1), type: 'role_start', summary: 'planner \u00b7 role start', payload: { role: 'planner', depth: 0, task: 'Plan how to add a dark mode toggle' } }),
				logEntry({ timestamp: t(4), type: 'llm_call', summary: 'planner \u00b7 llm call', payload: { role: 'planner' } }),
				logEntry({ timestamp: t(8), type: 'tool_call', summary: 'planner \u00b7 glob_files', payload: { role: 'planner', tool: 'glob_files', arguments: '{"pattern":"**/settings*"}' }, detailSections: [{ label: 'arguments', content: '{"pattern":"**/settings*"}' }] }),
			],
			budgets: budgets({ elapsedSeconds: 9, toolCalls: 1, tokensUsed: 4380, tokenBreakdown: tokenBreakdown(4200, 180) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 1, active: true, costTime: 9, costTokens: 4380 }), flowNode({ id: 'glob_files', kind: 'tool', label: toolLabel('glob_files'), column: 2, costTime: 1 })], edges: [flowEdge('you', 'planner', 'call'), flowEdge('planner', 'glob_files', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 9, totalTokens: 4380 }), topBarNode({ id: 'glob_files', kind: 'tool', label: toolLabel('glob_files'), invocations: 1 })] },
			),
		}, 9),
	],
}

const delegationInProgress = {
	id: 'delegation-in-progress',
	label: 'Orchestrator \u2192 coder delegation in progress',
	description: 'An agent\u2192agent edge is mid-flight: the orchestrator has called the coder, which has started but not yet produced its first turn.',
	frames: [
		frame({
			status: 'unknown',
			task: 'Add an export button to the report page.',
			startTime: t(0),
			currentActivity: { role: 'orchestrator', summary: 'orchestrator \u00b7 llm call' },
			roles: [roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(3), eventCount: 2, llmCalls: 1, lastPromptTokens: 3100 })],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(1), type: 'role_start', summary: 'orchestrator \u00b7 role start', payload: { role: 'orchestrator', depth: 0, task: 'Add an export button to the report page' } }),
				logEntry({ timestamp: t(3), type: 'llm_call', summary: 'orchestrator \u00b7 llm call', payload: { role: 'orchestrator' } }),
			],
			budgets: budgets({ elapsedSeconds: 4, tokensUsed: 3100, tokenBreakdown: tokenBreakdown(3100, 120) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, active: true, costTime: 4, costTokens: 3220 })], edges: [flowEdge('you', 'orchestrator', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 4, totalTokens: 3220 })] },
			),
		}, 4),
		frame({
			status: 'unknown',
			task: 'Add an export button to the report page.',
			startTime: t(0),
			currentActivity: { role: 'orchestrator', summary: 'orchestrator \u00b7 agent call \u2192 coder' },
			roles: [roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(7), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 3100 })],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(1), type: 'role_start', summary: 'orchestrator \u00b7 role start', payload: { role: 'orchestrator', depth: 0 } }),
				logEntry({ timestamp: t(3), type: 'llm_call', summary: 'orchestrator \u00b7 llm call', payload: { role: 'orchestrator' } }),
				logEntry({ timestamp: t(6), type: 'tool_call', summary: 'orchestrator \u00b7 agent', payload: { role: 'orchestrator', tool: 'agent', arguments: '{"role":"coder","task":"add the export button"}' } }),
				logEntry({ timestamp: t(7), type: 'agent_call', summary: 'orchestrator \u00b7 agent call \u2192 coder', payload: { parent: 'orchestrator', child: 'coder', depth: 1 } }),
			],
			budgets: budgets({ elapsedSeconds: 8, toolCalls: 1, tokensUsed: 3100, tokenBreakdown: tokenBreakdown(3100, 120) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 8, costTokens: 3220 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 2, active: true, costTime: 1 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'coder', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 8, totalTokens: 3220 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 1 })] },
			),
		}, 8),
		frame({
			status: 'unknown',
			task: 'Add an export button to the report page.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 role start' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(7), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 3100 }),
				roleActivity({ role: 'coder', firstSeen: t(8), lastSeen: t(8), eventCount: 1, llmCalls: 0 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(6), type: 'tool_call', summary: 'orchestrator \u00b7 agent', payload: { role: 'orchestrator', tool: 'agent' } }),
				logEntry({ timestamp: t(7), type: 'agent_call', summary: 'orchestrator \u00b7 agent call \u2192 coder', payload: { parent: 'orchestrator', child: 'coder', depth: 1 } }),
				logEntry({ timestamp: t(8), type: 'role_start', summary: 'coder \u00b7 role start', payload: { role: 'coder', depth: 1, parent: 'orchestrator', task: 'add the export button' } }),
			],
			budgets: budgets({ elapsedSeconds: 9, toolCalls: 1, tokensUsed: 3100, tokenBreakdown: tokenBreakdown(3100, 120) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 9, costTokens: 3220 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 2, active: true, costTime: 1 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'coder', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 9, totalTokens: 3220 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 1 })] },
			),
		}, 9),
	],
}

const toolCallInProgress = {
	id: 'tool-call-in-progress',
	label: 'Tool call in progress (no result yet)',
	description: 'An agent\u2192tool edge is mid-flight: the coder has called write_file and the tool_result has not returned.',
	frames: [
		frame({
			status: 'unknown',
			task: 'Write a README describing the project.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 write_file' },
			roles: [roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(6), eventCount: 3, llmCalls: 1, toolCalls: 1, recentTools: ['write_file'], lastPromptTokens: 2600 })],
			roleTree: [treeNode({ role: 'coder', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(1), type: 'role_start', summary: 'coder \u00b7 role start', payload: { role: 'coder', depth: 0, task: 'Write a README describing the project' } }),
				logEntry({ timestamp: t(3), type: 'llm_call', summary: 'coder \u00b7 llm call', payload: { role: 'coder' } }),
				logEntry({ timestamp: t(6), type: 'tool_call', summary: 'coder \u00b7 write_file', payload: { role: 'coder', tool: 'write_file', arguments: '{"path":"README.md","content":"# Project\\n"}' }, detailSections: [{ label: 'arguments', content: '{"path":"README.md","content":"# Project\\n"}' }] }),
			],
			budgets: budgets({ elapsedSeconds: 7, toolCalls: 1, tokensUsed: 2600, tokenBreakdown: tokenBreakdown(2600, 220) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 1, active: true, costTime: 7, costTokens: 2820 }), flowNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), column: 2, costTime: 1 })], edges: [flowEdge('you', 'coder', 'call'), flowEdge('coder', 'write_file', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 7, totalTokens: 2820 }), topBarNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), invocations: 1 })] },
			),
		}, 7),
		frame({
			status: 'unknown',
			task: 'Write a README describing the project.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 write_file' },
			roles: [roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(6), eventCount: 3, llmCalls: 1, toolCalls: 1, recentTools: ['write_file'], lastPromptTokens: 2600 })],
			roleTree: [treeNode({ role: 'coder', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(3), type: 'llm_call', summary: 'coder \u00b7 llm call', payload: { role: 'coder' } }),
				logEntry({ timestamp: t(6), type: 'tool_call', summary: 'coder \u00b7 write_file', payload: { role: 'coder', tool: 'write_file', arguments: '{"path":"README.md"}' } }),
			],
			budgets: budgets({ elapsedSeconds: 8, toolCalls: 1, tokensUsed: 2600, tokenBreakdown: tokenBreakdown(2600, 220) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 1, active: true, costTime: 8, costTokens: 2820 }), flowNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), column: 2, costTime: 2 })], edges: [flowEdge('you', 'coder', 'call'), flowEdge('coder', 'write_file', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 8, totalTokens: 2820 }), topBarNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), invocations: 1 })] },
			),
		}, 8),
	],
}

const retry = {
	id: 'retry',
	label: 'Retry (first coder attempt errors, second succeeds)',
	description: 'Two coder invocations under one orchestrator: the first errors, the second succeeds \u2014 exercises the counter badge and per-invocation status.',
	frames: [
		frame({
			status: 'unknown',
			task: 'Fix the failing import in calculator.js.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 finished (error)' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(2), eventCount: 2, llmCalls: 1, lastPromptTokens: 2900 }),
				roleActivity({ role: 'coder', firstSeen: t(3), lastSeen: t(5), eventCount: 2, llmCalls: 1 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', status: 'error', summary: 'file not found', active: false })] })],
			recentLog: [
				logEntry({ timestamp: t(1), type: 'role_start', summary: 'orchestrator \u00b7 role start', payload: { role: 'orchestrator', depth: 0 } }),
				logEntry({ timestamp: t(3), type: 'role_start', summary: 'coder \u00b7 role start', payload: { role: 'coder', depth: 1, parent: 'orchestrator', task: 'first attempt' } }),
				logEntry({ timestamp: t(5), type: 'role_finished', summary: 'coder \u00b7 finished (error)', payload: { role: 'coder', depth: 1, status: 'error', summary: 'file not found', error: { kind: 'invalid_arguments', message: 'no such file' } }, detailSections: [{ label: 'summary', content: 'file not found' }, { label: 'error', content: { kind: 'invalid_arguments', message: 'no such file' } }] }),
			],
			budgets: budgets({ elapsedSeconds: 6, tokensUsed: 2900, tokenBreakdown: tokenBreakdown(2900, 90) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 6, costTokens: 2990 }), flowNode({ id: 'coder-1', kind: 'role', label: roleLabel('coder'), sublabel: 'attempt 1', column: 2, status: 'error', costTime: 2 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'coder-1', 'call'), flowEdge('coder-1', 'orchestrator', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 6, totalTokens: 2990 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, status: 'error', totalTime: 2 })] },
			),
		}, 6),
		frame({
			status: 'unknown',
			task: 'Fix the failing import in calculator.js.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 write_file' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(2), eventCount: 2, llmCalls: 1, lastPromptTokens: 2900 }),
				roleActivity({ role: 'coder', firstSeen: t(3), lastSeen: t(9), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['write_file'] }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [
				treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', status: 'error', summary: 'file not found', active: false }),
				treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', active: true }),
			] })],
			recentLog: [
				logEntry({ timestamp: t(5), type: 'role_finished', summary: 'coder \u00b7 finished (error)', payload: { role: 'coder', status: 'error' } }),
				logEntry({ timestamp: t(7), type: 'role_start', summary: 'coder \u00b7 role start', payload: { role: 'coder', depth: 1, parent: 'orchestrator', task: 'second attempt' } }),
				logEntry({ timestamp: t(9), type: 'tool_call', summary: 'coder \u00b7 write_file', payload: { role: 'coder', tool: 'write_file', arguments: '{"path":"calculator.js"}' } }),
			],
			budgets: budgets({ elapsedSeconds: 10, toolCalls: 1, tokensUsed: 2900, tokenBreakdown: tokenBreakdown(2900, 90) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 10, costTokens: 2990 }), flowNode({ id: 'coder-2', kind: 'role', label: roleLabel('coder'), sublabel: 'attempt 2', column: 2, active: true, costTime: 3 }), flowNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), column: 3, costTime: 1 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'coder-2', 'call'), flowEdge('coder-2', 'write_file', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 10, totalTokens: 2990 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 2, totalTime: 5 }), topBarNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), invocations: 1 })] },
			),
		}, 10),
		frame({
			status: 'success',
			runId: 'run-retry-fixture',
			task: 'Fix the failing import in calculator.js.',
			startTime: t(0),
			endTime: t(12),
			result: { status: 'success', summary: 'Fixed the import after a retry.', artifacts: ['calculator.js'] },
			currentActivity: { role: 'orchestrator', summary: 'orchestrator \u00b7 finished (success)' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(12), eventCount: 3, llmCalls: 1 }),
				roleActivity({ role: 'coder', firstSeen: t(3), lastSeen: t(11), eventCount: 6, llmCalls: 2, toolCalls: 1, recentTools: ['write_file'] }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, status: 'success', summary: 'done after retry', active: false, children: [
				treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', status: 'error', summary: 'file not found', active: false }),
				treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', status: 'success', summary: 'wrote the file', active: false }),
			] })],
			recentLog: [
				logEntry({ timestamp: t(9), type: 'tool_call', summary: 'coder \u00b7 write_file', payload: { role: 'coder', tool: 'write_file' } }),
				logEntry({ timestamp: t(11), type: 'role_finished', summary: 'coder \u00b7 finished (success)', payload: { role: 'coder', status: 'success', summary: 'wrote the file' } }),
				logEntry({ timestamp: t(12), type: 'role_finished', summary: 'orchestrator \u00b7 finished (success)', payload: { role: 'orchestrator', status: 'success', summary: 'done after retry' } }),
			],
			budgets: budgets({ elapsedSeconds: 12, toolCalls: 1, tokensUsed: 2900, tokenBreakdown: tokenBreakdown(2900, 90) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, status: 'success', costTime: 12, costTokens: 2990 })], edges: [flowEdge('orchestrator', 'you', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 12, totalTokens: 2990, status: 'success' }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 2, totalTime: 5 }), topBarNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), invocations: 1 })] },
			),
		}, 12),
	],
}

const pendingQuestion = {
	id: 'pending-question',
	label: 'Pending ask_human question (no answer yet)',
	description: 'The orchestrator has asked you a question and is waiting \u2014 exercises the question modal and the You node\u2019s incoming edge.',
	frames: [
		frame({
			status: 'unknown',
			task: 'Set up a new CI workflow for the monorepo.',
			startTime: t(0),
			currentActivity: { role: 'orchestrator', summary: 'orchestrator \u00b7 llm call' },
			roles: [roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(3), eventCount: 2, llmCalls: 1, lastPromptTokens: 3500 })],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(1), type: 'role_start', summary: 'orchestrator \u00b7 role start', payload: { role: 'orchestrator', depth: 0 } }),
				logEntry({ timestamp: t(3), type: 'llm_call', summary: 'orchestrator \u00b7 llm call', payload: { role: 'orchestrator' } }),
			],
			budgets: budgets({ elapsedSeconds: 4, tokensUsed: 3500, tokenBreakdown: tokenBreakdown(3500, 140) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, active: true, costTime: 4, costTokens: 3640 })], edges: [flowEdge('you', 'orchestrator', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 4, totalTokens: 3640 })] },
			),
		}, 4),
		frame({
			status: 'unknown',
			task: 'Set up a new CI workflow for the monorepo.',
			startTime: t(0),
			currentActivity: { role: 'orchestrator', summary: 'ask_human' },
			roles: [roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(6), eventCount: 3, llmCalls: 1, toolCalls: 1, recentTools: ['ask_human'], lastPromptTokens: 3500 })],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(3), type: 'llm_call', summary: 'orchestrator \u00b7 llm call', payload: { role: 'orchestrator' } }),
				logEntry({ timestamp: t(5), type: 'tool_call', summary: 'orchestrator \u00b7 ask_human', payload: { role: 'orchestrator', tool: 'ask_human', arguments: '{"question":"Which CI provider should I target?"}' } }),
				logEntry({ timestamp: t(6), type: 'ask_human', summary: 'ask_human', payload: { id: 'q1', question: 'Which CI provider should I target?', context: '.github/workflows/' } }),
			],
			questionHistory: [question({ id: 'q1', question: 'Which CI provider should I target?', context: '.github/workflows/', askedAt: t(6) })],
			budgets: budgets({ elapsedSeconds: 20, toolCalls: 1, tokensUsed: 3500, tokenBreakdown: tokenBreakdown(3500, 140) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0, active: true }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, active: true, costTime: 20, costTokens: 3640 }), flowNode({ id: 'ask_human', kind: 'tool', label: toolLabel('ask_human'), column: 2, costTime: 14 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'ask_human', 'call'), flowEdge('ask_human', 'you', 'question')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 20, totalTokens: 3640 }), topBarNode({ id: 'ask_human', kind: 'tool', label: toolLabel('ask_human'), invocations: 1 })] },
			),
		}, 20),
	],
}

const completedSuccess = {
	id: 'completed-success',
	label: 'Completed successful run (orchestrator \u2192 planner \u2192 coder \u2192 critic)',
	description: 'A finished run with a deep delegation chain and a result \u2014 exercises the result modal and the settled static graph.',
	frames: [
		frame({
			status: 'unknown',
			task: 'Add a CSV export to the reports module.',
			startTime: t(0),
			currentActivity: { role: 'planner', summary: 'planner \u00b7 llm call' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(2), eventCount: 2, llmCalls: 1, lastPromptTokens: 3000 }),
				roleActivity({ role: 'planner', firstSeen: t(3), lastSeen: t(5), eventCount: 2, llmCalls: 1, lastPromptTokens: 5200 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'planner', depth: 1, parent: 'orchestrator', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(1), type: 'role_start', summary: 'orchestrator \u00b7 role start', payload: { role: 'orchestrator', depth: 0 } }),
				logEntry({ timestamp: t(2), type: 'agent_call', summary: 'orchestrator \u00b7 agent call \u2192 planner', payload: { parent: 'orchestrator', child: 'planner', depth: 1 } }),
				logEntry({ timestamp: t(3), type: 'role_start', summary: 'planner \u00b7 role start', payload: { role: 'planner', depth: 1, parent: 'orchestrator' } }),
				logEntry({ timestamp: t(5), type: 'llm_call', summary: 'planner \u00b7 llm call', payload: { role: 'planner' } }),
			],
			budgets: budgets({ elapsedSeconds: 6, tokensUsed: 8200, tokenBreakdown: tokenBreakdown(8200, 260) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 6, costTokens: 3260 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 2, active: true, costTime: 3, costTokens: 5460 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'planner', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 6, totalTokens: 3260 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 3, totalTokens: 5460 })] },
			),
		}, 6),
		frame({
			status: 'unknown',
			task: 'Add a CSV export to the reports module.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 write_file' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(2), eventCount: 2, llmCalls: 1, lastPromptTokens: 3000 }),
				roleActivity({ role: 'planner', firstSeen: t(3), lastSeen: t(8), eventCount: 3, llmCalls: 1, lastPromptTokens: 5200 }),
				roleActivity({ role: 'coder', firstSeen: t(10), lastSeen: t(14), eventCount: 3, llmCalls: 1, toolCalls: 1, recentTools: ['write_file'], lastPromptTokens: 6100 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [
				treeNode({ role: 'planner', depth: 1, parent: 'orchestrator', status: 'success', active: false }),
				treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', active: true }),
			] })],
			recentLog: [
				logEntry({ timestamp: t(8), type: 'role_finished', summary: 'planner \u00b7 finished (success)', payload: { role: 'planner', status: 'success' } }),
				logEntry({ timestamp: t(10), type: 'role_start', summary: 'coder \u00b7 role start', payload: { role: 'coder', depth: 1, parent: 'orchestrator' } }),
				logEntry({ timestamp: t(14), type: 'tool_call', summary: 'coder \u00b7 write_file', payload: { role: 'coder', tool: 'write_file', arguments: '{"path":"reports/csv.js"}' } }),
			],
			budgets: budgets({ elapsedSeconds: 15, toolCalls: 1, tokensUsed: 14300, tokenBreakdown: tokenBreakdown(14300, 520) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 15, costTokens: 3260 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 2, status: 'success', costTime: 5, costTokens: 5460 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 2, active: true, costTime: 5, costTokens: 6620 }), flowNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), column: 3, costTime: 1 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'planner', 'call'), flowEdge('planner', 'orchestrator', 'return'), flowEdge('orchestrator', 'coder', 'call'), flowEdge('coder', 'write_file', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 15, totalTokens: 3260 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 5, totalTokens: 5460, status: 'success' }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 5, totalTokens: 6620 }), topBarNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), invocations: 1 })] },
			),
		}, 15),
		frame({
			status: 'success',
			runId: 'run-success-fixture',
			task: 'Add a CSV export to the reports module.',
			startTime: t(0),
			endTime: t(22),
			result: { status: 'success', summary: 'Added CSV export and the reviewer signed off.', artifacts: ['reports/csv.js', 'reports/csv.test.js'] },
			currentActivity: { role: 'orchestrator', summary: 'orchestrator \u00b7 finished (success)' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(22), eventCount: 4, llmCalls: 1 }),
				roleActivity({ role: 'planner', firstSeen: t(3), lastSeen: t(8), eventCount: 3, llmCalls: 1 }),
				roleActivity({ role: 'coder', firstSeen: t(10), lastSeen: t(18), eventCount: 5, llmCalls: 2, toolCalls: 2, recentTools: ['write_file', 'test'] }),
				roleActivity({ role: 'critic', firstSeen: t(19), lastSeen: t(21), eventCount: 2, llmCalls: 1 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, status: 'success', summary: 'shipped', active: false, children: [
				treeNode({ role: 'planner', depth: 1, parent: 'orchestrator', status: 'success', active: false }),
				treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', status: 'success', active: false, children: [
					treeNode({ role: 'critic', depth: 2, parent: 'coder', status: 'success', summary: 'looks good', active: false }),
				] }),
			] })],
			recentLog: [
				logEntry({ timestamp: t(18), type: 'role_finished', summary: 'coder \u00b7 finished (success)', payload: { role: 'coder', status: 'success' } }),
				logEntry({ timestamp: t(21), type: 'role_finished', summary: 'critic \u00b7 finished (success)', payload: { role: 'critic', status: 'success', summary: 'looks good' } }),
				logEntry({ timestamp: t(22), type: 'role_finished', summary: 'orchestrator \u00b7 finished (success)', payload: { role: 'orchestrator', status: 'success', summary: 'shipped' } }),
			],
			budgets: budgets({ elapsedSeconds: 22, toolCalls: 2, tokensUsed: 18000, tokenBreakdown: tokenBreakdown(18000, 720) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, status: 'success', costTime: 22, costTokens: 3260 })], edges: [flowEdge('orchestrator', 'you', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 22, totalTokens: 3260, status: 'success' }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 5, totalTokens: 5460, status: 'success' }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 8, totalTokens: 6620, status: 'success' }), topBarNode({ id: 'critic', kind: 'role', label: roleLabel('critic'), invocations: 1, totalTime: 2, status: 'success' }), topBarNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), invocations: 2 })] },
			),
		}, 22),
	],
}

const failedRun = {
	id: 'failed-run',
	label: 'Failed run (error with kind + message)',
	description: 'A run that ended in error \u2014 exercises failure surfacing with a machine kind and a sanitized message.',
	frames: [
		frame({
			status: 'unknown',
			task: 'Refactor the auth module into a separate package.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 llm call' },
			roles: [roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(4), eventCount: 2, llmCalls: 1, lastPromptTokens: 4800 })],
			roleTree: [treeNode({ role: 'coder', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(1), type: 'role_start', summary: 'coder \u00b7 role start', payload: { role: 'coder', depth: 0 } }),
				logEntry({ timestamp: t(4), type: 'llm_call', summary: 'coder \u00b7 llm call', payload: { role: 'coder' } }),
			],
			budgets: budgets({ elapsedSeconds: 5, tokensUsed: 4800, tokenBreakdown: tokenBreakdown(4800, 160) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 1, active: true, costTime: 5, costTokens: 4960 })], edges: [flowEdge('you', 'coder', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 5, totalTokens: 4960 })] },
			),
		}, 5),
		frame({
			status: 'error',
			runId: 'run-failed-fixture',
			task: 'Refactor the auth module into a separate package.',
			startTime: t(0),
			endTime: t(9),
			error: { kind: 'llm_unavailable', message: 'The model endpoint refused the connection.' },
			result: { status: 'error', summary: 'The run could not reach the model.', error: { kind: 'llm_unavailable', message: 'The model endpoint refused the connection.' } },
			currentActivity: { role: 'coder', summary: 'coder \u00b7 llm unavailable' },
			roles: [roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(9), eventCount: 3, llmCalls: 1 })],
			roleTree: [treeNode({ role: 'coder', depth: 0, status: 'error', summary: 'model endpoint unreachable', active: false })],
			recentLog: [
				logEntry({ timestamp: t(4), type: 'llm_call', summary: 'coder \u00b7 llm call', payload: { role: 'coder' } }),
				logEntry({ timestamp: t(9), type: 'llm_unavailable', summary: 'coder \u00b7 llm unavailable', payload: { role: 'coder', message: 'connection refused' } }),
				logEntry({ timestamp: t(9), type: 'role_finished', summary: 'coder \u00b7 finished (error)', payload: { role: 'coder', status: 'error', summary: 'model endpoint unreachable', error: { kind: 'llm_unavailable', message: 'connection refused' } } }),
			],
			budgets: budgets({ elapsedSeconds: 9, tokensUsed: 4800, tokenBreakdown: tokenBreakdown(4800, 160) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 1, status: 'error', costTime: 9, costTokens: 4960 })], edges: [flowEdge('coder', 'you', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 9, totalTokens: 4960, status: 'error' })] },
			),
		}, 9),
	],
}

const effortSet = {
	id: 'effort-set',
	label: 'Run with effort set',
	description: 'A run carrying an effort level \u2014 exercises the cost strip\u2019s effort readout alongside elapsed time and tokens.',
	frames: [
		frame({
			status: 'unknown',
			task: 'Carefully migrate the database schema with no downtime.',
			effort: 5,
			startTime: t(0),
			currentActivity: { role: 'planner', summary: 'effort set (5)' },
			roles: [roleActivity({ role: 'planner', firstSeen: t(1), lastSeen: t(1), eventCount: 1 })],
			roleTree: [treeNode({ role: 'planner', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(0), type: 'effort_set', summary: 'effort set (5)', payload: { effort: 5 } }),
				logEntry({ timestamp: t(1), type: 'role_start', summary: 'planner \u00b7 role start', payload: { role: 'planner', depth: 0 } }),
			],
			budgets: budgets({ elapsedSeconds: 2 }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 1, active: true, costTime: 2 })], edges: [flowEdge('you', 'planner', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 2 })] },
			),
		}, 2),
		frame({
			status: 'unknown',
			task: 'Carefully migrate the database schema with no downtime.',
			effort: 5,
			startTime: t(0),
			currentActivity: { role: 'planner', summary: 'planner \u00b7 llm call' },
			roles: [roleActivity({ role: 'planner', firstSeen: t(1), lastSeen: t(6), eventCount: 3, llmCalls: 1, toolCalls: 1, recentTools: ['read_file'], lastPromptTokens: 7400 })],
			roleTree: [treeNode({ role: 'planner', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(0), type: 'effort_set', summary: 'effort set (5)', payload: { effort: 5 } }),
				logEntry({ timestamp: t(1), type: 'role_start', summary: 'planner \u00b7 role start', payload: { role: 'planner', depth: 0 } }),
				logEntry({ timestamp: t(4), type: 'llm_call', summary: 'planner \u00b7 llm call', payload: { role: 'planner' } }),
				logEntry({ timestamp: t(6), type: 'tool_call', summary: 'planner \u00b7 read_file', payload: { role: 'planner', tool: 'read_file', arguments: '{"path":"migrations/schema.sql"}' } }),
			],
			budgets: budgets({ elapsedSeconds: 7, toolCalls: 1, tokensUsed: 7400, tokenBreakdown: tokenBreakdown(7400, 300, 1200) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 1, active: true, costTime: 7, costTokens: 7700 }), flowNode({ id: 'read_file', kind: 'tool', label: toolLabel('read_file'), column: 2, costTime: 1 })], edges: [flowEdge('you', 'planner', 'call'), flowEdge('planner', 'read_file', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 7, totalTokens: 7700 }), topBarNode({ id: 'read_file', kind: 'tool', label: toolLabel('read_file'), invocations: 1 })] },
			),
		}, 7),
	],
}

const deepMultiRoleTree = {
	id: 'deep-multi-role-tree',
	label: 'Deep multi-role tree (with a context_manager side role)',
	description: 'A deep chain orchestrator \u2192 planner \u2192 coder plus a context_manager side delegation \u2014 exercises the tiered layout and side branches.',
	frames: [
		frame({
			status: 'unknown',
			task: 'Build a small REST API for the bookings feature.',
			startTime: t(0),
			currentActivity: { role: 'planner', summary: 'planner \u00b7 llm call' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(2), eventCount: 2, llmCalls: 1, lastPromptTokens: 3300 }),
				roleActivity({ role: 'planner', firstSeen: t(3), lastSeen: t(5), eventCount: 2, llmCalls: 1, lastPromptTokens: 5600 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'planner', depth: 1, parent: 'orchestrator', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(1), type: 'role_start', summary: 'orchestrator \u00b7 role start', payload: { role: 'orchestrator', depth: 0 } }),
				logEntry({ timestamp: t(2), type: 'agent_call', summary: 'orchestrator \u00b7 agent call \u2192 planner', payload: { parent: 'orchestrator', child: 'planner', depth: 1 } }),
				logEntry({ timestamp: t(5), type: 'llm_call', summary: 'planner \u00b7 llm call', payload: { role: 'planner' } }),
			],
			budgets: budgets({ elapsedSeconds: 6, tokensUsed: 8900, tokenBreakdown: tokenBreakdown(8900, 280) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 6, costTokens: 3580 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 2, active: true, costTime: 3, costTokens: 5880 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'planner', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 6, totalTokens: 3580 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 3, totalTokens: 5880 })] },
			),
		}, 6),
		frame({
			status: 'unknown',
			task: 'Build a small REST API for the bookings feature.',
			startTime: t(0),
			currentActivity: { role: 'context_manager', summary: 'context_manager \u00b7 edit_context' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(2), eventCount: 2, llmCalls: 1, lastPromptTokens: 3300 }),
				roleActivity({ role: 'planner', firstSeen: t(3), lastSeen: t(9), eventCount: 5, llmCalls: 3, lastPromptTokens: 28000 }),
				roleActivity({ role: 'context_manager', firstSeen: t(11), lastSeen: t(13), eventCount: 2, llmCalls: 1, toolCalls: 1, recentTools: ['edit_context'] }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [
				treeNode({ role: 'planner', depth: 1, parent: 'orchestrator', active: false, children: [
					treeNode({ role: 'context_manager', depth: 2, parent: 'planner', active: true }),
				] }),
			] })],
			recentLog: [
				logEntry({ timestamp: t(9), type: 'context_budget_exceeded', summary: 'planner \u00b7 context budget exceeded', payload: { role: 'planner', promptTokens: 28000, contextWindow: 262144 } }),
				logEntry({ timestamp: t(11), type: 'agent_call', summary: 'planner \u00b7 agent call \u2192 context_manager', payload: { parent: 'planner', child: 'context_manager', depth: 2 } }),
				logEntry({ timestamp: t(13), type: 'tool_call', summary: 'context_manager \u00b7 edit_context', payload: { role: 'context_manager', tool: 'edit_context', arguments: '{"action":"compact"}' } }),
			],
			budgets: budgets({ elapsedSeconds: 14, toolCalls: 1, tokensUsed: 36900, tokenBreakdown: tokenBreakdown(36900, 900) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 14, costTokens: 3580 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 2, active: true, costTime: 11, costTokens: 37800 }), flowNode({ id: 'context_manager', kind: 'role', label: roleLabel('context_manager'), sublabel: 'context_manager', column: 3, active: true, costTime: 3 }), flowNode({ id: 'edit_context', kind: 'tool', label: toolLabel('edit_context'), column: 4, costTime: 1 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'planner', 'call'), flowEdge('planner', 'context_manager', 'call'), flowEdge('context_manager', 'edit_context', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 14, totalTokens: 3580 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 11, totalTokens: 37800 }), topBarNode({ id: 'context_manager', kind: 'role', label: roleLabel('context_manager'), invocations: 1, totalTime: 3 }), topBarNode({ id: 'edit_context', kind: 'tool', label: toolLabel('edit_context'), invocations: 1 })] },
			),
		}, 14),
		frame({
			status: 'success',
			runId: 'run-deep-fixture',
			task: 'Build a small REST API for the bookings feature.',
			startTime: t(0),
			endTime: t(40),
			result: { status: 'success', summary: 'Built the bookings API with routes, handlers, and tests.', artifacts: ['src/bookings/routes.js', 'src/bookings/handlers.js', 'src/bookings/handlers.test.js'] },
			currentActivity: { role: 'orchestrator', summary: 'orchestrator \u00b7 finished (success)' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(40), eventCount: 4, llmCalls: 1 }),
				roleActivity({ role: 'planner', firstSeen: t(3), lastSeen: t(20), eventCount: 6, llmCalls: 4 }),
				roleActivity({ role: 'context_manager', firstSeen: t(11), lastSeen: t(15), eventCount: 3, llmCalls: 1, toolCalls: 1, recentTools: ['edit_context'] }),
				roleActivity({ role: 'coder', firstSeen: t(22), lastSeen: t(38), eventCount: 8, llmCalls: 3, toolCalls: 4, recentTools: ['write_file', 'test', 'typecheck'], lastPromptTokens: 12000 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, status: 'success', summary: 'shipped the API', active: false, children: [
				treeNode({ role: 'planner', depth: 1, parent: 'orchestrator', status: 'success', active: false, children: [
					treeNode({ role: 'context_manager', depth: 2, parent: 'planner', status: 'success', summary: 'compacted the conversation', active: false }),
				] }),
				treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', status: 'success', summary: 'wrote routes, handlers, and tests', active: false }),
			] })],
			recentLog: [
				logEntry({ timestamp: t(38), type: 'role_finished', summary: 'coder \u00b7 finished (success)', payload: { role: 'coder', status: 'success', summary: 'wrote routes, handlers, and tests' } }),
				logEntry({ timestamp: t(39), type: 'role_finished', summary: 'planner \u00b7 finished (success)', payload: { role: 'planner', status: 'success' } }),
				logEntry({ timestamp: t(40), type: 'role_finished', summary: 'orchestrator \u00b7 finished (success)', payload: { role: 'orchestrator', status: 'success', summary: 'shipped the API' } }),
			],
			budgets: budgets({ elapsedSeconds: 40, toolCalls: 4, tokensUsed: 64200, tokenBreakdown: tokenBreakdown(64200, 2100, 9000) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, status: 'success', costTime: 40, costTokens: 3580 })], edges: [flowEdge('orchestrator', 'you', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 40, totalTokens: 3580, status: 'success' }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 17, status: 'success' }), topBarNode({ id: 'context_manager', kind: 'role', label: roleLabel('context_manager'), invocations: 1, totalTime: 4, status: 'success' }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 16, status: 'success' }), topBarNode({ id: 'edit_context', kind: 'tool', label: toolLabel('edit_context'), invocations: 1 })] },
			),
		}, 40),
	],
}

const selfDelegation = {
	id: 'self-delegation',
	label: 'Self-delegation (coder \u2192 coder)',
	description: 'A role delegates to itself for a sub-task, producing same-named nodes at increasing depth \u2014 exercises the layout distinguishing repeated invocations of the same role nested under each other.',
	frames: [
		frame({
			status: 'unknown',
			task: 'Refactor the parser module into smaller files.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 llm call' },
			roles: [roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(4), eventCount: 2, llmCalls: 1, lastPromptTokens: 3800 })],
			roleTree: [treeNode({ role: 'coder', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(1), type: 'role_start', summary: 'coder \u00b7 role start', payload: { role: 'coder', depth: 0, task: 'Refactor the parser module into smaller files' } }),
				logEntry({ timestamp: t(4), type: 'llm_call', summary: 'coder \u00b7 llm call', payload: { role: 'coder' } }),
			],
			budgets: budgets({ elapsedSeconds: 5, tokensUsed: 3800, tokenBreakdown: tokenBreakdown(3800, 150) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'coder-1', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 1, active: true, costTime: 5, costTokens: 3950 })], edges: [flowEdge('you', 'coder-1', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 5, totalTokens: 3950 })] },
			),
		}, 5),
		frame({
			status: 'unknown',
			task: 'Refactor the parser module into smaller files.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 agent call \u2192 coder' },
			roles: [roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(8), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 3800 })],
			roleTree: [treeNode({ role: 'coder', depth: 0, active: false, children: [treeNode({ role: 'coder', depth: 1, parent: 'coder', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(4), type: 'llm_call', summary: 'coder \u00b7 llm call', payload: { role: 'coder' } }),
				logEntry({ timestamp: t(7), type: 'tool_call', summary: 'coder \u00b7 agent', payload: { role: 'coder', tool: 'agent', arguments: '{"role":"coder","task":"extract the tokenizer into its own file"}' } }),
				logEntry({ timestamp: t(8), type: 'agent_call', summary: 'coder \u00b7 agent call \u2192 coder', payload: { parent: 'coder', child: 'coder', depth: 1 } }),
			],
			budgets: budgets({ elapsedSeconds: 9, toolCalls: 1, tokensUsed: 3800, tokenBreakdown: tokenBreakdown(3800, 150) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'coder-1', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 1, costTime: 9, costTokens: 3950 }), flowNode({ id: 'coder-2', kind: 'role', label: roleLabel('coder'), sublabel: 'sub-task', column: 2, active: true, costTime: 1 })], edges: [flowEdge('you', 'coder-1', 'call'), flowEdge('coder-1', 'coder-2', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 2, totalTime: 10, totalTokens: 3950 })] },
			),
		}, 9),
		frame({
			status: 'success',
			runId: 'run-self-delegation-fixture',
			task: 'Refactor the parser module into smaller files.',
			startTime: t(0),
			endTime: t(16),
			result: { status: 'success', summary: 'Split the parser into a tokenizer and a grammar module.', artifacts: ['src/tokenizer.js', 'src/grammar.js'] },
			currentActivity: { role: 'coder', summary: 'coder \u00b7 finished (success)' },
			roles: [roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(16), eventCount: 7, llmCalls: 3, toolCalls: 2, recentTools: ['write_file', 'agent'] })],
			roleTree: [treeNode({ role: 'coder', depth: 0, status: 'success', summary: 'refactored the parser', active: false, children: [treeNode({ role: 'coder', depth: 1, parent: 'coder', status: 'success', summary: 'extracted the tokenizer', active: false })] })],
			recentLog: [
				logEntry({ timestamp: t(14), type: 'role_finished', summary: 'coder \u00b7 finished (success)', payload: { role: 'coder', depth: 1, status: 'success', summary: 'extracted the tokenizer', parent: 'coder' } }),
				logEntry({ timestamp: t(16), type: 'role_finished', summary: 'coder \u00b7 finished (success)', payload: { role: 'coder', depth: 0, status: 'success', summary: 'refactored the parser' } }),
			],
			budgets: budgets({ elapsedSeconds: 16, toolCalls: 2, tokensUsed: 9100, tokenBreakdown: tokenBreakdown(9100, 400) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'coder-1', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 1, status: 'success', costTime: 16, costTokens: 9500 })], edges: [flowEdge('coder-1', 'you', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 2, totalTime: 16, totalTokens: 9500, status: 'success' })] },
			),
		}, 16),
	],
}

// Forward-looking: the loop-detector agent and the interrupt mechanism are not yet emitted by the executor (they land with the interrupt/inspect platform). The event shapes here model what that platform will produce so the visualization is ready when it arrives; the `interrupted` status is likewise a future terminal status.
const detectedLoop = {
	id: 'detected-loop',
	label: 'Detected loop (loop-detector agent fires)',
	description: 'A role repeats identical tool calls; the loop-detector agent inspects its history and triggers an interrupt \u2014 forward-looking, modeling the interrupt platform\u2019s event shape.',
	frames: [
		frame({
			status: 'unknown',
			task: 'Fix the flaky test in the payments module.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 read_file' },
			roles: [roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(12), eventCount: 5, llmCalls: 2, toolCalls: 3, recentTools: ['read_file'], lastPromptTokens: 4400 })],
			roleTree: [treeNode({ role: 'coder', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(1), type: 'role_start', summary: 'coder \u00b7 role start', payload: { role: 'coder', depth: 0 } }),
				logEntry({ timestamp: t(4), type: 'llm_call', summary: 'coder \u00b7 llm call', payload: { role: 'coder' } }),
				logEntry({ timestamp: t(6), type: 'tool_call', summary: 'coder \u00b7 read_file', payload: { role: 'coder', tool: 'read_file', arguments: '{"path":"payments/handler.js"}' } }),
				logEntry({ timestamp: t(8), type: 'tool_call', summary: 'coder \u00b7 read_file', payload: { role: 'coder', tool: 'read_file', arguments: '{"path":"payments/handler.js"}' } }),
				logEntry({ timestamp: t(12), type: 'tool_call', summary: 'coder \u00b7 read_file', payload: { role: 'coder', tool: 'read_file', arguments: '{"path":"payments/handler.js"}' } }),
			],
			budgets: budgets({ elapsedSeconds: 13, toolCalls: 3, tokensUsed: 4400, tokenBreakdown: tokenBreakdown(4400, 180) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 1, active: true, costTime: 13, costTokens: 4580, counter: 3 }), flowNode({ id: 'read_file', kind: 'tool', label: toolLabel('read_file'), column: 2, costTime: 6 })], edges: [flowEdge('you', 'coder', 'call'), flowEdge('coder', 'read_file', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 13, totalTokens: 4580 }), topBarNode({ id: 'read_file', kind: 'tool', label: toolLabel('read_file'), invocations: 3 })] },
			),
		}, 13),
		frame({
			status: 'unknown',
			task: 'Fix the flaky test in the payments module.',
			startTime: t(0),
			currentActivity: { role: 'loop_detector', summary: 'loop_detector \u00b7 recent_role_tool_calls' },
			roles: [
				roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(12), eventCount: 5, llmCalls: 2, toolCalls: 3, recentTools: ['read_file'], lastPromptTokens: 4400 }),
				roleActivity({ role: 'loop_detector', firstSeen: t(15), lastSeen: t(17), eventCount: 2, llmCalls: 1, toolCalls: 1, recentTools: ['recent_role_tool_calls'] }),
			],
			roleTree: [treeNode({ role: 'coder', depth: 0, active: false, children: [treeNode({ role: 'loop_detector', depth: 1, parent: 'coder', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(12), type: 'tool_call', summary: 'coder \u00b7 read_file', payload: { role: 'coder', tool: 'read_file', arguments: '{"path":"payments/handler.js"}' } }),
				logEntry({ timestamp: t(14), type: 'agent_call', summary: 'coder \u00b7 agent call \u2192 loop_detector', payload: { parent: 'coder', child: 'loop_detector', depth: 1 } }),
				logEntry({ timestamp: t(15), type: 'role_start', summary: 'loop_detector \u00b7 role start', payload: { role: 'loop_detector', depth: 1, parent: 'coder' } }),
				logEntry({ timestamp: t(17), type: 'tool_call', summary: 'loop_detector \u00b7 recent_role_tool_calls', payload: { role: 'loop_detector', tool: 'recent_role_tool_calls', arguments: '{"role":"coder","count":10}' } }),
			],
			budgets: budgets({ elapsedSeconds: 18, toolCalls: 4, tokensUsed: 5200, tokenBreakdown: tokenBreakdown(5200, 210) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 1, costTime: 18, costTokens: 4580, counter: 3 }), flowNode({ id: 'loop_detector', kind: 'role', label: roleLabel('loop_detector'), sublabel: 'loop_detector', column: 2, active: true, costTime: 3 }), flowNode({ id: 'recent_role_tool_calls', kind: 'tool', label: toolLabel('recent_role_tool_calls'), column: 3, costTime: 1 })], edges: [flowEdge('you', 'coder', 'call'), flowEdge('coder', 'loop_detector', 'call'), flowEdge('loop_detector', 'recent_role_tool_calls', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 18, totalTokens: 4580 }), topBarNode({ id: 'loop_detector', kind: 'role', label: roleLabel('loop_detector'), invocations: 1, totalTime: 3 }), topBarNode({ id: 'read_file', kind: 'tool', label: toolLabel('read_file'), invocations: 3 }), topBarNode({ id: 'recent_role_tool_calls', kind: 'tool', label: toolLabel('recent_role_tool_calls'), invocations: 1 })] },
			),
		}, 18),
		frame({
			status: 'interrupted',
			runId: 'run-detected-loop-fixture',
			task: 'Fix the flaky test in the payments module.',
			startTime: t(0),
			endTime: t(20),
			currentActivity: { role: 'loop_detector', summary: 'loop_detector \u00b7 trigger_interrupt' },
			roles: [
				roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(12), eventCount: 5, llmCalls: 2, toolCalls: 3, recentTools: ['read_file'], lastPromptTokens: 4400 }),
				roleActivity({ role: 'loop_detector', firstSeen: t(15), lastSeen: t(20), eventCount: 4, llmCalls: 1, toolCalls: 2, recentTools: ['trigger_interrupt', 'recent_role_tool_calls'] }),
			],
			roleTree: [treeNode({ role: 'coder', depth: 0, status: 'interrupted', summary: 'repeated read_file 3\u00d7', active: false, children: [treeNode({ role: 'loop_detector', depth: 1, parent: 'coder', status: 'success', summary: 'detected a repetition loop', active: false })] })],
			recentLog: [
				logEntry({ timestamp: t(17), type: 'tool_call', summary: 'loop_detector \u00b7 recent_role_tool_calls', payload: { role: 'loop_detector', tool: 'recent_role_tool_calls' } }),
				logEntry({ timestamp: t(19), type: 'tool_call', summary: 'loop_detector \u00b7 trigger_interrupt', payload: { role: 'loop_detector', tool: 'trigger_interrupt', arguments: '{"kind":"loop_detected","message":"coder repeated read_file 3 times"}' } }),
				logEntry({ timestamp: t(20), type: 'interrupt_triggered', summary: 'interrupt triggered (loop_detected)', payload: { source: 'loop_detector', kind: 'loop_detected', message: 'coder repeated read_file 3 times' } }),
			],
			budgets: budgets({ elapsedSeconds: 20, toolCalls: 5, tokensUsed: 5200, tokenBreakdown: tokenBreakdown(5200, 210) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0, active: true }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 1, status: 'interrupted', costTime: 20, costTokens: 4580, counter: 3 }), flowNode({ id: 'loop_detector', kind: 'role', label: roleLabel('loop_detector'), sublabel: 'loop_detector', column: 2, status: 'success', costTime: 5 })], edges: [flowEdge('you', 'coder', 'call'), flowEdge('coder', 'loop_detector', 'call'), flowEdge('loop_detector', 'coder', 'return'), flowEdge('coder', 'you', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 20, totalTokens: 4580, status: 'interrupted' }), topBarNode({ id: 'loop_detector', kind: 'role', label: roleLabel('loop_detector'), invocations: 1, totalTime: 5, status: 'success' }), topBarNode({ id: 'read_file', kind: 'tool', label: toolLabel('read_file'), invocations: 3 }), topBarNode({ id: 'recent_role_tool_calls', kind: 'tool', label: toolLabel('recent_role_tool_calls'), invocations: 1 }), topBarNode({ id: 'trigger_interrupt', kind: 'tool', label: toolLabel('trigger_interrupt'), invocations: 1 })] },
			),
		}, 20),
	],
}

// Forward-looking: the operator/API interrupt (inquiry + plan-modification) is a future feature on the interrupt platform. These frames model a run paused by an operator inquiry so the visualization can present the paused state before the mechanism exists.
const userInterrupt = {
	id: 'user-interrupt',
	label: 'User interruption (operator inquiry, future feature)',
	description: 'The operator pauses a running task with an inquiry interrupt \u2014 forward-looking, modeling the interrupt platform\u2019s operator-inquiry event shape and the paused `interrupted` status.',
	frames: [
		frame({
			status: 'unknown',
			task: 'Migrate the monolith to a modular architecture.',
			startTime: t(0),
			currentActivity: { role: 'planner', summary: 'planner \u00b7 search_text' },
			roles: [roleActivity({ role: 'planner', firstSeen: t(1), lastSeen: t(8), eventCount: 4, llmCalls: 2, toolCalls: 1, recentTools: ['search_text'], lastPromptTokens: 6800 })],
			roleTree: [treeNode({ role: 'planner', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(1), type: 'role_start', summary: 'planner \u00b7 role start', payload: { role: 'planner', depth: 0 } }),
				logEntry({ timestamp: t(4), type: 'llm_call', summary: 'planner \u00b7 llm call', payload: { role: 'planner' } }),
				logEntry({ timestamp: t(8), type: 'tool_call', summary: 'planner \u00b7 search_text', payload: { role: 'planner', tool: 'search_text', arguments: '{"pattern":"module.exports"}' } }),
			],
			budgets: budgets({ elapsedSeconds: 9, toolCalls: 1, tokensUsed: 6800, tokenBreakdown: tokenBreakdown(6800, 260) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 1, active: true, costTime: 9, costTokens: 7060 }), flowNode({ id: 'search_text', kind: 'tool', label: toolLabel('search_text'), column: 2, costTime: 1 })], edges: [flowEdge('you', 'planner', 'call'), flowEdge('planner', 'search_text', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 9, totalTokens: 7060 }), topBarNode({ id: 'search_text', kind: 'tool', label: toolLabel('search_text'), invocations: 1 })] },
			),
		}, 9),
		frame({
			status: 'interrupted',
			runId: 'run-user-interrupt-fixture',
			task: 'Migrate the monolith to a modular architecture.',
			startTime: t(0),
			endTime: t(15),
			currentActivity: { role: 'planner', summary: 'interrupt triggered (operator_inquiry)' },
			roles: [roleActivity({ role: 'planner', firstSeen: t(1), lastSeen: t(15), eventCount: 5, llmCalls: 2, toolCalls: 1, recentTools: ['search_text'], lastPromptTokens: 6800 })],
			roleTree: [treeNode({ role: 'planner', depth: 0, status: 'interrupted', summary: 'paused for operator inquiry', active: false })],
			recentLog: [
				logEntry({ timestamp: t(8), type: 'tool_call', summary: 'planner \u00b7 search_text', payload: { role: 'planner', tool: 'search_text' } }),
				logEntry({ timestamp: t(15), type: 'interrupt_triggered', summary: 'interrupt triggered (operator_inquiry)', payload: { source: 'operator', kind: 'inquiry', message: 'Should we keep the legacy API endpoints for backward compatibility?' } }),
			],
			budgets: budgets({ elapsedSeconds: 15, toolCalls: 1, tokensUsed: 6800, tokenBreakdown: tokenBreakdown(6800, 260) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0, active: true }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 1, status: 'interrupted', costTime: 15, costTokens: 7060 })], edges: [flowEdge('you', 'planner', 'call'), flowEdge('planner', 'you', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 15, totalTokens: 7060, status: 'interrupted' }), topBarNode({ id: 'search_text', kind: 'tool', label: toolLabel('search_text'), invocations: 1 })] },
			),
		}, 15),
	],
}

const largeGuild = {
	id: 'large-guild',
	label: 'Large guild (~15 roles, complex tree)',
	description: 'A guild with fifteen roles and a run that touches most of them \u2014 exercises the static layout against a crowded node set and a deep, wide invocation tree.',
	frames: [
		frame({
			status: 'unknown',
			task: 'Build a full booking system: API, tests, docs, and a security review.',
			startTime: t(0),
			config: largeGuildConfig,
			currentActivity: { role: 'architect', summary: 'architect \u00b7 llm call' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(2), eventCount: 2, llmCalls: 1, lastPromptTokens: 3200 }),
				roleActivity({ role: 'architect', firstSeen: t(3), lastSeen: t(6), eventCount: 2, llmCalls: 1, lastPromptTokens: 7100 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'architect', depth: 1, parent: 'orchestrator', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(1), type: 'role_start', summary: 'orchestrator \u00b7 role start', payload: { role: 'orchestrator', depth: 0 } }),
				logEntry({ timestamp: t(2), type: 'agent_call', summary: 'orchestrator \u00b7 agent call \u2192 architect', payload: { parent: 'orchestrator', child: 'architect', depth: 1 } }),
				logEntry({ timestamp: t(6), type: 'llm_call', summary: 'architect \u00b7 llm call', payload: { role: 'architect' } }),
			],
			budgets: budgets({ elapsedSeconds: 7, tokensUsed: 10300, tokenBreakdown: tokenBreakdown(10300, 320) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), sublabel: 'orchestrator', column: 1, costTime: 7, costTokens: 3520 }), flowNode({ id: 'architect', kind: 'role', label: roleLabel('architect', largeGuildConfig), sublabel: 'architect', column: 2, active: true, costTime: 4, costTokens: 7420 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'architect', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), invocations: 1, totalTime: 7, totalTokens: 3520 }), topBarNode({ id: 'architect', kind: 'role', label: roleLabel('architect', largeGuildConfig), invocations: 1, totalTime: 4, totalTokens: 7420 })] },
			),
		}, 7),
		frame({
			status: 'unknown',
			task: 'Build a full booking system: API, tests, docs, and a security review.',
			startTime: t(0),
			config: largeGuildConfig,
			currentActivity: { role: 'coder', summary: 'coder \u00b7 write_file' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(2), eventCount: 2, llmCalls: 1, lastPromptTokens: 3200 }),
				roleActivity({ role: 'architect', firstSeen: t(3), lastSeen: t(9), eventCount: 3, llmCalls: 1 }),
				roleActivity({ role: 'coder', firstSeen: t(11), lastSeen: t(16), eventCount: 4, llmCalls: 2, toolCalls: 1, recentTools: ['write_file'], lastPromptTokens: 8400 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [
				treeNode({ role: 'architect', depth: 1, parent: 'orchestrator', status: 'success', active: false }),
				treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', active: true }),
			] })],
			recentLog: [
				logEntry({ timestamp: t(9), type: 'role_finished', summary: 'architect \u00b7 finished (success)', payload: { role: 'architect', status: 'success' } }),
				logEntry({ timestamp: t(11), type: 'role_start', summary: 'coder \u00b7 role start', payload: { role: 'coder', depth: 1, parent: 'orchestrator' } }),
				logEntry({ timestamp: t(14), type: 'llm_call', summary: 'coder \u00b7 llm call', payload: { role: 'coder' } }),
				logEntry({ timestamp: t(16), type: 'tool_call', summary: 'coder \u00b7 write_file', payload: { role: 'coder', tool: 'write_file', arguments: '{"path":"src/bookings/routes.js"}' } }),
			],
			budgets: budgets({ elapsedSeconds: 17, toolCalls: 1, tokensUsed: 18700, tokenBreakdown: tokenBreakdown(18700, 640) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), sublabel: 'orchestrator', column: 1, costTime: 17, costTokens: 3520 }), flowNode({ id: 'architect', kind: 'role', label: roleLabel('architect', largeGuildConfig), sublabel: 'architect', column: 2, status: 'success', costTime: 6, costTokens: 7420 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder', largeGuildConfig), sublabel: 'coder', column: 2, active: true, costTime: 6, costTokens: 9040 }), flowNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file', largeGuildConfig), column: 3, costTime: 1 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'architect', 'call'), flowEdge('architect', 'orchestrator', 'return'), flowEdge('orchestrator', 'coder', 'call'), flowEdge('coder', 'write_file', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), invocations: 1, totalTime: 17, totalTokens: 3520 }), topBarNode({ id: 'architect', kind: 'role', label: roleLabel('architect', largeGuildConfig), invocations: 1, totalTime: 6, totalTokens: 7420, status: 'success' }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder', largeGuildConfig), invocations: 1, totalTime: 6, totalTokens: 9040 }), topBarNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file', largeGuildConfig), invocations: 1 })] },
			),
		}, 17),
		frame({
			status: 'success',
			runId: 'run-large-guild-fixture',
			task: 'Build a full booking system: API, tests, docs, and a security review.',
			startTime: t(0),
			endTime: t(60),
			config: largeGuildConfig,
			result: { status: 'success', summary: 'Built the booking system end to end with tests, docs, and a security sign-off.', artifacts: ['src/bookings/routes.js', 'src/bookings/handlers.js', 'src/bookings/handlers.test.js', 'docs/bookings.md', 'security/audit-report.md'] },
			currentActivity: { role: 'orchestrator', summary: 'orchestrator \u00b7 finished (success)' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(60), eventCount: 8, llmCalls: 1 }),
				roleActivity({ role: 'architect', firstSeen: t(3), lastSeen: t(9), eventCount: 3, llmCalls: 1 }),
				roleActivity({ role: 'coder', firstSeen: t(11), lastSeen: t(30), eventCount: 8, llmCalls: 3, toolCalls: 4, recentTools: ['write_file', 'test', 'typecheck'] }),
				roleActivity({ role: 'tester', firstSeen: t(20), lastSeen: t(26), eventCount: 3, llmCalls: 1, toolCalls: 1, recentTools: ['test'] }),
				roleActivity({ role: 'reviewer', firstSeen: t(28), lastSeen: t(32), eventCount: 2, llmCalls: 1 }),
				roleActivity({ role: 'documenter', firstSeen: t(34), lastSeen: t(40), eventCount: 3, llmCalls: 1, toolCalls: 1, recentTools: ['write_file'] }),
				roleActivity({ role: 'researcher', firstSeen: t(12), lastSeen: t(18), eventCount: 3, llmCalls: 1, toolCalls: 1, recentTools: ['search_text'] }),
				roleActivity({ role: 'refactorer', firstSeen: t(42), lastSeen: t(48), eventCount: 3, llmCalls: 1, toolCalls: 1, recentTools: ['typecheck'] }),
				roleActivity({ role: 'security_auditor', firstSeen: t(50), lastSeen: t(58), eventCount: 3, llmCalls: 1, toolCalls: 1, recentTools: ['search_text'] }),
				roleActivity({ role: 'context_manager', firstSeen: t(24), lastSeen: t(27), eventCount: 2, llmCalls: 1, toolCalls: 1, recentTools: ['edit_context'] }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, status: 'success', summary: 'shipped the booking system', active: false, children: [
				treeNode({ role: 'architect', depth: 1, parent: 'orchestrator', status: 'success', active: false }),
				treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', status: 'success', active: false, children: [
					treeNode({ role: 'researcher', depth: 2, parent: 'coder', status: 'success', active: false }),
					treeNode({ role: 'tester', depth: 2, parent: 'coder', status: 'success', active: false }),
					treeNode({ role: 'context_manager', depth: 2, parent: 'coder', status: 'success', summary: 'compacted the conversation', active: false }),
					treeNode({ role: 'reviewer', depth: 2, parent: 'coder', status: 'success', active: false }),
				] }),
				treeNode({ role: 'documenter', depth: 1, parent: 'orchestrator', status: 'success', active: false }),
				treeNode({ role: 'refactorer', depth: 1, parent: 'orchestrator', status: 'success', active: false }),
				treeNode({ role: 'security_auditor', depth: 1, parent: 'orchestrator', status: 'success', summary: 'no issues found', active: false }),
			] })],
			recentLog: [
				logEntry({ timestamp: t(30), type: 'role_finished', summary: 'coder \u00b7 finished (success)', payload: { role: 'coder', status: 'success' } }),
				logEntry({ timestamp: t(48), type: 'role_finished', summary: 'refactorer \u00b7 finished (success)', payload: { role: 'refactorer', status: 'success' } }),
				logEntry({ timestamp: t(58), type: 'role_finished', summary: 'security_auditor \u00b7 finished (success)', payload: { role: 'security_auditor', status: 'success', summary: 'no issues found' } }),
				logEntry({ timestamp: t(60), type: 'role_finished', summary: 'orchestrator \u00b7 finished (success)', payload: { role: 'orchestrator', status: 'success', summary: 'shipped the booking system' } }),
			],
			budgets: budgets({ elapsedSeconds: 60, toolCalls: 9, tokensUsed: 84000, tokenBreakdown: tokenBreakdown(84000, 3200, 12000) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), sublabel: 'orchestrator', column: 1, status: 'success', costTime: 60, costTokens: 3520 })], edges: [flowEdge('orchestrator', 'you', 'return')] },
				{ nodes: [
					topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }),
					topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), invocations: 1, totalTime: 60, totalTokens: 3520, status: 'success' }),
					topBarNode({ id: 'architect', kind: 'role', label: roleLabel('architect', largeGuildConfig), invocations: 1, totalTime: 6, status: 'success' }),
					topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder', largeGuildConfig), invocations: 1, totalTime: 19, status: 'success' }),
					topBarNode({ id: 'researcher', kind: 'role', label: roleLabel('researcher', largeGuildConfig), invocations: 1, totalTime: 6, status: 'success' }),
					topBarNode({ id: 'tester', kind: 'role', label: roleLabel('tester', largeGuildConfig), invocations: 1, totalTime: 6, status: 'success' }),
					topBarNode({ id: 'context_manager', kind: 'role', label: roleLabel('context_manager', largeGuildConfig), invocations: 1, totalTime: 3, status: 'success' }),
					topBarNode({ id: 'reviewer', kind: 'role', label: roleLabel('reviewer', largeGuildConfig), invocations: 1, totalTime: 4, status: 'success' }),
					topBarNode({ id: 'documenter', kind: 'role', label: roleLabel('documenter', largeGuildConfig), invocations: 1, totalTime: 6, status: 'success' }),
					topBarNode({ id: 'refactorer', kind: 'role', label: roleLabel('refactorer', largeGuildConfig), invocations: 1, totalTime: 6, status: 'success' }),
					topBarNode({ id: 'security_auditor', kind: 'role', label: roleLabel('security_auditor', largeGuildConfig), invocations: 1, totalTime: 8, status: 'success' }),
					topBarNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file', largeGuildConfig), invocations: 5 }),
					topBarNode({ id: 'read_file', kind: 'tool', label: toolLabel('read_file', largeGuildConfig), invocations: 2 }),
					topBarNode({ id: 'search_text', kind: 'tool', label: toolLabel('search_text', largeGuildConfig), invocations: 2 }),
					topBarNode({ id: 'test', kind: 'tool', label: toolLabel('test', largeGuildConfig), invocations: 1 }),
					topBarNode({ id: 'typecheck', kind: 'tool', label: toolLabel('typecheck', largeGuildConfig), invocations: 2 }),
					topBarNode({ id: 'edit_context', kind: 'tool', label: toolLabel('edit_context', largeGuildConfig), invocations: 1 }),
				] },
			),
		}, 60),
	],
}

const fixtures = [
	singleRoleInProgress,
	delegationInProgress,
	toolCallInProgress,
	retry,
	pendingQuestion,
	completedSuccess,
	failedRun,
	effortSet,
	deepMultiRoleTree,
	selfDelegation,
	detectedLoop,
	userInterrupt,
	largeGuild,
]

export { mockConfig, largeGuildConfig, fixtures }
