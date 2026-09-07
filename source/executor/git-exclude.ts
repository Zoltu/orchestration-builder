import * as fs from 'node:fs'
import * as path from 'node:path'

// Result union following the createModelInfoProbe pattern: the operation is best-effort hygiene, so every failure mode is a value the caller logs, never a throw that could block a run.
export type GitExcludeResult = { ok: true; updated: boolean } | { ok: false; reason: string }

// Only the surface the exclude writer consumes: fs satisfies it structurally, and tests script it in memory (the PathFilesystem/GlobFilesystem precedent).
export interface GitExcludeFilesystem {
	kindOf(candidate: string): 'absent' | 'file' | 'directory'
	readTextFile(candidate: string): string
	writeTextFile(candidate: string, content: string): void
	makeDirectory(candidate: string): void
}

export const nodeGitExcludeFilesystem: GitExcludeFilesystem = {
	kindOf: (candidate) => {
		if (!fs.existsSync(candidate)) return 'absent'
		return fs.statSync(candidate).isDirectory() ? 'directory' : 'file'
	},
	readTextFile: (candidate) => fs.readFileSync(candidate, 'utf8'),
	writeTextFile: (candidate, content) => fs.writeFileSync(candidate, content, 'utf8'),
	makeDirectory: (candidate) => fs.mkdirSync(candidate, { recursive: true }),
}

const EXCLUDE_MARKER = '# Added by the Adaptive Orchestrator: run bookkeeping'
// The leading slash anchors the pattern to the repository root, mirroring the tool-level predicate's top-level-only rule: an unanchored `.orchestration/` would also hide a nested project's `.orchestration` from git.
const EXCLUDE_ENTRY = '/.orchestration/'

// Idempotency across executor versions: any of the spellings a previous run may have appended — the anchored entry, the older un-anchored one, or the bare name — counts as already present so re-runs never duplicate.
function containsOrchestrationEntry(text: string): boolean {
	for (const line of text.split('\n')) {
		const trimmed = line.trim()
		if (trimmed === EXCLUDE_ENTRY || trimmed === '.orchestration/' || trimmed === '.orchestration') return true
	}
	return false
}

// A worktree checkout carries a `.git` file pointing at the real git directory; the pointer may be absolute or relative to the checkout.
function gitDirFromLinkFile(text: string): string | null {
	for (const line of text.split('\n')) {
		const match = /^gitdir:\s*(\S.*)$/.exec(line)
		const target = match?.[1]
		if (target !== undefined && target.trim() !== '') return target.trim()
	}
	return null
}

// Adds `.orchestration/` to the workspace's git exclude file (`.git/info/exclude`, or the linked git directory's for a worktree checkout) so run bookkeeping never shows up in git status or an accidental commit. Best-effort by contract: never throws, reports what it did as a value, and treats an absent `.git` as nothing to do.
export function ensureOrchestrationGitExcluded(workspaceRoot: string, filesystem: GitExcludeFilesystem): GitExcludeResult {
	try {
		const gitPath = path.join(workspaceRoot, '.git')
		const gitKind = filesystem.kindOf(gitPath)
		if (gitKind === 'absent') return { ok: true, updated: false }
		let excludePath: string
		if (gitKind === 'directory') {
			excludePath = path.join(gitPath, 'info', 'exclude')
		} else {
			const gitDir = gitDirFromLinkFile(filesystem.readTextFile(gitPath))
			if (gitDir === null) return { ok: false, reason: `${gitPath} is a worktree link without a gitdir line` }
			const gitDirRoot = path.isAbsolute(gitDir) ? gitDir : path.resolve(workspaceRoot, gitDir)
			excludePath = path.join(gitDirRoot, 'info', 'exclude')
		}
		const existing = filesystem.kindOf(excludePath) === 'file' ? filesystem.readTextFile(excludePath) : ''
		if (containsOrchestrationEntry(existing)) return { ok: true, updated: false }
		filesystem.makeDirectory(path.dirname(excludePath))
		filesystem.writeTextFile(excludePath, `${existing}\n${EXCLUDE_MARKER}\n${EXCLUDE_ENTRY}\n`)
		return { ok: true, updated: true }
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) }
	}
}
