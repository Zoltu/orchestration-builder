import type { LogEvent, RunMeta } from '../executor/types.js'
import { deriveInteractionModel } from './interaction-model-adapter.js'
import type { InteractionModel } from './interaction-model-adapter.js'

// Event-stream fixtures the demo harness feeds through the real `deriveInteractionModel` adapter (the same derivation `/api/runs/:id/flow` runs), so the harness exercises the product's `LogEvent → InteractionModel` path rather than authored model frames like `scenarios.js`.
// Each frame is the adapter's output for `events[0..N]` — the model a product poll would see the moment that event had landed.
// Role and tool names match the bundled guild so the label resolver resolves them through `/api/config`.
// The interrupt scenarios author `interrupt` events exactly as the engine emits them for a loop-check handler invocation; the operator-inquiry scenario authors the inquiry-trigger `interrupt` the engine emits when an operator question preempts the run, plus the `observe` event the handler's cross-role inspection tool emits between its tool_call and tool_result. Terminate remains an adapter-only event kind (no current executor tool emits it).
//
// Scrub granularity: every role invocation emits one `llm_call_start` (the "started working" marker that ends the call's transit phase) and emits `llm_call` only after a `tool_result` or a child `role_finished` (where the completion settles the lingering return — a real structural change).
// A plain-turn `llm_call` (dispatch → completion with no return between) or a second `llm_call_start` (the call's transit is already settled) would produce a frame structurally identical to the previous one, so they are omitted to keep each scrub step visually distinct.

export interface DemoScenario {
	id: string
	label: string
	task: string
	events: LogEvent[]
	statuses: RunMeta['status'][]
}

function event(offsetSeconds: number, type: string, payload: unknown): LogEvent {
	// ISO timestamps one second apart so a frame's elapsed reads as a stable, legible count.
	const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, offsetSeconds)).toISOString()
	return { timestamp, type, payload }
}

function buildUsage(promptTokens: number, completionTokens: number): { promptTokens: number; completionTokens: number; totalTokens: number; cachedPromptTokens: number } {
	return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, cachedPromptTokens: 0 }
}

function runningThenTerminal(eventCount: number, terminal: RunMeta['status']): RunMeta['status'][] {
	const statuses: RunMeta['status'][] = new Array(eventCount).fill('running')
	statuses[eventCount - 1] = terminal
	return statuses
}

const singleRoleCompletion: DemoScenario = {
	id: 'single-role-completion',
	label: 'Single-role completion',
	task: 'Write a short greeting.',
	events: [
		event(0, 'role_start', { role: 'coder', depth: 0, task: 'Write a short greeting.' }),
		event(1, 'llm_call_start', { role: 'coder' }),
		event(2, 'role_finished', { role: 'coder', depth: 0, status: 'success', summary: 'Wrote "hello world".' }),
	],
	statuses: runningThenTerminal(3, 'success'),
}

const delegationChain: DemoScenario = {
	id: 'delegation-chain',
	label: 'Delegation chain',
	task: 'Plan and implement a feature.',
	events: [
		event(0, 'role_start', { role: 'orchestrator', depth: 0, task: 'Plan and implement a feature.' }),
		event(1, 'llm_call_start', { role: 'orchestrator' }),
		event(2, 'role_start', { role: 'planner', depth: 1, parent: 'orchestrator', task: 'Plan the approach.' }),
		event(3, 'llm_call_start', { role: 'planner' }),
		event(4, 'role_start', { role: 'coder', depth: 2, parent: 'planner', task: 'Implement it.' }),
		event(5, 'llm_call_start', { role: 'coder' }),
		event(6, 'tool_call', { role: 'coder', tool: 'read_file', arguments: '{"path":"src/main.ts"}' }),
		event(7, 'tool_result', { role: 'coder', tool: 'read_file', kind: 'success', result: { kind: 'success', data: { content: '...' } } }),
		event(8, 'llm_call', { role: 'coder', usage: buildUsage(170, 40) }),
		event(9, 'role_finished', { role: 'coder', depth: 2, status: 'success', summary: 'Implemented.', parent: 'planner' }),
		event(10, 'llm_call', { role: 'planner', usage: buildUsage(140, 25) }),
		event(11, 'role_finished', { role: 'planner', depth: 1, status: 'success', summary: 'Plan done.', parent: 'orchestrator' }),
		event(12, 'llm_call', { role: 'orchestrator', usage: buildUsage(210, 30) }),
		event(13, 'role_finished', { role: 'orchestrator', depth: 0, status: 'success', summary: 'Done.' }),
	],
	statuses: runningThenTerminal(14, 'success'),
}

