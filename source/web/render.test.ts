import { describe, expect, test } from 'bun:test'
import type { PendingQuestion } from '../executor/human-backend.js'
import type { DeploymentConfig, GuildConfig, RunMeta } from '../executor/types.js'
import { parseLogEvents, parseRunMeta, type RunSnapshot } from '../run-log/index.js'
import { renderConfig, renderPendingQuestions, renderProjectSettings, renderRunSummary, renderRunView } from './render.ts'
import { defined, present } from './test-fixtures.js'

function logEvent(type: string, role: string, timestamp: string, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ timestamp, type, payload: { role, ...extra } })
}

function askHumanEvent(id: string, question: string, timestamp: string, context?: string): string {
	const payload: Record<string, unknown> = { id, question }
	if (context !== undefined) payload['context'] = context
	return JSON.stringify({ timestamp, type: 'ask_human', payload })
}

function humanAnswerEvent(id: string, answer: string, timestamp: string): string {
	return JSON.stringify({ timestamp, type: 'human_answer', payload: { id, answer } })
}

function sampleRunMeta(overrides: Partial<RunMeta> = {}): RunMeta {
	return {
		runId: 'run-1',
		guildPath: 'guild',
		benchmarkPath: 'bench',
		task: 'fix the bug',
		status: 'success',
		startTime: '2026-01-01T00:00:00.000Z',
		endTime: '2026-01-01T00:01:00.000Z',
		...overrides,
	}
}

function parseSnapshot(raw: { metaText: string | null, logText: string }): RunSnapshot {
	return { meta: parseRunMeta(raw.metaText), logEvents: parseLogEvents(raw.logText) }
}

