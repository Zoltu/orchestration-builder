import { describe, expect, test } from 'bun:test'
import { createGitTools } from './git.ts'
import { type SubprocessRunner } from './subprocess-tool.ts'
import type { ToolHandler } from '../tool-dispatch.ts'
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
const DEFAULT_TIMEOUT_SECONDS = 30

const EXPECTED_PREFIX = ['git', '--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'user.name=Adaptive Orchestrator', '-c', 'user.email=orchestrator@localhost', '-c', 'commit.gpgsign=false']

interface GitSuccessData {
	exitCode: number | null
	stdout: string
	stderr: string
	message?: string
}

function isGitSuccessData(value: unknown): value is GitSuccessData {
	if (!isObject(value)) return false
	if (typeof value['exitCode'] !== 'number' && value['exitCode'] !== null) return false
	if (typeof value['stdout'] !== 'string') return false
	if (typeof value['stderr'] !== 'string') return false
	if (value['message'] !== undefined && typeof value['message'] !== 'string') return false
	return true
}

function makeTools(runner: SubprocessRunner, ensureOrchestrationExcluded: () => void = () => {}): Record<string, ToolHandler> {
	return createGitTools({ workspaceRoot: WORKSPACE, defaultToolTimeoutSeconds: DEFAULT_TIMEOUT_SECONDS, runner, ensureOrchestrationExcluded })
}

describe('createGitTools registration', () => {
	test('registers exactly the six git tools', () => {
		const tools = makeTools(makeScriptedRunner([]))
		expect(Object.keys(tools).sort()).toEqual(['git_branch', 'git_commit', 'git_diff', 'git_init', 'git_log', 'git_status'])
	})

	test('every operation invokes git directly and never a shell', async () => {
		const runner = makeScriptedRunner([{}, {}, {}, {}, {}, {}, {}])
		const tools = makeTools(runner)
		await tools['git_status']?.({})
		await tools['git_log']?.({})
		await tools['git_diff']?.({})
		await tools['git_init']?.({})
		await tools['git_commit']?.({ message: 'm' })
		await tools['git_branch']?.({ name: 'b' })
		for (const call of runner.calls) {
			expect(call.command[0]).toBe('git')
			expect(call.command.includes('sh')).toBe(false)
		}
	})
})

describe('git_status', () => {
	test('runs the fixed status argv in the resolved workspace and returns the captured streams', async () => {
		const runner = makeScriptedRunner([{ exitCode: 0, stdout: '## main\n', stderr: '' }])
		const tools = makeTools(runner)
		const result = await tools['git_status']?.({})
		expect(result?.kind).toBe('success')
		const data = toolData(result ?? { kind: 'invalid_arguments' }, isGitSuccessData)
		expect(data.exitCode).toBe(0)
		expect(data.stdout).toBe('## main\n')
		expect(runner.calls).toHaveLength(1)
		expect(runner.calls[0]?.command).toEqual([...EXPECTED_PREFIX, 'status', '--porcelain=v1', '--branch', '--untracked-files=normal'])
		expect(runner.calls[0]?.cwd).toBe(WORKSPACE)
		expect(runner.calls[0]?.timeoutMs).toBe(DEFAULT_TIMEOUT_SECONDS * 1000)
	})

	test('surfaces git stderr as the error message and keeps the exit code in details', async () => {
		const runner = makeScriptedRunner([{ exitCode: 128, stdout: '', stderr: 'fatal: not a git repository\n' }])
		const tools = makeTools(runner)
		const result = await tools['git_status']?.({})
		expect(result?.kind).toBe('invalid_arguments')
		if (result?.kind === 'invalid_arguments') {
			expect(result.message).toBe('fatal: not a git repository')
			if (isObject(result.details)) {
				expect(result.details['exitCode']).toBe(128)
				expect(result.details['stderr']).toContain('not a git repository')
			}
		}
	})

	test('falls back to a generic message when git produces no stderr', async () => {
		const runner = makeScriptedRunner([{ exitCode: 3, stdout: '', stderr: '' }])
		const tools = makeTools(runner)
		const result = await tools['git_status']?.({})
		expect(result?.kind).toBe('invalid_arguments')
		if (result?.kind === 'invalid_arguments') {
			expect(result.message).toBe('git status failed (exit code 3)')
		}
	})

	test('maps a null exit without a timeout to an unavailable signal error', async () => {
		const runner = makeScriptedRunner([{ exitCode: null, timedOut: false }])
		const tools = makeTools(runner)
		const result = await tools['git_status']?.({})
		expect(result?.kind).toBe('unavailable')
		if (result?.kind === 'unavailable') {
			expect(result.message).toContain('git status was terminated by a signal')
		}
	})

	test('maps a timed-out runner to a timeout error', async () => {
		const runner = makeScriptedRunner([{ timedOut: true, exitCode: null }])
		const tools = makeTools(runner)
		const result = await tools['git_status']?.({})
		expect(result?.kind).toBe('timeout')
		if (result?.kind === 'timeout' && isObject(result.details)) {
			expect(result.details['afterSeconds']).toBe(DEFAULT_TIMEOUT_SECONDS)
		}
	})

	test('maps a spawn rejection to an unavailable error', async () => {
		const runner = makeScriptedRunner([{ throwMessage: 'ENOENT git' }])
		const tools = makeTools(runner)
		const result = await tools['git_status']?.({})
		expect(result?.kind).toBe('unavailable')
		if (result?.kind === 'unavailable') {
			expect(result.message).toContain('ENOENT git')
		}
	})

	test('honors a caller timeout below the cap', async () => {
		const runner = makeScriptedRunner([{ exitCode: 0 }])
		const tools = makeTools(runner)
		await tools['git_status']?.({ timeoutSeconds: 5 })
		expect(runner.calls[0]?.timeoutMs).toBe(5000)
	})
})

describe('git_log', () => {
	test('defaults the count to 20', async () => {
		const runner = makeScriptedRunner([{ exitCode: 0, stdout: 'abc init\n' }])
		const tools = makeTools(runner)
		const result = await tools['git_log']?.({})
		expect(result?.kind).toBe('success')
		expect(runner.calls[0]?.command).toEqual([...EXPECTED_PREFIX, 'log', '--oneline', '--decorate', '-n', '20'])
	})

	test('uses a supplied count', async () => {
		const runner = makeScriptedRunner([{ exitCode: 0 }])
		const tools = makeTools(runner)
		await tools['git_log']?.({ count: 5 })
		expect(runner.calls[0]?.command).toEqual([...EXPECTED_PREFIX, 'log', '--oneline', '--decorate', '-n', '5'])
	})

	test('accepts the boundary count of 100', async () => {
		const runner = makeScriptedRunner([{ exitCode: 0 }])
		const tools = makeTools(runner)
		const result = await tools['git_log']?.({ count: 100 })
		expect(result?.kind).toBe('success')
		expect(runner.calls[0]?.command).toEqual([...EXPECTED_PREFIX, 'log', '--oneline', '--decorate', '-n', '100'])
	})

	test('rejects a count above 100 without spawning', async () => {
		const runner = makeScriptedRunner([])
		const tools = makeTools(runner)
		expect((await tools['git_log']?.({ count: 101 }))?.kind).toBe('invalid_arguments')
		expect(runner.calls).toHaveLength(0)
	})

	test('rejects a zero, negative, or non-integer count without spawning', async () => {
		const runner = makeScriptedRunner([])
		const tools = makeTools(runner)
		expect((await tools['git_log']?.({ count: 0 }))?.kind).toBe('invalid_arguments')
		expect((await tools['git_log']?.({ count: -1 }))?.kind).toBe('invalid_arguments')
		expect((await tools['git_log']?.({ count: 1.5 }))?.kind).toBe('invalid_arguments')
		expect((await tools['git_log']?.({ count: '10' }))?.kind).toBe('invalid_arguments')
		expect(runner.calls).toHaveLength(0)
	})

	test('maps a non-zero exit to an invalid_arguments error', async () => {
		const runner = makeScriptedRunner([{ exitCode: 128, stderr: 'fatal: bad revision' }])
		const tools = makeTools(runner)
		const result = await tools['git_log']?.({})
		expect(result?.kind).toBe('invalid_arguments')
	})
})

describe('git_diff', () => {
	test('runs a plain diff with external diff and textconv disabled', async () => {
		const runner = makeScriptedRunner([{ exitCode: 0, stdout: 'diff --git' }])
		const tools = makeTools(runner)
		const result = await tools['git_diff']?.({})
		expect(result?.kind).toBe('success')
		expect(runner.calls[0]?.command).toEqual([...EXPECTED_PREFIX, 'diff', '--no-ext-diff', '--no-textconv'])
	})

	test('adds --staged when requested', async () => {
		const runner = makeScriptedRunner([{ exitCode: 0 }])
		const tools = makeTools(runner)
		await tools['git_diff']?.({ staged: true })
		expect(runner.calls[0]?.command).toEqual([...EXPECTED_PREFIX, 'diff', '--no-ext-diff', '--no-textconv', '--staged'])
	})

	test('forwards safe pathspecs behind the -- sentinel', async () => {
		const runner = makeScriptedRunner([{ exitCode: 0 }])
		const tools = makeTools(runner)
		await tools['git_diff']?.({ paths: ['src/a.ts', 'src/b.ts'] })
		expect(runner.calls[0]?.command).toEqual([...EXPECTED_PREFIX, 'diff', '--no-ext-diff', '--no-textconv', '--', 'src/a.ts', 'src/b.ts'])
	})

	test('combines staged and pathspecs', async () => {
		const runner = makeScriptedRunner([{ exitCode: 0 }])
		const tools = makeTools(runner)
		await tools['git_diff']?.({ staged: true, paths: ['src/a.ts'] })
		expect(runner.calls[0]?.command).toEqual([...EXPECTED_PREFIX, 'diff', '--no-ext-diff', '--no-textconv', '--staged', '--', 'src/a.ts'])
	})

	test('rejects unsafe paths without spawning', async () => {
		const runner = makeScriptedRunner([])
		const tools = makeTools(runner)
		const unsafePaths = ['../secret', '.orchestration/x', 'foo/.orchestration/bar', '/etc/passwd', 'C:\\secret', '\\\\server\\share', '..\\..\\x', ':foo']
		for (const unsafePath of unsafePaths) {
			expect((await tools['git_diff']?.({ paths: [unsafePath] }))?.kind).toBe('invalid_arguments')
		}
		expect(runner.calls).toHaveLength(0)
	})

	test('rejects a non-array paths and a non-boolean staged without spawning', async () => {
		const runner = makeScriptedRunner([])
		const tools = makeTools(runner)
		expect((await tools['git_diff']?.({ paths: 'src/a.ts' }))?.kind).toBe('invalid_arguments')
		expect((await tools['git_diff']?.({ staged: 'yes' }))?.kind).toBe('invalid_arguments')
		expect(runner.calls).toHaveLength(0)
	})
})

describe('git_init', () => {
	test('runs git init with the fixed argv', async () => {
		const runner = makeScriptedRunner([{ exitCode: 0, stdout: 'Initialized empty Git repository' }])
		const tools = makeTools(runner)
		const result = await tools['git_init']?.({})
		expect(result?.kind).toBe('success')
		expect(runner.calls[0]?.command).toEqual([...EXPECTED_PREFIX, 'init'])
		expect(runner.calls[0]?.cwd).toBe(WORKSPACE)
	})

	test('re-ensures the orchestration exclusion exactly once after a successful init', async () => {
		const runner = makeScriptedRunner([{ exitCode: 0, stdout: 'Initialized empty Git repository' }])
		let calls = 0
		const tools = makeTools(runner, () => { calls += 1 })
		const result = await tools['git_init']?.({})
		expect(result?.kind).toBe('success')
		expect(calls).toBe(1)
	})

	test('does not re-ensure the orchestration exclusion when init fails', async () => {
		const runner = makeScriptedRunner([{ exitCode: 128, stderr: 'fatal: cannot init' }])
		let calls = 0
		const tools = makeTools(runner, () => { calls += 1 })
		const result = await tools['git_init']?.({})
		expect(result?.kind).toBe('invalid_arguments')
		expect(calls).toBe(0)
	})
})

describe('git_commit', () => {
	test('stages everything then commits, in that order, in the same cwd', async () => {
		const runner = makeScriptedRunner([{ exitCode: 0 }, { exitCode: 0, stdout: '[main abc123] message' }])
		const tools = makeTools(runner)
		const result = await tools['git_commit']?.({ message: 'message' })
		expect(result?.kind).toBe('success')
		expect(runner.calls).toHaveLength(2)
		expect(runner.calls[0]?.command).toEqual([...EXPECTED_PREFIX, 'add', '-A', '--', '.'])
		expect(runner.calls[1]?.command).toEqual([...EXPECTED_PREFIX, 'commit', '-m', 'message'])
		expect(runner.calls[0]?.cwd).toBe(WORKSPACE)
		expect(runner.calls[1]?.cwd).toBe(WORKSPACE)
	})

	test('keeps a flag-shaped message as the value after -m rather than a git option', async () => {
		const runner = makeScriptedRunner([{ exitCode: 0 }, { exitCode: 0 }])
		const tools = makeTools(runner)
		await tools['git_commit']?.({ message: '--amend' })
		const commitArgv = runner.calls[1]?.command
		expect(commitArgv).toEqual([...EXPECTED_PREFIX, 'commit', '-m', '--amend'])
		expect(commitArgv?.[commitArgv.length - 2]).toBe('-m')
		expect(commitArgv?.[commitArgv.length - 1]).toBe('--amend')
	})

	test('returns a successful, zero-exit result when there is nothing to commit', async () => {
		const runner = makeScriptedRunner([{ exitCode: 0 }, { exitCode: 1, stdout: '', stderr: 'nothing to commit, working tree clean' }])
		const tools = makeTools(runner)
		const result = await tools['git_commit']?.({ message: 'empty' })
		expect(result?.kind).toBe('success')
		const data = toolData(result ?? { kind: 'invalid_arguments' }, isGitSuccessData)
		expect(data.exitCode).toBe(0)
		expect(data.message).toContain('Nothing to commit')
	})

	test('recognizes the no-changes-added variant of the empty commit output', async () => {
		const runner = makeScriptedRunner([{ exitCode: 0 }, { exitCode: 1, stdout: 'no changes added to commit', stderr: '' }])
		const tools = makeTools(runner)
		const result = await tools['git_commit']?.({ message: 'empty' })
		expect(result?.kind).toBe('success')
	})

	test('does not treat an unrelated exit-1 phrase as the empty commit case', async () => {
		const runner = makeScriptedRunner([{ exitCode: 0 }, { exitCode: 1, stdout: '', stderr: 'fatal: unable to write new index file' }])
		const tools = makeTools(runner)
		const result = await tools['git_commit']?.({ message: 'message' })
		expect(result?.kind).toBe('invalid_arguments')
		if (result?.kind === 'invalid_arguments') {
			expect(result.message).toContain('unable to write new index file')
			if (isObject(result.details)) {
				expect(result.details['exitCode']).toBe(1)
				expect(result.details['stderr']).toContain('unable to write new index file')
			}
		}
	})

	test('surfaces a failing staging step before it ever commits', async () => {
		const runner = makeScriptedRunner([{ exitCode: 1, stderr: 'fatal: unable to create index.lock' }])
		const tools = makeTools(runner)
		const result = await tools['git_commit']?.({ message: 'message' })
		expect(result?.kind).toBe('invalid_arguments')
		expect(runner.calls).toHaveLength(1)
	})

	test('rejects an invalid message without spawning', async () => {
		const runner = makeScriptedRunner([])
		const tools = makeTools(runner)
		expect((await tools['git_commit']?.({ message: '' }))?.kind).toBe('invalid_arguments')
		expect((await tools['git_commit']?.({ message: '   ' }))?.kind).toBe('invalid_arguments')
		expect((await tools['git_commit']?.({ message: 42 }))?.kind).toBe('invalid_arguments')
		expect(runner.calls).toHaveLength(0)
	})

	test('maps a timed-out staging step to a timeout error', async () => {
		const runner = makeScriptedRunner([{ timedOut: true, exitCode: null }])
		const tools = makeTools(runner)
		const result = await tools['git_commit']?.({ message: 'message' })
		expect(result?.kind).toBe('timeout')
	})

	test('maps a signal-terminated commit to an unavailable error', async () => {
		const runner = makeScriptedRunner([{ exitCode: 0 }, { exitCode: null, timedOut: false }])
		const tools = makeTools(runner)
		const result = await tools['git_commit']?.({ message: 'message' })
		expect(result?.kind).toBe('unavailable')
		if (result?.kind === 'unavailable') {
			expect(result.message).toContain('git commit was terminated by a signal')
		}
	})
})

describe('git_branch', () => {
	test('creates the branch with the fixed argv', async () => {
		const runner = makeScriptedRunner([{ exitCode: 0, stdout: '' }])
		const tools = makeTools(runner)
		const result = await tools['git_branch']?.({ name: 'feature/git-tools' })
		expect(result?.kind).toBe('success')
		expect(runner.calls[0]?.command).toEqual([...EXPECTED_PREFIX, 'branch', '--', 'feature/git-tools'])
		expect(runner.calls[0]?.cwd).toBe(WORKSPACE)
	})

	test('rejects an invalid name without spawning', async () => {
		const runner = makeScriptedRunner([])
		const tools = makeTools(runner)
		const invalidNames: unknown[] = ['', '-x', 'a..b', '.hidden', 'feature/.hidden', 'bad name', 'HEAD', '@', 42]
		for (const name of invalidNames) {
			expect((await tools['git_branch']?.({ name }))?.kind).toBe('invalid_arguments')
		}
		expect(runner.calls).toHaveLength(0)
	})

	test('fails closed when the branch already exists', async () => {
		const runner = makeScriptedRunner([{ exitCode: 128, stderr: "fatal: a branch named 'feature/x' already exists" }])
		const tools = makeTools(runner)
		const result = await tools['git_branch']?.({ name: 'feature/x' })
		expect(result?.kind).toBe('invalid_arguments')
		if (result?.kind === 'invalid_arguments') {
			expect(result.message).toContain('already exists')
			if (isObject(result.details)) {
				expect(result.details['exitCode']).toBe(128)
				expect(result.details['stderr']).toContain('already exists')
			}
		}
	})
})
