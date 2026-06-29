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
		// Frame 0: you→planner call flowing (planner is the call's target, so it pulses).
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
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 1, costTime: 2 })], edges: [flowEdge('you', 'planner', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1 })] },
			),
		}, 2),
		// Frame 1: planner thinking (call settled, planner has costTokens, planner active flag).
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
		// Frame 2: planner→glob_files call flowing (glob_files is the call's target, so it pulses).
		frame({
			status: 'unknown',
			task: 'Plan how to add a dark mode toggle to the settings page.',
			startTime: t(0),
			currentActivity: { role: 'planner', summary: 'planner \u00b7 glob_files' },
			roles: [roleActivity({ role: 'planner', firstSeen: t(1), lastSeen: t(9), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['glob_files'], lastPromptTokens: 4200 })],
			roleTree: [treeNode({ role: 'planner', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(4), type: 'llm_call', summary: 'planner \u00b7 llm call', payload: { role: 'planner' } }),
				logEntry({ timestamp: t(8), type: 'tool_call', summary: 'planner \u00b7 glob_files', payload: { role: 'planner', tool: 'glob_files', arguments: '{"pattern":"**/settings*"}' }, detailSections: [{ label: 'arguments', content: '{"pattern":"**/settings*"}' }] }),
			],
			budgets: budgets({ elapsedSeconds: 9, toolCalls: 1, tokensUsed: 4380, tokenBreakdown: tokenBreakdown(4200, 180) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 1, costTime: 9, costTokens: 4380 }), flowNode({ id: 'glob_files', kind: 'tool', label: toolLabel('glob_files'), column: 2, costTime: 1 })], edges: [flowEdge('you', 'planner', 'call'), flowEdge('planner', 'glob_files', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 9, totalTokens: 4380 }), topBarNode({ id: 'glob_files', kind: 'tool', label: toolLabel('glob_files'), invocations: 1 })] },
			),
		}, 9),
		// Frame 3: glob_files returns green (planner is the return's target, so it pulses).
		frame({
			status: 'unknown',
			task: 'Plan how to add a dark mode toggle to the settings page.',
			startTime: t(0),
			currentActivity: { role: 'planner', summary: 'planner \u00b7 glob_files result' },
			roles: [roleActivity({ role: 'planner', firstSeen: t(1), lastSeen: t(11), eventCount: 5, llmCalls: 1, toolCalls: 1, recentTools: ['glob_files'], lastPromptTokens: 4200 })],
			roleTree: [treeNode({ role: 'planner', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(8), type: 'tool_call', summary: 'planner \u00b7 glob_files', payload: { role: 'planner', tool: 'glob_files' } }),
				logEntry({ timestamp: t(11), type: 'tool_result', summary: 'planner \u00b7 glob_files result', payload: { role: 'planner', tool: 'glob_files', result: 'found 3 files' }, detailSections: [{ label: 'result', content: 'found 3 files' }] }),
			],
			budgets: budgets({ elapsedSeconds: 12, toolCalls: 1, tokensUsed: 4380, tokenBreakdown: tokenBreakdown(4200, 180) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 1, costTime: 12, costTokens: 4380 }), flowNode({ id: 'glob_files', kind: 'tool', label: toolLabel('glob_files'), column: 2, status: 'success', costTime: 4 })], edges: [flowEdge('you', 'planner', 'call'), flowEdge('planner', 'glob_files', 'call'), flowEdge('glob_files', 'planner', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 12, totalTokens: 4380 }), topBarNode({ id: 'glob_files', kind: 'tool', label: toolLabel('glob_files'), invocations: 1 })] },
			),
		}, 12),
		// Frame 4: glob_files departed, planner thinking (planner active flag).
		frame({
			status: 'unknown',
			task: 'Plan how to add a dark mode toggle to the settings page.',
			startTime: t(0),
			currentActivity: { role: 'planner', summary: 'planner \u00b7 thinking' },
			roles: [roleActivity({ role: 'planner', firstSeen: t(1), lastSeen: t(13), eventCount: 5, llmCalls: 1, toolCalls: 1, recentTools: ['glob_files'], lastPromptTokens: 4200 })],
			roleTree: [treeNode({ role: 'planner', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(11), type: 'tool_result', summary: 'planner \u00b7 glob_files result', payload: { role: 'planner', tool: 'glob_files' } }),
			],
			budgets: budgets({ elapsedSeconds: 13, toolCalls: 1, tokensUsed: 4380, tokenBreakdown: tokenBreakdown(4200, 180) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 1, active: true, costTime: 13, costTokens: 4380 })], edges: [flowEdge('you', 'planner', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 13, totalTokens: 4380 }), topBarNode({ id: 'glob_files', kind: 'tool', label: toolLabel('glob_files'), invocations: 1 })] },
			),
		}, 13),
	],
}

const delegationInProgress = {
	id: 'delegation-in-progress',
	label: 'Orchestrator \u2192 coder delegation in progress',
	description: 'An agent\u2192agent edge is mid-flight: the orchestrator has called the coder, which has started but not yet produced its first turn.',
	frames: [
		// Frame 0: you→orchestrator call flowing (orchestrator is the call's target).
		frame({
			status: 'unknown',
			task: 'Add an export button to the report page.',
			startTime: t(0),
			currentActivity: { role: 'orchestrator', summary: 'orchestrator \u00b7 role start' },
			roles: [roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(1), eventCount: 1, llmCalls: 0 })],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: true })],
			recentLog: [logEntry({ timestamp: t(1), type: 'role_start', summary: 'orchestrator \u00b7 role start', payload: { role: 'orchestrator', depth: 0, task: 'Add an export button to the report page' } })],
			budgets: budgets({ elapsedSeconds: 2 }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 2 })], edges: [flowEdge('you', 'orchestrator', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 2 })] },
			),
		}, 2),
		// Frame 1: orchestrator thinking (call settled, orchestrator has costTokens, active flag).
		frame({
			status: 'unknown',
			task: 'Add an export button to the report page.',
			startTime: t(0),
			currentActivity: { role: 'orchestrator', summary: 'orchestrator \u00b7 llm call' },
			roles: [roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(4), eventCount: 2, llmCalls: 1, lastPromptTokens: 3100 })],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(1), type: 'role_start', summary: 'orchestrator \u00b7 role start', payload: { role: 'orchestrator', depth: 0 } }),
				logEntry({ timestamp: t(4), type: 'llm_call', summary: 'orchestrator \u00b7 llm call', payload: { role: 'orchestrator', usage: { promptTokens: 3100, completionTokens: 120, totalTokens: 3220 } }, detailSections: [{ label: 'usage', content: { promptTokens: 3100, completionTokens: 120, totalTokens: 3220 } }] }),
			],
			budgets: budgets({ elapsedSeconds: 5, tokensUsed: 3220, tokenBreakdown: tokenBreakdown(3100, 120) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, active: true, costTime: 5, costTokens: 3220 })], edges: [flowEdge('you', 'orchestrator', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 5, totalTokens: 3220 })] },
			),
		}, 5),
		// Frame 2: orchestrator→coder call flowing (coder is the call's target).
		frame({
			status: 'unknown',
			task: 'Add an export button to the report page.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 role start' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(7), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 3100 }),
				roleActivity({ role: 'coder', firstSeen: t(7), lastSeen: t(7), eventCount: 1, llmCalls: 0 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(4), type: 'llm_call', summary: 'orchestrator \u00b7 llm call', payload: { role: 'orchestrator' } }),
				logEntry({ timestamp: t(6), type: 'tool_call', summary: 'orchestrator \u00b7 agent', payload: { role: 'orchestrator', tool: 'agent', arguments: '{"role":"coder","task":"add the export button"}' } }),
				logEntry({ timestamp: t(7), type: 'agent_call', summary: 'orchestrator \u00b7 agent call \u2192 coder', payload: { parent: 'orchestrator', child: 'coder', depth: 1 } }),
			],
			budgets: budgets({ elapsedSeconds: 8, toolCalls: 1, tokensUsed: 3220, tokenBreakdown: tokenBreakdown(3100, 120) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 8, costTokens: 3220 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 2, costTime: 1 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'coder', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 8, totalTokens: 3220 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 1 })] },
			),
		}, 8),
		// Frame 3: coder thinking (call settled, coder has costTokens, active flag).
		frame({
			status: 'unknown',
			task: 'Add an export button to the report page.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 llm call' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(7), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 3100 }),
				roleActivity({ role: 'coder', firstSeen: t(7), lastSeen: t(10), eventCount: 3, llmCalls: 1, lastPromptTokens: 2900 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(7), type: 'agent_call', summary: 'orchestrator \u00b7 agent call \u2192 coder', payload: { parent: 'orchestrator', child: 'coder', depth: 1 } }),
				logEntry({ timestamp: t(8), type: 'role_start', summary: 'coder \u00b7 role start', payload: { role: 'coder', depth: 1, parent: 'orchestrator', task: 'add the export button' } }),
				logEntry({ timestamp: t(10), type: 'llm_call', summary: 'coder \u00b7 llm call', payload: { role: 'coder', usage: { promptTokens: 2900, completionTokens: 200, totalTokens: 3100 } }, detailSections: [{ label: 'usage', content: { promptTokens: 2900, completionTokens: 200, totalTokens: 3100 } }] }),
			],
			budgets: budgets({ elapsedSeconds: 11, tokensUsed: 6320, tokenBreakdown: tokenBreakdown(6000, 320) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 11, costTokens: 3220 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 2, active: true, costTime: 4, costTokens: 3100 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'coder', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 11, totalTokens: 3220 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 4, totalTokens: 3100 })] },
			),
		}, 11),
		// Frame 4: coder→write_file call flowing (write_file is the call's target).
		frame({
			status: 'unknown',
			task: 'Add an export button to the report page.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 write_file' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(7), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 3100 }),
				roleActivity({ role: 'coder', firstSeen: t(7), lastSeen: t(13), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['write_file'], lastPromptTokens: 2900 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(10), type: 'llm_call', summary: 'coder \u00b7 llm call', payload: { role: 'coder' } }),
				logEntry({ timestamp: t(13), type: 'tool_call', summary: 'coder \u00b7 write_file', payload: { role: 'coder', tool: 'write_file', arguments: '{"path":"reports/export.js"}' }, detailSections: [{ label: 'arguments', content: '{"path":"reports/export.js"}' }] }),
			],
			budgets: budgets({ elapsedSeconds: 14, toolCalls: 2, tokensUsed: 6320, tokenBreakdown: tokenBreakdown(6000, 320) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 14, costTokens: 3220 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 2, costTime: 7, costTokens: 3100 }), flowNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), column: 3, costTime: 1 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'coder', 'call'), flowEdge('coder', 'write_file', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 14, totalTokens: 3220 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 7, totalTokens: 3100 }), topBarNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), invocations: 1 })] },
			),
		}, 14),
		// Frame 5: write_file returns green (coder is the return's target).
		frame({
			status: 'unknown',
			task: 'Add an export button to the report page.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 write_file result' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(7), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 3100 }),
				roleActivity({ role: 'coder', firstSeen: t(7), lastSeen: t(16), eventCount: 5, llmCalls: 1, toolCalls: 1, recentTools: ['write_file'], lastPromptTokens: 2900 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(13), type: 'tool_call', summary: 'coder \u00b7 write_file', payload: { role: 'coder', tool: 'write_file' } }),
				logEntry({ timestamp: t(16), type: 'tool_result', summary: 'coder \u00b7 write_file result', payload: { role: 'coder', tool: 'write_file', result: 'wrote reports/export.js' }, detailSections: [{ label: 'result', content: 'wrote reports/export.js' }] }),
			],
			budgets: budgets({ elapsedSeconds: 17, toolCalls: 2, tokensUsed: 6320, tokenBreakdown: tokenBreakdown(6000, 320) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 17, costTokens: 3220 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 2, costTime: 10, costTokens: 3100 }), flowNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), column: 3, status: 'success', costTime: 4 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'coder', 'call'), flowEdge('coder', 'write_file', 'call'), flowEdge('write_file', 'coder', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 17, totalTokens: 3220 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 10, totalTokens: 3100 }), topBarNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), invocations: 1 })] },
			),
		}, 17),
		// Frame 6: write_file departed, coder thinking (coder active flag).
		frame({
			status: 'unknown',
			task: 'Add an export button to the report page.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 thinking' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(7), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 3100 }),
				roleActivity({ role: 'coder', firstSeen: t(7), lastSeen: t(18), eventCount: 5, llmCalls: 1, toolCalls: 1, recentTools: ['write_file'], lastPromptTokens: 2900 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(16), type: 'tool_result', summary: 'coder \u00b7 write_file result', payload: { role: 'coder', tool: 'write_file' } }),
			],
			budgets: budgets({ elapsedSeconds: 18, toolCalls: 2, tokensUsed: 6320, tokenBreakdown: tokenBreakdown(6000, 320) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 18, costTokens: 3220 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 2, active: true, costTime: 11, costTokens: 3100 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'coder', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 18, totalTokens: 3220 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 11, totalTokens: 3100 }), topBarNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), invocations: 1 })] },
			),
		}, 18),
		// Frame 7: coder returns green to orchestrator (orchestrator is the return's target).
		frame({
			status: 'unknown',
			task: 'Add an export button to the report page.',
			startTime: t(0),
			currentActivity: { role: 'orchestrator', summary: 'receiving coder success' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(20), eventCount: 5, llmCalls: 1, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 3100 }),
				roleActivity({ role: 'coder', firstSeen: t(7), lastSeen: t(20), eventCount: 6, llmCalls: 2, toolCalls: 1, recentTools: ['write_file'], lastPromptTokens: 2900 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', status: 'success', summary: 'added the export button', active: false })] })],
			recentLog: [
				logEntry({ timestamp: t(18), type: 'llm_call', summary: 'coder \u00b7 llm call (finish)', payload: { role: 'coder' } }),
				logEntry({ timestamp: t(20), type: 'role_finished', summary: 'coder \u00b7 finished (success)', payload: { role: 'coder', status: 'success', summary: 'added the export button' } }),
			],
			budgets: budgets({ elapsedSeconds: 21, toolCalls: 2, tokensUsed: 9420, tokenBreakdown: tokenBreakdown(9000, 420) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 21, costTokens: 3220 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 2, status: 'success', costTime: 14, costTokens: 3100 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'coder', 'call'), flowEdge('coder', 'orchestrator', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 21, totalTokens: 3220 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 14, totalTokens: 3100 }), topBarNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), invocations: 1 })] },
			),
		}, 21),
	],
}

const toolCallInProgress = {
	id: 'tool-call-in-progress',
	label: 'Tool call in progress (no result yet)',
	description: 'An agent\u2192tool edge is mid-flight: the coder has called write_file and the tool_result has not returned.',
	frames: [
		// Frame 0: you→coder call flowing (coder is the call's target).
		frame({
			status: 'unknown',
			task: 'Write a README describing the project.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 role start' },
			roles: [roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(1), eventCount: 1, llmCalls: 0 })],
			roleTree: [treeNode({ role: 'coder', depth: 0, active: true })],
			recentLog: [logEntry({ timestamp: t(1), type: 'role_start', summary: 'coder \u00b7 role start', payload: { role: 'coder', depth: 0, task: 'Write a README describing the project' } })],
			budgets: budgets({ elapsedSeconds: 2 }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 1, costTime: 2 })], edges: [flowEdge('you', 'coder', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 2 })] },
			),
		}, 2),
		// Frame 1: coder thinking (call settled, coder has costTokens, active flag).
		frame({
			status: 'unknown',
			task: 'Write a README describing the project.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 llm call' },
			roles: [roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(4), eventCount: 2, llmCalls: 1, lastPromptTokens: 2600 })],
			roleTree: [treeNode({ role: 'coder', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(1), type: 'role_start', summary: 'coder \u00b7 role start', payload: { role: 'coder', depth: 0, task: 'Write a README describing the project' } }),
				logEntry({ timestamp: t(4), type: 'llm_call', summary: 'coder \u00b7 llm call', payload: { role: 'coder', usage: { promptTokens: 2600, completionTokens: 220, totalTokens: 2820 } }, detailSections: [{ label: 'usage', content: { promptTokens: 2600, completionTokens: 220, totalTokens: 2820 } }] }),
			],
			budgets: budgets({ elapsedSeconds: 5, tokensUsed: 2820, tokenBreakdown: tokenBreakdown(2600, 220) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 1, active: true, costTime: 5, costTokens: 2820 })], edges: [flowEdge('you', 'coder', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 5, totalTokens: 2820 })] },
			),
		}, 5),
		// Frame 2: coder→write_file call flowing (write_file is the call's target).
		frame({
			status: 'unknown',
			task: 'Write a README describing the project.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 write_file' },
			roles: [roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(7), eventCount: 3, llmCalls: 1, toolCalls: 1, recentTools: ['write_file'], lastPromptTokens: 2600 })],
			roleTree: [treeNode({ role: 'coder', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(4), type: 'llm_call', summary: 'coder \u00b7 llm call', payload: { role: 'coder' } }),
				logEntry({ timestamp: t(7), type: 'tool_call', summary: 'coder \u00b7 write_file', payload: { role: 'coder', tool: 'write_file', arguments: '{"path":"README.md","content":"# Project\\n"}' }, detailSections: [{ label: 'arguments', content: '{"path":"README.md","content":"# Project\\n"}' }] }),
			],
			budgets: budgets({ elapsedSeconds: 8, toolCalls: 1, tokensUsed: 2820, tokenBreakdown: tokenBreakdown(2600, 220) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 1, costTime: 8, costTokens: 2820 }), flowNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), column: 2, costTime: 1 })], edges: [flowEdge('you', 'coder', 'call'), flowEdge('coder', 'write_file', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 8, totalTokens: 2820 }), topBarNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), invocations: 1 })] },
			),
		}, 8),
		// Frame 3: write_file returns green (coder is the return's target).
		frame({
			status: 'unknown',
			task: 'Write a README describing the project.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 write_file result' },
			roles: [roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(10), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['write_file'], lastPromptTokens: 2600 })],
			roleTree: [treeNode({ role: 'coder', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(7), type: 'tool_call', summary: 'coder \u00b7 write_file', payload: { role: 'coder', tool: 'write_file' } }),
				logEntry({ timestamp: t(10), type: 'tool_result', summary: 'coder \u00b7 write_file result', payload: { role: 'coder', tool: 'write_file', result: 'wrote README.md' }, detailSections: [{ label: 'result', content: 'wrote README.md' }] }),
			],
			budgets: budgets({ elapsedSeconds: 11, toolCalls: 1, tokensUsed: 2820, tokenBreakdown: tokenBreakdown(2600, 220) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 1, costTime: 11, costTokens: 2820 }), flowNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), column: 2, status: 'success', costTime: 4 })], edges: [flowEdge('you', 'coder', 'call'), flowEdge('coder', 'write_file', 'call'), flowEdge('write_file', 'coder', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 11, totalTokens: 2820 }), topBarNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), invocations: 1 })] },
			),
		}, 11),
		// Frame 4: write_file departed, coder thinking (coder active flag).
		frame({
			status: 'unknown',
			task: 'Write a README describing the project.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 thinking' },
			roles: [roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(12), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['write_file'], lastPromptTokens: 2600 })],
			roleTree: [treeNode({ role: 'coder', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(10), type: 'tool_result', summary: 'coder \u00b7 write_file result', payload: { role: 'coder', tool: 'write_file' } }),
			],
			budgets: budgets({ elapsedSeconds: 12, toolCalls: 1, tokensUsed: 2820, tokenBreakdown: tokenBreakdown(2600, 220) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 1, active: true, costTime: 12, costTokens: 2820 })], edges: [flowEdge('you', 'coder', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 12, totalTokens: 2820 }), topBarNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), invocations: 1 })] },
			),
		}, 12),
	],
}