describe('renderRunView', () => {
	test('shapes a completed run from its meta and log', () => {
		const snapshot = parseSnapshot({
			metaText: JSON.stringify(sampleRunMeta()),
			logText: [
				logEvent('llm_call', 'planner', '2026-01-01T00:00:01.000Z'),
				logEvent('role_finished', 'planner', '2026-01-01T00:00:02.000Z', { status: 'success' }),
			].join('\n'),
		})

		const view = renderRunView(snapshot, { maxLogLines: 200 })
		expect(view.status).toBe('success')
		expect(view.runId).toBe('run-1')
		expect(view.task).toBe('fix the bug')
		expect(view.startTime).toBe('2026-01-01T00:00:00.000Z')
		expect(view.endTime).toBe('2026-01-01T00:01:00.000Z')
		expect(view.roles.length).toBe(1)
		expect(defined(view.roles[0], 'view.roles[0]').role).toBe('planner')
		expect(view.recentLog.length).toBe(2)
		expect(view.budgets).toEqual({ elapsedSeconds: 60, toolCalls: 0, tokensUsed: null, tokenBreakdown: null })
	})

	test('reports unknown status when meta is absent (run in progress)', () => {
		const snapshot = parseSnapshot({ metaText: null, logText: logEvent('llm_call', 'planner', 't1') })
		const view = renderRunView(snapshot, { maxLogLines: 200 })
		expect(view.status).toBe('unknown')
		expect(view.runId).toBeNull()
		expect(view.task).toBeNull()
		expect(view.result).toBeNull()
		expect(view.roles.length).toBe(1)
	})

	test('surfaces the run effort from meta.effort, or null when meta is absent or carries no effort', () => {
		const withEffort = parseSnapshot({
			metaText: JSON.stringify(sampleRunMeta({ effort: 'thorough' })),
			logText: '',
		})
		expect(renderRunView(withEffort, { maxLogLines: 200 }).effort).toBe('thorough')

		const withoutEffort = parseSnapshot({ metaText: JSON.stringify(sampleRunMeta()), logText: '' })
		expect(renderRunView(withoutEffort, { maxLogLines: 200 }).effort).toBeNull()

		const inProgress = parseSnapshot({ metaText: null, logText: '' })
		expect(renderRunView(inProgress, { maxLogLines: 200 }).effort).toBeNull()
	})

	test('surfaces the run involvement from meta.involvement, or null when meta is absent or carries none', () => {
		const withInvolvement = parseSnapshot({
			metaText: JSON.stringify(sampleRunMeta({ involvement: 'collaborative' })),
			logText: '',
		})
		expect(renderRunView(withInvolvement, { maxLogLines: 200 }).involvement).toBe('collaborative')

		const withoutInvolvement = parseSnapshot({ metaText: JSON.stringify(sampleRunMeta()), logText: '' })
		expect(renderRunView(withoutInvolvement, { maxLogLines: 200 }).involvement).toBeNull()

		const inProgress = parseSnapshot({ metaText: null, logText: '' })
		expect(renderRunView(inProgress, { maxLogLines: 200 }).involvement).toBeNull()
	})

	test('surfaces the run lineage from meta.continuesFrom, or null when absent or meta is missing', () => {
		const continuation = parseSnapshot({
			metaText: JSON.stringify(sampleRunMeta({ continuesFrom: 'run-20260101-000000' })),
			logText: '',
		})
		expect(renderRunView(continuation, { maxLogLines: 200 }).continuesFrom).toBe('run-20260101-000000')

		const standalone = parseSnapshot({ metaText: JSON.stringify(sampleRunMeta()), logText: '' })
		expect(renderRunView(standalone, { maxLogLines: 200 }).continuesFrom).toBeNull()

		const inProgress = parseSnapshot({ metaText: null, logText: '' })
		expect(renderRunView(inProgress, { maxLogLines: 200 }).continuesFrom).toBeNull()
	})

	test('resumable is true only for an error meta the caller found a checkpoint file for', () => {
		const errored = parseSnapshot({ metaText: JSON.stringify(sampleRunMeta({ status: 'error' })), logText: '' })
		expect(renderRunView(errored, { maxLogLines: 200, checkpointExists: true }).resumable).toBe(true)
		expect(renderRunView(errored, { maxLogLines: 200, checkpointExists: false }).resumable).toBe(false)
		expect(renderRunView(errored, { maxLogLines: 200 }).resumable).toBe(false)

		const succeeded = parseSnapshot({ metaText: JSON.stringify(sampleRunMeta()), logText: '' })
		expect(renderRunView(succeeded, { maxLogLines: 200, checkpointExists: true }).resumable).toBe(false)

		const missingMeta = parseSnapshot({ metaText: null, logText: '' })
		expect(renderRunView(missingMeta, { maxLogLines: 200, checkpointExists: true }).resumable).toBe(false)
	})

	test('carries the raw plan markdown through to the view, or null when the caller read none', () => {
		const snapshot = parseSnapshot({ metaText: JSON.stringify(sampleRunMeta()), logText: '' })
		expect(renderRunView(snapshot, { maxLogLines: 200, plan: '# Plan\n\nstep one' }).plan).toBe('# Plan\n\nstep one')
		expect(renderRunView(snapshot, { maxLogLines: 200, plan: null }).plan).toBeNull()
		expect(renderRunView(snapshot, { maxLogLines: 200 }).plan).toBeNull()
	})

	test('truncates the recent log to the last maxLogLines events', () => {
		const lines: string[] = []
		for (let i = 0; i < 10; i++) {
			lines.push(logEvent('llm_call', 'planner', `t${i}`))
		}
		const snapshot = parseSnapshot({ metaText: null, logText: lines.join('\n') })

		const view = renderRunView(snapshot, { maxLogLines: 3 })
		expect(view.recentLog.length).toBe(3)
		expect(defined(view.recentLog[0], 'view.recentLog[0]').timestamp).toBe('t7')
		expect(defined(view.recentLog[2], 'view.recentLog[2]').timestamp).toBe('t9')
	})

	test('uses the full log when fewer than maxLogLines events exist', () => {
		const snapshot = parseSnapshot({
			metaText: null,
			logText: logEvent('llm_call', 'planner', 't1'),
		})
		const view = renderRunView(snapshot, { maxLogLines: 200 })
		expect(view.recentLog.length).toBe(1)
	})

	test('result is null when the meta has no result field', () => {
		const snapshot = parseSnapshot({
			metaText: JSON.stringify(sampleRunMeta({ result: undefined })),
			logText: '',
		})
		const view = renderRunView(snapshot, { maxLogLines: 200 })
		expect(view.result).toBeNull()
	})

	test('the result card passes through verbatim, including an error card\u2019s technical detail', () => {
		const card = { status: 'error' as const, summary: 'LLM unavailable: HTTP 402', error: { kind: 'llm_unavailable' as const, message: 'HTTP 402' }, detail: '{"error":"Insufficient credit"}' }
		const snapshot = parseSnapshot({
			metaText: JSON.stringify(sampleRunMeta({ status: 'error', result: card })),
			logText: '',
		})
		const view = renderRunView(snapshot, { maxLogLines: 200 })
		expect(view.result).toEqual(card)
	})

	test('recentLog entries carry the log-wide index and the one-line text, with no payload or detail sections', () => {
		const snapshot = parseSnapshot({
			metaText: null,
			logText: [
				logEvent('llm_call', 'planner', 't1'),
				logEvent('tool_call', 'planner', 't2', { tool: 'agent' }),
			].join('\n'),
		})

		const view = renderRunView(snapshot, { maxLogLines: 200 })
		expect(view.recentLog.length).toBe(2)
		expect(view.recentLog[0]).toEqual({
			index: 0,
			timestamp: 't1',
			type: 'llm_call',
			text: 'planner · llm call',
		})
		expect(defined(view.recentLog[1], 'view.recentLog[1]').text).toBe('planner · agent')
		expect(defined(view.recentLog[1], 'view.recentLog[1]').index).toBe(1)
	})

	test('recentLog indices are log-wide: a truncated window starts above zero', () => {
		const lines: string[] = []
		for (let i = 0; i < 10; i++) {
			lines.push(logEvent('llm_call', 'planner', `t${i}`))
		}
		const snapshot = parseSnapshot({ metaText: null, logText: lines.join('\n') })

		const view = renderRunView(snapshot, { maxLogLines: 3 })
		expect(view.recentLog.map((entry) => entry.index)).toEqual([7, 8, 9])
	})

	test('error is null while a run is in progress', () => {
		const snapshot = parseSnapshot({ metaText: null, logText: '' })
		const view = renderRunView(snapshot, { maxLogLines: 200 })
		expect(view.error).toBeNull()
	})

	test('error is null when a completed run has no error', () => {
		const snapshot = parseSnapshot({ metaText: JSON.stringify(sampleRunMeta()), logText: '' })
		const view = renderRunView(snapshot, { maxLogLines: 200 })
		expect(view.error).toBeNull()
	})

	test('error surfaces the kind and message of a failed run', () => {
		const snapshot = parseSnapshot({
			metaText: JSON.stringify(sampleRunMeta({
				status: 'error',
				error: { kind: 'llm_unavailable', message: 'connection refused' },
			})),
			logText: '',
		})

		const view = renderRunView(snapshot, { maxLogLines: 200 })
		expect(view.error).toEqual({ kind: 'llm_unavailable', message: 'connection refused' })
	})

	test('currentActivity reflects the most recent event role and summary', () => {
		const snapshot = parseSnapshot({
			metaText: null,
			logText: [
				logEvent('llm_call', 'planner', 't1'),
				logEvent('tool_call', 'coder', 't2', { tool: 'write_file' }),
			].join('\n'),
		})

		const view = renderRunView(snapshot, { maxLogLines: 200 })
		expect(view.currentActivity).toEqual({ role: 'coder', summary: 'coder · write_file' })
	})

	test('currentActivity is null for an empty log', () => {
		const snapshot = parseSnapshot({ metaText: null, logText: '' })
		const view = renderRunView(snapshot, { maxLogLines: 200 })
		expect(view.currentActivity).toBeNull()
	})

	test('roleTree is null when the log carries no role_start/role_finished/agent_call events', () => {
		const snapshot = parseSnapshot({
			metaText: null,
			logText: [
				logEvent('llm_call', 'planner', 't1'),
				logEvent('tool_call', 'planner', 't2', { tool: 'finish' }),
			].join('\n'),
		})
		const view = renderRunView(snapshot, { maxLogLines: 200 })
		expect(view.roleTree).toBeNull()
		expect(view.roles.length).toBe(1)
	})

	test('roleTree surfaces a parent→child tree when role_start/role_finished events are present', () => {
		const snapshot = parseSnapshot({
			metaText: null,
			logText: [
				JSON.stringify({ timestamp: 't1', type: 'role_start', payload: { role: 'orchestrator', depth: 0, task: 't' } }),
				JSON.stringify({ timestamp: 't2', type: 'agent_call', payload: { parent: 'orchestrator', child: 'coder', depth: 1 } }),
				JSON.stringify({ timestamp: 't3', type: 'role_start', payload: { role: 'coder', depth: 1, parent: 'orchestrator', task: 'code' } }),
				JSON.stringify({ timestamp: 't4', type: 'role_finished', payload: { role: 'coder', depth: 1, status: 'success', parent: 'orchestrator' } }),
				JSON.stringify({ timestamp: 't5', type: 'role_finished', payload: { role: 'orchestrator', depth: 0, status: 'success' } }),
			].join('\n'),
		})
		const view = renderRunView(snapshot, { maxLogLines: 200 })
		expect(view.roleTree).not.toBeNull()
		const roleTree = present(view.roleTree, 'view.roleTree')
		expect(roleTree.length).toBe(1)
		const rootNode = defined(roleTree[0], 'roleTree[0]')
		expect(rootNode.role).toBe('orchestrator')
		expect(rootNode.children.length).toBe(1)
		expect(defined(rootNode.children[0], 'rootNode.children[0]').role).toBe('coder')
	})

	test('questionHistory pairs ask_human events with their human_answer events', () => {
		const snapshot = parseSnapshot({
			metaText: null,
			logText: [
				askHumanEvent('q1', 'Which file?', 't1', 'src/index.ts'),
				humanAnswerEvent('q1', 'src/index.ts', 't2'),
				askHumanEvent('q2', 'What next?', 't3'),
			].join('\n'),
		})

		const view = renderRunView(snapshot, { maxLogLines: 200 })
		expect(view.questionHistory.length).toBe(2)
		expect(view.questionHistory[0]).toEqual({
			id: 'q1',
			question: 'Which file?',
			context: 'src/index.ts',
			askedAt: 't1',
			answer: 'src/index.ts',
			answeredAt: 't2',
		})
		expect(view.questionHistory[1]).toEqual({
			id: 'q2',
			question: 'What next?',
			askedAt: 't3',
		})
	})

	test('questionHistory is empty for a log with no ask_human events', () => {
		const snapshot = parseSnapshot({
			metaText: null,
			logText: [
				logEvent('llm_call', 'planner', 't1'),
				logEvent('role_finished', 'planner', 't2', { status: 'success' }),
			].join('\n'),
		})

		const view = renderRunView(snapshot, { maxLogLines: 200 })
		expect(view.questionHistory).toEqual([])
	})

	test('two renders of the same snapshot are deeply equal — the payload is clock-independent', () => {
		// The run view feeds an ETag over stored data, so two derivations at different wall-clock moments must serialize identically.
		const snapshot = parseSnapshot({
			metaText: JSON.stringify(sampleRunMeta({ startTime: '2026-01-01T00:00:00.000Z', endTime: '2026-01-01T00:01:00.000Z' })),
			logText: [
				logEvent('llm_call', 'planner', '2026-01-01T00:00:01.000Z'),
				logEvent('role_finished', 'planner', '2026-01-01T00:00:02.000Z', { status: 'success' }),
			].join('\n'),
		})
		const first = renderRunView(snapshot, { maxLogLines: 200 })
		const second = renderRunView(snapshot, { maxLogLines: 200 })
		expect(second).toEqual(first)
		// An in-progress run (no stored endTime) reports null elapsed, not a clock-derived figure.
		const inProgress = parseSnapshot({ metaText: JSON.stringify(sampleRunMeta({ startTime: '2026-01-01T00:00:00.000Z', endTime: undefined })), logText: '' })
		expect(renderRunView(inProgress, { maxLogLines: 200 }).budgets.elapsedSeconds).toBeNull()
	})
})

