import { describe, expect, test } from 'bun:test'

import { ValidationError } from '../executor/errors.ts'
import { defined } from '../executor/test-fixtures.ts'
import {
	evaluateValidation,
	parseEvalConfig,
	type BenchmarkRunOutput,
	type EvalConfig,
} from './validation.ts'

function runOutput(overrides: Partial<BenchmarkRunOutput> = {}): BenchmarkRunOutput {
	return {
		exitCode: 0,
		stdout: '',
		stderr: '',
		timedOut: false,
		expectedFilesPresent: {},
		...overrides,
	}
}

const smokeEval: EvalConfig = {
	taskType: 'smoke',
	description: "Write 'hello world' to output.txt.",
	validation: {
		command: 'bun test tests/',
		expectedExitCode: 0,
		expectedFiles: ['output.txt'],
		expectedStdoutContains: '2 pass',
		timeoutSeconds: 60,
	},
}

describe('parseEvalConfig', () => {
	test('accepts a well-formed eval config and returns it typed', () => {
		const parsed = parseEvalConfig(smokeEval)
		expect(parsed.taskType).toBe('smoke')
		expect(parsed.validation.command).toBe('bun test tests/')
		expect(parsed.validation.expectedFiles).toEqual(['output.txt'])
	})

	test('accepts a minimal config with only required fields', () => {
		const parsed = parseEvalConfig({
			taskType: 'coding',
			description: 'do something',
			validation: { command: 'true' },
		})
		expect(parsed.validation.expectedExitCode).toBeUndefined()
		expect(parsed.validation.expectedFiles).toBeUndefined()
	})

	test('accepts humanResponses as a record of strings', () => {
		const parsed = parseEvalConfig({
			taskType: 'coding',
			description: 'd',
			validation: { command: 'true' },
			humanResponses: { 'Which language?': 'TypeScript' },
		})
		expect(parsed.humanResponses).toEqual({ 'Which language?': 'TypeScript' })
	})

	test('accepts expectedStdoutContains as an array', () => {
		const parsed = parseEvalConfig({
			taskType: 'coding',
			description: 'd',
			validation: { command: 'true', expectedStdoutContains: ['a', 'b'] },
		})
		expect(parsed.validation.expectedStdoutContains).toEqual(['a', 'b'])
	})

	test('rejects a non-object root', () => {
		expect(() => parseEvalConfig('nope')).toThrow(ValidationError)
		expect(() => parseEvalConfig(null)).toThrow(ValidationError)
		expect(() => parseEvalConfig([])).toThrow(ValidationError)
	})

	test('rejects a missing taskType', () => {
		expect(() => parseEvalConfig({ description: 'd', validation: { command: 'true' } })).toThrow(ValidationError)
	})

	test('rejects a missing description', () => {
		expect(() => parseEvalConfig({ taskType: 't', validation: { command: 'true' } })).toThrow(ValidationError)
	})

	test('rejects a missing validation block', () => {
		expect(() => parseEvalConfig({ taskType: 't', description: 'd' })).toThrow(ValidationError)
	})

	test('rejects a validation block missing command', () => {
		expect(() => parseEvalConfig({ taskType: 't', description: 'd', validation: { expectedExitCode: 0 } })).toThrow(ValidationError)
	})

	test('rejects a non-number expectedExitCode', () => {
		expect(() => parseEvalConfig({
			taskType: 't', description: 'd', validation: { command: 'true', expectedExitCode: '0' },
		})).toThrow(ValidationError)
	})

	test('rejects a non-string-array expectedFiles', () => {
		expect(() => parseEvalConfig({
			taskType: 't', description: 'd', validation: { command: 'true', expectedFiles: 'output.txt' },
		})).toThrow(ValidationError)
	})

	test('rejects a non-string/array expectedStdoutContains', () => {
		expect(() => parseEvalConfig({
			taskType: 't', description: 'd', validation: { command: 'true', expectedStdoutContains: 42 },
		})).toThrow(ValidationError)
	})

	test('rejects a non-number timeoutSeconds', () => {
		expect(() => parseEvalConfig({
			taskType: 't', description: 'd', validation: { command: 'true', timeoutSeconds: '60' },
		})).toThrow(ValidationError)
	})

	test('rejects a non-string-record humanResponses', () => {
		expect(() => parseEvalConfig({
			taskType: 't', description: 'd', validation: { command: 'true' }, humanResponses: { q: 1 },
		})).toThrow(ValidationError)
	})

	test('validation error messages carry a path', () => {
		let caught: ValidationError | undefined
		try {
			parseEvalConfig({ taskType: 't', description: 'd', validation: { command: 5 } })
		} catch (error) {
			if (error instanceof ValidationError) caught = error
		}
		expect(caught).toBeDefined()
		expect(defined(caught, 'caught error').path).toBe('validation.command')
	})
})