const deepCallTree: DemoScenario = {
	id: 'deep-call-tree',
	label: 'Deep call tree',
	task: 'Do a deeply nested task.',
	events: [
		event(0, 'role_start', { role: 'orchestrator', depth: 0, task: 'Do a deeply nested task.' }),
		event(1, 'llm_call_start', { role: 'orchestrator' }),
		event(2, 'role_start', { role: 'planner', depth: 1, parent: 'orchestrator', task: 'Plan.' }),
		event(3, 'llm_call_start', { role: 'planner' }),
		event(4, 'role_start', { role: 'coder', depth: 2, parent: 'planner', task: 'Code.' }),
		event(5, 'llm_call_start', { role: 'coder' }),
		event(6, 'role_start', { role: 'critic', depth: 3, parent: 'coder', task: 'Review.' }),
		event(7, 'llm_call_start', { role: 'critic' }),
		event(8, 'role_finished', { role: 'critic', depth: 3, status: 'success', summary: 'Reviewed.', parent: 'coder' }),
		event(9, 'llm_call', { role: 'coder', usage: buildUsage(60, 15) }),
		event(10, 'role_finished', { role: 'coder', depth: 2, status: 'success', summary: 'Coded.', parent: 'planner' }),
		event(11, 'llm_call', { role: 'planner', usage: buildUsage(140, 25) }),
		event(12, 'role_finished', { role: 'planner', depth: 1, status: 'success', summary: 'Planned.', parent: 'orchestrator' }),
		event(13, 'llm_call', { role: 'orchestrator', usage: buildUsage(210, 30) }),
		event(14, 'role_finished', { role: 'orchestrator', depth: 0, status: 'success', summary: 'Done.' }),
	],
	statuses: runningThenTerminal(15, 'success'),
}

const retryWithFreshInstance: DemoScenario = {
	id: 'retry-with-fresh-instance',
	label: 'Retry with a fresh instance',
	task: 'Fix the failing test.',
	events: [
		event(0, 'role_start', { role: 'orchestrator', depth: 0, task: 'Fix the failing test.' }),
		event(1, 'llm_call_start', { role: 'orchestrator' }),
		event(2, 'role_start', { role: 'coder', depth: 1, parent: 'orchestrator', task: 'First attempt.' }),
		event(3, 'llm_call_start', { role: 'coder' }),
		event(4, 'role_finished', { role: 'coder', depth: 1, status: 'error', summary: 'Still failing.', parent: 'orchestrator' }),
		event(5, 'llm_call', { role: 'orchestrator', usage: buildUsage(150, 15) }),
		event(6, 'role_start', { role: 'coder', depth: 1, parent: 'orchestrator', task: 'Second attempt.' }),
		event(7, 'llm_call_start', { role: 'coder' }),
		event(8, 'role_finished', { role: 'coder', depth: 1, status: 'success', summary: 'Fixed.', parent: 'orchestrator' }),
		event(9, 'llm_call', { role: 'orchestrator', usage: buildUsage(210, 20) }),
		event(10, 'role_finished', { role: 'orchestrator', depth: 0, status: 'success', summary: 'Done.' }),
	],
	statuses: runningThenTerminal(11, 'success'),
}

const pendingQuestion: DemoScenario = {
	id: 'pending-question',
	label: 'Pending question',
	task: 'Pick a framework.',
	events: [
		event(0, 'role_start', { role: 'orchestrator', depth: 0, task: 'Pick a framework.' }),
		event(1, 'llm_call_start', { role: 'orchestrator' }),
		event(2, 'ask_human', { id: 'q1', question: 'Which framework should I use?', context: 'src/index.ts' }),
		event(3, 'human_answer', { id: 'q1', answer: 'Use the one already in the repo.' }),
		event(4, 'llm_call', { role: 'orchestrator', usage: buildUsage(160, 20) }),
		event(5, 'role_finished', { role: 'orchestrator', depth: 0, status: 'success', summary: 'Picked the existing framework.' }),
	],
	statuses: ['running', 'running', 'needs_clarification', 'running', 'running', 'success'],
}

