import { describe, expect, test } from 'bun:test'
import type { LlmCallResult, LlmRequest } from '../executor/llm.js'
import type { RunMeta } from '../executor/types.js'
import { createTaskSummarizer, type TaskSummarizerDependencies } from './summarize.js'

function successResult(content: string | undefined): LlmCallResult {
	return { kind: 'success', content, toolCalls: [], usage: { promptTokens: 10, completionTokens: 5 } }
}

function sampleMeta(overrides: Partial<RunMeta> = {}): RunMeta {
	return {
		runId: 'run-1',
		guildPath: 'guild',
		benchmarkPath: 'bench',
		task: 'fix the login bug',
		status: 'success',
		startTime: '2026-01-01T00:00:00.000Z',
		endTime: '2026-01-01T00:01:00.000Z',
		...overrides,
	}
}

function createHarness(initialResult: LlmCallResult) {
	let current = initialResult
	const requests: LlmRequest[] = []
	const writes: Array<{ runId: string; summary: string }> = []
	const log = { text: '' }
	const dependencies: TaskSummarizerDependencies = {
		callLlm: (request) => {
			requests.push(request)
			return Promise.resolve(current)
		},
		readRunLogText: () => log.text,
		writeRunSummaryText: (runId, summary) => {
			writes.push({ runId, summary })
		},
	}
	return {
		dependencies,
		requests,
		writes,
		log,
		setResult(result: LlmCallResult) {
			current = result
		},
	}
}

async function startSummary(modelContent: string): Promise<string | null> {
	const harness = createHarness(successResult(modelContent))
	await createTaskSummarizer(harness.dependencies).summarizeTaskStart('run-1', 'fix the login bug')
	const write = harness.writes[0]
	return write === undefined ? null : write.summary
}

describe('one-line reduction (through summarizeTaskStart)', () => {
	test('takes the first non-empty line', async () => {
		expect(await startSummary('\n\nAdd a settings page\nMore detail here')).toBe('Add a settings page')
	})

	test('strips list, heading, quote, and numbering scaffolding', async () => {
		expect(await startSummary('- just text')).toBe('just text')
		expect(await startSummary('## Fix the parser')).toBe('Fix the parser')
		expect(await startSummary('> Quoted line')).toBe('Quoted line')
		expect(await startSummary('1. Numbered line')).toBe('Numbered line')
		expect(await startSummary('"Wrapped in quotes"')).toBe('Wrapped in quotes')
	})

	test('caps an overlong line at a word boundary with an ellipsis', async () => {
		const words = Array.from({ length: 40 }, (_, index) => `word${index}`).join(' ')
		const result = (await startSummary(words))!
		expect(result.endsWith('…')).toBe(true)
		expect(result.length).toBeLessThanOrEqual(141)
		expect(result.slice(0, -1).includes('  ')).toBe(false)
	})

	test('writes nothing when nothing usable remains', async () => {
		expect(await startSummary('')).toBeNull()
		expect(await startSummary('\n\n  \n')).toBeNull()
		expect(await startSummary('##')).toBeNull()
	})
})

describe('summarizeTaskStart', () => {
	test('writes the one-line summary from the model response, sending the task as the user message', async () => {
		const harness = createHarness(successResult('Fix the login redirect loop'))
		await createTaskSummarizer(harness.dependencies).summarizeTaskStart('run-1', 'fix the login bug')
		expect(harness.writes).toEqual([{ runId: 'run-1', summary: 'Fix the login redirect loop' }])
		const request = harness.requests[0]!
		expect(request.messages.length).toBe(2)
		expect(request.messages[1]).toEqual({ role: 'user', content: 'fix the login bug' })
	})

	test('writes nothing when the endpoint is unavailable', async () => {
		const harness = createHarness({ kind: 'llm_unavailable', message: 'connection refused' })
		await createTaskSummarizer(harness.dependencies).summarizeTaskStart('run-1', 'fix the login bug')
		expect(harness.writes).toEqual([])
	})

	test('writes nothing when the response carries no content', async () => {
		const harness = createHarness(successResult(undefined))
		await createTaskSummarizer(harness.dependencies).summarizeTaskStart('run-1', 'fix the login bug')
		expect(harness.writes).toEqual([])
	})
})

describe('summarizeRunCompletion', () => {
	test('briefs the model with the task, interrupts, and outcome, then writes the summary', async () => {
		const harness = createHarness(successResult('Fixed the login redirect loop and added tests'))
		harness.log.text = [
			JSON.stringify({ timestamp: '2026-01-01T00:00:10.000Z', type: 'interrupt', payload: { trigger: 'inquiry', handler: 'inquiry_responder', target: 'coder-1-2', message: 'how is it going?' } }),
			JSON.stringify({ timestamp: '2026-01-01T00:00:12.000Z', type: 'interrupt_resolved', payload: { trigger: 'inquiry', handler: 'inquiry_responder', target: 'coder-1-2', action: 'answered', summary: 'almost done' } }),
			JSON.stringify({ timestamp: '2026-01-01T00:00:20.000Z', type: 'plan_modification', payload: { message: 'use sessions not jwt', aborted: ['coder'] } }),
		].join('\n')
		const meta = sampleMeta({ result: { status: 'success', summary: 'login fixed', artifacts: [] } })
		await createTaskSummarizer(harness.dependencies).summarizeRunCompletion(meta)

		const briefing = harness.requests[0]!.messages[1]!.content
		expect(briefing).toContain('Task: fix the login bug')
		expect(briefing).toContain('The operator asked: how is it going?')
		expect(briefing).toContain('The run answered: almost done')
		expect(briefing).toContain('The operator changed the plan: use sessions not jwt')
		expect(briefing).toContain('Outcome (success): login fixed')
		expect(harness.writes).toEqual([{ runId: 'run-1', summary: 'Fixed the login redirect loop and added tests' }])
	})

	test('includes the error message for a failed run', async () => {
		const harness = createHarness(successResult('Failed to fix login; endpoint unavailable'))
		const meta = sampleMeta({ status: 'error', error: { kind: 'llm_unavailable', message: 'connection refused' } })
		await createTaskSummarizer(harness.dependencies).summarizeRunCompletion(meta)
		expect(harness.requests[0]!.messages[1]!.content).toContain('Error: connection refused')
	})

	test('writes nothing when the endpoint is unavailable, leaving any start summary in place', async () => {
		const harness = createHarness({ kind: 'llm_unavailable', message: 'connection refused' })
		await createTaskSummarizer(harness.dependencies).summarizeRunCompletion(sampleMeta())
		expect(harness.writes).toEqual([])
	})
})