describe('renderRunSummary', () => {
	test('shapes a completed run from its meta, taking runId from the directory name', () => {
		const meta = parseRunMeta(JSON.stringify(sampleRunMeta({ runId: 'on-disk-id' })))

		const summary = renderRunSummary('dir-name', meta, null)
		expect(summary).toEqual({
			runId: 'dir-name',
			status: 'success',
			task: 'fix the bug',
			effort: null,
			involvement: null,
			startTime: '2026-01-01T00:00:00.000Z',
			endTime: '2026-01-01T00:01:00.000Z',
			result: null,
			error: null,
			continuesFrom: null,
			summary: null,
		})
	})

	test('reports unknown status and null fields when meta is absent (run in progress)', () => {
		const summary = renderRunSummary('run-in-progress', parseRunMeta(null), null)
		expect(summary).toEqual({
			runId: 'run-in-progress',
			status: 'unknown',
			task: null,
			effort: null,
			involvement: null,
			startTime: null,
			endTime: null,
			result: null,
			error: null,
			continuesFrom: null,
			summary: null,
		})
	})

	test('endTime is null when the meta omits it', () => {
		const meta = parseRunMeta(JSON.stringify(sampleRunMeta({ endTime: undefined })))

		const summary = renderRunSummary('r', meta, null)
		expect(summary.endTime).toBeNull()
	})

	test('carries the run effort from meta.effort', () => {
		const meta = parseRunMeta(JSON.stringify(sampleRunMeta({ effort: 'thorough' })))
		expect(renderRunSummary('r', meta, null).effort).toBe('thorough')
	})

	test('carries the run involvement from meta.involvement, or null when absent', () => {
		const meta = parseRunMeta(JSON.stringify(sampleRunMeta({ involvement: 'collaborative' })))
		expect(renderRunSummary('r', meta, null).involvement).toBe('collaborative')
		expect(renderRunSummary('r', parseRunMeta(JSON.stringify(sampleRunMeta())), null).involvement).toBeNull()
	})

	test('carries the run lineage from meta.continuesFrom, or null when absent or meta is missing', () => {
		const continuation = parseRunMeta(JSON.stringify(sampleRunMeta({ continuesFrom: 'run-20260101-000000' })))
		expect(renderRunSummary('r', continuation, null).continuesFrom).toBe('run-20260101-000000')

		const standalone = parseRunMeta(JSON.stringify(sampleRunMeta()))
		expect(renderRunSummary('r', standalone, null).continuesFrom).toBeNull()

		expect(renderRunSummary('r', parseRunMeta(null), null).continuesFrom).toBeNull()
	})

	test('passes the result card and run-level error through so the history view can browse outcomes', () => {
		const meta = parseRunMeta(JSON.stringify(sampleRunMeta({
			result: { status: 'success', summary: 'fixed it', artifacts: ['a.ts'] },
			error: { kind: 'llm_unavailable', message: 'endpoint down' },
		})))
		const summary = renderRunSummary('r', meta, null)
		expect(summary.result).toEqual({ status: 'success', summary: 'fixed it', artifacts: ['a.ts'] })
		expect(summary.error).toEqual({ kind: 'llm_unavailable', message: 'endpoint down' })
	})

	test('passes an error card\u2019s technical detail through to the history summary', () => {
		const meta = parseRunMeta(JSON.stringify(sampleRunMeta({
			status: 'error',
			result: { status: 'error', summary: 'LLM unavailable: HTTP 402', error: { kind: 'llm_unavailable', message: 'HTTP 402' }, detail: '{"error":"Insufficient credit"}' },
		})))
		expect(renderRunSummary('r', meta, null).result?.detail).toBe('{"error":"Insufficient credit"}')
	})

	test('carries the generated one-line summary through to the client', () => {
		const meta = parseRunMeta(JSON.stringify(sampleRunMeta()))
		expect(renderRunSummary('r', meta, 'Fixed the login bug').summary).toBe('Fixed the login bug')
		expect(renderRunSummary('r', meta, null).summary).toBeNull()
	})
})