const retry = {
	id: 'retry',
	label: 'Retry (first coder attempt errors, second succeeds)',
	description: 'Two coder invocations under one orchestrator: the first errors, the second succeeds \u2014 exercises the counter badge, the error return, the retry, and the full unwind back to You.',
	frames: [
		// Frame 0: builder-1 has errored. The error return edge builder→conductor is flowing (red), so the conductor (the return's target) is active. The builder lingers with a red border; the call edge in is settled.
		frame({
			status: 'unknown',
			task: 'Fix the failing import in calculator.js.',
			startTime: t(0),
			currentActivity: { role: 'orchestrator', summary: 'receiving builder error' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(5), eventCount: 3, llmCalls: 1, lastPromptTokens: 2900 }),
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
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 6, costTokens: 2990 }), flowNode({ id: 'coder-1', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 2, status: 'error', costTime: 2 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'coder-1', 'call'), flowEdge('coder-1', 'orchestrator', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 6, totalTokens: 2990 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 2 })] },
			),
		}, 6),
		// Frame 1: the error return has landed; the conductor is now mid-thought (deciding to retry). The builder has departed the main area; only you→conductor remains, with the conductor active (no flowing edge — a thinking state).
		frame({
			status: 'unknown',
			task: 'Fix the failing import in calculator.js.',
			startTime: t(0),
			currentActivity: { role: 'orchestrator', summary: 'orchestrator \u00b7 llm call (retry)' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(7), eventCount: 5, llmCalls: 2, lastPromptTokens: 2900 }),
				roleActivity({ role: 'coder', firstSeen: t(3), lastSeen: t(5), eventCount: 2, llmCalls: 1 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: true, children: [treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', status: 'error', summary: 'file not found', active: false })] })],
			recentLog: [
				logEntry({ timestamp: t(5), type: 'role_finished', summary: 'coder \u00b7 finished (error)', payload: { role: 'coder', status: 'error' } }),
				logEntry({ timestamp: t(7), type: 'llm_call', summary: 'orchestrator \u00b7 llm call (retry)', payload: { role: 'orchestrator' } }),
			],
			budgets: budgets({ elapsedSeconds: 8, tokensUsed: 5800, tokenBreakdown: tokenBreakdown(5800, 180) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, active: true, costTime: 8, costTokens: 2990 })], edges: [flowEdge('you', 'orchestrator', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 8, totalTokens: 2990 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 2 })] },
			),
		}, 8),
		// Frame 2: the conductor delegates again (a new builder-2). The orchestrator→coder-2 call is flowing, so builder-2 (the call's target) is active.
		frame({
			status: 'unknown',
			task: 'Fix the failing import in calculator.js.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 role start (second attempt)' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(9), eventCount: 6, llmCalls: 2, lastPromptTokens: 2900 }),
				roleActivity({ role: 'coder', firstSeen: t(9), lastSeen: t(9), eventCount: 1, llmCalls: 0 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(7), type: 'llm_call', summary: 'orchestrator \u00b7 llm call (retry)', payload: { role: 'orchestrator' } }),
				logEntry({ timestamp: t(9), type: 'agent_call', summary: 'orchestrator \u00b7 agent call \u2192 coder', payload: { parent: 'orchestrator', child: 'coder', depth: 1 } }),
				logEntry({ timestamp: t(9), type: 'role_start', summary: 'coder \u00b7 role start', payload: { role: 'coder', depth: 1, parent: 'orchestrator', task: 'second attempt' } }),
			],
			budgets: budgets({ elapsedSeconds: 10, tokensUsed: 5800, tokenBreakdown: tokenBreakdown(5800, 180) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 10, costTokens: 2990 }), flowNode({ id: 'coder-2', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 2, costTime: 1 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'coder-2', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 10, totalTokens: 2990 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 2, totalTime: 2 })] },
			),
		}, 10),
		// Frame 3: builder-2 has its first turn (costTokens set), no outgoing edge yet — a thinking state, so builder-2 carries the active flag.
		frame({
			status: 'unknown',
			task: 'Fix the failing import in calculator.js.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 llm call' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(9), eventCount: 6, llmCalls: 2, lastPromptTokens: 2900 }),
				roleActivity({ role: 'coder', firstSeen: t(9), lastSeen: t(11), eventCount: 3, llmCalls: 1, lastPromptTokens: 2700 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(9), type: 'role_start', summary: 'coder \u00b7 role start', payload: { role: 'coder', depth: 1, parent: 'orchestrator', task: 'second attempt' } }),
				logEntry({ timestamp: t(11), type: 'llm_call', summary: 'coder \u00b7 llm call', payload: { role: 'coder', usage: { promptTokens: 2700, completionTokens: 120, totalTokens: 2820 } }, detailSections: [{ label: 'usage', content: { promptTokens: 2700, completionTokens: 120, totalTokens: 2820 } }] }),
			],
			budgets: budgets({ elapsedSeconds: 12, tokensUsed: 8500, tokenBreakdown: tokenBreakdown(8400, 220) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 10, costTokens: 2990 }), flowNode({ id: 'coder-2', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 2, active: true, costTime: 3, costTokens: 2820 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'coder-2', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 10, totalTokens: 2990 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 2, totalTime: 3, totalTokens: 2820 })] },
			),
		}, 12),
		// Frame 4: builder-2 calls save-file. The coder→write_file call is flowing, so write_file is active.
		frame({
			status: 'unknown',
			task: 'Fix the failing import in calculator.js.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 write_file' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(9), eventCount: 6, llmCalls: 2, lastPromptTokens: 2900 }),
				roleActivity({ role: 'coder', firstSeen: t(9), lastSeen: t(13), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['write_file'], lastPromptTokens: 2700 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(11), type: 'llm_call', summary: 'coder \u00b7 llm call', payload: { role: 'coder' } }),
				logEntry({ timestamp: t(13), type: 'tool_call', summary: 'coder \u00b7 write_file', payload: { role: 'coder', tool: 'write_file', arguments: '{"path":"calculator.js"}' } }),
			],
			budgets: budgets({ elapsedSeconds: 14, toolCalls: 1, tokensUsed: 8500, tokenBreakdown: tokenBreakdown(8400, 220) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 10, costTokens: 2990 }), flowNode({ id: 'coder-2', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 2, costTime: 5, costTokens: 2820 }), flowNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), column: 3, costTime: 1 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'coder-2', 'call'), flowEdge('coder-2', 'write_file', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 10, totalTokens: 2990 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 2, totalTime: 5, totalTokens: 2820 }), topBarNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), invocations: 1 })] },
			),
		}, 14),
		// Frame 5: save-file returns. The write_file→coder-2 return edge is flowing, so builder-2 (the return's target) is active.
		frame({
			status: 'unknown',
			task: 'Fix the failing import in calculator.js.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 write_file result' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(9), eventCount: 6, llmCalls: 2, lastPromptTokens: 2900 }),
				roleActivity({ role: 'coder', firstSeen: t(9), lastSeen: t(15), eventCount: 5, llmCalls: 1, toolCalls: 1, recentTools: ['write_file'], lastPromptTokens: 2700 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(13), type: 'tool_call', summary: 'coder \u00b7 write_file', payload: { role: 'coder', tool: 'write_file' } }),
				logEntry({ timestamp: t(15), type: 'tool_result', summary: 'coder \u00b7 write_file result', payload: { role: 'coder', tool: 'write_file', result: 'wrote calculator.js' }, detailSections: [{ label: 'result', content: 'wrote calculator.js' }] }),
			],
			budgets: budgets({ elapsedSeconds: 16, toolCalls: 1, tokensUsed: 8500, tokenBreakdown: tokenBreakdown(8400, 220) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 10, costTokens: 2990 }), flowNode({ id: 'coder-2', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 2, costTime: 7, costTokens: 2820 }), flowNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), column: 3, status: 'success', costTime: 3 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'coder-2', 'call'), flowEdge('coder-2', 'write_file', 'call'), flowEdge('write_file', 'coder-2', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 10, totalTokens: 2990 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 2, totalTime: 7, totalTokens: 2820 }), topBarNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), invocations: 1 })] },
			),
		}, 16),
		// Frame 6: the tool return has landed; builder-2 is thinking (no flowing edge). write_file has departed; only you→orchestrator→coder-2 remains, with builder-2 active.
		frame({
			status: 'unknown',
			task: 'Fix the failing import in calculator.js.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 finishing' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(9), eventCount: 6, llmCalls: 2, lastPromptTokens: 2900 }),
				roleActivity({ role: 'coder', firstSeen: t(9), lastSeen: t(17), eventCount: 6, llmCalls: 2, toolCalls: 1, recentTools: ['write_file'], lastPromptTokens: 2700 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(15), type: 'tool_result', summary: 'coder \u00b7 write_file result', payload: { role: 'coder', tool: 'write_file' } }),
				logEntry({ timestamp: t(17), type: 'llm_call', summary: 'coder \u00b7 llm call (finish)', payload: { role: 'coder' } }),
			],
			budgets: budgets({ elapsedSeconds: 18, toolCalls: 1, tokensUsed: 11300, tokenBreakdown: tokenBreakdown(11200, 300) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 10, costTokens: 2990 }), flowNode({ id: 'coder-2', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 2, active: true, costTime: 9, costTokens: 2820 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'coder-2', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 10, totalTokens: 2990 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 2, totalTime: 9, totalTokens: 2820 }), topBarNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), invocations: 1 })] },
			),
		}, 18),
		// Frame 7: builder-2 returns success to the conductor. The coder-2→orchestrator return edge is flowing, so the conductor is active.
		frame({
			status: 'unknown',
			task: 'Fix the failing import in calculator.js.',
			startTime: t(0),
			currentActivity: { role: 'orchestrator', summary: 'receiving coder success' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(19), eventCount: 7, llmCalls: 2, lastPromptTokens: 2900 }),
				roleActivity({ role: 'coder', firstSeen: t(9), lastSeen: t(19), eventCount: 6, llmCalls: 2, toolCalls: 1, recentTools: ['write_file'], lastPromptTokens: 2700 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', status: 'success', summary: 'wrote the file', active: false })] })],
			recentLog: [
				logEntry({ timestamp: t(17), type: 'llm_call', summary: 'coder \u00b7 llm call (finish)', payload: { role: 'coder' } }),
				logEntry({ timestamp: t(19), type: 'role_finished', summary: 'coder \u00b7 finished (success)', payload: { role: 'coder', status: 'success', summary: 'wrote the file' } }),
			],
			budgets: budgets({ elapsedSeconds: 20, toolCalls: 1, tokensUsed: 11300, tokenBreakdown: tokenBreakdown(11200, 300) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 20, costTokens: 2990 }), flowNode({ id: 'coder-2', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 2, status: 'success', costTime: 11, costTokens: 2820 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'coder-2', 'call'), flowEdge('coder-2', 'orchestrator', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 20, totalTokens: 2990 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 2, totalTime: 11, totalTokens: 2820 }), topBarNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), invocations: 1 })] },
			),
		}, 20),
		// Frame 8: the success return has landed; the conductor is thinking (no flowing edge). builder-2 has departed; only you→orchestrator remains, with the conductor active.
		frame({
			status: 'unknown',
			task: 'Fix the failing import in calculator.js.',
			startTime: t(0),
			currentActivity: { role: 'orchestrator', summary: 'orchestrator \u00b7 finishing' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(21), eventCount: 8, llmCalls: 3, lastPromptTokens: 2900 }),
				roleActivity({ role: 'coder', firstSeen: t(9), lastSeen: t(19), eventCount: 6, llmCalls: 2, toolCalls: 1, recentTools: ['write_file'], lastPromptTokens: 2700 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(19), type: 'role_finished', summary: 'coder \u00b7 finished (success)', payload: { role: 'coder', status: 'success' } }),
				logEntry({ timestamp: t(21), type: 'llm_call', summary: 'orchestrator \u00b7 llm call (finish)', payload: { role: 'orchestrator' } }),
			],
			budgets: budgets({ elapsedSeconds: 22, toolCalls: 1, tokensUsed: 14200, tokenBreakdown: tokenBreakdown(14100, 360) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, active: true, costTime: 22, costTokens: 2990 })], edges: [flowEdge('you', 'orchestrator', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 22, totalTokens: 2990 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 2, totalTime: 11, totalTokens: 2820 }), topBarNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), invocations: 1 })] },
			),
		}, 22),
		// Frame 9: the conductor returns to You. The orchestrator→you return edge is flowing, so You is active.
		frame({
			status: 'unknown',
			task: 'Fix the failing import in calculator.js.',
			startTime: t(0),
			currentActivity: { role: 'orchestrator', summary: 'orchestrator \u00b7 finished (success)' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(23), eventCount: 9, llmCalls: 3, lastPromptTokens: 2900 }),
				roleActivity({ role: 'coder', firstSeen: t(9), lastSeen: t(19), eventCount: 6, llmCalls: 2, toolCalls: 1, recentTools: ['write_file'], lastPromptTokens: 2700 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, status: 'success', summary: 'done after retry', active: false })],
			recentLog: [
				logEntry({ timestamp: t(21), type: 'llm_call', summary: 'orchestrator \u00b7 llm call (finish)', payload: { role: 'orchestrator' } }),
				logEntry({ timestamp: t(23), type: 'role_finished', summary: 'orchestrator \u00b7 finished (success)', payload: { role: 'orchestrator', status: 'success', summary: 'done after retry' } }),
			],
			budgets: budgets({ elapsedSeconds: 23, toolCalls: 1, tokensUsed: 14200, tokenBreakdown: tokenBreakdown(14100, 360) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, status: 'success', costTime: 23, costTokens: 2990 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'you', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 23, totalTokens: 2990 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 2, totalTime: 11, totalTokens: 2820 }), topBarNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), invocations: 1 })] },
			),
		}, 23),
		// Frame 10: the run is done. Only You remains; everything has departed to the top bar.
		frame({
			status: 'success',
			runId: 'run-retry-fixture',
			task: 'Fix the failing import in calculator.js.',
			startTime: t(0),
			endTime: t(23),
			result: { status: 'success', summary: 'Fixed the import after a retry.', artifacts: ['calculator.js'] },
			currentActivity: { role: 'orchestrator', summary: 'orchestrator \u00b7 finished (success)' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(23), eventCount: 9, llmCalls: 3 }),
				roleActivity({ role: 'coder', firstSeen: t(9), lastSeen: t(19), eventCount: 6, llmCalls: 2, toolCalls: 1, recentTools: ['write_file'] }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, status: 'success', summary: 'done after retry', active: false })],
			recentLog: [
				logEntry({ timestamp: t(23), type: 'role_finished', summary: 'orchestrator \u00b7 finished (success)', payload: { role: 'orchestrator', status: 'success', summary: 'done after retry' } }),
			],
			budgets: budgets({ elapsedSeconds: 23, toolCalls: 1, tokensUsed: 14200, tokenBreakdown: tokenBreakdown(14100, 360) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 })], edges: [] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 23, totalTokens: 2990 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 2, totalTime: 11, totalTokens: 2820 }), topBarNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), invocations: 1 })] },
			),
		}, 23),
	],
}

const pendingQuestion = {
	id: 'pending-question',
	label: 'ask_human question: pending, answered, then caller acts',
	description: 'The orchestrator asks you a question and waits \u2014 then you answer, the child You lingers as a response edge, and the caller acts so the child You departs to the top bar. Exercises the question modal and the You node\u2019s enter/linger/depart lifecycle.',
	frames: [
		// Frame 0: you→orchestrator call flowing (orchestrator is the call's target, no costTokens yet).
		frame({
			status: 'unknown',
			task: 'Set up a new CI workflow for the monorepo.',
			startTime: t(0),
			currentActivity: { role: 'orchestrator', summary: 'orchestrator \u00b7 role start' },
			roles: [roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(1), eventCount: 1, llmCalls: 0 })],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: true })],
			recentLog: [logEntry({ timestamp: t(1), type: 'role_start', summary: 'orchestrator \u00b7 role start', payload: { role: 'orchestrator', depth: 0, task: 'Set up a new CI workflow for the monorepo' } })],
			budgets: budgets({ elapsedSeconds: 2 }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 2 })], edges: [flowEdge('you', 'orchestrator', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 2 })] },
			),
		}, 2),
		// Frame 1: orchestrator thinking (call settled, orchestrator has costTokens, active flag).
		frame({
			status: 'unknown',
			task: 'Set up a new CI workflow for the monorepo.',
			startTime: t(0),
			currentActivity: { role: 'orchestrator', summary: 'orchestrator \u00b7 llm call' },
			roles: [roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(4), eventCount: 2, llmCalls: 1, lastPromptTokens: 3500 })],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(1), type: 'role_start', summary: 'orchestrator \u00b7 role start', payload: { role: 'orchestrator', depth: 0 } }),
				logEntry({ timestamp: t(4), type: 'llm_call', summary: 'orchestrator \u00b7 llm call', payload: { role: 'orchestrator', usage: { promptTokens: 3500, completionTokens: 140, totalTokens: 3640 } }, detailSections: [{ label: 'usage', content: { promptTokens: 3500, completionTokens: 140, totalTokens: 3640 } }] }),
			],
			budgets: budgets({ elapsedSeconds: 5, tokensUsed: 3640, tokenBreakdown: tokenBreakdown(3500, 140) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, active: true, costTime: 5, costTokens: 3640 })], edges: [flowEdge('you', 'orchestrator', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 5, totalTokens: 3640 })] },
			),
		}, 5),
		// Frame 2: orchestrator→ask_human call flowing (ask_human is the call's target, in flight, no question edge yet).
		frame({
			status: 'unknown',
			task: 'Set up a new CI workflow for the monorepo.',
			startTime: t(0),
			currentActivity: { role: 'orchestrator', summary: 'orchestrator \u00b7 ask_human' },
			roles: [roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(6), eventCount: 3, llmCalls: 1, toolCalls: 1, recentTools: ['ask_human'], lastPromptTokens: 3500 })],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(4), type: 'llm_call', summary: 'orchestrator \u00b7 llm call', payload: { role: 'orchestrator' } }),
				logEntry({ timestamp: t(6), type: 'tool_call', summary: 'orchestrator \u00b7 ask_human', payload: { role: 'orchestrator', tool: 'ask_human', arguments: '{"question":"Which CI provider should I target?"}' }, detailSections: [{ label: 'arguments', content: '{"question":"Which CI provider should I target?"}' }] }),
			],
			budgets: budgets({ elapsedSeconds: 7, toolCalls: 1, tokensUsed: 3640, tokenBreakdown: tokenBreakdown(3500, 140) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 7, costTokens: 3640 }), flowNode({ id: 'ask_human', kind: 'tool', label: toolLabel('ask_human'), column: 2, costTime: 1 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'ask_human', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 7, totalTokens: 3640 }), topBarNode({ id: 'ask_human', kind: 'tool', label: toolLabel('ask_human'), invocations: 1 })] },
			),
		}, 7),
		// Frame 3: ask_human has emitted its question; the ask_human→you-ask question edge is flowing (you-ask is the target, so it pulses). The call edges settled: orchestrator has its first turn and ask_human is waiting for the answer, so its incoming call no longer flows.
		frame({
			status: 'unknown',
			task: 'Set up a new CI workflow for the monorepo.',
			startTime: t(0),
			currentActivity: { role: 'orchestrator', summary: 'ask_human' },
			roles: [roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(8), eventCount: 3, llmCalls: 1, toolCalls: 1, recentTools: ['ask_human'], lastPromptTokens: 3500 })],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(6), type: 'tool_call', summary: 'orchestrator \u00b7 ask_human', payload: { role: 'orchestrator', tool: 'ask_human' } }),
				logEntry({ timestamp: t(8), type: 'ask_human', summary: 'ask_human', payload: { id: 'q1', question: 'Which CI provider should I target?', context: '.github/workflows/' } }),
			],
			questionHistory: [question({ id: 'q1', question: 'Which CI provider should I target?', context: '.github/workflows/', askedAt: t(8) })],
			budgets: budgets({ elapsedSeconds: 20, toolCalls: 1, tokensUsed: 3640, tokenBreakdown: tokenBreakdown(3500, 140) }),
			flowModel: flowModel(
				// The pending question forms a `You → Orchestrator → ask_human → You` chain: the run's root You at the left, the question traveling right to a second You (the respondent) at the right. Only the ask_human → You (respondent) edge flows and only the respondent You pulses; the call edges settled (orchestrator has its first turn, and ask_human has emitted its question and is waiting for the answer, so its incoming call no longer flows).
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 20, costTokens: 3640 }), flowNode({ id: 'ask_human', kind: 'tool', label: toolLabel('ask_human'), column: 2, costTime: 14 }), flowNode({ id: 'you-ask', kind: 'you', label: 'You', column: 3, active: true })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'ask_human', 'call'), flowEdge('ask_human', 'you-ask', 'question')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 20, totalTokens: 3640 }), topBarNode({ id: 'ask_human', kind: 'tool', label: toolLabel('ask_human'), invocations: 1 })] },
			),
		}, 20),
		// Frame 4: the user has answered. The question edge is gone; the child You (respondent) lingers with a return edge back to ask_human, and ask_human lingers with its own return edge to the orchestrator (the tool has its result and is handing it back). Both returns flow right→left; the orchestrator (the outermost return's target) is active (receiving the answer). The call edges settle. The answered question now carries its answer in the history.
		frame({
			status: 'unknown',
			task: 'Set up a new CI workflow for the monorepo.',
			startTime: t(0),
			currentActivity: { role: 'orchestrator', summary: 'receiving your answer' },
			roles: [roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(22), eventCount: 3, llmCalls: 1, toolCalls: 1, recentTools: ['ask_human'], lastPromptTokens: 3500 })],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(8), type: 'ask_human', summary: 'ask_human', payload: { id: 'q1', question: 'Which CI provider should I target?', context: '.github/workflows/' } }),
				logEntry({ timestamp: t(22), type: 'human_answer', summary: 'human_answer', payload: { id: 'q1', answer: 'GitHub Actions \u2014 we already use it for the monorepo.' } }),
			],
			questionHistory: [question({ id: 'q1', question: 'Which CI provider should I target?', context: '.github/workflows/', askedAt: t(8), answer: 'GitHub Actions \u2014 we already use it for the monorepo.', answeredAt: t(22) })],
			budgets: budgets({ elapsedSeconds: 22, toolCalls: 1, tokensUsed: 3640, tokenBreakdown: tokenBreakdown(3500, 140) }),
			flowModel: flowModel(
				// The answer travels left along the same chain the question traveled right: you-ask → ask_human → orchestrator. Both the child You and ask_human linger as response edges (right→left) until the orchestrator emits a new action; the call edges settle because the returns now carry the motion.
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, active: true, costTime: 22, costTokens: 3640 }), flowNode({ id: 'ask_human', kind: 'tool', label: toolLabel('ask_human'), column: 2, status: 'success', costTime: 16 }), flowNode({ id: 'you-ask', kind: 'you', label: 'You', column: 3, status: 'success' })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'ask_human', 'call'), flowEdge('you-ask', 'ask_human', 'return'), flowEdge('ask_human', 'orchestrator', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 22, totalTokens: 3640 }), topBarNode({ id: 'ask_human', kind: 'tool', label: toolLabel('ask_human'), invocations: 1 })] },
			),
		}, 22),
		// Frame 5: the caller has acted (a new llm_call on the answered question), so the lingering child You and ask_human depart the main area for their top-bar slots. The child You merges into the "You" slot, bumping its count to 2 (the root plus one completed Q&A); ask_human merges into its existing slot (one invocation — the same question). The main area settles back to the root You and the thinking orchestrator.
		frame({
			status: 'unknown',
			task: 'Set up a new CI workflow for the monorepo.',
			startTime: t(0),
			currentActivity: { role: 'orchestrator', summary: 'orchestrator \u00b7 thinking' },
			roles: [roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(25), eventCount: 4, llmCalls: 2, toolCalls: 1, recentTools: ['ask_human'], lastPromptTokens: 3500 })],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(22), type: 'human_answer', summary: 'human_answer', payload: { id: 'q1', answer: 'GitHub Actions \u2014 we already use it for the monorepo.' } }),
				logEntry({ timestamp: t(25), type: 'llm_call', summary: 'orchestrator \u00b7 llm call', payload: { role: 'orchestrator', usage: { promptTokens: 3900, completionTokens: 160, totalTokens: 4060 } }, detailSections: [{ label: 'usage', content: { promptTokens: 3900, completionTokens: 160, totalTokens: 4060 } }] }),
			],
			questionHistory: [question({ id: 'q1', question: 'Which CI provider should I target?', context: '.github/workflows/', askedAt: t(8), answer: 'GitHub Actions \u2014 we already use it for the monorepo.', answeredAt: t(22) })],
			budgets: budgets({ elapsedSeconds: 25, toolCalls: 1, tokensUsed: 4060, tokenBreakdown: tokenBreakdown(3500, 560) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, active: true, costTime: 25, costTokens: 4060 })], edges: [flowEdge('you', 'orchestrator', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 2 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 25, totalTokens: 4060 }), topBarNode({ id: 'ask_human', kind: 'tool', label: toolLabel('ask_human'), invocations: 1 })] },
			),
		}, 25),
	],
}