const errorReturn: DemoScenario = {
	id: 'error-return',
	label: 'Error return',
	task: 'Do something that fails.',
	events: [
		event(0, 'role_start', { role: 'coder', depth: 0, task: 'Do something that fails.' }),
		event(1, 'llm_call_start', { role: 'coder' }),
		event(2, 'role_finished', { role: 'coder', depth: 0, status: 'error', summary: 'The build failed.' }),
	],
	statuses: runningThenTerminal(3, 'error'),
}

// Interrupt scenarios. The executor emits no interrupt/terminate/observe events yet; the fixtures author them so the demo exercises the adapter's multi-stack handling (each interrupt pushes its own stack, pausing the one below) and the observe/terminate cross-stack references the views already render.
const detectedLoopInterrupt: DemoScenario = {
	id: 'detected-loop-interrupt',
	label: 'Interrupt (detected loop)',
	task: 'Detect whether the coder is looping.',
	events: [
		event(0, 'role_start', { role: 'orchestrator', depth: 0, task: 'Detect whether the coder is looping.' }),
		event(1, 'llm_call_start', { role: 'orchestrator' }),
		event(2, 'role_start', { role: 'coder', depth: 1, parent: 'orchestrator', task: 'Write the file.' }),
		event(3, 'llm_call_start', { role: 'coder' }),
		event(4, 'interrupt', {}),
		event(5, 'role_start', { role: 'loop_detector', depth: 1, task: 'Detect the loop.' }),
		event(6, 'llm_call_start', { role: 'loop_detector' }),
		event(7, 'tool_call', { role: 'loop_detector', tool: 'read_message_window', arguments: '{"role":"coder"}' }),
		event(8, 'observe', { role: 'coder', details: 'peek at the looping coder' }),
		event(9, 'tool_result', { role: 'loop_detector', tool: 'read_message_window', kind: 'success', result: { kind: 'success', data: { messages: 3 } } }),
		event(10, 'llm_call', { role: 'loop_detector', usage: buildUsage(80, 15) }),
		event(11, 'role_finished', { role: 'loop_detector', depth: 1, status: 'success', summary: 'No loop detected.' }),
		event(12, 'tool_call', { role: 'coder', tool: 'read_file', arguments: '{"path":"out.txt"}' }),
		event(13, 'tool_result', { role: 'coder', tool: 'read_file', kind: 'success', result: { kind: 'success', data: { content: 'ok' } } }),
		event(14, 'llm_call', { role: 'coder', usage: buildUsage(120, 30) }),
		event(15, 'role_finished', { role: 'coder', depth: 1, status: 'success', summary: 'Wrote the file.', parent: 'orchestrator' }),
		event(16, 'llm_call', { role: 'orchestrator', usage: buildUsage(210, 25) }),
		event(17, 'role_finished', { role: 'orchestrator', depth: 0, status: 'success', summary: 'Done.' }),
	],
	statuses: runningThenTerminal(18, 'success'),
}

const nestedInterrupt: DemoScenario = {
	id: 'nested-interrupt',
	label: 'Nested interrupt',
	task: 'Interrupt an interrupt.',
	events: [
		event(0, 'role_start', { role: 'orchestrator', depth: 0, task: 'Interrupt an interrupt.' }),
		event(1, 'llm_call_start', { role: 'orchestrator' }),
		event(2, 'role_start', { role: 'coder', depth: 1, parent: 'orchestrator', task: 'Code it.' }),
		event(3, 'llm_call_start', { role: 'coder' }),
		event(4, 'interrupt', {}),
		event(5, 'role_start', { role: 'loop_detector', depth: 1, task: 'Detect outer.' }),
		event(6, 'llm_call_start', { role: 'loop_detector' }),
		event(7, 'interrupt', {}),
		event(8, 'role_start', { role: 'loop_detector', depth: 2, task: 'Detect inner.' }),
		event(9, 'llm_call_start', { role: 'loop_detector' }),
		event(10, 'role_finished', { role: 'loop_detector', depth: 2, status: 'success', summary: 'Inner done.' }),
		event(11, 'role_finished', { role: 'loop_detector', depth: 1, status: 'success', summary: 'Outer done.' }),
		event(12, 'role_finished', { role: 'coder', depth: 1, status: 'success', summary: 'Coded.', parent: 'orchestrator' }),
		event(13, 'llm_call', { role: 'orchestrator', usage: buildUsage(210, 25) }),
		event(14, 'role_finished', { role: 'orchestrator', depth: 0, status: 'success', summary: 'Done.' }),
	],
	statuses: runningThenTerminal(15, 'success'),
}

