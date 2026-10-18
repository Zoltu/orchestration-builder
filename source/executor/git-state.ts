import * as path from 'node:path'
import { gitPrefix } from './git-primitives.js'
import type { SubprocessRunner } from './subprocess.js'

export interface WorkspaceGitState {
	isRepository: boolean
	unbornHead: boolean
	headHash?: string
	uncommittedPaths: string[]
}

export type ReadWorkspaceGitState = () => Promise<WorkspaceGitState>

export interface ReadWorkspaceGitStateConfig {
	workspaceRoot: string
	runner: SubprocessRunner
}

// A read-only git probe runs before the entry role and must never delay a run; this cap bounds a hung git without tying the probe to the executor's tool-timeout configuration.
const WORKSPACE_GIT_STATE_TIMEOUT_MS = 30_000

// Parses `git status --porcelain=v1` output into the changed paths. A rename entry reads `XY <old> -> <new>`, so the destination path is taken; quoted paths with special characters keep their surrounding quotes, which is enough to count and describe the dirty state.
function parsePorcelainPaths(stdout: string): string[] {
	const paths: string[] = []
	for (const line of stdout.split('\n')) {
		if (line.trim() === '') continue
		const entry = line.slice(3)
		const arrowIndex = entry.indexOf(' -> ')
		const candidate = arrowIndex === -1 ? entry : entry.slice(arrowIndex + 4)
		const trimmed = candidate.trim()
		if (trimmed !== '') paths.push(trimmed)
	}
	return paths
}

// Reads the workspace's git state once at run start: whether a repository exists, whether its HEAD is unborn, the HEAD hash when it resolves, and the changed paths. Every failure mode (no repository, git absent, a failed command) is a value, never a throw — the notice it feeds is advisory.
export function createReadWorkspaceGitState(config: ReadWorkspaceGitStateConfig): ReadWorkspaceGitState {
	const resolvedRoot = path.resolve(config.workspaceRoot)
	const runner = config.runner

	async function runGit(args: readonly string[]): Promise<{ exitCode: number | null; stdout: string } | null> {
		try {
			const outcome = await runner({ command: [...gitPrefix(), ...args], cwd: resolvedRoot, timeoutMs: WORKSPACE_GIT_STATE_TIMEOUT_MS })
			return { exitCode: outcome.exitCode, stdout: outcome.stdout }
		} catch {
			return null
		}
	}

	return async () => {
		const probe = await runGit(['rev-parse', '--is-inside-work-tree'])
		if (probe === null || probe.exitCode !== 0 || probe.stdout.trim() !== 'true') {
			return { isRepository: false, unbornHead: false, uncommittedPaths: [] }
		}
		const head = await runGit(['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'])
		const headHash = head !== null && head.exitCode === 0 ? head.stdout.trim() : ''
		const status = await runGit(['status', '--porcelain=v1'])
		const uncommittedPaths = status !== null && status.exitCode === 0 ? parsePorcelainPaths(status.stdout) : []
		return {
			isRepository: true,
			unbornHead: headHash === '',
			...(headHash !== '' ? { headHash } : {}),
			uncommittedPaths,
		}
	}
}

// The one-line git notice injected into the entry role's initial history, or undefined when there is nothing to say. A workspace with no repository injects nothing rather than a "not a git repository" line; an unborn repository and a clean one each get an accurate line, and a dirty one asks the role to handle the dirty state.
export function formatWorkspaceGitNotice(state: WorkspaceGitState): string | undefined {
	if (!state.isRepository) return undefined
	if (state.uncommittedPaths.length > 0) return 'This repository has some uncommitted changes. Before starting on the task, familiarize yourself with those changes and decide how to handle starting this task in a dirty state.'
	if (state.headHash === undefined) return 'The workspace git repository has no commits yet.'
	return `The workspace git repository is clean at ${state.headHash.slice(0, 7)}.`
}
