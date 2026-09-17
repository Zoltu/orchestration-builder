import { describe, expect, test } from 'bun:test'
import { type SubprocessRunner } from './subprocess-tool.ts'
import { createTest, type TestData } from './test.ts'
import { toolData } from '../test-fixtures.ts'
import { isObject } from '../validation.ts'

interface RunnerCall {
	command: readonly string[]
	cwd: string
	timeoutMs: number
}

interface ScriptedOutcome {
	exitCode?: number | null
	stdout?: string
	stderr?: string
	timedOut?: boolean
	throwMessage?: string
}

function makeScriptedRunner(script: ScriptedOutcome[]): SubprocessRunner & { calls: RunnerCall[] } {
	const calls: RunnerCall[] = []
	const runner: SubprocessRunner & { calls: RunnerCall[] } = async (options) => {
		calls.push(options)
		const scripted = script[calls.length - 1] ?? {}
		if (scripted.throwMessage !== undefined) throw new Error(scripted.throwMessage)
		return {
			exitCode: scripted.exitCode !== undefined ? scripted.exitCode : 0,
			stdout: scripted.stdout ?? '',
			stderr: scripted.stderr ?? '',
			timedOut: scripted.timedOut ?? false,
		}
	}
	runner.calls = calls
	return runner
}

const WORKSPACE = '/fake/workspace'

function isTestData(value: unknown): value is TestData {
	return Array.isArray(value) && value.every((entry) => isObject(entry) && typeof entry['command'] === 'string' && typeof entry['stdout'] === 'string' && typeof entry['stderr'] === 'string' && (typeof entry['exitCode'] === 'number' || entry['exitCode'] === null))
}

describe('createTest', () => {
	test('passes the given commands through the checker machinery and returns per-command results', async () => {
		const failureOutput = '(fail) math.test.ts > "adds"\n1 fail\nAssertionError: expected 3 to be 5'
		const runner = makeScriptedRunner([{ exitCode: 1, stdout: failureOutput }, { exitCode: 0, stdout: '1 pass' }])
		const handler = createTest(WORKSPACE, 30, runner)
		const result = await handler({ commands: ['bun test', 'pytest tests/'] })
		expect(result.kind).toBe('success')
		const data = toolData(result, isTestData)
		expect(data[0]?.command).toBe('bun test')
		expect(data[0]?.stdout).toContain('AssertionError')
		expect(data[1]?.command).toBe('pytest tests/')
		expect(data[1]?.stdout).toBe('1 pass')
	})

	test('errors name the test tool', async () => {
		const runner = makeScriptedRunner([{ timedOut: true, exitCode: null }])
		const handler = createTest(WORKSPACE, 30, runner)
		const result = await handler({ commands: ['bun test'] })
		expect(result.kind).toBe('timeout')
		if (result.kind === 'timeout' && typeof result.message === 'string') {
			expect(result.message.startsWith('test timed out after 30s on "bun test"')).toBe(true)
			expect(result.details).toEqual({ command: 'bun test', afterSeconds: 30, results: [{ command: 'bun test', exitCode: null, stdout: '', stderr: '', timedOut: true }] })
		}
	})
})