const rewindFate: DemoScenario = {
	id: 'rewind-fate',
	label: 'Rewind fate',
	task: 'Rewind the looping coder.',
	events: [
		event(0, 'role_start', { role: 'orchestrator', depth: 0, task: 'Rewind the looping coder.' }),
		event(1, 'llm_call_start', { role: 'orchestrator' }),
		event(2, 'role_start', { role: 'coder', depth: 1, parent: 'orchestrator', task: 'Looping work.' }),
		event(3, 'llm_call_start', { role: 'coder' }),
		event(4, 'interrupt', {}),
		event(5, 'role_start', { role: 'loop_detector', depth: 1, task: 'Rewind it.' }),
		event(6, 'llm_call_start', { role: 'loop_detector' }),
		event(7, 'tool_call', { role: 'loop_detector', tool: 'rewind_stack', arguments: '{"target":"coder"}' }),
		event(8, 'terminate', { role: 'coder', details: 'revert the looping coder' }),
		event(9, 'tool_result', { role: 'loop_detector', tool: 'rewind_stack', kind: 'success', result: { kind: 'success', data: { reverted: 1 } } }),
		event(10, 'llm_call', { role: 'loop_detector', usage: buildUsage(80, 15) }),
		event(11, 'role_finished', { role: 'loop_detector', depth: 1, status: 'success', summary: 'Rewound.' }),
		event(12, 'role_start', { role: 'coder', depth: 1, parent: 'orchestrator', task: 'Fresh attempt.' }),
		event(13, 'llm_call_start', { role: 'coder' }),
		event(14, 'interrupt', {}),
		event(15, 'role_start', { role: 'loop_detector', depth: 1, task: 'Check the fresh coder.' }),
		event(16, 'llm_call_start', { role: 'loop_detector' }),
		event(17, 'role_finished', { role: 'loop_detector', depth: 1, status: 'success', summary: 'Fine now.' }),
		event(18, 'role_finished', { role: 'coder', depth: 1, status: 'success', summary: 'Coded.', parent: 'orchestrator' }),
		event(19, 'llm_call', { role: 'orchestrator', usage: buildUsage(210, 25) }),
		event(20, 'role_finished', { role: 'orchestrator', depth: 0, status: 'success', summary: 'Done.' }),
	],
	statuses: runningThenTerminal(21, 'success'),
}

