import { describe, expect, test } from 'bun:test'
import { createReadWorkspaceGitState, formatWorkspaceGitNotice } from './git-state.ts'
import { makeScriptedRunner } from './test-fixtures.ts'

const WORKSPACE = '/fake/workspace'

const EXPECTED_PREFIX = ['git', '--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'user.name=Adaptive Orchestrator', '-c', 'user.email=orchestrator@localhost', '-c', 'commit.gpgsign=false']

describe('createReadWorkspaceGitState', () => {
	test('returns a non-repository state without probing HEAD or status when the workspace is not a repository', async () => {
		const runner = makeScriptedRunner([{ exitCode: 128, stderr: 'fatal: not a git repository' }])
		const read = createReadWorkspaceGitState({ workspaceRoot: WORKSPACE, runner })
		const state = await read()
		expect(state).toEqual({ isRepository: false, unbornHead: false, uncommittedPaths: [] })
		expect(runner.calls).toHaveLength(1)
		expect(runner.calls[0]?.command).toEqual([...EXPECTED_PREFIX, 'rev-parse', '--is-inside-work-tree'])
		expect(runner.calls[0]?.cwd).toBe(WORKSPACE)
	})

	test('reads the HEAD hash and the porcelain paths for a dirty repository', async () => {
		const runner = makeScriptedRunner([
			{ exitCode: 0, stdout: 'true\n' },
			{ exitCode: 0, stdout: 'abc123\n' },
			{ exitCode: 0, stdout: ' M src/a.ts\n?? src/b.ts\n' },
		])
		const read = createReadWorkspaceGitState({ workspaceRoot: WORKSPACE, runner })
		const state = await read()
		expect(state).toEqual({ isRepository: true, unbornHead: false, headHash: 'abc123', uncommittedPaths: ['src/a.ts', 'src/b.ts'] })
		expect(runner.calls[1]?.command).toEqual([...EXPECTED_PREFIX, 'rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'])
		expect(runner.calls[2]?.command).toEqual([...EXPECTED_PREFIX, 'status', '--porcelain=v1'])
	})

	test('marks an unborn HEAD and takes the rename destination', async () => {
		const runner = makeScriptedRunner([
			{ exitCode: 0, stdout: 'true\n' },
			{ exitCode: 128, stderr: 'fatal: Needed a single revision' },
			{ exitCode: 0, stdout: 'R  old.ts -> new.ts\n' },
		])
		const read = createReadWorkspaceGitState({ workspaceRoot: WORKSPACE, runner })
		const state = await read()
		expect(state.isRepository).toBe(true)
		expect(state.unbornHead).toBe(true)
		expect(state.headHash).toBeUndefined()
		expect(state.uncommittedPaths).toEqual(['new.ts'])
	})

	test('degrades to a non-repository state when the runner rejects', async () => {
		const runner = makeScriptedRunner([{ throwMessage: 'ENOENT git' }])
		const read = createReadWorkspaceGitState({ workspaceRoot: WORKSPACE, runner })
		const state = await read()
		expect(state).toEqual({ isRepository: false, unbornHead: false, uncommittedPaths: [] })
	})
})

describe('formatWorkspaceGitNotice', () => {
	test('injects nothing for a non-repository', () => {
		expect(formatWorkspaceGitNotice({ isRepository: false, unbornHead: false, uncommittedPaths: [] })).toBeUndefined()
	})

	test('reports a clean repository at its short HEAD', () => {
		expect(formatWorkspaceGitNotice({ isRepository: true, unbornHead: false, headHash: 'abcdef1234567890', uncommittedPaths: [] })).toBe('The workspace git repository is clean at abcdef1.')
	})

	test('reports uncommitted changes regardless of HEAD', () => {
		const notice = formatWorkspaceGitNotice({ isRepository: true, unbornHead: false, headHash: 'abcdef1', uncommittedPaths: ['src/a.ts'] })
		expect(notice).toContain('uncommitted changes')
	})

	test('reports a repository with no commits', () => {
		expect(formatWorkspaceGitNotice({ isRepository: true, unbornHead: true, uncommittedPaths: [] })).toBe('The workspace git repository has no commits yet.')
	})
})