describe('renderProjectSettings', () => {
	test('returns all fields null when no default has been set', () => {
		expect(renderProjectSettings({})).toEqual({ effort: null, involvement: null, logLevel: null })
	})

	test('returns the stored values when set', () => {
		expect(renderProjectSettings({ effort: 'thorough', involvement: 'collaborative', logLevel: 'standard' })).toEqual({ effort: 'thorough', involvement: 'collaborative', logLevel: 'standard' })
	})

	test('returns exactly the effort, involvement, and logLevel fields in its output shape', () => {
		expect(Object.keys(renderProjectSettings({ effort: 'quick', involvement: 'autonomous', logLevel: 'full' }))).toEqual(['effort', 'involvement', 'logLevel'])
	})
})

describe('renderPendingQuestions', () => {
	test('shapes each pending question preserving order', () => {
		const questions: PendingQuestion[] = [
			{ id: 'q1', question: 'Which file?', context: 'src/index.ts', askedAt: 't1' },
			{ id: 'q2', question: 'What next?', askedAt: 't2' },
		]

		const shaped = renderPendingQuestions(questions)
		expect(shaped).toEqual([
			{ id: 'q1', question: 'Which file?', context: 'src/index.ts', askedAt: 't1' },
			{ id: 'q2', question: 'What next?', askedAt: 't2' },
		])
	})

	test('omits context when undefined', () => {
		const shaped = renderPendingQuestions([{ id: 'q1', question: 'q?', askedAt: 't1' }])
		expect(shaped[0]).not.toHaveProperty('context')
	})

	test('returns an empty array for no pending questions', () => {
		expect(renderPendingQuestions([])).toEqual([])
	})
})

