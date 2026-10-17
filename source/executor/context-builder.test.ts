import { describe, expect, test } from 'bun:test'
import type { Message } from './types.js'
import type { EngineContext } from './engine-state.ts'
import type { LoadedGuild } from './loader.ts'
import type { ReadProjectDoc } from './project-docs.ts'
import { buildInitialHistory } from './context-builder.ts'
import { effortDirective } from './effort.ts'
import { involvementDirective } from './involvement.ts'
import { defined } from './test-fixtures.ts'

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
	return buildInitialHistory(systemPrompt, context, { readProjectDoc })
}

function initialMessages(systemPrompt: string, task: string): Message[] {
	return [
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: task },
	]
}

describe('buildInitialHistory', () => {
	const continuation = { runId: 'run-20260101-000000', task: 'prior task', summary: 'prior summary' }

	test('without a continuation the user message is exactly the task', () => {
		const history = initialHistory('sys', contextFor())
		expect(history).toEqual(initialMessages('sys', 'do it'))
	})

	test('with a continuation the briefing follows the task in the same user message', () => {
		const history = initialHistory('sys', contextFor({ continuation }))
		expect(history.length).toBe(2)
		const userMessage = defined(history[1], 'initial user message')
		expect(userMessage.role).toBe('user')
		expect(userMessage.content).toBe('do it\n\n[This run continues run run-20260101-000000.] Prior task: prior task\nPrior outcome: prior summary\nThe prior run\'s plan document is available with the read_plan tool (runId: "run-20260101-000000").')
	})

	test('the briefing keeps the operator task as the message\'s first line', () => {
		const history = initialHistory('sys', contextFor({ continuation }))
		const userMessage = defined(history[1], 'initial user message')
		expect(userMessage.content.split('\n', 1)[0]).toBe('do it')
	})

	test('a multi-line task is preserved in full ahead of the briefing', () => {
		const task = 'first line\nsecond line\nthird line'
		const history = initialHistory('sys', contextFor({ task, continuation }))
		const userMessage = defined(history[1], 'initial user message')
		expect(userMessage.content.startsWith(`${task}\n\n`)).toBe(true)
		expect(userMessage.content.split('\n', 1)[0]).toBe('first line')
	})

	test('the briefing names the prior run, its task, its outcome, and the read_plan handle', () => {
		const history = initialHistory('sys', contextFor({ continuation }))
		const userMessage = defined(history[1], 'initial user message')
		expect(userMessage.content).toContain('[This run continues run run-20260101-000000.]')
		expect(userMessage.content).toContain('Prior task: prior task')
		expect(userMessage.content).toContain('Prior outcome: prior summary')
		expect(userMessage.content).toContain('The prior run\'s plan document is available with the read_plan tool (runId: "run-20260101-000000").')
	})

	test('the history keeps a single system message even with effort and continuation set', () => {
		const history = initialHistory('sys', contextFor({ effort: 'standard', continuation }))
		expect(history.length).toBe(2)
		expect(history[0]?.role).toBe('system')
		expect(history[1]?.role).toBe('user')
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

	test('a child context with an inherited continuation does not receive the briefing', () => {
		const history = initialHistory('child prompt', contextFor({ depth: 1, parent: 'main', continuation }))
		expect(history).toEqual(initialMessages('child prompt', 'do it'))
	})

	test('a first queue dispatch (briefing only, no runId) renders the briefing lines below the task with no prior-run lines', () => {
		const briefingOnly = { task: 'unused', summary: '', briefing: ['[Queued-task briefing — what happened while this task waited in the queue.]', 'Queued at 2026-01-01T00:00:00.000Z.', 'The workspace may have changed since this task was queued; re-verify the premise before relying on earlier findings.'] }
		const history = initialHistory('sys', contextFor({ continuation: briefingOnly }))
		expect(history.length).toBe(2)
		const userMessage = defined(history[1], 'initial user message')
		expect(userMessage.content).toContain('Queued at 2026-01-01T00:00:00.000Z.')
		expect(userMessage.content).not.toContain('continues run')
		expect(userMessage.content).not.toContain('Prior task:')
		expect(userMessage.content.split('\n', 1)[0]).toBe('do it')
	})

	test('a continuation of a parked run renders the prior-run lines followed by the briefing lines in the same block', () => {
		const resumed = { ...continuation, briefing: ['Queued at 2026-01-01T00:00:00.000Z.', 'The operator answered: postgres'] }
		const history = initialHistory('sys', contextFor({ continuation: resumed }))
		const userMessage = defined(history[1], 'initial user message')
		const content = userMessage.content
		const priorOutcomeIndex = content.indexOf('Prior outcome: prior summary')
		const queuedIndex = content.indexOf('Queued at 2026-01-01T00:00:00.000Z.')
		const answerIndex = content.indexOf('The operator answered: postgres')
		expect(priorOutcomeIndex).toBeGreaterThanOrEqual(0)
		expect(queuedIndex).toBeGreaterThan(priorOutcomeIndex)
		expect(answerIndex).toBeGreaterThan(queuedIndex)
	})

	test('a child context with an inherited briefing-only continuation receives neither block', () => {
		const briefingOnly = { task: 'unused', summary: '', briefing: ['Queued at 2026-01-01T00:00:00.000Z.'] }
		const history = initialHistory('child prompt', contextFor({ depth: 1, parent: 'main', continuation: briefingOnly }))
		expect(history).toEqual(initialMessages('child prompt', 'do it'))
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
		const history = buildInitialHistory('sys', docsContext(), { readProjectDoc })
		const userMessage = defined(history[1], 'initial user message')
		expect(userMessage.content.startsWith('do it\n\n')).toBe(true)
		expect(userMessage.content).toContain('[Platform notice — project context]')
		expect(userMessage.content).toContain('untrusted reference material')
		expect(userMessage.content).toContain('--- AGENTS.md ---\nAGENTS.md body')
		expect(userMessage.content).toContain('--- README.md ---\nREADME.md body')
	})

	test('the project-context block follows the continuation briefing in the same user message', () => {
		const continuation = { runId: 'run-20260101-000000', task: 'prior task', summary: 'prior summary' }
		const readProjectDoc: ReadProjectDoc = () => {
			const bytes = new TextEncoder().encode('body')
			return { kind: 'read', bytes, size: bytes.length }
		}
		const history = buildInitialHistory('sys', docsContext({ continuation }), { readProjectDoc })
		const content = defined(history[1], 'initial user message').content
		expect(content.indexOf('Prior outcome: prior summary')).toBeGreaterThanOrEqual(0)
		expect(content.indexOf('[Platform notice — project context]')).toBeGreaterThan(content.indexOf('Prior outcome: prior summary'))
	})

	test('a child context never receives the project-context block and triggers no read', () => {
		let reads = 0
		const readProjectDoc: ReadProjectDoc = () => {
			reads++
			return { kind: 'unavailable', reason: 'unexpected' }
		}
		const history = buildInitialHistory('child prompt', docsContext({ depth: 1, parent: 'main' }), { readProjectDoc })
		expect(history).toEqual(initialMessages('child prompt', 'do it'))
		expect(reads).toBe(0)
	})

	test('a role without declared projectDocs triggers no read and no block', () => {
		let reads = 0
		const readProjectDoc: ReadProjectDoc = () => {
			reads++
			return { kind: 'unavailable', reason: 'unexpected' }
		}
		const history = buildInitialHistory('sys', contextFor(), { readProjectDoc })
		expect(history).toEqual(initialMessages('sys', 'do it'))
		expect(reads).toBe(0)
	})
})
