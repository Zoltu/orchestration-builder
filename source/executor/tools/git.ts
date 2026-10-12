import * as path from 'node:path'
import { createToolError } from '../errors.js'
import type { ToolHandler } from '../tool-dispatch.js'
import type { ToolResult } from '../types.js'
import { optionalPositiveInt, ORCHESTRATION_DIR_NAME } from './shared.js'
import { resolveToolTimeoutSeconds, truncateStreams, type SubprocessOutcome, type SubprocessRunner } from './subprocess-tool.js'

export interface GitToolsConfig {
	workspaceRoot: string
	defaultToolTimeoutSeconds: number
	runner: SubprocessRunner
	ensureOrchestrationExcluded: () => void
}

interface GitOperationData {
	// On a success result this is always 0: the empty-commit case, where git itself exits non-zero, is normalized to 0 because the handler reports it as a success and explains it in `message`.
	exitCode: number | null
	stdout: string
	stderr: string
	// Present only on git_commit's "nothing to commit" success, explaining why a success was reported despite git declining the commit.
	message?: string
}

// The fixed prefix silences the pager and repository hooks (including the fsmonitor hook) and pins identity/signing via `-c`, but it cannot stop a workspace repo's configured clean filter from running during `git add`, so staging a filtered path may still execute a workspace-chosen program.
function gitPrefix(): readonly string[] {
	return ['git', '--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'user.name=Adaptive Orchestrator', '-c', 'user.email=orchestrator@localhost', '-c', 'commit.gpgsign=false']
}

function buildStatusArgv(): readonly string[] {
	return [...gitPrefix(), 'status', '--porcelain=v1', '--branch', '--untracked-files=normal']
}

function buildLogArgv(count: number): readonly string[] {
	return [...gitPrefix(), 'log', '--oneline', '--decorate', '-n', String(count)]
}

function buildDiffArgv(options: { staged: boolean; paths: readonly string[] }): readonly string[] {
	const argv = [...gitPrefix(), 'diff', '--no-ext-diff', '--no-textconv']
	if (options.staged) argv.push('--staged')
	if (options.paths.length > 0) argv.push('--', ...options.paths)
	return argv
}

function buildInitArgv(): readonly string[] {
	return [...gitPrefix(), 'init']
}

function buildAddAllArgv(): readonly string[] {
	return [...gitPrefix(), 'add', '-A', '--', '.']
}

function buildCommitArgv(message: string): readonly string[] {
	return [...gitPrefix(), 'commit', '-m', message]
}

function buildBranchArgv(name: string): readonly string[] {
	return [...gitPrefix(), 'branch', '--', name]
}

const FORBIDDEN_BRANCH_CHARACTERS = new Set([' ', '~', '^', ':', '?', '*', '[', '\\'])

function isForbiddenBranchCharacter(character: string): boolean {
	if (FORBIDDEN_BRANCH_CHARACTERS.has(character)) return true
	const codePoint = character.codePointAt(0)
	if (codePoint === undefined) return false
	return codePoint < 0x20 || codePoint === 0x7f
}

// Conservative subset of git's ref-format rules: it refuses everything the documented rules clearly forbid, and git remains the final authority for the rest (an invalid name makes `git branch` exit non-zero, which the handler surfaces).
function isValidBranchName(name: string): boolean {
	if (name === '') return false
	if (name === '@' || name === 'HEAD') return false
	if (name.startsWith('-')) return false
	if (name.startsWith('/') || name.endsWith('/')) return false
	if (name.startsWith('.') || name.endsWith('.')) return false
	if (name.endsWith('.lock')) return false
	if (name.includes('..') || name.includes('@{') || name.includes('//')) return false
	for (const character of name) {
		if (isForbiddenBranchCharacter(character)) return false
	}
	for (const segment of name.split('/')) {
		if (segment.startsWith('.')) return false
	}
	return true
}

const MAX_COMMIT_MESSAGE_LENGTH = 1000

function isValidCommitMessage(message: string): boolean {
	if (message.trim() === '') return false
	if (message.length > MAX_COMMIT_MESSAGE_LENGTH) return false
	if (message.includes('\u0000')) return false
	return true
}

// Defense in depth over git's own pathspec refusal: a leading `:` (pathspec magic), an absolute POSIX or Windows path, a `..` segment, or the executor's bookkeeping segment is rejected before the argument reaches git. Segments are split on both separators so a `..\..` Windows-style escape is caught, and the `.orchestration` check is stricter than shared.ts's top-level-only predicate because a git pathspec names any segment.
function isSafeWorkspaceRelativePath(candidate: string): boolean {
	if (candidate === '') return false
	if (candidate.startsWith(':')) return false
	if (candidate.startsWith('/') || candidate.startsWith('\\')) return false
	if (/^[A-Za-z]:/.test(candidate)) return false
	for (const segment of candidate.split(/[\\/]/)) {
		if (segment === '..') return false
		if (segment === ORCHESTRATION_DIR_NAME) return false
	}
	return true
}

const DEFAULT_LOG_COUNT = 20
const MAX_LOG_COUNT = 100

type CommandOutcome = { ok: true; data: GitOperationData } | { ok: false; error: ToolResult }

type PathsResolution = { ok: true; paths: readonly string[] } | { ok: false; error: ToolResult }

function parseDiffPaths(value: unknown): PathsResolution {
	if (value === undefined) return { ok: true, paths: [] }
	if (!Array.isArray(value)) {
		return { ok: false, error: createToolError('invalid_arguments', 'paths must be an array of workspace-relative path strings') }
	}
	const paths: string[] = []
	for (const entry of value) {
		if (typeof entry !== 'string' || !isSafeWorkspaceRelativePath(entry)) {
			return { ok: false, error: createToolError('invalid_arguments', 'paths must be workspace-relative strings that do not escape the workspace') }
		}
		paths.push(entry)
	}
	return { ok: true, paths }
}

const NOTHING_TO_COMMIT_PHRASES = ['nothing to commit', 'no changes added to commit']

// git exits 1 with one of these phrases when an empty commit is attempted; requiring both the exit code and a known phrase keeps an unrelated failure from being read as the benign case.
function isNothingToCommit(data: GitOperationData): boolean {
	if (data.exitCode !== 1) return false
	const combined = `${data.stdout}\n${data.stderr}`.toLowerCase()
	return NOTHING_TO_COMMIT_PHRASES.some((phrase) => combined.includes(phrase))
}

function signalTerminationError(operationName: string): ToolResult {
	return createToolError('unavailable', `git ${operationName} was terminated by a signal`)
}

// Leads with git's own stderr when it has something to say, so the model reads the real reason (e.g. "not a git repository"); the structured exit code and full stderr ride in details.
function nonZeroExitError(operationName: string, data: GitOperationData): ToolResult {
	const reason = data.stderr.trim()
	const message = reason !== '' ? reason : `git ${operationName} failed (exit code ${data.exitCode})`
	return createToolError('invalid_arguments', message, { exitCode: data.exitCode, stderr: data.stderr })
}

export function createGitTools(config: GitToolsConfig): Record<string, ToolHandler> {
	const resolvedRoot = path.resolve(config.workspaceRoot)
	const defaultTimeoutSeconds = config.defaultToolTimeoutSeconds
	const runner = config.runner

	async function runCommand(argv: readonly string[], timeoutSeconds: number): Promise<CommandOutcome> {
		let outcome: SubprocessOutcome
		try {
			outcome = await runner({ command: argv, cwd: resolvedRoot, timeoutMs: timeoutSeconds * 1000 })
		} catch (error) {
			const message = error instanceof Error ? error.message : 'spawn failed'
			return { ok: false, error: createToolError('unavailable', `git failed to run: ${message}`) }
		}
		if (outcome.timedOut) {
			return { ok: false, error: createToolError('timeout', `git timed out after ${timeoutSeconds}s`, { afterSeconds: timeoutSeconds }) }
		}
		const streams = truncateStreams(outcome)
		return { ok: true, data: { exitCode: outcome.exitCode, stdout: streams.stdout, stderr: streams.stderr } }
	}

	async function runRequiringSuccess(argv: readonly string[], operationName: string, timeoutSeconds: number): Promise<CommandOutcome> {
		const outcome = await runCommand(argv, timeoutSeconds)
		if (!outcome.ok) return outcome
		if (outcome.data.exitCode === null) return { ok: false, error: signalTerminationError(operationName) }
		if (outcome.data.exitCode !== 0) return { ok: false, error: nonZeroExitError(operationName, outcome.data) }
		return outcome
	}

	const gitStatus: ToolHandler = async (args) => {
		const timeout = resolveToolTimeoutSeconds(args, defaultTimeoutSeconds)
		if (!timeout.ok) return timeout.error
		const outcome = await runRequiringSuccess(buildStatusArgv(), 'status', timeout.timeoutSeconds)
		if (!outcome.ok) return outcome.error
		return { kind: 'success', data: outcome.data }
	}

	const gitLog: ToolHandler = async (args) => {
		const count = optionalPositiveInt(args['count'], DEFAULT_LOG_COUNT)
		if (count === null || count > MAX_LOG_COUNT) {
			return createToolError('invalid_arguments', `count must be a positive integer no greater than ${MAX_LOG_COUNT}`)
		}
		const timeout = resolveToolTimeoutSeconds(args, defaultTimeoutSeconds)
		if (!timeout.ok) return timeout.error
		const outcome = await runRequiringSuccess(buildLogArgv(count), 'log', timeout.timeoutSeconds)
		if (!outcome.ok) return outcome.error
		return { kind: 'success', data: outcome.data }
	}

	const gitDiff: ToolHandler = async (args) => {
		const stagedRaw = args['staged']
		if (stagedRaw !== undefined && typeof stagedRaw !== 'boolean') {
			return createToolError('invalid_arguments', 'staged must be a boolean when present')
		}
		const paths = parseDiffPaths(args['paths'])
		if (!paths.ok) return paths.error
		const timeout = resolveToolTimeoutSeconds(args, defaultTimeoutSeconds)
		if (!timeout.ok) return timeout.error
		const outcome = await runRequiringSuccess(buildDiffArgv({ staged: stagedRaw === true, paths: paths.paths }), 'diff', timeout.timeoutSeconds)
		if (!outcome.ok) return outcome.error
		return { kind: 'success', data: outcome.data }
	}

	const gitInit: ToolHandler = async (args) => {
		const timeout = resolveToolTimeoutSeconds(args, defaultTimeoutSeconds)
		if (!timeout.ok) return timeout.error
		const outcome = await runRequiringSuccess(buildInitArgv(), 'init', timeout.timeoutSeconds)
		if (!outcome.ok) return outcome.error
		// A fresh init has no exclude entry yet because the startup exclusion ran before `.git` existed, so it must be re-ensured or the next `git add -A` would commit run bookkeeping.
		config.ensureOrchestrationExcluded()
		return { kind: 'success', data: outcome.data }
	}

	const gitCommit: ToolHandler = async (args) => {
		const message = args['message']
		if (typeof message !== 'string' || !isValidCommitMessage(message)) {
			return createToolError('invalid_arguments', `message must be a non-empty string of at most ${MAX_COMMIT_MESSAGE_LENGTH} characters with no NUL`)
		}
		const timeout = resolveToolTimeoutSeconds(args, defaultTimeoutSeconds)
		if (!timeout.ok) return timeout.error
		const add = await runRequiringSuccess(buildAddAllArgv(), 'add', timeout.timeoutSeconds)
		if (!add.ok) return add.error
		const commit = await runCommand(buildCommitArgv(message), timeout.timeoutSeconds)
		if (!commit.ok) return commit.error
		if (commit.data.exitCode === null) return signalTerminationError('commit')
		if (commit.data.exitCode === 0) return { kind: 'success', data: commit.data }
		if (isNothingToCommit(commit.data)) return { kind: 'success', data: { exitCode: 0, stdout: commit.data.stdout, stderr: commit.data.stderr, message: 'Nothing to commit: the working tree had no changes, so git declined to create an empty commit.' } }
		return nonZeroExitError('commit', commit.data)
	}

	const gitBranch: ToolHandler = async (args) => {
		const name = args['name']
		if (typeof name !== 'string' || !isValidBranchName(name)) {
			return createToolError('invalid_arguments', 'name must be a valid git branch name')
		}
		const timeout = resolveToolTimeoutSeconds(args, defaultTimeoutSeconds)
		if (!timeout.ok) return timeout.error
		const outcome = await runRequiringSuccess(buildBranchArgv(name), 'branch', timeout.timeoutSeconds)
		if (!outcome.ok) return outcome.error
		return { kind: 'success', data: outcome.data }
	}

	return {
		git_status: gitStatus,
		git_log: gitLog,
		git_diff: gitDiff,
		git_init: gitInit,
		git_commit: gitCommit,
		git_branch: gitBranch,
	}
}