const nestedInterruptDeep: DemoScenario = {
	id: 'nested-interrupt-deep',
	label: 'Nested interrupt (deep, three stacks)',
	task: 'Three stacks with a cross-stack peek.',
	events: [
		event(0, 'role_start', { role: 'orchestrator', depth: 0, task: 'Three stacks with a cross-stack peek.' }),
		event(1, 'llm_call_start', { role: 'orchestrator' }),
		event(2, 'role_start', { role: 'coder', depth: 1, parent: 'orchestrator', task: 'Looping work.' }),
		event(3, 'llm_call_start', { role: 'coder' }),
		event(4, 'interrupt', {}),
		event(5, 'role_start', { role: 'loop_detector', depth: 1, task: 'Detect outer.' }),
		event(6, 'llm_call_start', { role: 'loop_detector' }),
		event(7, 'tool_call', { role: 'loop_detector', tool: 'read_message_window', arguments: '{"role":"coder"}' }),
		event(8, 'interrupt', {}),
		event(9, 'role_start', { role: 'loop_detector', depth: 2, task: 'Detect inner.' }),
		event(10, 'llm_call_start', { role: 'loop_detector' }),
		event(11, 'tool_call', { role: 'loop_detector', tool: 'read_message_window', arguments: '{"role":"coder"}' }),
		event(12, 'observe', { role: 'coder', details: 'peek at the outermost looping coder across the middle stack' }),
		event(13, 'tool_result', { role: 'loop_detector', tool: 'read_message_window', kind: 'success', result: { kind: 'success', data: { messages: 2 } } }),
		event(14, 'llm_call', { role: 'loop_detector', usage: buildUsage(75, 10) }),
		event(15, 'role_finished', { role: 'loop_detector', depth: 2, status: 'success', summary: 'Inner done.' }),
		event(16, 'tool_result', { role: 'loop_detector', tool: 'read_message_window', kind: 'success', result: { kind: 'success', data: { messages: 3 } } }),
		event(17, 'llm_call', { role: 'loop_detector', usage: buildUsage(85, 12) }),
		event(18, 'role_finished', { role: 'loop_detector', depth: 1, status: 'success', summary: 'Outer done.' }),
		event(19, 'tool_call', { role: 'coder', tool: 'read_file', arguments: '{"path":"out.txt"}' }),
		event(20, 'tool_result', { role: 'coder', tool: 'read_file', kind: 'success', result: { kind: 'success', data: { content: 'ok' } } }),
		event(21, 'llm_call', { role: 'coder', usage: buildUsage(120, 25) }),
		event(22, 'role_finished', { role: 'coder', depth: 1, status: 'success', summary: 'Coded.', parent: 'orchestrator' }),
		event(23, 'llm_call', { role: 'orchestrator', usage: buildUsage(210, 25) }),
		event(24, 'role_finished', { role: 'orchestrator', depth: 0, status: 'success', summary: 'Done.' }),
	],
	statuses: runningThenTerminal(25, 'success'),
}

const rewindMultiTerminate: DemoScenario = {
	id: 'rewind-multi-terminate',
	label: 'Rewind (multi-terminate)',
	task: 'Rewind two nested roles.',
	events: [
		event(0, 'role_start', { role: 'orchestrator', depth: 0, task: 'Rewind two nested roles.' }),
		event(1, 'llm_call_start', { role: 'orchestrator' }),
		event(2, 'role_start', { role: 'planner', depth: 1, parent: 'orchestrator', task: 'Plan.' }),
		event(3, 'llm_call_start', { role: 'planner' }),
		event(4, 'role_start', { role: 'coder', depth: 2, parent: 'planner', task: 'Code.' }),
		event(5, 'llm_call_start', { role: 'coder' }),
		event(6, 'interrupt', {}),
		event(7, 'role_start', { role: 'loop_detector', depth: 1, task: 'Rewind.' }),
		event(8, 'llm_call_start', { role: 'loop_detector' }),
		event(9, 'tool_call', { role: 'loop_detector', tool: 'rewind_stack', arguments: '{"target":"coder"}' }),
		event(10, 'terminate', { role: 'coder', details: 'revert the looping coder' }),
		event(11, 'terminate', { role: 'planner', details: 'revert the planner that delegated to it' }),
		event(12, 'tool_result', { role: 'loop_detector', tool: 'rewind_stack', kind: 'success', result: { kind: 'success', data: { reverted: 2 } } }),
		event(13, 'llm_call', { role: 'loop_detector', usage: buildUsage(80, 15) }),
		event(14, 'role_finished', { role: 'loop_detector', depth: 1, status: 'success', summary: 'Rewound.' }),
		event(15, 'interrupt', {}),
		event(16, 'role_start', { role: 'loop_detector', depth: 1, task: 'Check the teardown.' }),
		event(17, 'llm_call_start', { role: 'loop_detector' }),
		event(18, 'role_finished', { role: 'loop_detector', depth: 1, status: 'success', summary: 'Clean.' }),
		event(19, 'role_start', { role: 'coder', depth: 1, parent: 'orchestrator', task: 'Fresh attempt.' }),
		event(20, 'llm_call_start', { role: 'coder' }),
		event(21, 'tool_call', { role: 'coder', tool: 'read_file', arguments: '{"path":"out.txt"}' }),
		event(22, 'interrupt', {}),
		event(23, 'role_start', { role: 'loop_detector', depth: 1, task: 'Check progress.' }),
		event(24, 'llm_call_start', { role: 'loop_detector' }),
		event(25, 'role_finished', { role: 'loop_detector', depth: 1, status: 'success', summary: 'Fine.' }),
		event(26, 'tool_result', { role: 'coder', tool: 'read_file', kind: 'success', result: { kind: 'success', data: { content: 'ok' } } }),
		event(27, 'llm_call', { role: 'coder', usage: buildUsage(120, 25) }),
		event(28, 'role_finished', { role: 'coder', depth: 1, status: 'success', summary: 'Coded.', parent: 'orchestrator' }),
		event(29, 'llm_call', { role: 'orchestrator', usage: buildUsage(210, 25) }),
		event(30, 'role_finished', { role: 'orchestrator', depth: 0, status: 'success', summary: 'Done.' }),
	],
	statuses: runningThenTerminal(31, 'success'),
}

