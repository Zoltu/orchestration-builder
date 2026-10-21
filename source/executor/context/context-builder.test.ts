import { describe, expect, test } from 'bun:test'
import type { Message } from '../types.js'
import type { EngineContext } from '../engine-state.ts'
import type { LoadedGuild } from '../loader.ts'
import type { ReadProjectDoc } from '../project-docs.ts'
import { buildInitialHistory } from './index.js'
import { effortDirective } from '../effort.ts'
import { involvementDirective } from '../involvement.ts'
import { defined } from '../test-fixtures.ts'

const guild: LoadedGuild = {
	config: { entryRole: 'main', roles: {}, tools: [] },
	deployment: {
		model: { name: 'm', apiBase: 'http://x', contextWindow: 32768, generation: {} },
		executor: { maxAgentDepth: 8, defaultToolTimeoutSeconds: 30, maxCompactionAttempts: 5 },
		contextPolicy: { maxToolOutputChars: 4000 },
	},
	prompts: {},
	tools: {},
}

function contextFor(overrides: Partial<EngineContext> = {}): EngineContext {
	return { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it', ...overrides }
}

// The guild fixture declares no role projectDocs, so this reader is a tripwire: any test reaching it proves an unintended read.
const readProjectDoc: ReadProjectDoc = (relativePath) => ({ kind: 'unavailable', reason: `unexpected read of ${relativePath}` })

function initialHistory(systemPrompt: string, context: EngineContext): Message[] {
	return buildInitialHistory(systemPrompt, context, { readProjectDoc }).history
}

function initialPrefix(systemPrompt: string, context: EngineContext): number {
	return buildInitialHistory(systemPrompt, context, { readProjectDoc }).protectedPrefixLength
}

function initialMessages(systemPrompt: string, task: string): Message[] {
	return [
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: task },
	]
}

const marker = '[This run continues run run-20260101-000000.] The prior run\'s plan document is available with the read_plan tool (runId: "run-20260101-000000").'

