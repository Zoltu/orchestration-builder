import { describe, expect, test } from 'bun:test'
import { type SubprocessOutcome, type SubprocessRunner } from './subprocess-tool.ts'
import { createTest } from './test.ts'
import type { TestData } from './test.ts'

interface RunnerCall {
	command: readonly string[]
	cwd: string
	timeoutMs: number
}

function makeRunner(
	outcome: Partial<SubprocessOutcome> = {},
	opts: { throwMessage?: string } = {},
): SubprocessRunner & { calls: RunnerCall[] } {
	const calls: RunnerCall[] = []
	const runner: SubprocessRunner & { calls: RunnerCall[] } = async (options) => {
		calls.push(options)
		if (opts.throwMessage !== undefined) throw new Error(opts.throwMessage)
		return {
			exitCode: outcome.exitCode ?? 0,
			stdout: outcome.stdout ?? '',
			stderr: outcome.stderr ?? '',
			timedOut: outcome.timedOut ?? false,
		}
	}
	runner.calls = calls
	return runner
}

const WORKSPACE = '/fake/workspace'

describe('createTest', () => {
	test('returns success with exit code 0 and the pass summary in stdout for a passing suite', async () => {
		const passSummary = '(pass) pass\n1 pass, 0 fail, 1 expect)'
		const runner = makeRunner({ exitCode: 0, stdout: passSummary, stderr: '' })
		const handler = createTest(WORKSPACE, 30, runner)
		const result = await handler({})
		expect(result.kind).toBe('success')
		if (result.kind === 'success') {
			const data = result.data as TestData
			expect(data.exitCode).toBe(0)
			expect(data.stdout).toContain('1 pass')
			expect(data.stderr).toBe('')
		}
		expect(runner.calls).toHaveLength(1)
		expect(runner.calls[0]?.command).toEqual(['bun', 'test'])
		expect(runner.calls[0]?.cwd).toBe(WORKSPACE)
		expect(runner.calls[0]?.timeoutMs).toBe(30000)
	})

	test('returns a non-zero exit code as a success result with the failure in stdout', async () => {
		const failureOutput = '(fail) math.test.ts > "adds"\n1 fail\nAssertionError: expected 3 to be 5'
		const runner = makeRunner({ exitCode: 1, stdout: failureOutput, stderr: '' })
		const handler = createTest(WORKSPACE, 30, runner)
		const result = await handler({})
		expect(result.kind).toBe('success')
		if (result.kind === 'success') {
			const data = result.data as TestData
			expect(data.exitCode).toBe(1)
			expect(data.stdout).toContain('1 fail')
			expect(data.stdout).toContain('AssertionError')
		}
	})

	test('returns a timeout result when the runner reports a timeout', async () => {
		const runner = makeRunner({ timedOut: true, exitCode: null, stdout: '', stderr: '' })
		const handler = createTest(WORKSPACE, 30, runner)
		const result = await handler({})
		expect(result.kind).toBe('timeout')
		if (result.kind === 'timeout') {
			expect(result.details).toEqual({ afterSeconds: 30 })
		}
	})

	test('reports the effective (capped) timeout in the timeout details', async () => {
		const runner = makeRunner({ timedOut: true, exitCode: null, stdout: '', stderr: '' })
		const handler = createTest(WORKSPACE, 30, runner)
		const result = await handler({ timeoutSeconds: 5 })
		expect(result.kind).toBe('timeout')
		if (result.kind === 'timeout') {
			expect(result.details).toEqual({ afterSeconds: 5 })
		}
		expect(runner.calls[0]?.timeoutMs).toBe(5000)
	})

	test('caps a requested timeout at the executor default', async () => {
		const runner = makeRunner({ exitCode: 0 })
		const handler = createTest(WORKSPACE, 30, runner)
		await handler({ timeoutSeconds: 120 })
		expect(runner.calls[0]?.timeoutMs).toBe(30000)
	})

	test('uses the executor default when no timeout is requested', async () => {
		const runner = makeRunner({ exitCode: 0 })
		const handler = createTest(WORKSPACE, 45, runner)
		await handler({})
		expect(runner.calls[0]?.timeoutMs).toBe(45000)
	})

	test('truncates stdout past the cap with a clear marker', async () => {
		const big = 'x'.repeat(20000)
		const runner = makeRunner({ exitCode: 1, stdout: big, stderr: '' })
		const handler = createTest(WORKSPACE, 30, runner)
		const result = await handler({})
		expect(result.kind).toBe('success')
		if (result.kind === 'success') {
			const data = result.data as TestData
			expect(data.stdout.length).toBeLessThan(big.length)
			expect(data.stdout).toContain('[truncated:')
		}
	})

	test('truncates stderr past the cap with a clear marker', async () => {
		const big = 'y'.repeat(20000)
		const runner = makeRunner({ exitCode: 1, stdout: '', stderr: big })
		const handler = createTest(WORKSPACE, 30, runner)
		const result = await handler({})
		expect(result.kind).toBe('success')
		if (result.kind === 'success') {
			const data = result.data as TestData
			expect(data.stderr.length).toBeLessThan(big.length)
			expect(data.stderr).toContain('[truncated:')
		}
	})

	test('rejects a non-number timeoutSeconds', async () => {
		const runner = makeRunner({ exitCode: 0 })
		const handler = createTest(WORKSPACE, 30, runner)
		const result = await handler({ timeoutSeconds: '30' })
		expect(result.kind).toBe('invalid_arguments')
		expect(runner.calls).toHaveLength(0)
	})

	test('rejects a zero or negative timeoutSeconds', async () => {
		const runner = makeRunner({ exitCode: 0 })
		const handler = createTest(WORKSPACE, 30, runner)
		expect((await handler({ timeoutSeconds: 0 })).kind).toBe('invalid_arguments')
		expect((await handler({ timeoutSeconds: -5 })).kind).toBe('invalid_arguments')
		expect((await handler({ timeoutSeconds: NaN })).kind).toBe('invalid_arguments')
		expect(runner.calls).toHaveLength(0)
	})

	test('returns an error result when the runner throws on spawn', async () => {
		const runner = makeRunner({}, { throwMessage: 'ENOENT bun' })
		const handler = createTest(WORKSPACE, 30, runner)
		const result = await handler({})
		expect(result.kind).toBe('invalid_arguments')
		if (result.kind === 'invalid_arguments') {
			expect(result.message).toContain('ENOENT bun')
		}
	})
})