function sampleGuildConfig(overrides: Partial<GuildConfig> = {}): GuildConfig {
	return {
		entryRole: 'orchestrator',
		roles: {
			orchestrator: { systemPrompt: 'prompts/orchestrator.md', tools: ['agent', 'ask_human', 'finish'] },
			coder: { systemPrompt: 'prompts/coder.md', tools: ['read_file', 'write_file', 'finish'] },
		},
		tools: ['tools/agent.json', 'tools/finish.json'],
		...overrides,
	}
}

function sampleDeployment(overrides: Partial<DeploymentConfig> = {}): DeploymentConfig {
	return {
		model: {
			name: 'qwen3.6:35b',
			apiBase: 'http://llama-server:8080/v1',
			contextWindow: 262144,
			generation: { temperature: 0.2, maxTokens: 32768 },
		},
		executor: {
			maxAgentDepth: 8,
			defaultToolTimeoutSeconds: 30,
			maxCompactionAttempts: 5,
		},
		contextPolicy: { maxToolOutputChars: 8000 },
		...overrides,
	}
}

describe('renderConfig', () => {
	test('shapes the model name and context window, executor budgets, entry role, and role tool lists', () => {
		const view = renderConfig(sampleGuildConfig(), sampleDeployment(), {}, null)
		expect(view.model).toEqual({ name: 'qwen3.6:35b', contextWindow: 262144 })
		expect(view.executor).toEqual({
			maxAgentDepth: 8,
			defaultToolTimeoutSeconds: 30,
			maxCompactionAttempts: 5,
		})
		expect(view.entryRole).toBe('orchestrator')
		expect(view.roles).toEqual({
			orchestrator: { tools: ['agent', 'ask_human', 'finish'] },
			coder: { tools: ['read_file', 'write_file', 'finish'] },
		})
	})

	test('structurally omits apiKey and apiBase from the view', () => {
		const view = renderConfig(sampleGuildConfig(), sampleDeployment(), {}, null)
		expect(view.model).not.toHaveProperty('apiKey')
		expect(view.model).not.toHaveProperty('apiBase')
		const serialized = JSON.stringify(view)
		expect(serialized).not.toContain('secret-key')
		expect(serialized).not.toContain('llama-server')
	})

	test('omits empty roles', () => {
		const config = sampleGuildConfig({
			roles: {
				orchestrator: { systemPrompt: 'p', tools: ['finish'] },
				empty: { systemPrompt: 'p', tools: [] },
			},
		})
		const view = renderConfig(config, sampleDeployment(), {}, null)
		expect(Object.keys(view.roles).sort()).toEqual(['empty', 'orchestrator'])
		expect(defined(view.roles.orchestrator, 'view.roles.orchestrator').tools).toEqual(['finish'])
		expect(defined(view.roles.empty, 'view.roles.empty').tools).toEqual([])
	})

	test('includes every role declared in the Guild with its full tool list', () => {
		const config = sampleGuildConfig({
			roles: {
				orchestrator: { systemPrompt: 'p', tools: ['agent', 'finish'] },
				planner: { systemPrompt: 'p', tools: ['read_file', 'glob_files', 'search_text', 'finish'] },
				empty: { systemPrompt: 'p', tools: [] },
			},
		})
		const view = renderConfig(config, sampleDeployment(), {}, null)
		expect(Object.keys(view.roles).sort()).toEqual(['empty', 'orchestrator', 'planner'])
		expect(defined(view.roles.orchestrator, 'view.roles.orchestrator').tools).toEqual(['agent', 'finish'])
		expect(defined(view.roles.planner, 'view.roles.planner').tools).toEqual(['read_file', 'glob_files', 'search_text', 'finish'])
		expect(defined(view.roles.empty, 'view.roles.empty').tools).toEqual([])
	})

	test('drops role-only fields that are not part of the safe subset (systemPrompt)', () => {
		const config = sampleGuildConfig({
			roles: {
				orchestrator: {
					systemPrompt: 'prompts/orchestrator.md',
					tools: ['finish'],
				},
			},
		})
		const view = renderConfig(config, sampleDeployment(), {}, null)
		expect(view.roles.orchestrator).toEqual({ tools: ['finish'] })
		expect(view.roles.orchestrator).not.toHaveProperty('systemPrompt')
	})

	test('passes through the visualization section when the guild carries one', () => {
		const visualization = {
			pseudoRoleLabels: { human: { detailed: ['The human'], friendly: ['The human'], whimsical: ['The Dreamer'] } },
			operationTemplates: {
				call: { 'role->role': { detailed: ['{source} is calling {destination}'] } },
				return: { 'role->role': { detailed: ['{source} is returning to {destination}'] } },
				observe: { 'role->role': { detailed: ['{source} is observing {destination}'] } },
				terminate: { 'tool->role': { detailed: ['{source} is terminating {destination}'] } },
			},
			genericOperationTemplates: {
				call: { detailed: ['{source} is calling {destination}'] },
				return: { detailed: ['{source} is returning to {destination}'] },
				observe: { detailed: ['{source} is observing {destination}'] },
				terminate: { detailed: ['{source} is terminating {destination}'] },
			},
		}
		const config = sampleGuildConfig({ visualization })
		const view = renderConfig(config, sampleDeployment(), {}, null)
		expect(view.visualization).toEqual(visualization)
	})

	test('omits the visualization field when the guild does not carry one', () => {
		const view = renderConfig(sampleGuildConfig(), sampleDeployment(), {}, null)
		expect(view).not.toHaveProperty('visualization')
	})

	test('carries the build identifier through to the view', () => {
		const build = { sha: '9f3a2b7c4d1e5a6b', builtAt: '2026-09-25T12:00:00Z' }
		const view = renderConfig(sampleGuildConfig(), sampleDeployment(), {}, build)
		expect(view.build).toEqual({ sha: '9f3a2b7c4d1e5a6b', builtAt: '2026-09-25T12:00:00Z' })
	})

	test('reports build as null when the process has none', () => {
		const view = renderConfig(sampleGuildConfig(), sampleDeployment(), {}, null)
		expect(view.build).toBeNull()
	})
})