describe('buildInitialHistory', () => {
	const continuation = { runId: 'run-20260101-000000', task: 'prior task', summary: 'prior summary' }

	test('without a continuation the user message is exactly the task and the protected prefix is two', () => {
		const history = initialHistory('sys', contextFor())
		expect(history).toEqual(initialMessages('sys', 'do it'))
		expect(initialPrefix('sys', contextFor())).toBe(2)
	})

	test('a genuine continuation reports the four-message protected prefix explicitly', () => {
		const history = initialHistory('sys', contextFor({ continuation }))
		expect(history.length).toBe(4)
		expect(initialPrefix('sys', contextFor({ continuation }))).toBe(4)
	})

	test('a genuine continuation produces the four-message history with prior turns and the marker', () => {
		const history = initialHistory('sys', contextFor({ continuation }))
		expect(history).toEqual([
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'prior task' },
			{ role: 'assistant', content: '[Prior run result — status: unknown.]\n\nprior summary' },
			{ role: 'user', content: `do it\n\n${marker}` },
		])
	})

	test('the prior task and prior result each appear exactly once across the history', () => {
		const history = initialHistory('sys', contextFor({ continuation }))
		const serialized = history.map((message) => message.content).join('\n')
		expect(serialized.split('prior task').length - 1).toBe(1)
		expect(serialized.split('prior summary').length - 1).toBe(1)
		expect(serialized.split(marker).length - 1).toBe(1)
	})

	test('the new user message carries no prior-task or prior-outcome lines', () => {
		const history = initialHistory('sys', contextFor({ continuation }))
		const userMessage = defined(history[3], 'final user message')
		expect(userMessage.content).not.toContain('Prior task:')
		expect(userMessage.content).not.toContain('Prior outcome:')
		expect(userMessage.content).not.toContain('prior task')
		expect(userMessage.content).not.toContain('prior summary')
	})

	test('the final user message keeps the operator task as its first line', () => {
		const history = initialHistory('sys', contextFor({ continuation }))
		const userMessage = defined(history[3], 'final user message')
		expect(userMessage.content.split('\n', 1)[0]).toBe('do it')
	})

	test('a multi-line task is preserved in full ahead of the marker', () => {
		const task = 'first line\nsecond line\nthird line'
		const history = initialHistory('sys', contextFor({ task, continuation }))
		const userMessage = defined(history[3], 'final user message')
		expect(userMessage.content.startsWith(`${task}\n\n`)).toBe(true)
		expect(userMessage.content.split('\n', 1)[0]).toBe('first line')
	})

	test('the history keeps a single system message even with effort and continuation set', () => {
		const history = initialHistory('sys', contextFor({ effort: 'standard', continuation }))
		expect(history.length).toBe(4)
		expect(history.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user'])
	})

	test('the entry role receives the effort and involvement directives in the same single system message', () => {
		const history = initialHistory('sys', contextFor({ effort: 'standard', involvement: 'collaborative' }))
		expect(history.length).toBe(2)
		expect(history[0]).toEqual({ role: 'system', content: `sys\n\n${effortDirective('standard')}\n\n${involvementDirective('collaborative')}` })
	})

	test('the entry role receives no involvement directive when the context carries none', () => {
		const history = initialHistory('sys', contextFor({ effort: 'standard' }))
		expect(history[0]).toEqual({ role: 'system', content: `sys\n\n${effortDirective('standard')}` })
	})

	test('a child context does not receive the involvement directive even when inherited', () => {
		const history = initialHistory('child prompt', contextFor({ depth: 1, parent: 'main', involvement: 'collaborative' }))
		expect(history).toEqual(initialMessages('child prompt', 'do it'))
	})

	test('a child context with an inherited continuation receives no prior turns, no blocks, and a two-message prefix', () => {
		const resumed = { ...continuation, briefing: ['Queued at 2026-01-01T00:00:00.000Z.'] }
		const context = contextFor({ depth: 1, parent: 'main', continuation: resumed })
		const history = initialHistory('child prompt', context)
		expect(history).toEqual(initialMessages('child prompt', 'do it'))
		expect(initialPrefix('child prompt', context)).toBe(2)
	})

	test('a first queue dispatch (briefing only, no runId) renders two messages with no prior turns or marker', () => {
		const briefingOnly = { task: 'unused', summary: '', briefing: ['[Queued-task briefing — what happened while this task waited in the queue.]', 'Queued at 2026-01-01T00:00:00.000Z.'] }
		const history = initialHistory('sys', contextFor({ continuation: briefingOnly }))
		expect(history).toEqual([
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'do it\n\n[Queued-task briefing — what happened while this task waited in the queue.]\nQueued at 2026-01-01T00:00:00.000Z.' },
		])
	})

	test('a genuine continuation places the marker, then the briefing, in the final user message', () => {
		const resumed = { ...continuation, briefing: ['Queued at 2026-01-01T00:00:00.000Z.', 'The operator answered: postgres'] }
		const history = initialHistory('sys', contextFor({ continuation: resumed }))
		const content = defined(history[3], 'final user message').content
		expect(content).toBe(`do it\n\n${marker}\n\nQueued at 2026-01-01T00:00:00.000Z.\nThe operator answered: postgres`)
	})

	test('a continuation with neither runId nor briefing renders as the bare task', () => {
		const history = initialHistory('sys', contextFor({ continuation: { task: 'prior', summary: '' } }))
		expect(history).toEqual(initialMessages('sys', 'do it'))
	})

	test('the entry role receives the workspace git notice, and a child inheriting it does not', () => {
		const notice = 'The workspace git repository is clean at abc1234.'
		const entry = initialHistory('sys', contextFor({ workspaceGitNotice: notice }))
		expect(defined(entry[1], 'initial user message').content).toBe(`do it\n\n${notice}`)
		const child = initialHistory('child prompt', contextFor({ depth: 1, parent: 'main', workspaceGitNotice: notice }))
		expect(child).toEqual(initialMessages('child prompt', 'do it'))
	})
})