const completedSuccess = {
	id: 'completed-success',
	label: 'Completed successful run (orchestrator \u2192 planner \u2192 coder \u2192 critic)',
	description: 'A finished run with a deep delegation chain and a result \u2014 exercises the result modal and the settled static graph.',
	frames: [
		// Frame 0: you→orchestrator call flowing (orchestrator is the call's target, no costTokens yet).
		frame({
			status: 'unknown',
			task: 'Add a CSV export to the reports module.',
			startTime: t(0),
			currentActivity: { role: 'orchestrator', summary: 'orchestrator \u00b7 role start' },
			roles: [roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(1), eventCount: 1, llmCalls: 0 })],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: true })],
			recentLog: [logEntry({ timestamp: t(1), type: 'role_start', summary: 'orchestrator \u00b7 role start', payload: { role: 'orchestrator', depth: 0, task: 'Add a CSV export to the reports module' } })],
			budgets: budgets({ elapsedSeconds: 2 }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 2 })], edges: [flowEdge('you', 'orchestrator', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 2 })] },
			),
		}, 2),
		// Frame 1: orchestrator thinking (call settled, orchestrator has costTokens, active flag).
		frame({
			status: 'unknown',
			task: 'Add a CSV export to the reports module.',
			startTime: t(0),
			currentActivity: { role: 'orchestrator', summary: 'orchestrator \u00b7 llm call' },
			roles: [roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(4), eventCount: 2, llmCalls: 1, lastPromptTokens: 3000 })],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(1), type: 'role_start', summary: 'orchestrator \u00b7 role start', payload: { role: 'orchestrator', depth: 0 } }),
				logEntry({ timestamp: t(4), type: 'llm_call', summary: 'orchestrator \u00b7 llm call', payload: { role: 'orchestrator', usage: { promptTokens: 3000, completionTokens: 260, totalTokens: 3260 } }, detailSections: [{ label: 'usage', content: { promptTokens: 3000, completionTokens: 260, totalTokens: 3260 } }] }),
			],
			budgets: budgets({ elapsedSeconds: 5, tokensUsed: 3260, tokenBreakdown: tokenBreakdown(3000, 260) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, active: true, costTime: 5, costTokens: 3260 })], edges: [flowEdge('you', 'orchestrator', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 5, totalTokens: 3260 })] },
			),
		}, 5),
		// Frame 2: orchestrator→planner call flowing (planner is the call's target, no costTokens yet).
		frame({
			status: 'unknown',
			task: 'Add a CSV export to the reports module.',
			startTime: t(0),
			currentActivity: { role: 'planner', summary: 'planner \u00b7 role start' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(7), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 3000 }),
				roleActivity({ role: 'planner', firstSeen: t(7), lastSeen: t(7), eventCount: 1, llmCalls: 0 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'planner', depth: 1, parent: 'orchestrator', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(4), type: 'llm_call', summary: 'orchestrator \u00b7 llm call', payload: { role: 'orchestrator' } }),
				logEntry({ timestamp: t(7), type: 'tool_call', summary: 'orchestrator \u00b7 agent', payload: { role: 'orchestrator', tool: 'agent', arguments: '{"role":"planner","task":"plan the CSV export"}' }, detailSections: [{ label: 'arguments', content: '{"role":"planner","task":"plan the CSV export"}' }] }),
				logEntry({ timestamp: t(7), type: 'agent_call', summary: 'orchestrator \u00b7 agent call \u2192 planner', payload: { parent: 'orchestrator', child: 'planner', depth: 1 } }),
			],
			budgets: budgets({ elapsedSeconds: 8, toolCalls: 1, tokensUsed: 3260, tokenBreakdown: tokenBreakdown(3000, 260) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 8, costTokens: 3260 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 2, costTime: 1 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'planner', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 8, totalTokens: 3260 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 1 })] },
			),
		}, 8),
		// Frame 3: planner thinking (call settled, planner has costTokens, active flag).
		frame({
			status: 'unknown',
			task: 'Add a CSV export to the reports module.',
			startTime: t(0),
			currentActivity: { role: 'planner', summary: 'planner \u00b7 llm call' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(7), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 3000 }),
				roleActivity({ role: 'planner', firstSeen: t(7), lastSeen: t(10), eventCount: 3, llmCalls: 1, lastPromptTokens: 5200 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'planner', depth: 1, parent: 'orchestrator', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(7), type: 'agent_call', summary: 'orchestrator \u00b7 agent call \u2192 planner', payload: { parent: 'orchestrator', child: 'planner', depth: 1 } }),
				logEntry({ timestamp: t(7), type: 'role_start', summary: 'planner \u00b7 role start', payload: { role: 'planner', depth: 1, parent: 'orchestrator', task: 'plan the CSV export' } }),
				logEntry({ timestamp: t(10), type: 'llm_call', summary: 'planner \u00b7 llm call', payload: { role: 'planner', usage: { promptTokens: 5200, completionTokens: 260, totalTokens: 5460 } }, detailSections: [{ label: 'usage', content: { promptTokens: 5200, completionTokens: 260, totalTokens: 5460 } }] }),
			],
			budgets: budgets({ elapsedSeconds: 11, tokensUsed: 8720, tokenBreakdown: tokenBreakdown(8200, 520) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 11, costTokens: 3260 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 2, active: true, costTime: 4, costTokens: 5460 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'planner', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 11, totalTokens: 3260 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 4, totalTokens: 5460 })] },
			),
		}, 11),
		// Frame 4: planner returns green to orchestrator (planner status:success, return edge flowing, orchestrator is the return's target).
		frame({
			status: 'unknown',
			task: 'Add a CSV export to the reports module.',
			startTime: t(0),
			currentActivity: { role: 'orchestrator', summary: 'receiving planner success' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(13), eventCount: 5, llmCalls: 1, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 3000 }),
				roleActivity({ role: 'planner', firstSeen: t(7), lastSeen: t(13), eventCount: 4, llmCalls: 1, lastPromptTokens: 5200 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'planner', depth: 1, parent: 'orchestrator', status: 'success', summary: 'planned the CSV export', active: false })] })],
			recentLog: [
				logEntry({ timestamp: t(10), type: 'llm_call', summary: 'planner \u00b7 llm call (finish)', payload: { role: 'planner' } }),
				logEntry({ timestamp: t(13), type: 'role_finished', summary: 'planner \u00b7 finished (success)', payload: { role: 'planner', status: 'success', summary: 'planned the CSV export' } }),
			],
			budgets: budgets({ elapsedSeconds: 14, toolCalls: 1, tokensUsed: 8720, tokenBreakdown: tokenBreakdown(8200, 520) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 14, costTokens: 3260 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 2, status: 'success', costTime: 7, costTokens: 5460 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'planner', 'call'), flowEdge('planner', 'orchestrator', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 14, totalTokens: 3260 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 7, totalTokens: 5460 })] },
			),
		}, 14),
		// Frame 5: planner departed, orchestrator thinking (orchestrator active flag, no flowing edge).
		frame({
			status: 'unknown',
			task: 'Add a CSV export to the reports module.',
			startTime: t(0),
			currentActivity: { role: 'orchestrator', summary: 'orchestrator \u00b7 thinking' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(15), eventCount: 6, llmCalls: 2, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 3000 }),
				roleActivity({ role: 'planner', firstSeen: t(7), lastSeen: t(13), eventCount: 4, llmCalls: 1, lastPromptTokens: 5200 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(13), type: 'role_finished', summary: 'planner \u00b7 finished (success)', payload: { role: 'planner', status: 'success' } }),
				logEntry({ timestamp: t(15), type: 'llm_call', summary: 'orchestrator \u00b7 llm call', payload: { role: 'orchestrator', usage: { promptTokens: 3000, completionTokens: 200, totalTokens: 3200 } }, detailSections: [{ label: 'usage', content: { promptTokens: 3000, completionTokens: 200, totalTokens: 3200 } }] }),
			],
			budgets: budgets({ elapsedSeconds: 15, toolCalls: 1, tokensUsed: 11920, tokenBreakdown: tokenBreakdown(11200, 720) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, active: true, costTime: 15, costTokens: 6460 })], edges: [flowEdge('you', 'orchestrator', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 15, totalTokens: 6460 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 7, totalTokens: 5460, status: 'success' })] },
			),
		}, 15),
		// Frame 6: orchestrator→coder call flowing (coder is the call's target, no costTokens yet).
		frame({
			status: 'unknown',
			task: 'Add a CSV export to the reports module.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 role start' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(17), eventCount: 7, llmCalls: 2, toolCalls: 2, recentTools: ['agent'], lastPromptTokens: 3000 }),
				roleActivity({ role: 'planner', firstSeen: t(7), lastSeen: t(13), eventCount: 4, llmCalls: 1, lastPromptTokens: 5200 }),
				roleActivity({ role: 'coder', firstSeen: t(17), lastSeen: t(17), eventCount: 1, llmCalls: 0 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(15), type: 'llm_call', summary: 'orchestrator \u00b7 llm call', payload: { role: 'orchestrator' } }),
				logEntry({ timestamp: t(17), type: 'tool_call', summary: 'orchestrator \u00b7 agent', payload: { role: 'orchestrator', tool: 'agent', arguments: '{"role":"coder","task":"write the CSV export"}' }, detailSections: [{ label: 'arguments', content: '{"role":"coder","task":"write the CSV export"}' }] }),
				logEntry({ timestamp: t(17), type: 'agent_call', summary: 'orchestrator \u00b7 agent call \u2192 coder', payload: { parent: 'orchestrator', child: 'coder', depth: 1 } }),
			],
			budgets: budgets({ elapsedSeconds: 18, toolCalls: 2, tokensUsed: 11920, tokenBreakdown: tokenBreakdown(11200, 720) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 18, costTokens: 6460 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 2, costTime: 1 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'coder', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 18, totalTokens: 6460 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 7, totalTokens: 5460, status: 'success' }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 1 })] },
			),
		}, 18),
		// Frame 7: coder thinking (call settled, coder has costTokens, active flag).
		frame({
			status: 'unknown',
			task: 'Add a CSV export to the reports module.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 llm call' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(17), eventCount: 7, llmCalls: 2, toolCalls: 2, recentTools: ['agent'], lastPromptTokens: 3000 }),
				roleActivity({ role: 'planner', firstSeen: t(7), lastSeen: t(13), eventCount: 4, llmCalls: 1, lastPromptTokens: 5200 }),
				roleActivity({ role: 'coder', firstSeen: t(17), lastSeen: t(20), eventCount: 3, llmCalls: 1, lastPromptTokens: 6100 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(17), type: 'agent_call', summary: 'orchestrator \u00b7 agent call \u2192 coder', payload: { parent: 'orchestrator', child: 'coder', depth: 1 } }),
				logEntry({ timestamp: t(17), type: 'role_start', summary: 'coder \u00b7 role start', payload: { role: 'coder', depth: 1, parent: 'orchestrator', task: 'write the CSV export' } }),
				logEntry({ timestamp: t(20), type: 'llm_call', summary: 'coder \u00b7 llm call', payload: { role: 'coder', usage: { promptTokens: 6100, completionTokens: 520, totalTokens: 6620 } }, detailSections: [{ label: 'usage', content: { promptTokens: 6100, completionTokens: 520, totalTokens: 6620 } }] }),
			],
			budgets: budgets({ elapsedSeconds: 21, tokensUsed: 18540, tokenBreakdown: tokenBreakdown(17300, 1240) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 21, costTokens: 6460 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 2, active: true, costTime: 4, costTokens: 6620 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'coder', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 21, totalTokens: 6460 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 7, totalTokens: 5460, status: 'success' }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 4, totalTokens: 6620 })] },
			),
		}, 21),
		// Frame 8: coder→write_file call flowing (write_file is the call's target).
		frame({
			status: 'unknown',
			task: 'Add a CSV export to the reports module.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 write_file' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(17), eventCount: 7, llmCalls: 2, toolCalls: 2, recentTools: ['agent'], lastPromptTokens: 3000 }),
				roleActivity({ role: 'planner', firstSeen: t(7), lastSeen: t(13), eventCount: 4, llmCalls: 1, lastPromptTokens: 5200 }),
				roleActivity({ role: 'coder', firstSeen: t(17), lastSeen: t(22), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['write_file'], lastPromptTokens: 6100 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(20), type: 'llm_call', summary: 'coder \u00b7 llm call', payload: { role: 'coder' } }),
				logEntry({ timestamp: t(22), type: 'tool_call', summary: 'coder \u00b7 write_file', payload: { role: 'coder', tool: 'write_file', arguments: '{"path":"reports/csv.js"}' }, detailSections: [{ label: 'arguments', content: '{"path":"reports/csv.js"}' }] }),
			],
			budgets: budgets({ elapsedSeconds: 23, toolCalls: 3, tokensUsed: 18540, tokenBreakdown: tokenBreakdown(17300, 1240) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 23, costTokens: 6460 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 2, costTime: 6, costTokens: 6620 }), flowNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), column: 3, costTime: 1 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'coder', 'call'), flowEdge('coder', 'write_file', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 23, totalTokens: 6460 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 7, totalTokens: 5460, status: 'success' }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 6, totalTokens: 6620 }), topBarNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), invocations: 1 })] },
			),
		}, 23),
		// Frame 9: write_file returns green (write_file status:success, return edge flowing, coder is the return's target).
		frame({
			status: 'unknown',
			task: 'Add a CSV export to the reports module.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 write_file result' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(17), eventCount: 7, llmCalls: 2, toolCalls: 2, recentTools: ['agent'], lastPromptTokens: 3000 }),
				roleActivity({ role: 'planner', firstSeen: t(7), lastSeen: t(13), eventCount: 4, llmCalls: 1, lastPromptTokens: 5200 }),
				roleActivity({ role: 'coder', firstSeen: t(17), lastSeen: t(24), eventCount: 5, llmCalls: 1, toolCalls: 1, recentTools: ['write_file'], lastPromptTokens: 6100 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(22), type: 'tool_call', summary: 'coder \u00b7 write_file', payload: { role: 'coder', tool: 'write_file' } }),
				logEntry({ timestamp: t(24), type: 'tool_result', summary: 'coder \u00b7 write_file result', payload: { role: 'coder', tool: 'write_file', result: 'wrote reports/csv.js' }, detailSections: [{ label: 'result', content: 'wrote reports/csv.js' }] }),
			],
			budgets: budgets({ elapsedSeconds: 25, toolCalls: 3, tokensUsed: 18540, tokenBreakdown: tokenBreakdown(17300, 1240) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 25, costTokens: 6460 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 2, costTime: 8, costTokens: 6620 }), flowNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), column: 3, status: 'success', costTime: 3 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'coder', 'call'), flowEdge('coder', 'write_file', 'call'), flowEdge('write_file', 'coder', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 25, totalTokens: 6460 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 7, totalTokens: 5460, status: 'success' }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 8, totalTokens: 6620 }), topBarNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), invocations: 1 })] },
			),
		}, 25),
		// Frame 10: write_file departed, coder thinking (coder active flag, no flowing edge).
		frame({
			status: 'unknown',
			task: 'Add a CSV export to the reports module.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 thinking' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(17), eventCount: 7, llmCalls: 2, toolCalls: 2, recentTools: ['agent'], lastPromptTokens: 3000 }),
				roleActivity({ role: 'planner', firstSeen: t(7), lastSeen: t(13), eventCount: 4, llmCalls: 1, lastPromptTokens: 5200 }),
				roleActivity({ role: 'coder', firstSeen: t(17), lastSeen: t(27), eventCount: 6, llmCalls: 2, toolCalls: 1, recentTools: ['write_file'], lastPromptTokens: 6100 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(24), type: 'tool_result', summary: 'coder \u00b7 write_file result', payload: { role: 'coder', tool: 'write_file' } }),
				logEntry({ timestamp: t(27), type: 'llm_call', summary: 'coder \u00b7 llm call (finish)', payload: { role: 'coder', usage: { promptTokens: 6100, completionTokens: 200, totalTokens: 6300 } }, detailSections: [{ label: 'usage', content: { promptTokens: 6100, completionTokens: 200, totalTokens: 6300 } }] }),
			],
			budgets: budgets({ elapsedSeconds: 26, toolCalls: 3, tokensUsed: 24840, tokenBreakdown: tokenBreakdown(23400, 1440) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 26, costTokens: 6460 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 2, active: true, costTime: 9, costTokens: 12920 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'coder', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 26, totalTokens: 6460 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 7, totalTokens: 5460, status: 'success' }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 9, totalTokens: 12920 }), topBarNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), invocations: 1 })] },
			),
		}, 26),
		// Frame 11: coder returns green to orchestrator (coder status:success, return edge flowing, orchestrator is the return's target).
		frame({
			status: 'unknown',
			task: 'Add a CSV export to the reports module.',
			startTime: t(0),
			currentActivity: { role: 'orchestrator', summary: 'receiving coder success' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(28), eventCount: 8, llmCalls: 2, toolCalls: 2, recentTools: ['agent'], lastPromptTokens: 3000 }),
				roleActivity({ role: 'planner', firstSeen: t(7), lastSeen: t(13), eventCount: 4, llmCalls: 1, lastPromptTokens: 5200 }),
				roleActivity({ role: 'coder', firstSeen: t(17), lastSeen: t(28), eventCount: 7, llmCalls: 2, toolCalls: 1, recentTools: ['write_file'], lastPromptTokens: 6100 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', status: 'success', summary: 'wrote reports/csv.js', active: false })] })],
			recentLog: [
				logEntry({ timestamp: t(27), type: 'llm_call', summary: 'coder \u00b7 llm call (finish)', payload: { role: 'coder' } }),
				logEntry({ timestamp: t(28), type: 'role_finished', summary: 'coder \u00b7 finished (success)', payload: { role: 'coder', status: 'success', summary: 'wrote reports/csv.js' } }),
			],
			budgets: budgets({ elapsedSeconds: 28, toolCalls: 3, tokensUsed: 24840, tokenBreakdown: tokenBreakdown(23400, 1440) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 28, costTokens: 6460 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 2, status: 'success', costTime: 11, costTokens: 12920 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'coder', 'call'), flowEdge('coder', 'orchestrator', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 28, totalTokens: 6460 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 7, totalTokens: 5460, status: 'success' }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 11, totalTokens: 12920 }), topBarNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), invocations: 1 })] },
			),
		}, 28),
		// Frame 12: coder departed, orchestrator→you return flowing (orchestrator status:success, You is the return's target).
		frame({
			status: 'unknown',
			task: 'Add a CSV export to the reports module.',
			startTime: t(0),
			currentActivity: { role: 'orchestrator', summary: 'orchestrator \u00b7 finished (success)' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(29), eventCount: 9, llmCalls: 2, toolCalls: 2, recentTools: ['agent'], lastPromptTokens: 3000 }),
				roleActivity({ role: 'planner', firstSeen: t(7), lastSeen: t(13), eventCount: 4, llmCalls: 1, lastPromptTokens: 5200 }),
				roleActivity({ role: 'coder', firstSeen: t(17), lastSeen: t(28), eventCount: 7, llmCalls: 2, toolCalls: 1, recentTools: ['write_file'], lastPromptTokens: 6100 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, status: 'success', summary: 'shipped', active: false })],
			recentLog: [
				logEntry({ timestamp: t(28), type: 'role_finished', summary: 'coder \u00b7 finished (success)', payload: { role: 'coder', status: 'success' } }),
				logEntry({ timestamp: t(29), type: 'role_finished', summary: 'orchestrator \u00b7 finished (success)', payload: { role: 'orchestrator', status: 'success', summary: 'shipped' } }),
			],
			budgets: budgets({ elapsedSeconds: 29, toolCalls: 3, tokensUsed: 24840, tokenBreakdown: tokenBreakdown(23400, 1440) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, status: 'success', costTime: 29, costTokens: 6460 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'you', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 29, totalTokens: 6460 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 7, totalTokens: 5460, status: 'success' }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 11, totalTokens: 12920, status: 'success' }), topBarNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), invocations: 1 })] },
			),
		}, 29),
		// Frame 13: done, only You remains (status:success); everything has departed to the top bar.
		frame({
			status: 'success',
			runId: 'run-success-fixture',
			task: 'Add a CSV export to the reports module.',
			startTime: t(0),
			endTime: t(30),
			result: { status: 'success', summary: 'Added the CSV export to the reports module.', artifacts: ['reports/csv.js'] },
			currentActivity: { role: 'orchestrator', summary: 'orchestrator \u00b7 finished (success)' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(29), eventCount: 9, llmCalls: 2, toolCalls: 2 }),
				roleActivity({ role: 'planner', firstSeen: t(7), lastSeen: t(13), eventCount: 4, llmCalls: 1 }),
				roleActivity({ role: 'coder', firstSeen: t(17), lastSeen: t(28), eventCount: 7, llmCalls: 2, toolCalls: 1, recentTools: ['write_file'] }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, status: 'success', summary: 'shipped', active: false })],
			recentLog: [
				logEntry({ timestamp: t(29), type: 'role_finished', summary: 'orchestrator \u00b7 finished (success)', payload: { role: 'orchestrator', status: 'success', summary: 'shipped' } }),
			],
			budgets: budgets({ elapsedSeconds: 30, toolCalls: 3, tokensUsed: 24840, tokenBreakdown: tokenBreakdown(23400, 1440) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 })], edges: [] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 29, totalTokens: 6460, status: 'success' }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 7, totalTokens: 5460, status: 'success' }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 11, totalTokens: 12920, status: 'success' }), topBarNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file'), invocations: 1 })] },
			),
		}, 30),
	],
}

