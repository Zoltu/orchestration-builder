import { describe, expect, test } from 'bun:test'
import { createCheckerTool, type CheckerCommandResult } from './checker-tool.ts'
import { type SubprocessRunner } from './subprocess-tool.ts'
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

function isCheckerResultEntry(value: unknown): value is CheckerCommandResult {
	if (!isObject(value)) return false
	if (typeof value['command'] !== 'string') return false
	if (typeof value['exitCode'] !== 'number' && value['exitCode'] !== null) return false
	if (typeof value['stdout'] !== 'string') return false
	if (typeof value['stderr'] !== 'string') return false
	if (value['timedOut'] !== undefined && typeof value['timedOut'] !== 'boolean') return false
	return true
}

function isCheckerData(value: unknown): value is CheckerCommandResult[] {
	return Array.isArray(value) && value.every(isCheckerResultEntry)
}

describe('createCheckerTool', () => {
	test('runs each command in order via sh -c with the workspace as cwd', async () => {
		const runner = makeScriptedRunner([{}, {}])
		const handler = createCheckerTool({ noun: 'typecheck' }, WORKSPACE, 30, runner)
		const result = await handler({ commands: ['tsc --noEmit', 'cargo check'] })
		expect(result.kind).toBe('success')
		expect(runner.calls).toHaveLength(2)
		expect(runner.calls[0]?.command).toEqual(['sh', '-c', 'tsc --noEmit'])
		expect(runner.calls[1]?.command).toEqual(['sh', '-c', 'cargo check'])
		expect(runner.calls[0]?.cwd).toBe(WORKSPACE)
		expect(runner.calls[0]?.timeoutMs).toBe(30000)
	})

	test('returns one structured result entry per command, in order', async () => {
		const runner = makeScriptedRunner([
			{ exitCode: 0, stdout: 'clean\n', stderr: '' },
			{ exitCode: 1, stdout: 'diagnostics', stderr: 'noise' },
		])
		const handler = createCheckerTool({ noun: 'typecheck' }, WORKSPACE, 30, runner)
		const result = await handler({ commands: ['tsc --noEmit', 'cargo check'] })
		expect(result.kind).toBe('success')
		const data = toolData(result, isCheckerData)
		expect(data).toHaveLength(2)
		expect(data[0]?.command).toBe('tsc --noEmit')
		expect(data[0]?.exitCode).toBe(0)
		expect(data[0]?.stdout).toBe('clean\n')
		expect(data[0]?.stderr).toBe('')
		expect(data[0]?.timedOut).toBeUndefined()
		expect(data[1]?.command).toBe('cargo check')
		expect(data[1]?.exitCode).toBe(1)
		expect(data[1]?.stdout).toBe('diagnostics')
		expect(data[1]?.stderr).toBe('noise')
	})

	test('aggregates non-zero exits as success data the caller iterates on', async () => {
		const runner = makeScriptedRunner([{ exitCode: 2, stdout: 'error TS2322' }, { exitCode: 1, stdout: '1 fail' }])
		const handler = createCheckerTool({ noun: 'test' }, WORKSPACE, 30, runner)
		const result = await handler({ commands: ['tsc --noEmit', 'bun test'] })
		expect(result.kind).toBe('success')
		const data = toolData(result, isCheckerData)
		expect(data[0]?.exitCode).toBe(2)
		expect(data[0]?.stdout).toContain('error TS2322')
		expect(data[1]?.exitCode).toBe(1)
	})

	test('rejects missing commands without spawning', async () => {
		const runner = makeScriptedRunner([])
		const handler = createCheckerTool({ noun: 'typecheck' }, WORKSPACE, 30, runner)
		const result = await handler({})
		expect(result.kind).toBe('invalid_arguments')
		expect(runner.calls).toHaveLength(0)
	})

	test('rejects a non-array commands argument without spawning', async () => {
		const runner = makeScriptedRunner([])
		const handler = createCheckerTool({ noun: 'typecheck' }, WORKSPACE, 30, runner)
		expect((await handler({ commands: 'tsc --noEmit' })).kind).toBe('invalid_arguments')
		expect((await handler({ commands: { 0: 'tsc --noEmit' } })).kind).toBe('invalid_arguments')
		expect(runner.calls).toHaveLength(0)
	})

	test('rejects an empty commands array without spawning', async () => {
		const runner = makeScriptedRunner([])
		const handler = createCheckerTool({ noun: 'typecheck' }, WORKSPACE, 30, runner)
		const result = await handler({ commands: [] })
		expect(result.kind).toBe('invalid_arguments')
		expect(runner.calls).toHaveLength(0)
	})

	test('rejects a non-string or empty element anywhere in the array without spawning', async () => {
		const runner = makeScriptedRunner([])
		const handler = createCheckerTool({ noun: 'typecheck' }, WORKSPACE, 30, runner)
		expect((await handler({ commands: ['tsc --noEmit', 42] })).kind).toBe('invalid_arguments')
		expect((await handler({ commands: ['tsc --noEmit', ''] })).kind).toBe('invalid_arguments')
		expect((await handler({ commands: ['tsc --noEmit', '   '] })).kind).toBe('invalid_arguments')
		expect((await handler({ commands: [null, 'tsc --noEmit'] })).kind).toBe('invalid_arguments')
		expect(runner.calls).toHaveLength(0)
	})

	test('rejects a commands array longer than 16 without spawning', async () => {
		const runner = makeScriptedRunner([])
		const handler = createCheckerTool({ noun: 'typecheck' }, WORKSPACE, 30, runner)
		const commands = Array.from({ length: 17 }, (_, index) => `command-${index}`)
		const result = await handler({ commands })
		expect(result.kind).toBe('invalid_arguments')
		expect(runner.calls).toHaveLength(0)
	})

	test('stops on a timed-out command and preserves the completed entries plus the timed-out entry', async () => {
		const runner = makeScriptedRunner([{ exitCode: 0, stdout: 'first ok' }, { timedOut: true, exitCode: null, stdout: 'partial', stderr: '' }, {}])
		const handler = createCheckerTool({ noun: 'typecheck' }, WORKSPACE, 30, runner)
		const result = await handler({ commands: ['tsc --noEmit', 'cargo check', 'never-run'] })
		expect(result.kind).toBe('timeout')
		if (result.kind === 'timeout') {
			expect(result.message).toContain('cargo check')
			const details = result.details
			expect(isObject(details)).toBe(true)
			if (isObject(details)) {
				expect(details['command']).toBe('cargo check')
				expect(details['afterSeconds']).toBe(30)
				const results = details['results']
				expect(isCheckerData(results)).toBe(true)
				if (isCheckerData(results)) {
					expect(results).toHaveLength(2)
					expect(results[0]?.command).toBe('tsc --noEmit')
					expect(results[0]?.timedOut).toBeUndefined()
					expect(results[1]?.command).toBe('cargo check')
					expect(results[1]?.exitCode).toBeNull()
					expect(results[1]?.stdout).toBe('partial')
					expect(results[1]?.timedOut).toBe(true)
				}
			}
		}
		expect(runner.calls).toHaveLength(2)
	})

	test('reports the effective (capped) timeout per command in the timeout details', async () => {
		const runner = makeScriptedRunner([{ timedOut: true }])
		const handler = createCheckerTool({ noun: 'typecheck' }, WORKSPACE, 30, runner)
		const result = await handler({ commands: ['tsc --noEmit'], timeoutSeconds: 5 })
		expect(result.kind).toBe('timeout')
		if (result.kind === 'timeout' && isObject(result.details)) {
			expect(result.details['afterSeconds']).toBe(5)
		}
		expect(runner.calls[0]?.timeoutMs).toBe(5000)
	})

	test('caps a requested timeout at the executor default for every command', async () => {
		const runner = makeScriptedRunner([{}, {}, {}])
		const handler = createCheckerTool({ noun: 'typecheck' }, WORKSPACE, 30, runner)
		await handler({ commands: ['a', 'b', 'c'], timeoutSeconds: 120 })
		expect(runner.calls.map((call) => call.timeoutMs)).toEqual([30000, 30000, 30000])
	})

	test('uses the executor default when no timeout is requested', async () => {
		const runner = makeScriptedRunner([{}, {}])
		const handler = createCheckerTool({ noun: 'typecheck' }, WORKSPACE, 45, runner)
		await handler({ commands: ['a', 'b'] })
		expect(runner.calls.map((call) => call.timeoutMs)).toEqual([45000, 45000])
	})

	test('truncates stdout and stderr independently per command', async () => {
		const big = 'x'.repeat(20000)
		const runner = makeScriptedRunner([
			{ exitCode: 1, stdout: big, stderr: 'small' },
			{ exitCode: 1, stdout: 'small', stderr: big },
		])
		const handler = createCheckerTool({ noun: 'typecheck' }, WORKSPACE, 30, runner)
		const result = await handler({ commands: ['a', 'b'] })
		expect(result.kind).toBe('success')
		const data = toolData(result, isCheckerData)
		expect(data[0]?.stdout.length).toBeLessThan(big.length)
		expect(data[0]?.stdout).toContain('[truncated:')
		expect(data[0]?.stderr).toBe('small')
		expect(data[1]?.stdout).toBe('small')
		expect(data[1]?.stderr.length).toBeLessThan(big.length)
		expect(data[1]?.stderr).toContain('[truncated:')
	})

	test('returns an unavailable error naming the command when the runner throws on spawn, preserving completed entries', async () => {
		const runner = makeScriptedRunner([{ exitCode: 0, stdout: 'first ok' }, { throwMessage: 'ENOENT cargo' }, {}])
		const handler = createCheckerTool({ noun: 'typecheck' }, WORKSPACE, 30, runner)
		const result = await handler({ commands: ['tsc --noEmit', 'cargo check', 'never-run'] })
		expect(result.kind).toBe('unavailable')
		if (result.kind === 'unavailable') {
			expect(result.message).toContain('cargo check')
			expect(result.message).toContain('ENOENT cargo')
			const details = result.details
			expect(isObject(details)).toBe(true)
			if (isObject(details)) {
				expect(details['command']).toBe('cargo check')
				const results = details['results']
				expect(isCheckerData(results)).toBe(true)
				if (isCheckerData(results)) {
					expect(results).toHaveLength(1)
					expect(results[0]?.command).toBe('tsc --noEmit')
				}
			}
		}
		expect(runner.calls).toHaveLength(2)
	})

	test('rejects a non-number, zero, or negative timeoutSeconds without spawning', async () => {
		const runner = makeScriptedRunner([])
		const handler = createCheckerTool({ noun: 'typecheck' }, WORKSPACE, 30, runner)
		expect((await handler({ commands: ['a'], timeoutSeconds: '30' })).kind).toBe('invalid_arguments')
		expect((await handler({ commands: ['a'], timeoutSeconds: 0 })).kind).toBe('invalid_arguments')
		expect((await handler({ commands: ['a'], timeoutSeconds: -5 })).kind).toBe('invalid_arguments')
		expect((await handler({ commands: ['a'], timeoutSeconds: NaN })).kind).toBe('invalid_arguments')
		expect(runner.calls).toHaveLength(0)
	})

	test('uses the configured noun in error messages so the model reads which checker failed', async () => {
		const spawnFailure = makeScriptedRunner([{ throwMessage: 'boom' }])
		const spawnResult = await createCheckerTool({ noun: 'test' }, WORKSPACE, 30, spawnFailure)({ commands: ['bun test'] })
		expect(spawnResult.kind).toBe('unavailable')
		if (spawnResult.kind === 'unavailable' && typeof spawnResult.message === 'string') {
			expect(spawnResult.message.startsWith('test failed to run')).toBe(true)
		}
		const timeout = makeScriptedRunner([{ timedOut: true }])
		const timeoutResult = await createCheckerTool({ noun: 'test' }, WORKSPACE, 30, timeout)({ commands: ['bun test'] })
		expect(timeoutResult.kind).toBe('timeout')
		if (timeoutResult.kind === 'timeout' && typeof timeoutResult.message === 'string') {
			expect(timeoutResult.message.startsWith('test timed out after 30s')).toBe(true)
		}
	})
})