describe('buildInitialHistory — prior result rendering', () => {
	const base = { runId: 'run-20260101-000000', task: 'prior task', summary: 'fallback summary' }

	test('renders the status header, summary, artifacts, and surfaced error from the full result card', () => {
		const continuation = {
			...base,
			status: 'error' as const,
			result: {
				status: 'error' as const,
				summary: 'card summary',
				artifacts: ['output.txt', 'logs/run.txt'],
				error: { kind: 'loop_detected' as const, message: 'card error message' },
				detail: 'raw endpoint body with secrets',
			},
			error: { kind: 'loop_detected' as const, message: 'run-level error message' },
		}
		const history = initialHistory('sys', contextFor({ continuation }))
		const assistant = defined(history[2], 'prior result turn')
		expect(assistant.role).toBe('assistant')
		expect(assistant.content).toBe('[Prior run result — status: error.]\n\ncard summary\n\nArtifacts:\n- output.txt\n- logs/run.txt\n\nError: run-level error message')
		expect(assistant.reasoning).toBeUndefined()
		expect(assistant.tool_calls).toBeUndefined()
		expect(assistant.content).not.toContain('loop_detected')
		expect(assistant.content).not.toContain('Technical details')
		expect(assistant.content).not.toContain('raw endpoint body with secrets')
	})

	test('surfaces a card-only error message when no run-level error exists', () => {
		const continuation = {
			...base,
			status: 'error' as const,
			result: { status: 'error' as const, summary: 'failed', error: { kind: 'llm_unavailable' as const, message: 'card only boom' } },
		}
		const history = initialHistory('sys', contextFor({ continuation }))
		expect(defined(history[2], 'prior result turn').content).toBe('[Prior run result — status: error.]\n\nfailed\n\nError: card only boom')
	})

	test('falls back to the continuation summary when the card has no summary', () => {
		const continuation = { ...base, status: 'success' as const, result: { status: 'success' as const, summary: '' } }
		const history = initialHistory('sys', contextFor({ continuation }))
		expect(defined(history[2], 'prior result turn').content).toBe('[Prior run result — status: success.]\n\nfallback summary')
	})

	test('an interrupted run with no result card shows the status and the run-level error', () => {
		const continuation = {
			...base,
			summary: '',
			status: 'interrupted' as const,
			error: { kind: 'interrupted' as const, message: 'The service stopped while this run was in progress.' },
		}
		const history = initialHistory('sys', contextFor({ continuation }))
		expect(defined(history[2], 'prior result turn').content).toBe('[Prior run result — status: interrupted.]\n\nError: The service stopped while this run was in progress.')
	})

	test('a continuation without status, result, or error still renders a sensible result turn', () => {
		const history = initialHistory('sys', contextFor({ continuation: { ...base, summary: '' } }))
		expect(defined(history[2], 'prior result turn').content).toBe('[Prior run result — status: unknown.]\n\n(No result summary, artifacts, or error were recorded for the prior run.)')
	})

	test('an error object without a message states that no message was recorded', () => {
		const continuation = { ...base, summary: '', status: 'error' as const, result: { status: 'error' as const, summary: '', error: { kind: 'timeout' as const } } }
		const history = initialHistory('sys', contextFor({ continuation }))
		expect(defined(history[2], 'prior result turn').content).toBe('[Prior run result — status: error.]\n\nError: (No error message was recorded.)')
	})

	test('an empty prior task uses the deterministic fallback', () => {
		const history = initialHistory('sys', contextFor({ continuation: { ...base, task: '' } }))
		expect(defined(history[1], 'prior task turn').content).toBe("(The prior run's task was not recorded.)")
	})

	test('the status resolves from the result card when the continuation carries none', () => {
		const continuation = { ...base, result: { status: 'needs_clarification' as const, summary: 'which database?' } }
		const history = initialHistory('sys', contextFor({ continuation }))
		expect(defined(history[2], 'prior result turn').content).toBe('[Prior run result — status: needs_clarification.]\n\nwhich database?')
	})
})