const failedRun = {
	id: 'failed-run',
	label: 'Failed run (error with kind + message)',
	description: 'A run that ended in error \u2014 exercises failure surfacing with a machine kind and a sanitized message.',
	frames: [
		// Frame 0: you→coder call flowing (coder is the call's target, no costTokens yet).
		frame({
			status: 'unknown',
			task: 'Refactor the auth module into a separate package.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 role start' },
			roles: [roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(1), eventCount: 1, llmCalls: 0 })],
			roleTree: [treeNode({ role: 'coder', depth: 0, active: true })],
			recentLog: [logEntry({ timestamp: t(1), type: 'role_start', summary: 'coder \u00b7 role start', payload: { role: 'coder', depth: 0, task: 'Refactor the auth module into a separate package' } })],
			budgets: budgets({ elapsedSeconds: 2 }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 1, costTime: 2 })], edges: [flowEdge('you', 'coder', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 2 })] },
			),
		}, 2),
		// Frame 1: coder thinking (call settled, coder has costTokens, active flag).
		frame({
			status: 'unknown',
			task: 'Refactor the auth module into a separate package.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 llm call' },
			roles: [roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(4), eventCount: 2, llmCalls: 1, lastPromptTokens: 4800 })],
			roleTree: [treeNode({ role: 'coder', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(1), type: 'role_start', summary: 'coder \u00b7 role start', payload: { role: 'coder', depth: 0 } }),
				logEntry({ timestamp: t(4), type: 'llm_call', summary: 'coder \u00b7 llm call', payload: { role: 'coder', usage: { promptTokens: 4800, completionTokens: 160, totalTokens: 4960 } }, detailSections: [{ label: 'usage', content: { promptTokens: 4800, completionTokens: 160, totalTokens: 4960 } }] }),
			],
			budgets: budgets({ elapsedSeconds: 5, tokensUsed: 4960, tokenBreakdown: tokenBreakdown(4800, 160) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 1, active: true, costTime: 5, costTokens: 4960 })], edges: [flowEdge('you', 'coder', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 5, totalTokens: 4960 })] },
			),
		}, 5),
		// Frame 2: coder returns red error to You (coder status:error, error return edge flowing, You is the return's target).
		frame({
			status: 'unknown',
			task: 'Refactor the auth module into a separate package.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 llm unavailable' },
			roles: [roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(8), eventCount: 3, llmCalls: 1, lastPromptTokens: 4800 })],
			roleTree: [treeNode({ role: 'coder', depth: 0, status: 'error', summary: 'model endpoint unreachable', active: false })],
			recentLog: [
				logEntry({ timestamp: t(4), type: 'llm_call', summary: 'coder \u00b7 llm call', payload: { role: 'coder' } }),
				logEntry({ timestamp: t(8), type: 'llm_unavailable', summary: 'coder \u00b7 llm unavailable', payload: { role: 'coder', message: 'connection refused' } }),
				logEntry({ timestamp: t(8), type: 'role_finished', summary: 'coder \u00b7 finished (error)', payload: { role: 'coder', status: 'error', summary: 'model endpoint unreachable', error: { kind: 'llm_unavailable', message: 'connection refused' } } }),
			],
			budgets: budgets({ elapsedSeconds: 8, tokensUsed: 4960, tokenBreakdown: tokenBreakdown(4800, 160) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 1, status: 'error', costTime: 8, costTokens: 4960 })], edges: [flowEdge('you', 'coder', 'call'), flowEdge('coder', 'you', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 8, totalTokens: 4960 })] },
			),
		}, 8),
		// Frame 3: coder departed to the top bar, only You remains in the main area (run status still unknown while the error is surfaced).
		frame({
			status: 'unknown',
			task: 'Refactor the auth module into a separate package.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 llm unavailable' },
			roles: [roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(9), eventCount: 3, llmCalls: 1 })],
			roleTree: [treeNode({ role: 'coder', depth: 0, status: 'error', summary: 'model endpoint unreachable', active: false })],
			recentLog: [
				logEntry({ timestamp: t(8), type: 'role_finished', summary: 'coder \u00b7 finished (error)', payload: { role: 'coder', status: 'error', summary: 'model endpoint unreachable' } }),
			],
			budgets: budgets({ elapsedSeconds: 9, tokensUsed: 4960, tokenBreakdown: tokenBreakdown(4800, 160) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 })], edges: [] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 9, totalTokens: 4960, status: 'error' })] },
			),
		}, 9),
		// Frame 4: done, status:error, only You remains.
		frame({
			status: 'error',
			runId: 'run-failed-fixture',
			task: 'Refactor the auth module into a separate package.',
			startTime: t(0),
			endTime: t(10),
			error: { kind: 'llm_unavailable', message: 'The model endpoint refused the connection.' },
			result: { status: 'error', summary: 'The run could not reach the model.', error: { kind: 'llm_unavailable', message: 'The model endpoint refused the connection.' } },
			currentActivity: { role: 'coder', summary: 'coder \u00b7 finished (error)' },
			roles: [roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(9), eventCount: 3, llmCalls: 1 })],
			roleTree: [treeNode({ role: 'coder', depth: 0, status: 'error', summary: 'model endpoint unreachable', active: false })],
			recentLog: [
				logEntry({ timestamp: t(8), type: 'role_finished', summary: 'coder \u00b7 finished (error)', payload: { role: 'coder', status: 'error', summary: 'model endpoint unreachable', error: { kind: 'llm_unavailable', message: 'connection refused' } } }),
			],
			budgets: budgets({ elapsedSeconds: 10, tokensUsed: 4960, tokenBreakdown: tokenBreakdown(4800, 160) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 })], edges: [] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 10, totalTokens: 4960, status: 'error' })] },
			),
		}, 10),
	],
}

const effortSet = {
	id: 'effort-set',
	label: 'Run with effort set',
	description: 'A run carrying an effort level \u2014 exercises the cost strip\u2019s effort readout alongside elapsed time and tokens.',
	frames: [
		// Frame 0: effort_set event fires and the you→planner call is flowing (planner is the call's target, no costTokens yet).
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
				logEntry({ timestamp: t(1), type: 'role_start', summary: 'planner \u00b7 role start', payload: { role: 'planner', depth: 0, task: 'Carefully migrate the database schema with no downtime' } }),
			],
			budgets: budgets({ elapsedSeconds: 2 }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 1, costTime: 2 })], edges: [flowEdge('you', 'planner', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 2 })] },
			),
		}, 2),
		// Frame 1: planner thinking (call settled, planner has costTokens, active flag).
		frame({
			status: 'unknown',
			task: 'Carefully migrate the database schema with no downtime.',
			effort: 5,
			startTime: t(0),
			currentActivity: { role: 'planner', summary: 'planner \u00b7 llm call' },
			roles: [roleActivity({ role: 'planner', firstSeen: t(1), lastSeen: t(4), eventCount: 2, llmCalls: 1, lastPromptTokens: 7400 })],
			roleTree: [treeNode({ role: 'planner', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(0), type: 'effort_set', summary: 'effort set (5)', payload: { effort: 5 } }),
				logEntry({ timestamp: t(1), type: 'role_start', summary: 'planner \u00b7 role start', payload: { role: 'planner', depth: 0 } }),
				logEntry({ timestamp: t(4), type: 'llm_call', summary: 'planner \u00b7 llm call', payload: { role: 'planner', usage: { promptTokens: 7400, completionTokens: 300, totalTokens: 7700 } }, detailSections: [{ label: 'usage', content: { promptTokens: 7400, completionTokens: 300, totalTokens: 7700 } }] }),
			],
			budgets: budgets({ elapsedSeconds: 5, tokensUsed: 7700, tokenBreakdown: tokenBreakdown(7400, 300, 1200) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 1, active: true, costTime: 5, costTokens: 7700 })], edges: [flowEdge('you', 'planner', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 5, totalTokens: 7700 })] },
			),
		}, 5),
		// Frame 2: planner→read_file call flowing (read_file is the call's target).
		frame({
			status: 'unknown',
			task: 'Carefully migrate the database schema with no downtime.',
			effort: 5,
			startTime: t(0),
			currentActivity: { role: 'planner', summary: 'planner \u00b7 read_file' },
			roles: [roleActivity({ role: 'planner', firstSeen: t(1), lastSeen: t(6), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['read_file'], lastPromptTokens: 7400 })],
			roleTree: [treeNode({ role: 'planner', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(4), type: 'llm_call', summary: 'planner \u00b7 llm call', payload: { role: 'planner' } }),
				logEntry({ timestamp: t(6), type: 'tool_call', summary: 'planner \u00b7 read_file', payload: { role: 'planner', tool: 'read_file', arguments: '{"path":"migrations/schema.sql"}' }, detailSections: [{ label: 'arguments', content: '{"path":"migrations/schema.sql"}' }] }),
			],
			budgets: budgets({ elapsedSeconds: 7, toolCalls: 1, tokensUsed: 7700, tokenBreakdown: tokenBreakdown(7400, 300, 1200) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 1, costTime: 7, costTokens: 7700 }), flowNode({ id: 'read_file', kind: 'tool', label: toolLabel('read_file'), column: 2, costTime: 1 })], edges: [flowEdge('you', 'planner', 'call'), flowEdge('planner', 'read_file', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 7, totalTokens: 7700 }), topBarNode({ id: 'read_file', kind: 'tool', label: toolLabel('read_file'), invocations: 1 })] },
			),
		}, 7),
		// Frame 3: read_file returns green (read_file status:success, return edge flowing, planner is the return's target).
		frame({
			status: 'unknown',
			task: 'Carefully migrate the database schema with no downtime.',
			effort: 5,
			startTime: t(0),
			currentActivity: { role: 'planner', summary: 'planner \u00b7 read_file result' },
			roles: [roleActivity({ role: 'planner', firstSeen: t(1), lastSeen: t(9), eventCount: 5, llmCalls: 1, toolCalls: 1, recentTools: ['read_file'], lastPromptTokens: 7400 })],
			roleTree: [treeNode({ role: 'planner', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(6), type: 'tool_call', summary: 'planner \u00b7 read_file', payload: { role: 'planner', tool: 'read_file' } }),
				logEntry({ timestamp: t(9), type: 'tool_result', summary: 'planner \u00b7 read_file result', payload: { role: 'planner', tool: 'read_file', result: 'read migrations/schema.sql' }, detailSections: [{ label: 'result', content: 'read migrations/schema.sql' }] }),
			],
			budgets: budgets({ elapsedSeconds: 10, toolCalls: 1, tokensUsed: 7700, tokenBreakdown: tokenBreakdown(7400, 300, 1200) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 1, costTime: 10, costTokens: 7700 }), flowNode({ id: 'read_file', kind: 'tool', label: toolLabel('read_file'), column: 2, status: 'success', costTime: 4 })], edges: [flowEdge('you', 'planner', 'call'), flowEdge('planner', 'read_file', 'call'), flowEdge('read_file', 'planner', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 10, totalTokens: 7700 }), topBarNode({ id: 'read_file', kind: 'tool', label: toolLabel('read_file'), invocations: 1 })] },
			),
		}, 10),
		// Frame 4: read_file departed, planner thinking (planner active flag, no flowing edge).
		frame({
			status: 'unknown',
			task: 'Carefully migrate the database schema with no downtime.',
			effort: 5,
			startTime: t(0),
			currentActivity: { role: 'planner', summary: 'planner \u00b7 thinking' },
			roles: [roleActivity({ role: 'planner', firstSeen: t(1), lastSeen: t(11), eventCount: 5, llmCalls: 1, toolCalls: 1, recentTools: ['read_file'], lastPromptTokens: 7400 })],
			roleTree: [treeNode({ role: 'planner', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(6), type: 'tool_call', summary: 'planner \u00b7 read_file', payload: { role: 'planner', tool: 'read_file' } }),
				logEntry({ timestamp: t(9), type: 'tool_result', summary: 'planner \u00b7 read_file result', payload: { role: 'planner', tool: 'read_file' } }),
			],
			budgets: budgets({ elapsedSeconds: 11, toolCalls: 1, tokensUsed: 7700, tokenBreakdown: tokenBreakdown(7400, 300, 1200) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 1, active: true, costTime: 11, costTokens: 7700 })], edges: [flowEdge('you', 'planner', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 11, totalTokens: 7700 }), topBarNode({ id: 'read_file', kind: 'tool', label: toolLabel('read_file'), invocations: 1 })] },
			),
		}, 11),
		// Frame 5: planner returns green to You (planner status:success, return edge flowing, You is the return's target).
		frame({
			status: 'success',
			runId: 'run-effort-set-fixture',
			task: 'Carefully migrate the database schema with no downtime.',
			effort: 5,
			startTime: t(0),
			endTime: t(14),
			result: { status: 'success', summary: 'Planned the schema migration for zero downtime.', artifacts: ['migrations/plan.md'] },
			currentActivity: { role: 'planner', summary: 'planner \u00b7 finished (success)' },
			roles: [roleActivity({ role: 'planner', firstSeen: t(1), lastSeen: t(13), eventCount: 6, llmCalls: 1, toolCalls: 1, recentTools: ['read_file'] })],
			roleTree: [treeNode({ role: 'planner', depth: 0, status: 'success', summary: 'planned the migration', active: false })],
			recentLog: [
				logEntry({ timestamp: t(9), type: 'tool_result', summary: 'planner \u00b7 read_file result', payload: { role: 'planner', tool: 'read_file' } }),
				logEntry({ timestamp: t(13), type: 'role_finished', summary: 'planner \u00b7 finished (success)', payload: { role: 'planner', status: 'success', summary: 'planned the migration' } }),
			],
			budgets: budgets({ elapsedSeconds: 14, toolCalls: 1, tokensUsed: 7700, tokenBreakdown: tokenBreakdown(7400, 300, 1200) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 1, status: 'success', costTime: 14, costTokens: 7700 })], edges: [flowEdge('you', 'planner', 'call'), flowEdge('planner', 'you', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 14, totalTokens: 7700, status: 'success' }), topBarNode({ id: 'read_file', kind: 'tool', label: toolLabel('read_file'), invocations: 1 })] },
			),
		}, 14),
	],
}