describe('evaluateValidation', () => {
	test('passes when all expectations are met', () => {
		const result = evaluateValidation(smokeEval.validation, runOutput({
			exitCode: 0,
			stdout: '2 pass',
			expectedFilesPresent: { 'output.txt': true },
		}))
		expect(result).toEqual({ status: 'pass', reasons: [] })
	})

	test('fails when an expected file is missing', () => {
		const result = evaluateValidation(smokeEval.validation, runOutput({
			exitCode: 0,
			stdout: '2 pass',
			expectedFilesPresent: { 'output.txt': false },
		}))
		expect(result.status).toBe('fail')
		expect(result.reasons).toContain('expected file missing: output.txt')
	})

	test('fails when the exit code is wrong', () => {
		const result = evaluateValidation(smokeEval.validation, runOutput({
			exitCode: 1,
			stdout: '2 pass',
			expectedFilesPresent: { 'output.txt': true },
		}))
		expect(result.status).toBe('fail')
		expect(result.reasons).toContain('expected exit code 0, got 1')
	})

	test('fails when a stdout substring is missing', () => {
		const result = evaluateValidation(smokeEval.validation, runOutput({
			exitCode: 0,
			stdout: 'something else',
			expectedFilesPresent: { 'output.txt': true },
		}))
		expect(result.status).toBe('fail')
		expect(result.reasons).toContain('stdout missing expected text: 2 pass')
	})

	test('fails on timeout regardless of other fields', () => {
		const result = evaluateValidation(smokeEval.validation, runOutput({
			exitCode: null,
			stdout: '',
			timedOut: true,
			expectedFilesPresent: { 'output.txt': true },
		}))
		expect(result.status).toBe('fail')
		expect(result.reasons).toEqual(['validation command timed out after 60s'])
	})

	test('defaults expectedExitCode to 0 when omitted', () => {
		const spec = { command: 'true' }
		const passing = evaluateValidation(spec, runOutput({ exitCode: 0 }))
		const failing = evaluateValidation(spec, runOutput({ exitCode: 2 }))
		expect(passing.status).toBe('pass')
		expect(failing.status).toBe('fail')
		expect(failing.reasons).toContain('expected exit code 0, got 2')
	})

	test('treats a missing expectedFilesPresent entry as a missing file', () => {
		const result = evaluateValidation(
			{ command: 'true', expectedFiles: ['a.txt', 'b.txt'] },
			runOutput({ exitCode: 0, expectedFilesPresent: { 'a.txt': true } }),
		)
		expect(result.status).toBe('fail')
		expect(result.reasons).toContain('expected file missing: b.txt')
	})

	test('checks each substring when expectedStdoutContains is an array', () => {
		const spec = { command: 'true', expectedStdoutContains: ['alpha', 'beta'] }
		const result = evaluateValidation(spec, runOutput({ exitCode: 0, stdout: 'alpha only' }))
		expect(result.status).toBe('fail')
		expect(result.reasons).toContain('stdout missing expected text: beta')
	})

	test('passes when no expectations are declared beyond the command', () => {
		const result = evaluateValidation({ command: 'true' }, runOutput({ exitCode: 0 }))
		expect(result).toEqual({ status: 'pass', reasons: [] })
	})

	test('fails when the command produced no exit code (and did not time out)', () => {
		const result = evaluateValidation({ command: 'true' }, runOutput({ exitCode: null }))
		expect(result.status).toBe('fail')
		expect(result.reasons).toContain('validation command did not produce an exit code')
	})
})
