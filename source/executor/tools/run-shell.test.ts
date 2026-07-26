import { describe, expect, test } from 'bun:test'
import { type SubprocessOutcome, type SubprocessRunner } from './subprocess-tool.ts'
import { createRunShell, type RunShellData } from './run-shell.ts'

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

describe('createRunShell', () => {
	test('wraps the command in sh -c and runs it with the workspace as cwd', async () => {
		const runner = makeRunner({ exitCode: 0, stdout: 'ok\n' })
		const handler = createRunShell(WORKSPACE, 30, runner)
		const result = await handler({ command: 'echo ok' })
		expect(result.kind).toBe('success')
		if (result.kind === 'success') {
			const data = result.data as RunShellData
			expect(data.exitCode).toBe(0)
			expect(data.stdout).toBe('ok\n')
		}
		expect(runner.calls).toHaveLength(1)
		expect(runner.calls[0]?.command).toEqual(['sh', '-c', 'echo ok'])
		expect(runner.calls[0]?.cwd).toBe(WORKSPACE)
		expect(runner.calls[0]?.timeoutMs).toBe(30000)
	})

	test('rejects a missing command without spawning', async () => {
		const runner = makeRunner({ exitCode: 0 })
		const handler = createRunShell(WORKSPACE, 30, runner)
		const result = await handler({})
		expect(result.kind).toBe('invalid_arguments')
		expect(runner.calls).toHaveLength(0)
	})

	test('rejects a non-string command without spawning', async () => {
		const runner = makeRunner({ exitCode: 0 })
		const handler = createRunShell(WORKSPACE, 30, runner)
		expect((await handler({ command: 42 })).kind).toBe('invalid_arguments')
		expect((await handler({ command: ['echo', 'ok'] })).kind).toBe('invalid_arguments')
		expect(runner.calls).toHaveLength(0)
	})

	test('rejects an empty or whitespace-only command without spawning', async () => {
		const runner = makeRunner({ exitCode: 0 })
		const handler = createRunShell(WORKSPACE, 30, runner)
		expect((await handler({ command: '' })).kind).toBe('invalid_arguments')
		expect((await handler({ command: '  \n\t ' })).kind).toBe('invalid_arguments')
		expect(runner.calls).toHaveLength(0)
	})

	test('honors a requested timeout below the cap', async () => {
		const runner = makeRunner({ exitCode: 0 })
		const handler = createRunShell(WORKSPACE, 30, runner)
		await handler({ command: 'echo ok', timeoutSeconds: 5 })
		expect(runner.calls[0]?.timeoutMs).toBe(5000)
	})

	test('caps a requested timeout at the executor default', async () => {
		const runner = makeRunner({ exitCode: 0 })
		const handler = createRunShell(WORKSPACE, 30, runner)
		await handler({ command: 'echo ok', timeoutSeconds: 120 })
		expect(runner.calls[0]?.timeoutMs).toBe(30000)
	})

	test('returns an error result when the runner throws on spawn', async () => {
		const runner = makeRunner({}, { throwMessage: 'ENOENT sh' })
		const handler = createRunShell(WORKSPACE, 30, runner)
		const result = await handler({ command: 'echo ok' })
		expect(result.kind).toBe('invalid_arguments')
		if (result.kind === 'invalid_arguments') {
			expect(result.message).toContain('ENOENT sh')
		}
	})
})