const deepMultiRoleTree = {
	id: 'deep-multi-role-tree',
	label: 'Deep multi-role tree (with a context_manager side role)',
	description: 'A deep chain orchestrator \u2192 planner \u2192 coder plus a context_manager side delegation \u2014 exercises the tiered layout and side branches.',
	frames: [
		// Frame 0: you→orchestrator call flowing (orchestrator is the call's target, no costTokens yet).
		frame({
			status: 'unknown',
			task: 'Build a small REST API for the bookings feature.',
			startTime: t(0),
			currentActivity: { role: 'orchestrator', summary: 'orchestrator \u00b7 role start' },
			roles: [roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(1), eventCount: 1, llmCalls: 0 })],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: true })],
			recentLog: [logEntry({ timestamp: t(1), type: 'role_start', summary: 'orchestrator \u00b7 role start', payload: { role: 'orchestrator', depth: 0, task: 'Build a small REST API for the bookings feature' } })],
			budgets: budgets({ elapsedSeconds: 2 }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 2 })], edges: [flowEdge('you', 'orchestrator', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 2 })] },
			),
		}, 2),
		// Frame 1: orchestrator thinking (call settled, orchestrator has costTokens, active flag).
		frame({
			status: 'unknown',
			task: 'Build a small REST API for the bookings feature.',
			startTime: t(0),
			currentActivity: { role: 'orchestrator', summary: 'orchestrator \u00b7 llm call' },
			roles: [roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(4), eventCount: 2, llmCalls: 1, lastPromptTokens: 3300 })],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(1), type: 'role_start', summary: 'orchestrator \u00b7 role start', payload: { role: 'orchestrator', depth: 0 } }),
				logEntry({ timestamp: t(4), type: 'llm_call', summary: 'orchestrator \u00b7 llm call', payload: { role: 'orchestrator', usage: { promptTokens: 3300, completionTokens: 280, totalTokens: 3580 } }, detailSections: [{ label: 'usage', content: { promptTokens: 3300, completionTokens: 280, totalTokens: 3580 } }] }),
			],
			budgets: budgets({ elapsedSeconds: 5, tokensUsed: 3580, tokenBreakdown: tokenBreakdown(3300, 280) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, active: true, costTime: 5, costTokens: 3580 })], edges: [flowEdge('you', 'orchestrator', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 5, totalTokens: 3580 })] },
			),
		}, 5),
		// Frame 2: orchestrator→planner call flowing (planner is the call's target, no costTokens yet).
		frame({
			status: 'unknown',
			task: 'Build a small REST API for the bookings feature.',
			startTime: t(0),
			currentActivity: { role: 'planner', summary: 'planner \u00b7 role start' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(7), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 3300 }),
				roleActivity({ role: 'planner', firstSeen: t(7), lastSeen: t(7), eventCount: 1, llmCalls: 0 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'planner', depth: 1, parent: 'orchestrator', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(4), type: 'llm_call', summary: 'orchestrator \u00b7 llm call', payload: { role: 'orchestrator' } }),
				logEntry({ timestamp: t(7), type: 'tool_call', summary: 'orchestrator \u00b7 agent', payload: { role: 'orchestrator', tool: 'agent', arguments: '{"role":"planner","task":"plan the bookings API"}' }, detailSections: [{ label: 'arguments', content: '{"role":"planner","task":"plan the bookings API"}' }] }),
				logEntry({ timestamp: t(7), type: 'agent_call', summary: 'orchestrator \u00b7 agent call \u2192 planner', payload: { parent: 'orchestrator', child: 'planner', depth: 1 } }),
			],
			budgets: budgets({ elapsedSeconds: 8, toolCalls: 1, tokensUsed: 3580, tokenBreakdown: tokenBreakdown(3300, 280) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 8, costTokens: 3580 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 2, costTime: 1 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'planner', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 8, totalTokens: 3580 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 1 })] },
			),
		}, 8),
		// Frame 3: planner thinking (call settled, planner has costTokens, active flag).
		frame({
			status: 'unknown',
			task: 'Build a small REST API for the bookings feature.',
			startTime: t(0),
			currentActivity: { role: 'planner', summary: 'planner \u00b7 llm call' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(7), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 3300 }),
				roleActivity({ role: 'planner', firstSeen: t(7), lastSeen: t(10), eventCount: 3, llmCalls: 1, lastPromptTokens: 5600 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'planner', depth: 1, parent: 'orchestrator', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(7), type: 'agent_call', summary: 'orchestrator \u00b7 agent call \u2192 planner', payload: { parent: 'orchestrator', child: 'planner', depth: 1 } }),
				logEntry({ timestamp: t(7), type: 'role_start', summary: 'planner \u00b7 role start', payload: { role: 'planner', depth: 1, parent: 'orchestrator', task: 'plan the bookings API' } }),
				logEntry({ timestamp: t(10), type: 'llm_call', summary: 'planner \u00b7 llm call', payload: { role: 'planner', usage: { promptTokens: 5600, completionTokens: 280, totalTokens: 5880 } }, detailSections: [{ label: 'usage', content: { promptTokens: 5600, completionTokens: 280, totalTokens: 5880 } }] }),
			],
			budgets: budgets({ elapsedSeconds: 11, tokensUsed: 9460, tokenBreakdown: tokenBreakdown(8900, 560) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 11, costTokens: 3580 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 2, active: true, costTime: 4, costTokens: 5880 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'planner', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 11, totalTokens: 3580 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 4, totalTokens: 5880 })] },
			),
		}, 11),
		// Frame 4: planner→context_manager call flowing (context_manager is the call's target). Planner's context has grown heavy, so its cumulative cost jumps.
		frame({
			status: 'unknown',
			task: 'Build a small REST API for the bookings feature.',
			startTime: t(0),
			currentActivity: { role: 'context_manager', summary: 'context_manager \u00b7 role start' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(7), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 3300 }),
				roleActivity({ role: 'planner', firstSeen: t(7), lastSeen: t(12), eventCount: 6, llmCalls: 3, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 28000 }),
				roleActivity({ role: 'context_manager', firstSeen: t(12), lastSeen: t(12), eventCount: 1, llmCalls: 0 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [
				treeNode({ role: 'planner', depth: 1, parent: 'orchestrator', active: false, children: [
					treeNode({ role: 'context_manager', depth: 2, parent: 'planner', active: true }),
				] }),
			] })],
			recentLog: [
				logEntry({ timestamp: t(10), type: 'llm_call', summary: 'planner \u00b7 llm call', payload: { role: 'planner' } }),
				logEntry({ timestamp: t(11), type: 'context_budget_exceeded', summary: 'planner \u00b7 context budget exceeded', payload: { role: 'planner', promptTokens: 28000, contextWindow: 262144 } }),
				logEntry({ timestamp: t(12), type: 'agent_call', summary: 'planner \u00b7 agent call \u2192 context_manager', payload: { parent: 'planner', child: 'context_manager', depth: 2 } }),
			],
			budgets: budgets({ elapsedSeconds: 14, toolCalls: 2, tokensUsed: 41380, tokenBreakdown: tokenBreakdown(40300, 1080) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 14, costTokens: 3580 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 2, costTime: 7, costTokens: 37800 }), flowNode({ id: 'context_manager', kind: 'role', label: roleLabel('context_manager'), sublabel: 'context_manager', column: 3, costTime: 1 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'planner', 'call'), flowEdge('planner', 'context_manager', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 14, totalTokens: 3580 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 7, totalTokens: 37800 }), topBarNode({ id: 'context_manager', kind: 'role', label: roleLabel('context_manager'), invocations: 1, totalTime: 1 })] },
			),
		}, 14),
		// Frame 5: context_manager thinking (call settled, context_manager has costTokens, active flag).
		frame({
			status: 'unknown',
			task: 'Build a small REST API for the bookings feature.',
			startTime: t(0),
			currentActivity: { role: 'context_manager', summary: 'context_manager \u00b7 llm call' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(7), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 3300 }),
				roleActivity({ role: 'planner', firstSeen: t(7), lastSeen: t(12), eventCount: 6, llmCalls: 3, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 28000 }),
				roleActivity({ role: 'context_manager', firstSeen: t(12), lastSeen: t(14), eventCount: 2, llmCalls: 1, lastPromptTokens: 2800 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [
				treeNode({ role: 'planner', depth: 1, parent: 'orchestrator', active: false, children: [
					treeNode({ role: 'context_manager', depth: 2, parent: 'planner', active: true }),
				] }),
			] })],
			recentLog: [
				logEntry({ timestamp: t(11), type: 'context_budget_exceeded', summary: 'planner \u00b7 context budget exceeded', payload: { role: 'planner', promptTokens: 28000, contextWindow: 262144 } }),
				logEntry({ timestamp: t(12), type: 'agent_call', summary: 'planner \u00b7 agent call \u2192 context_manager', payload: { parent: 'planner', child: 'context_manager', depth: 2 } }),
				logEntry({ timestamp: t(14), type: 'llm_call', summary: 'context_manager \u00b7 llm call', payload: { role: 'context_manager', usage: { promptTokens: 2800, completionTokens: 100, totalTokens: 2900 } }, detailSections: [{ label: 'usage', content: { promptTokens: 2800, completionTokens: 100, totalTokens: 2900 } }] }),
			],
			budgets: budgets({ elapsedSeconds: 15, toolCalls: 2, tokensUsed: 44280, tokenBreakdown: tokenBreakdown(43100, 1180) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 15, costTokens: 3580 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 2, costTime: 8, costTokens: 37800 }), flowNode({ id: 'context_manager', kind: 'role', label: roleLabel('context_manager'), sublabel: 'context_manager', column: 3, active: true, costTime: 3, costTokens: 2900 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'planner', 'call'), flowEdge('planner', 'context_manager', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 15, totalTokens: 3580 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 8, totalTokens: 37800 }), topBarNode({ id: 'context_manager', kind: 'role', label: roleLabel('context_manager'), invocations: 1, totalTime: 3, totalTokens: 2900 })] },
			),
		}, 15),
		// Frame 6: context_manager→edit_context call flowing (edit_context is the call's target).
		frame({
			status: 'unknown',
			task: 'Build a small REST API for the bookings feature.',
			startTime: t(0),
			currentActivity: { role: 'context_manager', summary: 'context_manager \u00b7 edit_context' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(7), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 3300 }),
				roleActivity({ role: 'planner', firstSeen: t(7), lastSeen: t(12), eventCount: 6, llmCalls: 3, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 28000 }),
				roleActivity({ role: 'context_manager', firstSeen: t(12), lastSeen: t(16), eventCount: 3, llmCalls: 1, toolCalls: 1, recentTools: ['edit_context'], lastPromptTokens: 2800 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [
				treeNode({ role: 'planner', depth: 1, parent: 'orchestrator', active: false, children: [
					treeNode({ role: 'context_manager', depth: 2, parent: 'planner', active: true }),
				] }),
			] })],
			recentLog: [
				logEntry({ timestamp: t(14), type: 'llm_call', summary: 'context_manager \u00b7 llm call', payload: { role: 'context_manager' } }),
				logEntry({ timestamp: t(16), type: 'tool_call', summary: 'context_manager \u00b7 edit_context', payload: { role: 'context_manager', tool: 'edit_context', arguments: '{"action":"compact"}' }, detailSections: [{ label: 'arguments', content: '{"action":"compact"}' }] }),
			],
			budgets: budgets({ elapsedSeconds: 17, toolCalls: 3, tokensUsed: 44280, tokenBreakdown: tokenBreakdown(43100, 1180) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 17, costTokens: 3580 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 2, costTime: 10, costTokens: 37800 }), flowNode({ id: 'context_manager', kind: 'role', label: roleLabel('context_manager'), sublabel: 'context_manager', column: 3, costTime: 5, costTokens: 2900 }), flowNode({ id: 'edit_context', kind: 'tool', label: toolLabel('edit_context'), column: 4, costTime: 1 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'planner', 'call'), flowEdge('planner', 'context_manager', 'call'), flowEdge('context_manager', 'edit_context', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 17, totalTokens: 3580 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 10, totalTokens: 37800 }), topBarNode({ id: 'context_manager', kind: 'role', label: roleLabel('context_manager'), invocations: 1, totalTime: 5, totalTokens: 2900 }), topBarNode({ id: 'edit_context', kind: 'tool', label: toolLabel('edit_context'), invocations: 1 })] },
			),
		}, 17),
		// Frame 7: edit_context returns green (edit_context status:success, return edge flowing, context_manager is the return's target).
		frame({
			status: 'unknown',
			task: 'Build a small REST API for the bookings feature.',
			startTime: t(0),
			currentActivity: { role: 'context_manager', summary: 'context_manager \u00b7 edit_context result' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(7), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 3300 }),
				roleActivity({ role: 'planner', firstSeen: t(7), lastSeen: t(12), eventCount: 6, llmCalls: 3, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 28000 }),
				roleActivity({ role: 'context_manager', firstSeen: t(12), lastSeen: t(19), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['edit_context'], lastPromptTokens: 2800 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [
				treeNode({ role: 'planner', depth: 1, parent: 'orchestrator', active: false, children: [
					treeNode({ role: 'context_manager', depth: 2, parent: 'planner', active: true }),
				] }),
			] })],
			recentLog: [
				logEntry({ timestamp: t(16), type: 'tool_call', summary: 'context_manager \u00b7 edit_context', payload: { role: 'context_manager', tool: 'edit_context' } }),
				logEntry({ timestamp: t(19), type: 'tool_result', summary: 'context_manager \u00b7 edit_context result', payload: { role: 'context_manager', tool: 'edit_context', result: 'compacted the conversation' }, detailSections: [{ label: 'result', content: 'compacted the conversation' }] }),
			],
			budgets: budgets({ elapsedSeconds: 20, toolCalls: 3, tokensUsed: 44280, tokenBreakdown: tokenBreakdown(43100, 1180) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 20, costTokens: 3580 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 2, costTime: 13, costTokens: 37800 }), flowNode({ id: 'context_manager', kind: 'role', label: roleLabel('context_manager'), sublabel: 'context_manager', column: 3, costTime: 8, costTokens: 2900 }), flowNode({ id: 'edit_context', kind: 'tool', label: toolLabel('edit_context'), column: 4, status: 'success', costTime: 4 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'planner', 'call'), flowEdge('planner', 'context_manager', 'call'), flowEdge('context_manager', 'edit_context', 'call'), flowEdge('edit_context', 'context_manager', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 20, totalTokens: 3580 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 13, totalTokens: 37800 }), topBarNode({ id: 'context_manager', kind: 'role', label: roleLabel('context_manager'), invocations: 1, totalTime: 8, totalTokens: 2900 }), topBarNode({ id: 'edit_context', kind: 'tool', label: toolLabel('edit_context'), invocations: 1 })] },
			),
		}, 20),
		// Frame 8: edit_context departed, context_manager thinking (context_manager active flag, no flowing edge).
		frame({
			status: 'unknown',
			task: 'Build a small REST API for the bookings feature.',
			startTime: t(0),
			currentActivity: { role: 'context_manager', summary: 'context_manager \u00b7 thinking' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(7), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 3300 }),
				roleActivity({ role: 'planner', firstSeen: t(7), lastSeen: t(12), eventCount: 6, llmCalls: 3, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 28000 }),
				roleActivity({ role: 'context_manager', firstSeen: t(12), lastSeen: t(20), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['edit_context'], lastPromptTokens: 2800 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [
				treeNode({ role: 'planner', depth: 1, parent: 'orchestrator', active: false, children: [
					treeNode({ role: 'context_manager', depth: 2, parent: 'planner', active: true }),
				] }),
			] })],
			recentLog: [
				logEntry({ timestamp: t(16), type: 'tool_call', summary: 'context_manager \u00b7 edit_context', payload: { role: 'context_manager', tool: 'edit_context' } }),
				logEntry({ timestamp: t(19), type: 'tool_result', summary: 'context_manager \u00b7 edit_context result', payload: { role: 'context_manager', tool: 'edit_context' } }),
			],
			budgets: budgets({ elapsedSeconds: 21, toolCalls: 3, tokensUsed: 44280, tokenBreakdown: tokenBreakdown(43100, 1180) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 21, costTokens: 3580 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 2, costTime: 14, costTokens: 37800 }), flowNode({ id: 'context_manager', kind: 'role', label: roleLabel('context_manager'), sublabel: 'context_manager', column: 3, active: true, costTime: 9, costTokens: 2900 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'planner', 'call'), flowEdge('planner', 'context_manager', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 21, totalTokens: 3580 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 14, totalTokens: 37800 }), topBarNode({ id: 'context_manager', kind: 'role', label: roleLabel('context_manager'), invocations: 1, totalTime: 9, totalTokens: 2900 }), topBarNode({ id: 'edit_context', kind: 'tool', label: toolLabel('edit_context'), invocations: 1 })] },
			),
		}, 21),
		// Frame 9: context_manager returns green to planner (context_manager status:success, return edge flowing, planner is the return's target).
		frame({
			status: 'unknown',
			task: 'Build a small REST API for the bookings feature.',
			startTime: t(0),
			currentActivity: { role: 'planner', summary: 'receiving context_manager success' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(7), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 3300 }),
				roleActivity({ role: 'planner', firstSeen: t(7), lastSeen: t(22), eventCount: 7, llmCalls: 3, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 28000 }),
				roleActivity({ role: 'context_manager', firstSeen: t(12), lastSeen: t(22), eventCount: 5, llmCalls: 1, toolCalls: 1, recentTools: ['edit_context'], lastPromptTokens: 2800 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [
				treeNode({ role: 'planner', depth: 1, parent: 'orchestrator', active: false, children: [
					treeNode({ role: 'context_manager', depth: 2, parent: 'planner', status: 'success', summary: 'compacted the conversation', active: false }),
				] }),
			] })],
			recentLog: [
				logEntry({ timestamp: t(19), type: 'tool_result', summary: 'context_manager \u00b7 edit_context result', payload: { role: 'context_manager', tool: 'edit_context' } }),
				logEntry({ timestamp: t(22), type: 'role_finished', summary: 'context_manager \u00b7 finished (success)', payload: { role: 'context_manager', status: 'success', summary: 'compacted the conversation' } }),
			],
			budgets: budgets({ elapsedSeconds: 23, toolCalls: 3, tokensUsed: 44280, tokenBreakdown: tokenBreakdown(43100, 1180) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 23, costTokens: 3580 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 2, costTime: 16, costTokens: 37800 }), flowNode({ id: 'context_manager', kind: 'role', label: roleLabel('context_manager'), sublabel: 'context_manager', column: 3, status: 'success', costTime: 11, costTokens: 2900 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'planner', 'call'), flowEdge('planner', 'context_manager', 'call'), flowEdge('context_manager', 'planner', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 23, totalTokens: 3580 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 16, totalTokens: 37800 }), topBarNode({ id: 'context_manager', kind: 'role', label: roleLabel('context_manager'), invocations: 1, totalTime: 11, totalTokens: 2900 }), topBarNode({ id: 'edit_context', kind: 'tool', label: toolLabel('edit_context'), invocations: 1 })] },
			),
		}, 23),
		// Frame 10: context_manager departed, planner thinking (planner active flag, no flowing edge).
		frame({
			status: 'unknown',
			task: 'Build a small REST API for the bookings feature.',
			startTime: t(0),
			currentActivity: { role: 'planner', summary: 'planner \u00b7 thinking' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(7), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 3300 }),
				roleActivity({ role: 'planner', firstSeen: t(7), lastSeen: t(23), eventCount: 8, llmCalls: 4, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 28000 }),
				roleActivity({ role: 'context_manager', firstSeen: t(12), lastSeen: t(22), eventCount: 5, llmCalls: 1, toolCalls: 1, recentTools: ['edit_context'], lastPromptTokens: 2800 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'planner', depth: 1, parent: 'orchestrator', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(22), type: 'role_finished', summary: 'context_manager \u00b7 finished (success)', payload: { role: 'context_manager', status: 'success' } }),
				logEntry({ timestamp: t(23), type: 'llm_call', summary: 'planner \u00b7 llm call', payload: { role: 'planner', usage: { promptTokens: 18000, completionTokens: 300, totalTokens: 18300 } }, detailSections: [{ label: 'usage', content: { promptTokens: 18000, completionTokens: 300, totalTokens: 18300 } }] }),
			],
			budgets: budgets({ elapsedSeconds: 24, toolCalls: 3, tokensUsed: 44280, tokenBreakdown: tokenBreakdown(43100, 1180, 9000) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 24, costTokens: 3580 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 2, active: true, costTime: 17, costTokens: 37800 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'planner', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 24, totalTokens: 3580 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 17, totalTokens: 37800 }), topBarNode({ id: 'context_manager', kind: 'role', label: roleLabel('context_manager'), invocations: 1, totalTime: 11, totalTokens: 2900, status: 'success' }), topBarNode({ id: 'edit_context', kind: 'tool', label: toolLabel('edit_context'), invocations: 1 })] },
			),
		}, 24),
		// Frame 11: planner returns green to orchestrator (planner status:success, return edge flowing, orchestrator is the return's target).
		frame({
			status: 'unknown',
			task: 'Build a small REST API for the bookings feature.',
			startTime: t(0),
			currentActivity: { role: 'orchestrator', summary: 'receiving planner success' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(26), eventCount: 5, llmCalls: 1, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 3300 }),
				roleActivity({ role: 'planner', firstSeen: t(7), lastSeen: t(26), eventCount: 9, llmCalls: 4, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 28000 }),
				roleActivity({ role: 'context_manager', firstSeen: t(12), lastSeen: t(22), eventCount: 5, llmCalls: 1, toolCalls: 1, recentTools: ['edit_context'], lastPromptTokens: 2800 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'planner', depth: 1, parent: 'orchestrator', status: 'success', summary: 'planned the bookings API', active: false })] })],
			recentLog: [
				logEntry({ timestamp: t(23), type: 'llm_call', summary: 'planner \u00b7 llm call', payload: { role: 'planner' } }),
				logEntry({ timestamp: t(26), type: 'role_finished', summary: 'planner \u00b7 finished (success)', payload: { role: 'planner', status: 'success', summary: 'planned the bookings API' } }),
			],
			budgets: budgets({ elapsedSeconds: 27, toolCalls: 3, tokensUsed: 44280, tokenBreakdown: tokenBreakdown(43100, 1180, 9000) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, costTime: 27, costTokens: 3580 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 2, status: 'success', costTime: 20, costTokens: 37800 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'planner', 'call'), flowEdge('planner', 'orchestrator', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 27, totalTokens: 3580 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 20, totalTokens: 37800 }), topBarNode({ id: 'context_manager', kind: 'role', label: roleLabel('context_manager'), invocations: 1, totalTime: 11, totalTokens: 2900, status: 'success' }), topBarNode({ id: 'edit_context', kind: 'tool', label: toolLabel('edit_context'), invocations: 1 })] },
			),
		}, 27),
		// Frame 12: planner departed, orchestrator thinking (orchestrator active flag, no flowing edge). The success return has landed; the orchestrator processes the result before finishing.
		frame({
			status: 'unknown',
			task: 'Build a small REST API for the bookings feature.',
			startTime: t(0),
			currentActivity: { role: 'orchestrator', summary: 'orchestrator \u00b7 thinking' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(28), eventCount: 6, llmCalls: 1, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 3300 }),
				roleActivity({ role: 'planner', firstSeen: t(7), lastSeen: t(26), eventCount: 9, llmCalls: 4, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 28000 }),
				roleActivity({ role: 'context_manager', firstSeen: t(12), lastSeen: t(22), eventCount: 5, llmCalls: 1, toolCalls: 1, recentTools: ['edit_context'], lastPromptTokens: 2800 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(26), type: 'role_finished', summary: 'planner \u00b7 finished (success)', payload: { role: 'planner', status: 'success' } }),
				logEntry({ timestamp: t(28), type: 'llm_call', summary: 'orchestrator \u00b7 llm call (finish)', payload: { role: 'orchestrator' } }),
			],
			budgets: budgets({ elapsedSeconds: 28, toolCalls: 3, tokensUsed: 44280, tokenBreakdown: tokenBreakdown(43100, 1180, 9000) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, active: true, costTime: 28, costTokens: 3580 })], edges: [flowEdge('you', 'orchestrator', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 28, totalTokens: 3580 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 20, totalTokens: 37800, status: 'success' }), topBarNode({ id: 'context_manager', kind: 'role', label: roleLabel('context_manager'), invocations: 1, totalTime: 11, totalTokens: 2900, status: 'success' }), topBarNode({ id: 'edit_context', kind: 'tool', label: toolLabel('edit_context'), invocations: 1 })] },
			),
		}, 28),
		// Frame 13: orchestrator returns to You (orchestrator status:success, return edge flowing, You is the return's target).
		frame({
			status: 'unknown',
			task: 'Build a small REST API for the bookings feature.',
			startTime: t(0),
			currentActivity: { role: 'orchestrator', summary: 'orchestrator \u00b7 finished (success)' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(30), eventCount: 7, llmCalls: 2, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 3300 }),
				roleActivity({ role: 'planner', firstSeen: t(7), lastSeen: t(26), eventCount: 9, llmCalls: 4, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 28000 }),
				roleActivity({ role: 'context_manager', firstSeen: t(12), lastSeen: t(22), eventCount: 5, llmCalls: 1, toolCalls: 1, recentTools: ['edit_context'], lastPromptTokens: 2800 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, status: 'success', summary: 'shipped the API', active: false })],
			recentLog: [
				logEntry({ timestamp: t(28), type: 'llm_call', summary: 'orchestrator \u00b7 llm call (finish)', payload: { role: 'orchestrator' } }),
				logEntry({ timestamp: t(30), type: 'role_finished', summary: 'orchestrator \u00b7 finished (success)', payload: { role: 'orchestrator', status: 'success', summary: 'shipped the API' } }),
			],
			budgets: budgets({ elapsedSeconds: 30, toolCalls: 3, tokensUsed: 44280, tokenBreakdown: tokenBreakdown(43100, 1180, 9000) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), sublabel: 'orchestrator', column: 1, status: 'success', costTime: 30, costTokens: 3580 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'you', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 30, totalTokens: 3580 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 20, totalTokens: 37800, status: 'success' }), topBarNode({ id: 'context_manager', kind: 'role', label: roleLabel('context_manager'), invocations: 1, totalTime: 11, totalTokens: 2900, status: 'success' }), topBarNode({ id: 'edit_context', kind: 'tool', label: toolLabel('edit_context'), invocations: 1 })] },
			),
		}, 30),
		// Frame 14: done, only You remains (status:success); everything has departed to the top bar.
		frame({
			status: 'success',
			runId: 'run-deep-fixture',
			task: 'Build a small REST API for the bookings feature.',
			startTime: t(0),
			endTime: t(31),
			result: { status: 'success', summary: 'Planned the bookings API and compacted the planner context.', artifacts: ['docs/bookings-plan.md'] },
			currentActivity: { role: 'orchestrator', summary: 'orchestrator \u00b7 finished (success)' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(30), eventCount: 7, llmCalls: 2 }),
				roleActivity({ role: 'planner', firstSeen: t(7), lastSeen: t(26), eventCount: 9, llmCalls: 4, toolCalls: 1, recentTools: ['agent'] }),
				roleActivity({ role: 'context_manager', firstSeen: t(12), lastSeen: t(22), eventCount: 5, llmCalls: 1, toolCalls: 1, recentTools: ['edit_context'] }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, status: 'success', summary: 'shipped the API', active: false })],
			recentLog: [
				logEntry({ timestamp: t(30), type: 'role_finished', summary: 'orchestrator \u00b7 finished (success)', payload: { role: 'orchestrator', status: 'success', summary: 'shipped the API' } }),
			],
			budgets: budgets({ elapsedSeconds: 31, toolCalls: 3, tokensUsed: 44280, tokenBreakdown: tokenBreakdown(43100, 1180, 9000) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 })], edges: [] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator'), invocations: 1, totalTime: 30, totalTokens: 3580, status: 'success' }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 20, totalTokens: 37800, status: 'success' }), topBarNode({ id: 'context_manager', kind: 'role', label: roleLabel('context_manager'), invocations: 1, totalTime: 11, totalTokens: 2900, status: 'success' }), topBarNode({ id: 'edit_context', kind: 'tool', label: toolLabel('edit_context'), invocations: 1 })] },
			),
		}, 31),
	],
}