const terminateFate: DemoScenario = {
	id: 'terminate-fate',
	label: 'Terminate fate',
	task: 'Discard the whole task.',
	events: [
		event(0, 'role_start', { role: 'orchestrator', depth: 0, task: 'Discard the whole task.' }),
		event(1, 'llm_call_start', { role: 'orchestrator' }),
		event(2, 'role_start', { role: 'coder', depth: 1, parent: 'orchestrator', task: 'Looping work.' }),
		event(3, 'llm_call_start', { role: 'coder' }),
		event(4, 'interrupt', {}),
		event(5, 'role_start', { role: 'loop_detector', depth: 1, task: 'Terminate the task.' }),
		event(6, 'llm_call_start', { role: 'loop_detector' }),
		event(7, 'tool_call', { role: 'loop_detector', tool: 'terminate_task', arguments: '{}' }),
		event(8, 'terminate', { role: 'coder', details: 'discard the looping coder' }),
		event(9, 'terminate', { role: 'orchestrator', details: 'discard the orchestrator' }),
		event(10, 'tool_result', { role: 'loop_detector', tool: 'terminate_task', kind: 'success', result: { kind: 'success', data: { terminated: 2 } } }),
		event(11, 'llm_call', { role: 'loop_detector', usage: buildUsage(80, 15) }),
		event(12, 'role_finished', { role: 'loop_detector', depth: 1, status: 'success', summary: 'Terminated.' }),
	],
	statuses: runningThenTerminal(13, 'success'),
}

const operatorInquiry: DemoScenario = {
	id: 'operator-inquiry',
	label: 'Operator inquiry',
	task: 'Build the care-guide website.',
	events: [
		event(0, 'role_start', { role: 'orchestrator', depth: 0, task: 'Build the care-guide website.' }),
		event(1, 'llm_call_start', { role: 'orchestrator' }),
		event(2, 'role_start', { role: 'coder', depth: 1, parent: 'orchestrator', task: 'Write the care-guide page.' }),
		event(3, 'llm_call_start', { role: 'coder' }),
		event(4, 'tool_call', { role: 'coder', tool: 'write_file', arguments: '{"path":"care-guide.html","content":"..."}' }),
		event(5, 'tool_result', { role: 'coder', tool: 'write_file', kind: 'success', result: { kind: 'success', data: { path: 'care-guide.html', bytes: 512 } } }),
		// The operator's question preempts the run: a fresh stack rooted at the human asker, handled by the inquiry responder while the coder's write_file return leg lingers on the paused main stack.
		event(6, 'interrupt', { trigger: 'inquiry', handler: 'inquiry_responder', target: 'coder-1-2', message: 'What is the coder working on?' }),
		event(7, 'role_start', { role: 'inquiry_responder', depth: 2, parent: 'coder', task: 'Answer the operator’s question — “What is the coder working on?” — by inspecting the paused run, then finish with the answer as your summary.' }),
		event(8, 'llm_call_start', { role: 'inquiry_responder' }),
		event(9, 'tool_call', { role: 'inquiry_responder', tool: 'read_message_window', arguments: '{"targetRole":"coder-1-2","index":4,"field":"content","start":0,"end":200}' }),
		// The cross-role inspection tool read the paused coder: the engine emits the observe between the tool_call and its tool_result.
		event(10, 'observe', { role: 'coder', roleId: 'coder-1-2', details: 'read_message_window' }),
		event(11, 'tool_result', { role: 'inquiry_responder', tool: 'read_message_window', kind: 'success', result: { kind: 'success', data: { targetRole: 'coder-1-2', totalChars: 200, text: '…verifying care-guide.html…' } } }),
		event(12, 'llm_call', { role: 'inquiry_responder', usage: buildUsage(90, 20) }),
		// The handler's finish-card summary is the answer; the interrupt_resolved event itself changes no model structure, so it is omitted like every interrupt fixture's resolution.
		event(13, 'role_finished', { role: 'inquiry_responder', depth: 2, status: 'success', summary: 'The coder is writing the care-guide page; it just saved care-guide.html and is verifying it now.', parent: 'coder' }),
		event(14, 'tool_call', { role: 'coder', tool: 'read_file', arguments: '{"path":"care-guide.html"}' }),
		event(15, 'tool_result', { role: 'coder', tool: 'read_file', kind: 'success', result: { kind: 'success', data: { content: 'ok' } } }),
		event(16, 'llm_call', { role: 'coder', usage: buildUsage(120, 30) }),
		event(17, 'role_finished', { role: 'coder', depth: 1, status: 'success', summary: 'Wrote care-guide.html.', parent: 'orchestrator' }),
		event(18, 'llm_call', { role: 'orchestrator', usage: buildUsage(210, 25) }),
		event(19, 'role_finished', { role: 'orchestrator', depth: 0, status: 'success', summary: 'Done.' }),
	],
	statuses: runningThenTerminal(20, 'success'),
}