describe('buildInitialHistory — project context', () => {
	const docsGuild: LoadedGuild = {
		...guild,
		config: { entryRole: 'main', roles: { main: { systemPrompt: 'p', tools: [], projectDocs: ['AGENTS.md', 'README.md'] } }, tools: [] },
	}
	const docsContext = (overrides: Partial<EngineContext> = {}): EngineContext => ({ loadedGuild: docsGuild, depth: 0, roleName: 'main', task: 'do it', ...overrides })

	test('the entry role receives one labeled project-context block after the task', () => {
		const readProjectDoc: ReadProjectDoc = (relativePath) => {
			const bytes = new TextEncoder().encode(`${relativePath} body`)
			return { kind: 'read', bytes, size: bytes.length }
		}
		const history = buildInitialHistory('sys', docsContext(), { readProjectDoc }).history
		const userMessage = defined(history[1], 'initial user message')
		expect(userMessage.content.startsWith('do it\n\n')).toBe(true)
		expect(userMessage.content).toContain('[Platform notice — project context]')
		expect(userMessage.content).toContain('untrusted reference material')
		expect(userMessage.content).toContain('--- AGENTS.md ---\nAGENTS.md body')
		expect(userMessage.content).toContain('--- README.md ---\nREADME.md body')
	})

	test('the marked blocks follow the task in marker, briefing, project-docs, git-notice order', () => {
		const continuation = { runId: 'run-20260101-000000', task: 'prior task', summary: 'prior summary', briefing: ['Queued at 2026-01-01T00:00:00.000Z.'] }
		const readProjectDoc: ReadProjectDoc = () => {
			const bytes = new TextEncoder().encode('body')
			return { kind: 'read', bytes, size: bytes.length }
		}
		const notice = 'The workspace git repository is clean at abc1234.'
		const history = buildInitialHistory('sys', docsContext({ continuation, workspaceGitNotice: notice }), { readProjectDoc }).history
		const content = defined(history[3], 'final user message').content
		expect(content.split('\n', 1)[0]).toBe('do it')
		const markerIndex = content.indexOf(marker)
		const briefingIndex = content.indexOf('Queued at 2026-01-01T00:00:00.000Z.')
		const docsIndex = content.indexOf('[Platform notice — project context]')
		const noticeIndex = content.indexOf(notice)
		expect(markerIndex).toBeGreaterThanOrEqual(0)
		expect(briefingIndex).toBeGreaterThan(markerIndex)
		expect(docsIndex).toBeGreaterThan(briefingIndex)
		expect(noticeIndex).toBeGreaterThan(docsIndex)
	})

	test('a child context never receives the project-context block and triggers no read', () => {
		let reads = 0
		const readProjectDoc: ReadProjectDoc = () => {
			reads++
			return { kind: 'unavailable', reason: 'unexpected' }
		}
		const history = buildInitialHistory('child prompt', docsContext({ depth: 1, parent: 'main' }), { readProjectDoc }).history
		expect(history).toEqual(initialMessages('child prompt', 'do it'))
		expect(reads).toBe(0)
	})

	test('a role without declared projectDocs triggers no read and no block', () => {
		let reads = 0
		const readProjectDoc: ReadProjectDoc = () => {
			reads++
			return { kind: 'unavailable', reason: 'unexpected' }
		}
		const history = buildInitialHistory('sys', contextFor(), { readProjectDoc }).history
		expect(history).toEqual(initialMessages('sys', 'do it'))
		expect(reads).toBe(0)
	})
})