const selfDelegation = {
	id: 'self-delegation',
	label: 'Self-delegation (coder \u2192 coder)',
	description: 'A role delegates to itself for a sub-task, producing same-named nodes at increasing depth \u2014 exercises the layout distinguishing repeated invocations of the same role nested under each other.',
	frames: [
		// Frame 0: you→coder-1 call flowing (coder-1 is the call's target, no costTokens yet).
		frame({
			status: 'unknown',
			task: 'Refactor the parser module into smaller files.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 role start' },
			roles: [roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(1), eventCount: 1, llmCalls: 0 })],
			roleTree: [treeNode({ role: 'coder', depth: 0, active: true })],
			recentLog: [logEntry({ timestamp: t(1), type: 'role_start', summary: 'coder \u00b7 role start', payload: { role: 'coder', depth: 0, task: 'Refactor the parser module into smaller files' } })],
			budgets: budgets({ elapsedSeconds: 2 }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'coder-1', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 1, costTime: 2 })], edges: [flowEdge('you', 'coder-1', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 2 })] },
			),
		}, 2),
		// Frame 1: coder-1 thinking (call settled, coder-1 has costTokens, active flag).
		frame({
			status: 'unknown',
			task: 'Refactor the parser module into smaller files.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 llm call' },
			roles: [roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(4), eventCount: 2, llmCalls: 1, lastPromptTokens: 3800 })],
			roleTree: [treeNode({ role: 'coder', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(1), type: 'role_start', summary: 'coder \u00b7 role start', payload: { role: 'coder', depth: 0 } }),
				logEntry({ timestamp: t(4), type: 'llm_call', summary: 'coder \u00b7 llm call', payload: { role: 'coder', usage: { promptTokens: 3800, completionTokens: 150, totalTokens: 3950 } }, detailSections: [{ label: 'usage', content: { promptTokens: 3800, completionTokens: 150, totalTokens: 3950 } }] }),
			],
			budgets: budgets({ elapsedSeconds: 5, tokensUsed: 3950, tokenBreakdown: tokenBreakdown(3800, 150) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'coder-1', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 1, active: true, costTime: 5, costTokens: 3950 })], edges: [flowEdge('you', 'coder-1', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 5, totalTokens: 3950 })] },
			),
		}, 5),
		// Frame 2: coder-1→coder-2 call flowing (same role nested, sublabel 'sub-task'; coder-2 is the call's target).
		frame({
			status: 'unknown',
			task: 'Refactor the parser module into smaller files.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 agent call \u2192 coder' },
			roles: [roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(8), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 3800 })],
			roleTree: [treeNode({ role: 'coder', depth: 0, active: false, children: [treeNode({ role: 'coder', depth: 1, parent: 'coder', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(4), type: 'llm_call', summary: 'coder \u00b7 llm call', payload: { role: 'coder' } }),
				logEntry({ timestamp: t(7), type: 'tool_call', summary: 'coder \u00b7 agent', payload: { role: 'coder', tool: 'agent', arguments: '{"role":"coder","task":"extract the tokenizer into its own file"}' }, detailSections: [{ label: 'arguments', content: '{"role":"coder","task":"extract the tokenizer into its own file"}' }] }),
				logEntry({ timestamp: t(8), type: 'agent_call', summary: 'coder \u00b7 agent call \u2192 coder', payload: { parent: 'coder', child: 'coder', depth: 1 } }),
			],
			budgets: budgets({ elapsedSeconds: 9, toolCalls: 1, tokensUsed: 3950, tokenBreakdown: tokenBreakdown(3800, 150) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'coder-1', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 1, costTime: 9, costTokens: 3950 }), flowNode({ id: 'coder-2', kind: 'role', label: roleLabel('coder'), sublabel: 'sub-task', column: 2, costTime: 1 })], edges: [flowEdge('you', 'coder-1', 'call'), flowEdge('coder-1', 'coder-2', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 2, totalTime: 9, totalTokens: 3950 })] },
			),
		}, 9),
		// Frame 3: coder-2 thinking (call settled, coder-2 has costTokens, active flag).
		frame({
			status: 'unknown',
			task: 'Refactor the parser module into smaller files.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 llm call' },
			roles: [roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(11), eventCount: 6, llmCalls: 2, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 5400 })],
			roleTree: [treeNode({ role: 'coder', depth: 0, active: false, children: [treeNode({ role: 'coder', depth: 1, parent: 'coder', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(8), type: 'agent_call', summary: 'coder \u00b7 agent call \u2192 coder', payload: { parent: 'coder', child: 'coder', depth: 1 } }),
				logEntry({ timestamp: t(8), type: 'role_start', summary: 'coder \u00b7 role start', payload: { role: 'coder', depth: 1, parent: 'coder', task: 'extract the tokenizer into its own file' } }),
				logEntry({ timestamp: t(11), type: 'llm_call', summary: 'coder \u00b7 llm call', payload: { role: 'coder', usage: { promptTokens: 5400, completionTokens: 150, totalTokens: 5550 } }, detailSections: [{ label: 'usage', content: { promptTokens: 5400, completionTokens: 150, totalTokens: 5550 } }] }),
			],
			budgets: budgets({ elapsedSeconds: 12, toolCalls: 1, tokensUsed: 9500, tokenBreakdown: tokenBreakdown(9200, 300) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'coder-1', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 1, costTime: 12, costTokens: 3950 }), flowNode({ id: 'coder-2', kind: 'role', label: roleLabel('coder'), sublabel: 'sub-task', column: 2, active: true, costTime: 4, costTokens: 5550 })], edges: [flowEdge('you', 'coder-1', 'call'), flowEdge('coder-1', 'coder-2', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 2, totalTime: 12, totalTokens: 9500 })] },
			),
		}, 12),
		// Frame 4: coder-2 returns green to coder-1 (coder-2 status:success, return edge flowing, coder-1 is the return's target).
		frame({
			status: 'unknown',
			task: 'Refactor the parser module into smaller files.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 coder-2 result' },
			roles: [roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(14), eventCount: 7, llmCalls: 2, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 5400 })],
			roleTree: [treeNode({ role: 'coder', depth: 0, active: false, children: [treeNode({ role: 'coder', depth: 1, parent: 'coder', status: 'success', summary: 'extracted the tokenizer', active: false })] })],
			recentLog: [
				logEntry({ timestamp: t(11), type: 'llm_call', summary: 'coder \u00b7 llm call', payload: { role: 'coder' } }),
				logEntry({ timestamp: t(14), type: 'role_finished', summary: 'coder \u00b7 finished (success)', payload: { role: 'coder', depth: 1, status: 'success', summary: 'extracted the tokenizer', parent: 'coder' } }),
			],
			budgets: budgets({ elapsedSeconds: 15, toolCalls: 1, tokensUsed: 9500, tokenBreakdown: tokenBreakdown(9200, 300) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'coder-1', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 1, costTime: 15, costTokens: 3950 }), flowNode({ id: 'coder-2', kind: 'role', label: roleLabel('coder'), sublabel: 'sub-task', column: 2, status: 'success', costTime: 7, costTokens: 5550 })], edges: [flowEdge('you', 'coder-1', 'call'), flowEdge('coder-1', 'coder-2', 'call'), flowEdge('coder-2', 'coder-1', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 2, totalTime: 15, totalTokens: 9500 })] },
			),
		}, 15),
		// Frame 5: coder-2 departed, coder-1 thinking (coder-1 active flag, no flowing edge).
		frame({
			status: 'unknown',
			task: 'Refactor the parser module into smaller files.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 thinking' },
			roles: [roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(15), eventCount: 8, llmCalls: 3, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 3800 })],
			roleTree: [treeNode({ role: 'coder', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(14), type: 'role_finished', summary: 'coder \u00b7 finished (success)', payload: { role: 'coder', depth: 1, status: 'success', summary: 'extracted the tokenizer', parent: 'coder' } }),
				logEntry({ timestamp: t(15), type: 'llm_call', summary: 'coder \u00b7 llm call (finish)', payload: { role: 'coder', usage: { promptTokens: 3800, completionTokens: 150, totalTokens: 3950 } }, detailSections: [{ label: 'usage', content: { promptTokens: 3800, completionTokens: 150, totalTokens: 3950 } }] }),
			],
			budgets: budgets({ elapsedSeconds: 16, toolCalls: 1, tokensUsed: 13450, tokenBreakdown: tokenBreakdown(13000, 450) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'coder-1', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 1, active: true, costTime: 16, costTokens: 7900 })], edges: [flowEdge('you', 'coder-1', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 2, totalTime: 16, totalTokens: 13450 })] },
			),
		}, 16),
		// Frame 6: coder-1 returns green to You (coder-1 status:success, return edge flowing, You is the return's target).
		frame({
			status: 'unknown',
			task: 'Refactor the parser module into smaller files.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 finished (success)' },
			roles: [roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(17), eventCount: 9, llmCalls: 3, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 3800 })],
			roleTree: [treeNode({ role: 'coder', depth: 0, status: 'success', summary: 'refactored the parser', active: false })],
			recentLog: [
				logEntry({ timestamp: t(15), type: 'llm_call', summary: 'coder \u00b7 llm call (finish)', payload: { role: 'coder' } }),
				logEntry({ timestamp: t(17), type: 'role_finished', summary: 'coder \u00b7 finished (success)', payload: { role: 'coder', depth: 0, status: 'success', summary: 'refactored the parser' } }),
			],
			budgets: budgets({ elapsedSeconds: 18, toolCalls: 1, tokensUsed: 13450, tokenBreakdown: tokenBreakdown(13000, 450) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'coder-1', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 1, status: 'success', costTime: 18, costTokens: 7900 })], edges: [flowEdge('you', 'coder-1', 'call'), flowEdge('coder-1', 'you', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 2, totalTime: 18, totalTokens: 13450 })] },
			),
		}, 18),
		// Frame 7: done, only You remains (status:success).
		frame({
			status: 'success',
			runId: 'run-self-delegation-fixture',
			task: 'Refactor the parser module into smaller files.',
			startTime: t(0),
			endTime: t(19),
			result: { status: 'success', summary: 'Split the parser into a tokenizer and a grammar module.', artifacts: ['src/tokenizer.js', 'src/grammar.js'] },
			currentActivity: { role: 'coder', summary: 'coder \u00b7 finished (success)' },
			roles: [roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(17), eventCount: 9, llmCalls: 3, toolCalls: 1, recentTools: ['agent'] })],
			roleTree: [treeNode({ role: 'coder', depth: 0, status: 'success', summary: 'refactored the parser', active: false })],
			recentLog: [
				logEntry({ timestamp: t(17), type: 'role_finished', summary: 'coder \u00b7 finished (success)', payload: { role: 'coder', depth: 0, status: 'success', summary: 'refactored the parser' } }),
			],
			budgets: budgets({ elapsedSeconds: 19, toolCalls: 1, tokensUsed: 13450, tokenBreakdown: tokenBreakdown(13000, 450) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 })], edges: [] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 2, totalTime: 19, totalTokens: 13450, status: 'success' })] },
			),
		}, 19),
	],
}

// Forward-looking: the loop-detector agent and the interrupt mechanism are not yet emitted by the executor (they land with the interrupt/inspect platform). The event shapes here model what that platform will produce so the visualization is ready when it arrives; the `interrupted` status is likewise a future terminal status.
const detectedLoop = {
	id: 'detected-loop',
	label: 'Detected loop (loop-detector agent fires)',
	description: 'A role repeats identical tool calls; the loop-detector agent inspects its history and triggers an interrupt \u2014 forward-looking, modeling the interrupt platform\u2019s event shape.',
	frames: [
		// Frame 0: you→coder call flowing (coder is the call's target, no costTokens yet). The loop has not yet occurred.
		frame({
			status: 'unknown',
			task: 'Fix the flaky test in the payments module.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 role start' },
			roles: [roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(1), eventCount: 1, llmCalls: 0 })],
			roleTree: [treeNode({ role: 'coder', depth: 0, active: true })],
			recentLog: [logEntry({ timestamp: t(1), type: 'role_start', summary: 'coder \u00b7 role start', payload: { role: 'coder', depth: 0, task: 'Fix the flaky test in the payments module' } })],
			budgets: budgets({ elapsedSeconds: 2 }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 1, costTime: 2 })], edges: [flowEdge('you', 'coder', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 2 })] },
			),
		}, 2),
		// Frame 1: coder thinking (call settled, coder has costTokens, active flag). The coder has already repeated read_file 3× — reflected in the top bar — and is stuck mid-loop.
		frame({
			status: 'unknown',
			task: 'Fix the flaky test in the payments module.',
			startTime: t(0),
			currentActivity: { role: 'coder', summary: 'coder \u00b7 read_file' },
			roles: [roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(12), eventCount: 5, llmCalls: 2, toolCalls: 3, recentTools: ['read_file'], lastPromptTokens: 4400 })],
			roleTree: [treeNode({ role: 'coder', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(4), type: 'llm_call', summary: 'coder \u00b7 llm call', payload: { role: 'coder' } }),
				logEntry({ timestamp: t(8), type: 'tool_call', summary: 'coder \u00b7 read_file', payload: { role: 'coder', tool: 'read_file', arguments: '{"path":"payments/handler.js"}' } }),
				logEntry({ timestamp: t(12), type: 'tool_call', summary: 'coder \u00b7 read_file', payload: { role: 'coder', tool: 'read_file', arguments: '{"path":"payments/handler.js"}' } }),
			],
			budgets: budgets({ elapsedSeconds: 13, toolCalls: 3, tokensUsed: 4580, tokenBreakdown: tokenBreakdown(4400, 180) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 1, active: true, costTime: 13, costTokens: 4580 })], edges: [flowEdge('you', 'coder', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 13, totalTokens: 4580 }), topBarNode({ id: 'read_file', kind: 'tool', label: toolLabel('read_file'), invocations: 3 })] },
			),
		}, 13),
		// Frame 2: loop_detector appears in row 1 and calls recent_role_tool_calls (call flowing, recent_role_tool_calls is the target). An inspect edge runs from recent_role_tool_calls up to coder (the role whose history it reads).
		frame({
			status: 'unknown',
			task: 'Fix the flaky test in the payments module.',
			startTime: t(0),
			currentActivity: { role: 'loop_detector', summary: 'loop_detector \u00b7 recent_role_tool_calls' },
			roles: [
				roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(12), eventCount: 6, llmCalls: 2, toolCalls: 4, recentTools: ['read_file'], lastPromptTokens: 4400 }),
				roleActivity({ role: 'loop_detector', firstSeen: t(15), lastSeen: t(17), eventCount: 2, llmCalls: 1, toolCalls: 1, recentTools: ['recent_role_tool_calls'] }),
			],
			roleTree: [treeNode({ role: 'coder', depth: 0, active: false, children: [treeNode({ role: 'loop_detector', depth: 1, parent: 'coder', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(12), type: 'tool_call', summary: 'coder \u00b7 read_file', payload: { role: 'coder', tool: 'read_file', arguments: '{"path":"payments/handler.js"}' } }),
				logEntry({ timestamp: t(14), type: 'agent_call', summary: 'coder \u00b7 agent call \u2192 loop_detector', payload: { parent: 'coder', child: 'loop_detector', depth: 1 } }),
				logEntry({ timestamp: t(17), type: 'tool_call', summary: 'loop_detector \u00b7 recent_role_tool_calls', payload: { role: 'loop_detector', tool: 'recent_role_tool_calls', arguments: '{"role":"coder","count":10}' }, detailSections: [{ label: 'arguments', content: '{"role":"coder","count":10}' }] }),
			],
			budgets: budgets({ elapsedSeconds: 18, toolCalls: 4, tokensUsed: 7680, tokenBreakdown: tokenBreakdown(7400, 280) }),
			flowModel: flowModel(
				// The loop_detector is an overseer, not a child of coder: it sits in its own row (row 1) and calls recent_role_tool_calls there, with an `inspect` edge up to coder (the role whose history it is reading). This illustrates the tool observing the builder rather than the builder calling the watchdog.
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0, row: 0 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 1, row: 0, costTime: 18, costTokens: 4580 }), flowNode({ id: 'loop_detector', kind: 'role', label: roleLabel('loop_detector'), sublabel: 'loop_detector', column: 0, row: 1, costTime: 3, costTokens: 3100 }), flowNode({ id: 'recent_role_tool_calls', kind: 'tool', label: toolLabel('recent_role_tool_calls'), column: 1, row: 1, costTime: 1 })], edges: [flowEdge('you', 'coder', 'call'), flowEdge('loop_detector', 'recent_role_tool_calls', 'call'), flowEdge('recent_role_tool_calls', 'coder', 'inspect')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 18, totalTokens: 4580 }), topBarNode({ id: 'read_file', kind: 'tool', label: toolLabel('read_file'), invocations: 3 }), topBarNode({ id: 'loop_detector', kind: 'role', label: roleLabel('loop_detector'), invocations: 1, totalTime: 3, totalTokens: 3100 }), topBarNode({ id: 'recent_role_tool_calls', kind: 'tool', label: toolLabel('recent_role_tool_calls'), invocations: 1 })] },
			),
		}, 18),
		// Frame 3: recent_role_tool_calls returns green to loop_detector (recent_role_tool_calls status:success, return edge flowing, loop_detector is the return's target).
		frame({
			status: 'unknown',
			task: 'Fix the flaky test in the payments module.',
			startTime: t(0),
			currentActivity: { role: 'loop_detector', summary: 'loop_detector \u00b7 recent_role_tool_calls result' },
			roles: [
				roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(12), eventCount: 6, llmCalls: 2, toolCalls: 4, recentTools: ['read_file'], lastPromptTokens: 4400 }),
				roleActivity({ role: 'loop_detector', firstSeen: t(15), lastSeen: t(19), eventCount: 3, llmCalls: 1, toolCalls: 1, recentTools: ['recent_role_tool_calls'] }),
			],
			roleTree: [treeNode({ role: 'coder', depth: 0, active: false, children: [treeNode({ role: 'loop_detector', depth: 1, parent: 'coder', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(17), type: 'tool_call', summary: 'loop_detector \u00b7 recent_role_tool_calls', payload: { role: 'loop_detector', tool: 'recent_role_tool_calls' } }),
				logEntry({ timestamp: t(19), type: 'tool_result', summary: 'loop_detector \u00b7 recent_role_tool_calls result', payload: { role: 'loop_detector', tool: 'recent_role_tool_calls', result: 'coder repeated read_file 3 times' }, detailSections: [{ label: 'result', content: 'coder repeated read_file 3 times' }] }),
			],
			budgets: budgets({ elapsedSeconds: 19, toolCalls: 4, tokensUsed: 7680, tokenBreakdown: tokenBreakdown(7400, 280) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0, row: 0 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), sublabel: 'coder', column: 1, row: 0, costTime: 19, costTokens: 4580 }), flowNode({ id: 'loop_detector', kind: 'role', label: roleLabel('loop_detector'), sublabel: 'loop_detector', column: 0, row: 1, costTime: 4, costTokens: 3100 }), flowNode({ id: 'recent_role_tool_calls', kind: 'tool', label: toolLabel('recent_role_tool_calls'), column: 1, row: 1, status: 'success', costTime: 3 })], edges: [flowEdge('you', 'coder', 'call'), flowEdge('loop_detector', 'recent_role_tool_calls', 'call'), flowEdge('recent_role_tool_calls', 'coder', 'inspect'), flowEdge('recent_role_tool_calls', 'loop_detector', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 19, totalTokens: 4580 }), topBarNode({ id: 'read_file', kind: 'tool', label: toolLabel('read_file'), invocations: 3 }), topBarNode({ id: 'loop_detector', kind: 'role', label: roleLabel('loop_detector'), invocations: 1, totalTime: 4, totalTokens: 3100 }), topBarNode({ id: 'recent_role_tool_calls', kind: 'tool', label: toolLabel('recent_role_tool_calls'), invocations: 1 })] },
			),
		}, 19),
		// Frame 4: loop_detector fires trigger_interrupt and departs; the interrupt suspends the run. Status:interrupted, only You remains. trigger_interrupt is kept in the top bar.
		frame({
			status: 'interrupted',
			runId: 'run-detected-loop-fixture',
			task: 'Fix the flaky test in the payments module.',
			startTime: t(0),
			endTime: t(20),
			currentActivity: { role: 'loop_detector', summary: 'loop_detector \u00b7 trigger_interrupt' },
			roles: [
				roleActivity({ role: 'coder', firstSeen: t(1), lastSeen: t(12), eventCount: 6, llmCalls: 2, toolCalls: 4, recentTools: ['read_file'], lastPromptTokens: 4400 }),
				roleActivity({ role: 'loop_detector', firstSeen: t(15), lastSeen: t(20), eventCount: 4, llmCalls: 1, toolCalls: 2, recentTools: ['trigger_interrupt', 'recent_role_tool_calls'] }),
			],
			roleTree: [treeNode({ role: 'coder', depth: 0, status: 'interrupted', summary: 'repeated read_file 3\u00d7', active: false, children: [treeNode({ role: 'loop_detector', depth: 1, parent: 'coder', status: 'success', summary: 'detected a repetition loop', active: false })] })],
			recentLog: [
				logEntry({ timestamp: t(19), type: 'tool_result', summary: 'loop_detector \u00b7 recent_role_tool_calls result', payload: { role: 'loop_detector', tool: 'recent_role_tool_calls' } }),
				logEntry({ timestamp: t(20), type: 'tool_call', summary: 'loop_detector \u00b7 trigger_interrupt', payload: { role: 'loop_detector', tool: 'trigger_interrupt', arguments: '{"kind":"loop_detected","message":"coder repeated read_file 3 times"}' } }),
				logEntry({ timestamp: t(20), type: 'interrupt_triggered', summary: 'interrupt triggered (loop_detected)', payload: { source: 'loop_detector', kind: 'loop_detected', message: 'coder repeated read_file 3 times' } }),
			],
			budgets: budgets({ elapsedSeconds: 20, toolCalls: 5, tokensUsed: 7680, tokenBreakdown: tokenBreakdown(7400, 280) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 })], edges: [] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder'), invocations: 1, totalTime: 20, totalTokens: 4580, status: 'interrupted' }), topBarNode({ id: 'loop_detector', kind: 'role', label: roleLabel('loop_detector'), invocations: 1, totalTime: 5, status: 'success' }), topBarNode({ id: 'read_file', kind: 'tool', label: toolLabel('read_file'), invocations: 3 }), topBarNode({ id: 'recent_role_tool_calls', kind: 'tool', label: toolLabel('recent_role_tool_calls'), invocations: 1 }), topBarNode({ id: 'trigger_interrupt', kind: 'tool', label: toolLabel('trigger_interrupt'), invocations: 1 })] },
			),
		}, 20),
	],
}

