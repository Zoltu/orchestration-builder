import { describe, expect, test } from 'bun:test'
import { ensureOrchestrationGitExcluded, type GitExcludeFilesystem } from './git-exclude.ts'

const ROOT = '/workspace'
const APPENDED = '\n# Added by the Adaptive Orchestrator: run bookkeeping\n/.orchestration/\n'

// A scripted filesystem: `files` maps paths to content, `directories` lists directory paths explicitly. Writes record into the same structures so assertions can inspect them like a real checkout.
function makeFilesystem(files: Map<string, string>, directories: Set<string> = new Set()): GitExcludeFilesystem & { written: Map<string, string> } {
	const written = new Map<string, string>()
	return {
		written,
		kindOf: (candidate) => {
			if (files.has(candidate) || written.has(candidate)) return 'file'
			if (directories.has(candidate)) return 'directory'
			return 'absent'
		},
		readTextFile: (candidate) => {
			const content = written.get(candidate) ?? files.get(candidate)
			if (content === undefined) throw new Error(`ENOENT: ${candidate}`)
			return content
		},
		writeTextFile: (candidate, content) => {
			written.set(candidate, content)
		},
		makeDirectory: (candidate) => {
			directories.add(candidate)
		},
	}
}

describe('ensureOrchestrationGitExcluded', () => {
	test('a workspace without .git has nothing to do', () => {
		const filesystem = makeFilesystem(new Map())
		expect(ensureOrchestrationGitExcluded(ROOT, filesystem)).toEqual({ ok: true, updated: false })
		expect(filesystem.written.size).toBe(0)
	})

	test('appends the entry to a plain .git directory’s exclude file', () => {
		const excludePath = `${ROOT}/.git/info/exclude`
		const filesystem = makeFilesystem(new Map([[excludePath, '*.log\n']]), new Set([`${ROOT}/.git`, `${ROOT}/.git/info`]))
		const result = ensureOrchestrationGitExcluded(ROOT, filesystem)
		expect(result).toEqual({ ok: true, updated: true })
		expect(filesystem.readTextFile(excludePath)).toBe(`*.log\n${APPENDED}`)
	})

	test('a missing info/ directory is created on the way', () => {
		const filesystem = makeFilesystem(new Map(), new Set([`${ROOT}/.git`]))
		const result = ensureOrchestrationGitExcluded(ROOT, filesystem)
		expect(result).toEqual({ ok: true, updated: true })
		expect(filesystem.readTextFile(`${ROOT}/.git/info/exclude`)).toBe(APPENDED)
	})

	test('an already-present entry (any spelling, any padding) is a no-op', () => {
		for (const line of ['/.orchestration/', '.orchestration/', '.orchestration', '  .orchestration  ']) {
			const filesystem = makeFilesystem(new Map([[`${ROOT}/.git/info/exclude`, `*.log\n${line}\n`]]), new Set([`${ROOT}/.git`, `${ROOT}/.git/info`]))
			expect(ensureOrchestrationGitExcluded(ROOT, filesystem)).toEqual({ ok: true, updated: false })
			expect(filesystem.written.size).toBe(0)
		}
	})

	test('a lookalike entry under a nested directory is not treated as present', () => {
		const excludePath = `${ROOT}/.git/info/exclude`
		const filesystem = makeFilesystem(new Map([[excludePath, 'project/.orchestration/\n']]), new Set([`${ROOT}/.git`, `${ROOT}/.git/info`]))
		expect(ensureOrchestrationGitExcluded(ROOT, filesystem)).toEqual({ ok: true, updated: true })
		expect(filesystem.readTextFile(excludePath)).toBe(`project/.orchestration/\n${APPENDED}`)
	})

	test('a worktree link file targets the linked git directory, with an absolute gitdir', () => {
		const filesystem = makeFilesystem(new Map([[`${ROOT}/.git`, 'gitdir: /real/repo/.git/worktrees/one\n']]))
		const result = ensureOrchestrationGitExcluded(ROOT, filesystem)
		expect(result).toEqual({ ok: true, updated: true })
		expect(filesystem.readTextFile('/real/repo/.git/worktrees/one/info/exclude')).toBe(APPENDED)
	})

	test('a worktree link file with a relative gitdir resolves it against the checkout', () => {
		const filesystem = makeFilesystem(new Map([[`${ROOT}/.git`, 'gitdir: ../repo/.git/worktrees/one\n']]))
		const result = ensureOrchestrationGitExcluded(ROOT, filesystem)
		expect(result).toEqual({ ok: true, updated: true })
		expect(filesystem.readTextFile('/repo/.git/worktrees/one/info/exclude')).toBe(APPENDED)
	})

	test('a worktree link file without a gitdir line reports a reason', () => {
		const filesystem = makeFilesystem(new Map([[`${ROOT}/.git`, 'something else\n']]))
		expect(ensureOrchestrationGitExcluded(ROOT, filesystem).ok).toBe(false)
		expect(filesystem.written.size).toBe(0)
	})

	test('never throws: an unexpected filesystem failure comes back as a reason', () => {
		const filesystem = makeFilesystem(new Map(), new Set([`${ROOT}/.git`]))
		const broken: GitExcludeFilesystem = { ...filesystem, makeDirectory: () => { throw new Error('EACCES: /workspace/.git/info') } }
		const result = ensureOrchestrationGitExcluded(ROOT, broken)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.reason).toContain('EACCES')
	})
})
