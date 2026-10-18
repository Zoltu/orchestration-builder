import { describe, expect, test } from 'bun:test'
import { createGitTools } from './git.ts'
import { EMPTY_TREE_HASH } from '../git-primitives.ts'
import { type SubprocessRunner } from '../subprocess.ts'
import type { ToolHandler } from './tool-dispatch.ts'
import { createRunBaseTracker, type RunBaseTracker } from '../base-state.ts'
import { makeScriptedRunner, toolData } from '../test-fixtures.ts'
import { isObject } from '../validation.ts'

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

function makeTools(runner: SubprocessRunner, ensureOrchestrationExcluded: () => void = () => {}, baseTracker: RunBaseTracker = createRunBaseTracker()): Record<string, ToolHandler> {
	return createGitTools({ workspaceRoot: WORKSPACE, defaultToolTimeoutSeconds: DEFAULT_TIMEOUT_SECONDS, runner, ensureOrchestrationExcluded, baseTracker })
}

describe('createGitTools registration', () => {
	test('registers exactly the nine git tools', () => {
		const tools = makeTools(makeScriptedRunner([]))
		expect(Object.keys(tools).sort()).toEqual(['git_branch', 'git_changes_since_base', 'git_commit', 'git_diff', 'git_init', 'git_log', 'git_set_base', 'git_status', 'git_uncommitted_changes'])
	})

	test('every operation invokes git directly and never a shell', async () => {
		const runner = makeScriptedRunner([{}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}])
		const tools = makeTools(runner, () => {}, createRunBaseTracker('base-hash'))
		await tools['git_status']?.({})
		await tools['git_log']?.({})
		await tools['git_diff']?.({})
		await tools['git_init']?.({})
		await tools['git_commit']?.({ message: 'm' })
		await tools['git_branch']?.({ name: 'b' })
		await tools['git_set_base']?.({ ref: 'main' })
		await tools['git_changes_since_base']?.({})
		await tools['git_uncommitted_changes']?.({})
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

describe('git_set_base', () => {
	test('defaults the ref to HEAD and records the resolved commit hash', async () => {
		const baseTracker = createRunBaseTracker()
		const runner = makeScriptedRunner([{ exitCode: 0, stdout: 'abc123\n' }])
		const tools = makeTools(runner, () => {}, baseTracker)
		const result = await tools['git_set_base']?.({})
		expect(result?.kind).toBe('success')
		const data = toolData(result ?? { kind: 'invalid_arguments' }, isGitSuccessData)
		expect(data.stdout).toBe('abc123')
		expect(runner.calls[0]?.command).toEqual([...EXPECTED_PREFIX, 'rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'])
		expect(runner.calls[0]?.cwd).toBe(WORKSPACE)
		expect(runner.calls[0]?.timeoutMs).toBe(DEFAULT_TIMEOUT_SECONDS * 1000)
		expect(baseTracker.baseHash).toBe('abc123')
	})

	test('resolves an explicit ref and replaces an existing base', async () => {
		const baseTracker = createRunBaseTracker('old-hash')
		const runner = makeScriptedRunner([{ exitCode: 0, stdout: 'new-hash\n' }])
		const tools = makeTools(runner, () => {}, baseTracker)
		await tools['git_set_base']?.({ ref: 'feature/x' })
		expect(runner.calls[0]?.command).toEqual([...EXPECTED_PREFIX, 'rev-parse', '--verify', '--end-of-options', 'feature/x^{commit}'])
		expect(baseTracker.baseHash).toBe('new-hash')
	})

	test('rejects an invalid ref without spawning', async () => {
		const runner = makeScriptedRunner([])
		const tools = makeTools(runner)
		const invalidRefs: unknown[] = ['', '-x', 'a b', 'HEAD~1', 'a:b', 'a^b', 'a?b', 'a*b', 'a[b', 42]
		for (const ref of invalidRefs) {
			expect((await tools['git_set_base']?.({ ref }))?.kind).toBe('invalid_arguments')
		}
		expect(runner.calls).toHaveLength(0)
	})

	test('surfaces a not-a-repository failure as an invalid_arguments error', async () => {
		const runner = makeScriptedRunner([{ exitCode: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git' }])
		const tools = makeTools(runner)
		const result = await tools['git_set_base']?.({})
		expect(result?.kind).toBe('invalid_arguments')
		if (result?.kind === 'invalid_arguments') expect(result.message).toContain('not a git repository')
	})

	test('fails fast when git resolves an empty hash', async () => {
		const runner = makeScriptedRunner([{ exitCode: 0, stdout: '' }])
		const tools = makeTools(runner)
		const result = await tools['git_set_base']?.({})
		expect(result?.kind).toBe('invalid_arguments')
	})
})

describe('git_changes_since_base', () => {
	test('reports a success sentence without spawning when no base is recorded', async () => {
		const runner = makeScriptedRunner([])
		const tools = makeTools(runner)
		const result = await tools['git_changes_since_base']?.({})
		expect(result?.kind).toBe('success')
		const data = toolData(result ?? { kind: 'invalid_arguments' }, isGitSuccessData)
		expect(data.stdout).toContain('No base commit is recorded')
		expect(runner.calls).toHaveLength(0)
	})

	test('lists untracked files alongside tracked changes in name-status mode', async () => {
		const runner = makeScriptedRunner([
			{ exitCode: 0, stdout: 'M\tsrc/a.ts\n' },
			{ exitCode: 0, stdout: 'new.txt\n' },
		])
		const tools = makeTools(runner, () => {}, createRunBaseTracker('base-hash'))
		const result = await tools['git_changes_since_base']?.({})
		expect(result?.kind).toBe('success')
		const data = toolData(result ?? { kind: 'invalid_arguments' }, isGitSuccessData)
		expect(data.stdout).toBe('M\tsrc/a.ts\n??\tnew.txt')
		expect(runner.calls[1]?.command).toEqual([...EXPECTED_PREFIX, 'ls-files', '--others', '--exclude-standard'])
	})

	test('lists an untracked-only change set', async () => {
		const runner = makeScriptedRunner([
			{ exitCode: 0, stdout: '' },
			{ exitCode: 0, stdout: 'new.txt\n' },
		])
		const tools = makeTools(runner, () => {}, createRunBaseTracker('base-hash'))
		const result = await tools['git_changes_since_base']?.({})
		expect(result?.kind).toBe('success')
		const data = toolData(result ?? { kind: 'invalid_arguments' }, isGitSuccessData)
		expect(data.stdout).toBe('??\tnew.txt')
	})

	test('forwards pathspecs to the untracked listing', async () => {
		const runner = makeScriptedRunner([
			{ exitCode: 0, stdout: '' },
			{ exitCode: 0, stdout: '' },
		])
		const tools = makeTools(runner, () => {}, createRunBaseTracker('base-hash'))
		await tools['git_changes_since_base']?.({ paths: ['src'] })
		expect(runner.calls[1]?.command).toEqual([...EXPECTED_PREFIX, 'ls-files', '--others', '--exclude-standard', '--', 'src'])
	})

	test('includes untracked file contents in includeDiff mode', async () => {
		const runner = makeScriptedRunner([
			{ exitCode: 0, stdout: 'diff --git a/src/a.ts b/src/a.ts\n' },
			{ exitCode: 0, stdout: 'new.txt\n' },
			{ exitCode: 1, stdout: 'diff --git a/dev/null b/new.txt\n+hello\n' },
		])
		const tools = makeTools(runner, () => {}, createRunBaseTracker('base-hash'))
		const result = await tools['git_changes_since_base']?.({ includeDiff: true })
		expect(result?.kind).toBe('success')
		const data = toolData(result ?? { kind: 'invalid_arguments' }, isGitSuccessData)
		expect(data.stdout).toContain('diff --git a/src/a.ts b/src/a.ts')
		expect(data.stdout).toContain('+hello')
		expect(runner.calls[2]?.command).toEqual([...EXPECTED_PREFIX, 'diff', '--no-ext-diff', '--no-textconv', '--no-index', '--', '/dev/null', 'new.txt'])
	})

	test('filters untracked paths that escape the workspace', async () => {
		const runner = makeScriptedRunner([
			{ exitCode: 0, stdout: '' },
			{ exitCode: 0, stdout: '.orchestration/secret\n../escape\nnew.txt\n' },
		])
		const tools = makeTools(runner, () => {}, createRunBaseTracker('base-hash'))
		const result = await tools['git_changes_since_base']?.({})
		expect(result?.kind).toBe('success')
		const data = toolData(result ?? { kind: 'invalid_arguments' }, isGitSuccessData)
		expect(data.stdout).toBe('??\tnew.txt')
	})

	test('caps the number of untracked file contents diffed and notes the omission', async () => {
		const untrackedDiffCap = 10
		const untrackedPaths = Array.from({ length: untrackedDiffCap + 2 }, (_, index) => `file-${index}.txt`)
		const runner = makeScriptedRunner([
			{ exitCode: 0, stdout: '' },
			{ exitCode: 0, stdout: `${untrackedPaths.join('\n')}\n` },
			...untrackedPaths.slice(0, untrackedDiffCap).map((untrackedPath) => ({ exitCode: 1, stdout: `diff --git a/dev/null b/${untrackedPath}\n+content\n` })),
		])
		const tools = makeTools(runner, () => {}, createRunBaseTracker('base-hash'))
		const result = await tools['git_changes_since_base']?.({ includeDiff: true })
		expect(result?.kind).toBe('success')
		const data = toolData(result ?? { kind: 'invalid_arguments' }, isGitSuccessData)
		expect(data.stdout).toContain('2 more untracked file diffs omitted')
		// The tracked diff, the single ls-files call, and exactly the capped number of no-index diffs — nothing beyond the cap.
		expect(runner.calls).toHaveLength(2 + untrackedDiffCap)
	})

	test('diffs against the recorded base with --name-status by default', async () => {
		const runner = makeScriptedRunner([{ exitCode: 0, stdout: 'M\tsrc/a.ts\n' }])
		const tools = makeTools(runner, () => {}, createRunBaseTracker('base-hash'))
		const result = await tools['git_changes_since_base']?.({})
		expect(result?.kind).toBe('success')
		expect(runner.calls[0]?.command).toEqual([...EXPECTED_PREFIX, 'diff', '--no-ext-diff', '--no-textconv', '--name-status', 'base-hash'])
		expect(runner.calls[0]?.cwd).toBe(WORKSPACE)
		expect(runner.calls[0]?.timeoutMs).toBe(DEFAULT_TIMEOUT_SECONDS * 1000)
	})

	test('omits --name-status and forwards pathspecs when includeDiff is set', async () => {
		const runner = makeScriptedRunner([{ exitCode: 0 }])
		const tools = makeTools(runner, () => {}, createRunBaseTracker('base-hash'))
		await tools['git_changes_since_base']?.({ includeDiff: true, paths: ['src/a.ts'] })
		expect(runner.calls[0]?.command).toEqual([...EXPECTED_PREFIX, 'diff', '--no-ext-diff', '--no-textconv', 'base-hash', '--', 'src/a.ts'])
	})

	test('rejects unsafe paths and a non-boolean includeDiff without spawning', async () => {
		const runner = makeScriptedRunner([])
		const tools = makeTools(runner, () => {}, createRunBaseTracker('base-hash'))
		expect((await tools['git_changes_since_base']?.({ paths: ['../secret'] }))?.kind).toBe('invalid_arguments')
		expect((await tools['git_changes_since_base']?.({ includeDiff: 'yes' }))?.kind).toBe('invalid_arguments')
		expect(runner.calls).toHaveLength(0)
	})
})

describe('git_uncommitted_changes', () => {
	test('reports a success sentence without a diff when the workspace is not a repository', async () => {
		const runner = makeScriptedRunner([{ exitCode: 128, stderr: 'fatal: not a git repository' }])
		const tools = makeTools(runner)
		const result = await tools['git_uncommitted_changes']?.({})
		expect(result?.kind).toBe('success')
		const data = toolData(result ?? { kind: 'invalid_arguments' }, isGitSuccessData)
		expect(data.stdout).toContain('not a git repository')
		expect(runner.calls).toHaveLength(1)
		expect(runner.calls[0]?.command).toEqual([...EXPECTED_PREFIX, 'rev-parse', '--is-inside-work-tree'])
	})

	test('diffs HEAD with --name-status by default', async () => {
		const runner = makeScriptedRunner([
			{ exitCode: 0, stdout: 'true\n' },
			{ exitCode: 0, stdout: 'abc123\n' },
			{ exitCode: 0, stdout: ' M src/a.ts\n' },
		])
		const tools = makeTools(runner)
		const result = await tools['git_uncommitted_changes']?.({})
		expect(result?.kind).toBe('success')
		expect(runner.calls[1]?.command).toEqual([...EXPECTED_PREFIX, 'rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'])
		expect(runner.calls[2]?.command).toEqual([...EXPECTED_PREFIX, 'diff', '--no-ext-diff', '--no-textconv', '--name-status', 'HEAD'])
		expect(runner.calls[2]?.cwd).toBe(WORKSPACE)
		expect(runner.calls[2]?.timeoutMs).toBe(DEFAULT_TIMEOUT_SECONDS * 1000)
	})

	test('uses the empty tree when HEAD is unborn', async () => {
		const runner = makeScriptedRunner([
			{ exitCode: 0, stdout: 'true\n' },
			{ exitCode: 128, stderr: 'fatal: Needed a single revision' },
			{ exitCode: 0, stdout: '' },
		])
		const tools = makeTools(runner)
		await tools['git_uncommitted_changes']?.({})
		expect(runner.calls[2]?.command).toEqual([...EXPECTED_PREFIX, 'diff', '--no-ext-diff', '--no-textconv', '--name-status', EMPTY_TREE_HASH])
	})

	test('omits --name-status and forwards pathspecs when includeDiff is set', async () => {
		const runner = makeScriptedRunner([
			{ exitCode: 0, stdout: 'true\n' },
			{ exitCode: 0, stdout: 'abc123\n' },
			{ exitCode: 0 },
		])
		const tools = makeTools(runner)
		await tools['git_uncommitted_changes']?.({ includeDiff: true, paths: ['src/a.ts'] })
		expect(runner.calls[2]?.command).toEqual([...EXPECTED_PREFIX, 'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', 'src/a.ts'])
	})

	test('rejects unsafe paths without spawning', async () => {
		const runner = makeScriptedRunner([])
		const tools = makeTools(runner)
		expect((await tools['git_uncommitted_changes']?.({ paths: ['../secret'] }))?.kind).toBe('invalid_arguments')
		expect(runner.calls).toHaveLength(0)
	})

	test('lists untracked files alongside uncommitted changes', async () => {
		const runner = makeScriptedRunner([
			{ exitCode: 0, stdout: 'true\n' },
			{ exitCode: 0, stdout: 'abc123\n' },
			{ exitCode: 0, stdout: ' M src/a.ts\n' },
			{ exitCode: 0, stdout: 'new.txt\n' },
		])
		const tools = makeTools(runner)
		const result = await tools['git_uncommitted_changes']?.({})
		expect(result?.kind).toBe('success')
		const data = toolData(result ?? { kind: 'invalid_arguments' }, isGitSuccessData)
		expect(data.stdout).toBe(' M src/a.ts\n??\tnew.txt')
	})

	test('includes untracked file contents in includeDiff mode', async () => {
		const runner = makeScriptedRunner([
			{ exitCode: 0, stdout: 'true\n' },
			{ exitCode: 0, stdout: 'abc123\n' },
			{ exitCode: 0, stdout: 'diff --git a/src/a.ts b/src/a.ts\n' },
			{ exitCode: 0, stdout: 'new.txt\n' },
			{ exitCode: 1, stdout: 'diff --git a/dev/null b/new.txt\n+hello\n' },
		])
		const tools = makeTools(runner)
		const result = await tools['git_uncommitted_changes']?.({ includeDiff: true })
		expect(result?.kind).toBe('success')
		const data = toolData(result ?? { kind: 'invalid_arguments' }, isGitSuccessData)
		expect(data.stdout).toContain('+hello')
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