// Forward-looking: the operator/API interrupt (inquiry + plan-modification) is a future feature on the interrupt platform. These frames model a run paused by an operator inquiry so the visualization can present the paused state before the mechanism exists.
const userInterrupt = {
	id: 'user-interrupt',
	label: 'User interruption (operator inquiry, future feature)',
	description: 'The operator pauses a running task with an inquiry interrupt \u2014 a new You node appears in a second row, the first row pauses, and after the inquiry resolves the first row resumes.',
	frames: [
		// Frame 0: you→planner call flowing (planner is the call's target, no costTokens yet).
		frame({
			status: 'unknown',
			task: 'Migrate the monolith to a modular architecture.',
			startTime: t(0),
			currentActivity: { role: 'planner', summary: 'planner \u00b7 role start' },
			roles: [roleActivity({ role: 'planner', firstSeen: t(1), lastSeen: t(1), eventCount: 1, llmCalls: 0 })],
			roleTree: [treeNode({ role: 'planner', depth: 0, active: true })],
			recentLog: [logEntry({ timestamp: t(1), type: 'role_start', summary: 'planner \u00b7 role start', payload: { role: 'planner', depth: 0, task: 'Migrate the monolith to a modular architecture' } })],
			budgets: budgets({ elapsedSeconds: 2 }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 1, costTime: 2 })], edges: [flowEdge('you', 'planner', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 2 })] },
			),
		}, 2),
		// Frame 1: planner thinking (call settled, planner has costTokens, active flag).
		frame({
			status: 'unknown',
			task: 'Migrate the monolith to a modular architecture.',
			startTime: t(0),
			currentActivity: { role: 'planner', summary: 'planner \u00b7 llm call' },
			roles: [roleActivity({ role: 'planner', firstSeen: t(1), lastSeen: t(4), eventCount: 2, llmCalls: 1, lastPromptTokens: 6800 })],
			roleTree: [treeNode({ role: 'planner', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(1), type: 'role_start', summary: 'planner \u00b7 role start', payload: { role: 'planner', depth: 0 } }),
				logEntry({ timestamp: t(4), type: 'llm_call', summary: 'planner \u00b7 llm call', payload: { role: 'planner', usage: { promptTokens: 6800, completionTokens: 260, totalTokens: 7060 } }, detailSections: [{ label: 'usage', content: { promptTokens: 6800, completionTokens: 260, totalTokens: 7060 } }] }),
			],
			budgets: budgets({ elapsedSeconds: 5, tokensUsed: 7060, tokenBreakdown: tokenBreakdown(6800, 260) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 1, active: true, costTime: 5, costTokens: 7060 })], edges: [flowEdge('you', 'planner', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 5, totalTokens: 7060 })] },
			),
		}, 5),
		// Frame 2: planner→search_text call flowing (search_text is the call's target).
		frame({
			status: 'unknown',
			task: 'Migrate the monolith to a modular architecture.',
			startTime: t(0),
			currentActivity: { role: 'planner', summary: 'planner \u00b7 search_text' },
			roles: [roleActivity({ role: 'planner', firstSeen: t(1), lastSeen: t(8), eventCount: 4, llmCalls: 2, toolCalls: 1, recentTools: ['search_text'], lastPromptTokens: 6800 })],
			roleTree: [treeNode({ role: 'planner', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(4), type: 'llm_call', summary: 'planner \u00b7 llm call', payload: { role: 'planner' } }),
				logEntry({ timestamp: t(8), type: 'tool_call', summary: 'planner \u00b7 search_text', payload: { role: 'planner', tool: 'search_text', arguments: '{"pattern":"module.exports"}' }, detailSections: [{ label: 'arguments', content: '{"pattern":"module.exports"}' }] }),
			],
			budgets: budgets({ elapsedSeconds: 8, toolCalls: 1, tokensUsed: 7060, tokenBreakdown: tokenBreakdown(6800, 260) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 1, costTime: 8, costTokens: 7060 }), flowNode({ id: 'search_text', kind: 'tool', label: toolLabel('search_text'), column: 2, costTime: 1 })], edges: [flowEdge('you', 'planner', 'call'), flowEdge('planner', 'search_text', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 8, totalTokens: 7060 }), topBarNode({ id: 'search_text', kind: 'tool', label: toolLabel('search_text'), invocations: 1 })] },
			),
		}, 8),
		// Frame 3: search_text returns green (search_text status:success, return edge flowing, planner is the return's target).
		frame({
			status: 'unknown',
			task: 'Migrate the monolith to a modular architecture.',
			startTime: t(0),
			currentActivity: { role: 'planner', summary: 'planner \u00b7 search_text result' },
			roles: [roleActivity({ role: 'planner', firstSeen: t(1), lastSeen: t(10), eventCount: 5, llmCalls: 2, toolCalls: 1, recentTools: ['search_text'], lastPromptTokens: 6800 })],
			roleTree: [treeNode({ role: 'planner', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(8), type: 'tool_call', summary: 'planner \u00b7 search_text', payload: { role: 'planner', tool: 'search_text' } }),
				logEntry({ timestamp: t(10), type: 'tool_result', summary: 'planner \u00b7 search_text result', payload: { role: 'planner', tool: 'search_text', result: 'found 14 matches' }, detailSections: [{ label: 'result', content: 'found 14 matches' }] }),
			],
			budgets: budgets({ elapsedSeconds: 10, toolCalls: 1, tokensUsed: 7060, tokenBreakdown: tokenBreakdown(6800, 260) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 1, costTime: 10, costTokens: 7060 }), flowNode({ id: 'search_text', kind: 'tool', label: toolLabel('search_text'), column: 2, status: 'success', costTime: 4 })], edges: [flowEdge('you', 'planner', 'call'), flowEdge('planner', 'search_text', 'call'), flowEdge('search_text', 'planner', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 10, totalTokens: 7060 }), topBarNode({ id: 'search_text', kind: 'tool', label: toolLabel('search_text'), invocations: 1 })] },
			),
		}, 10),
		// Frame 4: the operator fires an inquiry interrupt. A new You node appears in row 1 (far left); the first row's planner is paused (status: 'paused'). The inquiry question flows from the new You to the planner's paused node via a question edge. The new You (the question's source) is active.
		frame({
			status: 'unknown',
			task: 'Migrate the monolith to a modular architecture.',
			startTime: t(0),
			currentActivity: { role: null, summary: 'operator inquiry' },
			roles: [roleActivity({ role: 'planner', firstSeen: t(1), lastSeen: t(12), eventCount: 5, llmCalls: 2, toolCalls: 1, recentTools: ['search_text'], lastPromptTokens: 6800 })],
			roleTree: [treeNode({ role: 'planner', depth: 0, status: 'interrupted', summary: 'paused for operator inquiry', active: false })],
			questionHistory: [question({ id: 'q1', question: 'Should we keep the legacy API endpoints for backward compatibility?', askedAt: t(12), context: 'The planner was searching for module.exports patterns.' })],
			recentLog: [
				logEntry({ timestamp: t(10), type: 'tool_result', summary: 'planner \u00b7 search_text result', payload: { role: 'planner', tool: 'search_text' } }),
				logEntry({ timestamp: t(12), type: 'interrupt_triggered', summary: 'interrupt triggered (operator_inquiry)', payload: { source: 'operator', kind: 'inquiry', message: 'Should we keep the legacy API endpoints for backward compatibility?' } }),
			],
			budgets: budgets({ elapsedSeconds: 12, toolCalls: 1, tokensUsed: 7060, tokenBreakdown: tokenBreakdown(6800, 260) }),
			flowModel: flowModel(
				// Row 0: the paused run — you→planner (status: 'paused') with search_text departed. Row 1: a new You node (the operator's inquiry entry point) with a question edge flowing up to the paused planner. The question edge flows from the new You to the planner, so the planner (the question's target) is active.
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0, row: 0 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 1, row: 0, status: 'interrupted', costTime: 12, costTokens: 7060 }), flowNode({ id: 'you-inquiry', kind: 'you', label: 'You', column: 0, row: 1 })], edges: [flowEdge('you', 'planner', 'call'), flowEdge('you-inquiry', 'planner', 'question')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 12, totalTokens: 7060 }), topBarNode({ id: 'search_text', kind: 'tool', label: toolLabel('search_text'), invocations: 1 })] },
			),
		}, 12),
		// Frame 5: the inquiry is answered. The new You departs; the planner resumes (active flag). The run continues from where it was paused. Status returns to unknown.
		frame({
			status: 'unknown',
			task: 'Migrate the monolith to a modular architecture.',
			startTime: t(0),
			currentActivity: { role: 'planner', summary: 'planner \u00b7 resumed' },
			roles: [roleActivity({ role: 'planner', firstSeen: t(1), lastSeen: t(14), eventCount: 6, llmCalls: 2, toolCalls: 1, recentTools: ['search_text'], lastPromptTokens: 6800 })],
			roleTree: [treeNode({ role: 'planner', depth: 0, active: true })],
			questionHistory: [question({ id: 'q1', question: 'Should we keep the legacy API endpoints for backward compatibility?', askedAt: t(12), context: 'The planner was searching for module.exports patterns.', answer: 'Yes, keep them for backward compatibility.', answeredAt: t(13) })],
			recentLog: [
				logEntry({ timestamp: t(12), type: 'interrupt_triggered', summary: 'interrupt triggered (operator_inquiry)', payload: { source: 'operator', kind: 'inquiry', message: 'Should we keep the legacy API endpoints for backward compatibility?' } }),
				logEntry({ timestamp: t(13), type: 'interrupt_resolved', summary: 'interrupt resolved', payload: { source: 'operator', kind: 'inquiry', answer: 'Yes, keep them for backward compatibility.' } }),
				logEntry({ timestamp: t(14), type: 'llm_call', summary: 'planner \u00b7 llm call (resumed)', payload: { role: 'planner' } }),
			],
			budgets: budgets({ elapsedSeconds: 14, toolCalls: 1, tokensUsed: 7060, tokenBreakdown: tokenBreakdown(6800, 260) }),
			flowModel: flowModel(
				// The inquiry You has departed; the planner is back to thinking (active flag), row 0 only.
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 1, active: true, costTime: 14, costTokens: 7060 })], edges: [flowEdge('you', 'planner', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 14, totalTokens: 7060 }), topBarNode({ id: 'search_text', kind: 'tool', label: toolLabel('search_text'), invocations: 1 })] },
			),
		}, 14),
		// Frame 6: the planner finishes and returns green to You (planner status:success, return edge flowing, You is the return's target).
		frame({
			status: 'unknown',
			task: 'Migrate the monolith to a modular architecture.',
			startTime: t(0),
			currentActivity: { role: 'planner', summary: 'planner \u00b7 finished (success)' },
			roles: [roleActivity({ role: 'planner', firstSeen: t(1), lastSeen: t(16), eventCount: 7, llmCalls: 3, toolCalls: 1, recentTools: ['search_text'], lastPromptTokens: 6800 })],
			roleTree: [treeNode({ role: 'planner', depth: 0, status: 'success', summary: 'planned the migration', active: false })],
			recentLog: [
				logEntry({ timestamp: t(14), type: 'llm_call', summary: 'planner \u00b7 llm call (resumed)', payload: { role: 'planner' } }),
				logEntry({ timestamp: t(16), type: 'role_finished', summary: 'planner \u00b7 finished (success)', payload: { role: 'planner', status: 'success', summary: 'planned the migration' } }),
			],
			budgets: budgets({ elapsedSeconds: 16, toolCalls: 1, tokensUsed: 7060, tokenBreakdown: tokenBreakdown(6800, 260) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), sublabel: 'planner', column: 1, status: 'success', costTime: 16, costTokens: 7060 })], edges: [flowEdge('you', 'planner', 'call'), flowEdge('planner', 'you', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 16, totalTokens: 7060 }), topBarNode({ id: 'search_text', kind: 'tool', label: toolLabel('search_text'), invocations: 1 })] },
			),
		}, 16),
		// Frame 7: done, only You remains (status:success).
		frame({
			status: 'success',
			runId: 'run-user-interrupt-fixture',
			task: 'Migrate the monolith to a modular architecture.',
			startTime: t(0),
			endTime: t(17),
			result: { status: 'success', summary: 'Planned the migration after an operator inquiry about legacy endpoints.', artifacts: ['docs/migration-plan.md'] },
			currentActivity: { role: 'planner', summary: 'planner \u00b7 finished (success)' },
			roles: [roleActivity({ role: 'planner', firstSeen: t(1), lastSeen: t(16), eventCount: 7, llmCalls: 3, toolCalls: 1 })],
			roleTree: [treeNode({ role: 'planner', depth: 0, status: 'success', summary: 'planned the migration', active: false })],
			recentLog: [
				logEntry({ timestamp: t(16), type: 'role_finished', summary: 'planner \u00b7 finished (success)', payload: { role: 'planner', status: 'success', summary: 'planned the migration' } }),
			],
			budgets: budgets({ elapsedSeconds: 17, toolCalls: 1, tokensUsed: 7060, tokenBreakdown: tokenBreakdown(6800, 260) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 })], edges: [] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'planner', kind: 'role', label: roleLabel('planner'), invocations: 1, totalTime: 16, totalTokens: 7060, status: 'success' }), topBarNode({ id: 'search_text', kind: 'tool', label: toolLabel('search_text'), invocations: 1 })] },
			),
		}, 17),
	],
}