export const DEMO_SCENARIOS: DemoScenario[] = [
	singleRoleCompletion,
	delegationChain,
	deepCallTree,
	retryWithFreshInstance,
	pendingQuestion,
	operatorInquiry,
	detectedLoopInterrupt,
	nestedInterrupt,
	rewindFate,
	nestedInterruptDeep,
	rewindMultiTerminate,
	terminateFate,
	errorReturn,
]

export function findDemoScenario(scenarioId: string): DemoScenario | undefined {
	for (const scenario of DEMO_SCENARIOS) {
		if (scenario.id === scenarioId) return scenario
	}
	return undefined
}

// The adapter consumes only a DemoScenario's `status`, so a minimal meta keyed off the frame's per-event status is enough; the synthetic ids keep the RunMeta shape valid without inventing run-bookkeeping the demo does not model.
function demoScenarioMeta(scenario: DemoScenario, frameIndex: number): RunMeta {
	const status = scenario.statuses[frameIndex] ?? 'running'
	const firstEvent = scenario.events[0]
	if (firstEvent === undefined) throw new Error(`demo scenario "${scenario.id}" has no events`)
	return {
		runId: `demo-${scenario.id}`,
		guildPath: 'demo',
		benchmarkPath: 'demo',
		task: scenario.task,
		status,
		startTime: firstEvent.timestamp,
	}
}

// One demo frame: the adapter's output over the scenario's first `frameIndex + 1` events — the model a product poll would see the moment that event landed.
// The terminal frame is derived as if the run were still active and then stamped with the fixture's terminal status: a real run writes its terminal meta only after the final role_finished lands in the log (docs/reference.md "Run lifecycle"), so the last observable state of a finished run carries the final return still in flight — its lingering leg to You renders until the See Result click stands in as You's acknowledgment and settles it (docs/visualization.md "The two views").
export function deriveDemoFrameModel(scenario: DemoScenario, frameIndex: number): InteractionModel {
	const events = scenario.events.slice(0, frameIndex + 1)
	const meta = demoScenarioMeta(scenario, frameIndex)
	const frameEvent = scenario.events[frameIndex]
	if (frameEvent === undefined) throw new Error(`demo scenario "${scenario.id}" has no frame ${frameIndex}`)
	const now = frameEvent.timestamp
	if (frameIndex !== scenario.events.length - 1) {
		return deriveInteractionModel({ meta, logEvents: events }, now)
	}
	const model = deriveInteractionModel({ meta: { ...meta, status: 'running' }, logEvents: events }, now)
	return { ...model, status: meta.status }
}