const largeGuild = {
	id: 'large-guild',
	label: 'Large guild (~15 roles, complex tree)',
	description: 'A guild with fifteen roles and a run that touches most of them \u2014 exercises the static layout against a crowded node set and a deep, wide invocation tree.',
	frames: [
		// Frame 0: you→orchestrator call flowing (orchestrator is the call's target, no costTokens yet).
		frame({
			status: 'unknown',
			task: 'Build a full booking system: API, tests, docs, and a security review.',
			startTime: t(0),
			config: largeGuildConfig,
			currentActivity: { role: 'orchestrator', summary: 'orchestrator \u00b7 role start' },
			roles: [roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(1), eventCount: 1, llmCalls: 0 })],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: true })],
			recentLog: [logEntry({ timestamp: t(1), type: 'role_start', summary: 'orchestrator \u00b7 role start', payload: { role: 'orchestrator', depth: 0, task: 'Build a full booking system: API, tests, docs, and a security review' } })],
			budgets: budgets({ elapsedSeconds: 2 }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), sublabel: 'orchestrator', column: 1, costTime: 2 })], edges: [flowEdge('you', 'orchestrator', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), invocations: 1, totalTime: 2 })] },
			),
		}, 2),
		// Frame 1: orchestrator thinking (call settled, orchestrator has costTokens, active flag).
		frame({
			status: 'unknown',
			task: 'Build a full booking system: API, tests, docs, and a security review.',
			startTime: t(0),
			config: largeGuildConfig,
			currentActivity: { role: 'orchestrator', summary: 'orchestrator \u00b7 llm call' },
			roles: [roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(4), eventCount: 2, llmCalls: 1, lastPromptTokens: 3200 })],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(1), type: 'role_start', summary: 'orchestrator \u00b7 role start', payload: { role: 'orchestrator', depth: 0 } }),
				logEntry({ timestamp: t(4), type: 'llm_call', summary: 'orchestrator \u00b7 llm call', payload: { role: 'orchestrator', usage: { promptTokens: 3200, completionTokens: 320, totalTokens: 3520 } }, detailSections: [{ label: 'usage', content: { promptTokens: 3200, completionTokens: 320, totalTokens: 3520 } }] }),
			],
			budgets: budgets({ elapsedSeconds: 5, tokensUsed: 3520, tokenBreakdown: tokenBreakdown(3200, 320) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), sublabel: 'orchestrator', column: 1, active: true, costTime: 5, costTokens: 3520 })], edges: [flowEdge('you', 'orchestrator', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), invocations: 1, totalTime: 5, totalTokens: 3520 })] },
			),
		}, 5),
		// Frame 2: orchestrator→architect call flowing (architect is the call's target, no costTokens yet).
		frame({
			status: 'unknown',
			task: 'Build a full booking system: API, tests, docs, and a security review.',
			startTime: t(0),
			config: largeGuildConfig,
			currentActivity: { role: 'architect', summary: 'architect \u00b7 role start' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(7), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 3200 }),
				roleActivity({ role: 'architect', firstSeen: t(7), lastSeen: t(7), eventCount: 1, llmCalls: 0 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'architect', depth: 1, parent: 'orchestrator', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(4), type: 'llm_call', summary: 'orchestrator \u00b7 llm call', payload: { role: 'orchestrator' } }),
				logEntry({ timestamp: t(7), type: 'tool_call', summary: 'orchestrator \u00b7 agent', payload: { role: 'orchestrator', tool: 'agent', arguments: '{"role":"architect","task":"design the booking module structure"}' }, detailSections: [{ label: 'arguments', content: '{"role":"architect","task":"design the booking module structure"}' }] }),
				logEntry({ timestamp: t(7), type: 'agent_call', summary: 'orchestrator \u00b7 agent call \u2192 architect', payload: { parent: 'orchestrator', child: 'architect', depth: 1 } }),
			],
			budgets: budgets({ elapsedSeconds: 8, toolCalls: 1, tokensUsed: 3520, tokenBreakdown: tokenBreakdown(3200, 320) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), sublabel: 'orchestrator', column: 1, costTime: 8, costTokens: 3520 }), flowNode({ id: 'architect', kind: 'role', label: roleLabel('architect', largeGuildConfig), sublabel: 'architect', column: 2, costTime: 1 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'architect', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), invocations: 1, totalTime: 8, totalTokens: 3520 }), topBarNode({ id: 'architect', kind: 'role', label: roleLabel('architect', largeGuildConfig), invocations: 1, totalTime: 1 })] },
			),
		}, 8),
		// Frame 3: architect thinking (call settled, architect has costTokens, active flag).
		frame({
			status: 'unknown',
			task: 'Build a full booking system: API, tests, docs, and a security review.',
			startTime: t(0),
			config: largeGuildConfig,
			currentActivity: { role: 'architect', summary: 'architect \u00b7 llm call' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(7), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 3200 }),
				roleActivity({ role: 'architect', firstSeen: t(7), lastSeen: t(10), eventCount: 3, llmCalls: 1, lastPromptTokens: 7100 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'architect', depth: 1, parent: 'orchestrator', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(7), type: 'agent_call', summary: 'orchestrator \u00b7 agent call \u2192 architect', payload: { parent: 'orchestrator', child: 'architect', depth: 1 } }),
				logEntry({ timestamp: t(7), type: 'role_start', summary: 'architect \u00b7 role start', payload: { role: 'architect', depth: 1, parent: 'orchestrator', task: 'design the booking module structure' } }),
				logEntry({ timestamp: t(10), type: 'llm_call', summary: 'architect \u00b7 llm call', payload: { role: 'architect', usage: { promptTokens: 7100, completionTokens: 320, totalTokens: 7420 } }, detailSections: [{ label: 'usage', content: { promptTokens: 7100, completionTokens: 320, totalTokens: 7420 } }] }),
			],
			budgets: budgets({ elapsedSeconds: 11, tokensUsed: 10940, tokenBreakdown: tokenBreakdown(10300, 640) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), sublabel: 'orchestrator', column: 1, costTime: 11, costTokens: 3520 }), flowNode({ id: 'architect', kind: 'role', label: roleLabel('architect', largeGuildConfig), sublabel: 'architect', column: 2, active: true, costTime: 4, costTokens: 7420 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'architect', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), invocations: 1, totalTime: 11, totalTokens: 3520 }), topBarNode({ id: 'architect', kind: 'role', label: roleLabel('architect', largeGuildConfig), invocations: 1, totalTime: 4, totalTokens: 7420 })] },
			),
		}, 11),
		// Frame 4: architect returns green to orchestrator (architect status:success, return edge flowing, orchestrator is the return's target).
		frame({
			status: 'unknown',
			task: 'Build a full booking system: API, tests, docs, and a security review.',
			startTime: t(0),
			config: largeGuildConfig,
			currentActivity: { role: 'orchestrator', summary: 'receiving architect success' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(13), eventCount: 5, llmCalls: 1, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 3200 }),
				roleActivity({ role: 'architect', firstSeen: t(7), lastSeen: t(13), eventCount: 4, llmCalls: 1, lastPromptTokens: 7100 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'architect', depth: 1, parent: 'orchestrator', status: 'success', summary: 'designed the module structure', active: false })] })],
			recentLog: [
				logEntry({ timestamp: t(10), type: 'llm_call', summary: 'architect \u00b7 llm call (finish)', payload: { role: 'architect' } }),
				logEntry({ timestamp: t(13), type: 'role_finished', summary: 'architect \u00b7 finished (success)', payload: { role: 'architect', status: 'success', summary: 'designed the module structure' } }),
			],
			budgets: budgets({ elapsedSeconds: 14, toolCalls: 1, tokensUsed: 10940, tokenBreakdown: tokenBreakdown(10300, 640) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), sublabel: 'orchestrator', column: 1, costTime: 14, costTokens: 3520 }), flowNode({ id: 'architect', kind: 'role', label: roleLabel('architect', largeGuildConfig), sublabel: 'architect', column: 2, status: 'success', costTime: 7, costTokens: 7420 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'architect', 'call'), flowEdge('architect', 'orchestrator', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), invocations: 1, totalTime: 14, totalTokens: 3520 }), topBarNode({ id: 'architect', kind: 'role', label: roleLabel('architect', largeGuildConfig), invocations: 1, totalTime: 7, totalTokens: 7420 })] },
			),
		}, 14),
		// Frame 5: architect departed, orchestrator thinking (orchestrator active flag, no flowing edge).
		frame({
			status: 'unknown',
			task: 'Build a full booking system: API, tests, docs, and a security review.',
			startTime: t(0),
			config: largeGuildConfig,
			currentActivity: { role: 'orchestrator', summary: 'orchestrator \u00b7 thinking' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(15), eventCount: 6, llmCalls: 2, toolCalls: 1, recentTools: ['agent'], lastPromptTokens: 3200 }),
				roleActivity({ role: 'architect', firstSeen: t(7), lastSeen: t(13), eventCount: 4, llmCalls: 1, lastPromptTokens: 7100 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: true })],
			recentLog: [
				logEntry({ timestamp: t(13), type: 'role_finished', summary: 'architect \u00b7 finished (success)', payload: { role: 'architect', status: 'success' } }),
				logEntry({ timestamp: t(15), type: 'llm_call', summary: 'orchestrator \u00b7 llm call', payload: { role: 'orchestrator', usage: { promptTokens: 3200, completionTokens: 200, totalTokens: 3400 } }, detailSections: [{ label: 'usage', content: { promptTokens: 3200, completionTokens: 200, totalTokens: 3400 } }] }),
			],
			budgets: budgets({ elapsedSeconds: 16, toolCalls: 1, tokensUsed: 14340, tokenBreakdown: tokenBreakdown(13500, 840) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), sublabel: 'orchestrator', column: 1, active: true, costTime: 16, costTokens: 6920 })], edges: [flowEdge('you', 'orchestrator', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), invocations: 1, totalTime: 16, totalTokens: 6920 }), topBarNode({ id: 'architect', kind: 'role', label: roleLabel('architect', largeGuildConfig), invocations: 1, totalTime: 7, totalTokens: 7420, status: 'success' })] },
			),
		}, 16),
		// Frame 6: orchestrator→coder call flowing (coder is the call's target, no costTokens yet).
		frame({
			status: 'unknown',
			task: 'Build a full booking system: API, tests, docs, and a security review.',
			startTime: t(0),
			config: largeGuildConfig,
			currentActivity: { role: 'coder', summary: 'coder \u00b7 role start' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(17), eventCount: 7, llmCalls: 2, toolCalls: 2, recentTools: ['agent'], lastPromptTokens: 3200 }),
				roleActivity({ role: 'architect', firstSeen: t(7), lastSeen: t(13), eventCount: 4, llmCalls: 1, lastPromptTokens: 7100 }),
				roleActivity({ role: 'coder', firstSeen: t(17), lastSeen: t(17), eventCount: 1, llmCalls: 0 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(15), type: 'llm_call', summary: 'orchestrator \u00b7 llm call', payload: { role: 'orchestrator' } }),
				logEntry({ timestamp: t(17), type: 'tool_call', summary: 'orchestrator \u00b7 agent', payload: { role: 'orchestrator', tool: 'agent', arguments: '{"role":"coder","task":"write the booking routes"}' }, detailSections: [{ label: 'arguments', content: '{"role":"coder","task":"write the booking routes"}' }] }),
				logEntry({ timestamp: t(17), type: 'agent_call', summary: 'orchestrator \u00b7 agent call \u2192 coder', payload: { parent: 'orchestrator', child: 'coder', depth: 1 } }),
			],
			budgets: budgets({ elapsedSeconds: 18, toolCalls: 2, tokensUsed: 14340, tokenBreakdown: tokenBreakdown(13500, 840) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), sublabel: 'orchestrator', column: 1, costTime: 18, costTokens: 6920 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder', largeGuildConfig), sublabel: 'coder', column: 2, costTime: 1 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'coder', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), invocations: 1, totalTime: 18, totalTokens: 6920 }), topBarNode({ id: 'architect', kind: 'role', label: roleLabel('architect', largeGuildConfig), invocations: 1, totalTime: 7, totalTokens: 7420, status: 'success' }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder', largeGuildConfig), invocations: 1, totalTime: 1 })] },
			),
		}, 18),
		// Frame 7: coder thinking (call settled, coder has costTokens, active flag).
		frame({
			status: 'unknown',
			task: 'Build a full booking system: API, tests, docs, and a security review.',
			startTime: t(0),
			config: largeGuildConfig,
			currentActivity: { role: 'coder', summary: 'coder \u00b7 llm call' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(17), eventCount: 7, llmCalls: 2, toolCalls: 2, recentTools: ['agent'], lastPromptTokens: 3200 }),
				roleActivity({ role: 'architect', firstSeen: t(7), lastSeen: t(13), eventCount: 4, llmCalls: 1, lastPromptTokens: 7100 }),
				roleActivity({ role: 'coder', firstSeen: t(17), lastSeen: t(20), eventCount: 3, llmCalls: 1, lastPromptTokens: 8400 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(17), type: 'agent_call', summary: 'orchestrator \u00b7 agent call \u2192 coder', payload: { parent: 'orchestrator', child: 'coder', depth: 1 } }),
				logEntry({ timestamp: t(17), type: 'role_start', summary: 'coder \u00b7 role start', payload: { role: 'coder', depth: 1, parent: 'orchestrator', task: 'write the booking routes' } }),
				logEntry({ timestamp: t(20), type: 'llm_call', summary: 'coder \u00b7 llm call', payload: { role: 'coder', usage: { promptTokens: 8400, completionTokens: 640, totalTokens: 9040 } }, detailSections: [{ label: 'usage', content: { promptTokens: 8400, completionTokens: 640, totalTokens: 9040 } }] }),
			],
			budgets: budgets({ elapsedSeconds: 21, tokensUsed: 23380, tokenBreakdown: tokenBreakdown(21900, 1480) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), sublabel: 'orchestrator', column: 1, costTime: 21, costTokens: 6920 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder', largeGuildConfig), sublabel: 'coder', column: 2, active: true, costTime: 4, costTokens: 9040 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'coder', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), invocations: 1, totalTime: 21, totalTokens: 6920 }), topBarNode({ id: 'architect', kind: 'role', label: roleLabel('architect', largeGuildConfig), invocations: 1, totalTime: 7, totalTokens: 7420, status: 'success' }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder', largeGuildConfig), invocations: 1, totalTime: 4, totalTokens: 9040 })] },
			),
		}, 21),
		// Frame 8: coder→write_file call flowing (write_file is the call's target).
		frame({
			status: 'unknown',
			task: 'Build a full booking system: API, tests, docs, and a security review.',
			startTime: t(0),
			config: largeGuildConfig,
			currentActivity: { role: 'coder', summary: 'coder \u00b7 write_file' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(17), eventCount: 7, llmCalls: 2, toolCalls: 2, recentTools: ['agent'], lastPromptTokens: 3200 }),
				roleActivity({ role: 'architect', firstSeen: t(7), lastSeen: t(13), eventCount: 4, llmCalls: 1, lastPromptTokens: 7100 }),
				roleActivity({ role: 'coder', firstSeen: t(17), lastSeen: t(22), eventCount: 4, llmCalls: 1, toolCalls: 1, recentTools: ['write_file'], lastPromptTokens: 8400 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(20), type: 'llm_call', summary: 'coder \u00b7 llm call', payload: { role: 'coder' } }),
				logEntry({ timestamp: t(22), type: 'tool_call', summary: 'coder \u00b7 write_file', payload: { role: 'coder', tool: 'write_file', arguments: '{"path":"src/bookings/routes.js"}' }, detailSections: [{ label: 'arguments', content: '{"path":"src/bookings/routes.js"}' }] }),
			],
			budgets: budgets({ elapsedSeconds: 23, toolCalls: 3, tokensUsed: 23380, tokenBreakdown: tokenBreakdown(21900, 1480) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), sublabel: 'orchestrator', column: 1, costTime: 23, costTokens: 6920 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder', largeGuildConfig), sublabel: 'coder', column: 2, costTime: 6, costTokens: 9040 }), flowNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file', largeGuildConfig), column: 3, costTime: 1 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'coder', 'call'), flowEdge('coder', 'write_file', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), invocations: 1, totalTime: 23, totalTokens: 6920 }), topBarNode({ id: 'architect', kind: 'role', label: roleLabel('architect', largeGuildConfig), invocations: 1, totalTime: 7, totalTokens: 7420, status: 'success' }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder', largeGuildConfig), invocations: 1, totalTime: 6, totalTokens: 9040 }), topBarNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file', largeGuildConfig), invocations: 1 })] },
			),
		}, 23),
		// Frame 9: write_file returns green (write_file status:success, return edge flowing, coder is the return's target).
		frame({
			status: 'unknown',
			task: 'Build a full booking system: API, tests, docs, and a security review.',
			startTime: t(0),
			config: largeGuildConfig,
			currentActivity: { role: 'coder', summary: 'coder \u00b7 write_file result' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(17), eventCount: 7, llmCalls: 2, toolCalls: 2, recentTools: ['agent'], lastPromptTokens: 3200 }),
				roleActivity({ role: 'architect', firstSeen: t(7), lastSeen: t(13), eventCount: 4, llmCalls: 1, lastPromptTokens: 7100 }),
				roleActivity({ role: 'coder', firstSeen: t(17), lastSeen: t(24), eventCount: 5, llmCalls: 1, toolCalls: 1, recentTools: ['write_file'], lastPromptTokens: 8400 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(22), type: 'tool_call', summary: 'coder \u00b7 write_file', payload: { role: 'coder', tool: 'write_file' } }),
				logEntry({ timestamp: t(24), type: 'tool_result', summary: 'coder \u00b7 write_file result', payload: { role: 'coder', tool: 'write_file', result: 'wrote src/bookings/routes.js' }, detailSections: [{ label: 'result', content: 'wrote src/bookings/routes.js' }] }),
			],
			budgets: budgets({ elapsedSeconds: 25, toolCalls: 3, tokensUsed: 23380, tokenBreakdown: tokenBreakdown(21900, 1480) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), sublabel: 'orchestrator', column: 1, costTime: 25, costTokens: 6920 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder', largeGuildConfig), sublabel: 'coder', column: 2, costTime: 8, costTokens: 9040 }), flowNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file', largeGuildConfig), column: 3, status: 'success', costTime: 3 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'coder', 'call'), flowEdge('coder', 'write_file', 'call'), flowEdge('write_file', 'coder', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), invocations: 1, totalTime: 25, totalTokens: 6920 }), topBarNode({ id: 'architect', kind: 'role', label: roleLabel('architect', largeGuildConfig), invocations: 1, totalTime: 7, totalTokens: 7420, status: 'success' }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder', largeGuildConfig), invocations: 1, totalTime: 8, totalTokens: 9040 }), topBarNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file', largeGuildConfig), invocations: 1 })] },
			),
		}, 25),
		// Frame 10: write_file departed, coder thinking (coder active flag, no flowing edge).
		frame({
			status: 'unknown',
			task: 'Build a full booking system: API, tests, docs, and a security review.',
			startTime: t(0),
			config: largeGuildConfig,
			currentActivity: { role: 'coder', summary: 'coder \u00b7 thinking' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(17), eventCount: 7, llmCalls: 2, toolCalls: 2, recentTools: ['agent'], lastPromptTokens: 3200 }),
				roleActivity({ role: 'architect', firstSeen: t(7), lastSeen: t(13), eventCount: 4, llmCalls: 1, lastPromptTokens: 7100 }),
				roleActivity({ role: 'coder', firstSeen: t(17), lastSeen: t(26), eventCount: 6, llmCalls: 2, toolCalls: 1, recentTools: ['write_file'], lastPromptTokens: 8400 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', active: true })] })],
			recentLog: [
				logEntry({ timestamp: t(24), type: 'tool_result', summary: 'coder \u00b7 write_file result', payload: { role: 'coder', tool: 'write_file' } }),
				logEntry({ timestamp: t(26), type: 'llm_call', summary: 'coder \u00b7 llm call (finish)', payload: { role: 'coder', usage: { promptTokens: 8400, completionTokens: 360, totalTokens: 8760 } }, detailSections: [{ label: 'usage', content: { promptTokens: 8400, completionTokens: 360, totalTokens: 8760 } }] }),
			],
			budgets: budgets({ elapsedSeconds: 26, toolCalls: 3, tokensUsed: 32140, tokenBreakdown: tokenBreakdown(30300, 1840) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), sublabel: 'orchestrator', column: 1, costTime: 26, costTokens: 6920 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder', largeGuildConfig), sublabel: 'coder', column: 2, active: true, costTime: 9, costTokens: 17800 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'coder', 'call')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), invocations: 1, totalTime: 26, totalTokens: 6920 }), topBarNode({ id: 'architect', kind: 'role', label: roleLabel('architect', largeGuildConfig), invocations: 1, totalTime: 7, totalTokens: 7420, status: 'success' }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder', largeGuildConfig), invocations: 1, totalTime: 9, totalTokens: 17800 }), topBarNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file', largeGuildConfig), invocations: 1 })] },
			),
		}, 26),
		// Frame 11: coder returns green to orchestrator (coder status:success, return edge flowing, orchestrator is the return's target).
		frame({
			status: 'unknown',
			task: 'Build a full booking system: API, tests, docs, and a security review.',
			startTime: t(0),
			config: largeGuildConfig,
			currentActivity: { role: 'orchestrator', summary: 'receiving coder success' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(28), eventCount: 8, llmCalls: 2, toolCalls: 2, recentTools: ['agent'], lastPromptTokens: 3200 }),
				roleActivity({ role: 'architect', firstSeen: t(7), lastSeen: t(13), eventCount: 4, llmCalls: 1, lastPromptTokens: 7100 }),
				roleActivity({ role: 'coder', firstSeen: t(17), lastSeen: t(28), eventCount: 7, llmCalls: 2, toolCalls: 1, recentTools: ['write_file'], lastPromptTokens: 8400 }),
			],
			roleTree: [treeNode({ role: 'orchestrator', depth: 0, active: false, children: [treeNode({ role: 'coder', depth: 1, parent: 'orchestrator', status: 'success', summary: 'wrote the booking routes', active: false })] })],
			recentLog: [
				logEntry({ timestamp: t(26), type: 'llm_call', summary: 'coder \u00b7 llm call (finish)', payload: { role: 'coder' } }),
				logEntry({ timestamp: t(28), type: 'role_finished', summary: 'coder \u00b7 finished (success)', payload: { role: 'coder', status: 'success', summary: 'wrote the booking routes' } }),
			],
			budgets: budgets({ elapsedSeconds: 28, toolCalls: 3, tokensUsed: 32140, tokenBreakdown: tokenBreakdown(30300, 1840) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), sublabel: 'orchestrator', column: 1, costTime: 28, costTokens: 6920 }), flowNode({ id: 'coder', kind: 'role', label: roleLabel('coder', largeGuildConfig), sublabel: 'coder', column: 2, status: 'success', costTime: 11, costTokens: 17800 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'coder', 'call'), flowEdge('coder', 'orchestrator', 'return')] },
				{ nodes: [topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }), topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), invocations: 1, totalTime: 28, totalTokens: 6920 }), topBarNode({ id: 'architect', kind: 'role', label: roleLabel('architect', largeGuildConfig), invocations: 1, totalTime: 7, totalTokens: 7420, status: 'success' }), topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder', largeGuildConfig), invocations: 1, totalTime: 11, totalTokens: 17800 }), topBarNode({ id: 'write_file', kind: 'tool', label: toolLabel('write_file', largeGuildConfig), invocations: 1 })] },
			),
		}, 28),
		// Frame 12: coder departed, orchestrator→you return flowing (orchestrator status:success, You is the return's target). The remaining guild roles (researcher, tester, reviewer, documenter, refactorer, security_auditor, context_manager) ran off-screen between coder's finish and the orchestrator's finish, so the top bar now carries the full run history.
		frame({
			status: 'unknown',
			task: 'Build a full booking system: API, tests, docs, and a security review.',
			startTime: t(0),
			config: largeGuildConfig,
			currentActivity: { role: 'orchestrator', summary: 'orchestrator \u00b7 finished (success)' },
			roles: [
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(60), eventCount: 8, llmCalls: 2, toolCalls: 2 }),
				roleActivity({ role: 'architect', firstSeen: t(3), lastSeen: t(13), eventCount: 4, llmCalls: 1 }),
				roleActivity({ role: 'coder', firstSeen: t(11), lastSeen: t(28), eventCount: 8, llmCalls: 2, toolCalls: 1, recentTools: ['write_file'] }),
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
				logEntry({ timestamp: t(48), type: 'role_finished', summary: 'refactorer \u00b7 finished (success)', payload: { role: 'refactorer', status: 'success' } }),
				logEntry({ timestamp: t(58), type: 'role_finished', summary: 'security_auditor \u00b7 finished (success)', payload: { role: 'security_auditor', status: 'success', summary: 'no issues found' } }),
				logEntry({ timestamp: t(60), type: 'role_finished', summary: 'orchestrator \u00b7 finished (success)', payload: { role: 'orchestrator', status: 'success', summary: 'shipped the booking system' } }),
			],
			budgets: budgets({ elapsedSeconds: 60, toolCalls: 9, tokensUsed: 84000, tokenBreakdown: tokenBreakdown(84000, 3200, 12000) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 }), flowNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), sublabel: 'orchestrator', column: 1, status: 'success', costTime: 60, costTokens: 6920 })], edges: [flowEdge('you', 'orchestrator', 'call'), flowEdge('orchestrator', 'you', 'return')] },
				{ nodes: [
					topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }),
					topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), invocations: 1, totalTime: 60, totalTokens: 6920 }),
					topBarNode({ id: 'architect', kind: 'role', label: roleLabel('architect', largeGuildConfig), invocations: 1, totalTime: 7, totalTokens: 7420, status: 'success' }),
					topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder', largeGuildConfig), invocations: 1, totalTime: 11, totalTokens: 17800, status: 'success' }),
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
		// Frame 13: done, only You remains (status:success); everything has departed to the top bar.
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
				roleActivity({ role: 'orchestrator', firstSeen: t(1), lastSeen: t(60), eventCount: 8, llmCalls: 2, toolCalls: 2 }),
				roleActivity({ role: 'architect', firstSeen: t(3), lastSeen: t(13), eventCount: 4, llmCalls: 1 }),
				roleActivity({ role: 'coder', firstSeen: t(11), lastSeen: t(28), eventCount: 8, llmCalls: 2, toolCalls: 1, recentTools: ['write_file'] }),
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
				logEntry({ timestamp: t(60), type: 'role_finished', summary: 'orchestrator \u00b7 finished (success)', payload: { role: 'orchestrator', status: 'success', summary: 'shipped the booking system' } }),
			],
			budgets: budgets({ elapsedSeconds: 60, toolCalls: 9, tokensUsed: 84000, tokenBreakdown: tokenBreakdown(84000, 3200, 12000) }),
			flowModel: flowModel(
				{ nodes: [flowNode({ id: 'you', kind: 'you', label: 'You', column: 0 })], edges: [] },
				{ nodes: [
					topBarNode({ id: 'you', kind: 'you', label: 'You', invocations: 1 }),
					topBarNode({ id: 'orchestrator', kind: 'role', label: roleLabel('orchestrator', largeGuildConfig), invocations: 1, totalTime: 60, totalTokens: 6920, status: 'success' }),
					topBarNode({ id: 'architect', kind: 'role', label: roleLabel('architect', largeGuildConfig), invocations: 1, totalTime: 7, totalTokens: 7420, status: 'success' }),
					topBarNode({ id: 'coder', kind: 'role', label: roleLabel('coder', largeGuildConfig), invocations: 1, totalTime: 11, totalTokens: 17800, status: 'success' }),
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
