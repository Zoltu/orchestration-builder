import * as path from 'node:path'
import { createToolError } from '../errors.js'
import type { RunBaseTracker } from '../base-state.js'
import { EMPTY_TREE_HASH, gitPrefix } from '../git-primitives.js'
import type { ToolHandler } from './tool-dispatch.js'
import type { ToolResult } from '../types.js'
import { optionalPositiveInt } from './shared.js'
import { ORCHESTRATION_DIR_NAME } from '../workspace-path.js'
import { resolveToolTimeoutSeconds, truncateStreams } from './subprocess-tool.js'
import type { SubprocessOutcome, SubprocessRunner } from '../subprocess.js'

export interface GitToolsConfig {
	workspaceRoot: string
	defaultToolTimeoutSeconds: number
	runner: SubprocessRunner
	ensureOrchestrationExcluded: () => void
	baseTracker: RunBaseTracker
}

interface GitOperationData {
	// On a success result this is always 0: the empty-commit case, where git itself exits non-zero, is normalized to 0 because the handler reports it as a success and explains it in `message`.
	exitCode: number | null
	stdout: string
	stderr: string
	// Present only on git_commit's "nothing to commit" success, explaining why a success was reported despite git declining the commit.
	message?: string
}

function buildStatusArgv(): readonly string[] {
	return [...gitPrefix(), 'status', '--porcelain=v1', '--branch', '--untracked-files=normal']
}

function buildLogArgv(count: number): readonly string[] {
	return [...gitPrefix(), 'log', '--oneline', '--decorate', '-n', String(count)]
}

interface DiffArgvOptions {
	staged?: boolean
	ref?: string
	nameStatus?: boolean
	paths: readonly string[]
}

// The one diff builder shared by git_diff, git_changes_since_base, and git_uncommitted_changes: the base flags are fixed, then the optional --staged, --name-status, and comparison ref, then the pathspec behind the `--` sentinel.
function buildDiffArgv(options: DiffArgvOptions): readonly string[] {
	const argv = [...gitPrefix(), 'diff', '--no-ext-diff', '--no-textconv']
	if (options.staged === true) argv.push('--staged')
	if (options.nameStatus === true) argv.push('--name-status')
	if (options.ref !== undefined) argv.push(options.ref)
	if (options.paths.length > 0) argv.push('--', ...options.paths)
	return argv
}

// Resolves a revision to its commit hash. --end-of-options stops a caller-supplied ref from being read as an option even though the caller validates it first; the ^{commit} peel forces a commit rather than a tree/blob so an annotated tag or tree name does not silently become the base.
function buildResolveCommitArgv(ref: string): readonly string[] {
	return [...gitPrefix(), 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]
}

function buildInsideWorkTreeArgv(): readonly string[] {
	return [...gitPrefix(), 'rev-parse', '--is-inside-work-tree']
}

// Lists files git does not track yet: `git diff` cannot see them, yet a run that only calls write_file leaves exactly these, so the change tools must surface them. --exclude-standard honors .gitignore and the workspace's .git/info/exclude (where .orchestration lives), and each returned path is re-checked through the workspace-relative guard as defense in depth.
function buildUntrackedFilesArgv(paths: readonly string[]): readonly string[] {
	const argv = [...gitPrefix(), 'ls-files', '--others', '--exclude-standard']
	if (paths.length > 0) argv.push('--', ...paths)
	return argv
}

// A workspace can leave thousands of untracked files (a build output tree, a vendored checkout), and expanding each to a full diff would spawn one git process per file, so only a bounded prefix is diffed and the remainder is reported as an omission. The name-status list is unaffected: it comes from a single ls-files call and still names every untracked path.
const MAX_UNTRACKED_DIFFS = 10

// Renders one untracked file as a full unified diff against the empty file, the way `git diff` would show a newly added tracked path. --no-index compares two filesystem paths outside the index and exits 1 both when the files differ and on an access error, so callers accept exit 0 or 1 and require non-empty stdout before treating the output as a diff.
function buildUntrackedDiffArgv(path: string): readonly string[] {
	return [...gitPrefix(), 'diff', '--no-ext-diff', '--no-textconv', '--no-index', '--', '/dev/null', path]
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

// The conservative ref vocabulary git_set_base accepts before git itself sees the argument: a leading `-` (which would read as an option) and any character outside the safe revision set are refused, and git remains the final authority for names that pass but do not resolve.
const BASE_REF_PATTERN = /^[A-Za-z0-9._/-]+$/

function isValidBaseRef(ref: string): boolean {
	if (ref === '') return false
	if (ref.startsWith('-')) return false
	return BASE_REF_PATTERN.test(ref)
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

// A success result whose stdout is a single explanatory sentence rather than diff output, for the git-absent cases the diff tools degrade to instead of erroring.
function diffAbsenceResult(message: string): GitOperationData {
	return { exitCode: 0, stdout: message, stderr: '' }
}

// Joins two stdout fragments with a single newline between them, dropping empty fragments and their trailing newlines so the merged text reads as one list.
function joinStdoutFragments(first: string, second: string): string {
	const head = first.replace(/\n+$/, '')
	const tail = second.replace(/\n+$/, '')
	if (head === '') return tail
	if (tail === '') return head
	return `${head}\n${tail}`
}

// The porcelain marker `??` prefixes each untracked path so the merged list distinguishes a file git has never tracked from a tracked-path modification.
function formatUntrackedNameStatus(untrackedPaths: readonly string[]): string {
	return untrackedPaths.map((untrackedPath) => `??\t${untrackedPath}`).join('\n')
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

	// The comparison ref for git_uncommitted_changes: HEAD when it resolves, the empty tree when the repository has no commits yet, or null when the workspace is not a git repository at all. It is resolved per call rather than read from the base tracker because git may be initialized mid-run, after the base was recorded.
	async function resolveUncommittedRef(timeoutSeconds: number): Promise<string | null> {
		const probe = await runCommand(buildInsideWorkTreeArgv(), timeoutSeconds)
		if (!probe.ok) return null
		if (probe.data.exitCode !== 0 || probe.data.stdout.trim() !== 'true') return null
		const head = await runCommand(buildResolveCommitArgv('HEAD'), timeoutSeconds)
		if (!head.ok || head.data.exitCode !== 0 || head.data.stdout.trim() === '') return EMPTY_TREE_HASH
		return 'HEAD'
	}

	// The untracked files a diff cannot see, filtered through the same workspace-relative guard the pathspecs use. A failed listing degrades to none rather than failing the whole tool.
	async function listUntrackedPaths(paths: readonly string[], timeoutSeconds: number): Promise<string[]> {
		const outcome = await runCommand(buildUntrackedFilesArgv(paths), timeoutSeconds)
		if (!outcome.ok || outcome.data.exitCode !== 0) return []
		const untracked: string[] = []
		for (const line of outcome.data.stdout.split('\n')) {
			const candidate = line.trim()
			if (candidate === '') continue
			if (!isSafeWorkspaceRelativePath(candidate)) continue
			untracked.push(candidate)
		}
		return untracked
	}

	// The full unified diffs of the untracked files, concatenated. `git diff --no-index` exits 1 both when the files differ — the normal case — and on an access error, so both 0 and 1 are accepted; a non-empty stdout is required so an access failure is skipped rather than injected as a bogus diff. Only the first MAX_UNTRACKED_DIFFS files are expanded; the rest are summarized in a trailing note.
	async function collectUntrackedDiffs(untrackedPaths: readonly string[], timeoutSeconds: number): Promise<string> {
		const fragments: string[] = []
		const expandedPaths = untrackedPaths.slice(0, MAX_UNTRACKED_DIFFS)
		for (const untrackedPath of expandedPaths) {
			const outcome = await runCommand(buildUntrackedDiffArgv(untrackedPath), timeoutSeconds)
			if (!outcome.ok) continue
			if (outcome.data.exitCode !== 0 && outcome.data.exitCode !== 1) continue
			if (outcome.data.stdout.trim() !== '') fragments.push(outcome.data.stdout)
		}
		const omittedCount = untrackedPaths.length - expandedPaths.length
		if (omittedCount > 0) {
			fragments.push(`[${omittedCount} more untracked file ${omittedCount === 1 ? 'diff' : 'diffs'} omitted; the name-status list names every untracked path.]`)
		}
		return fragments.join('\n')
	}

	// Runs the tracked diff against ref, then appends the untracked files git diff cannot show: `??\t<path>` lines in name-status mode, or each file's full diff in includeDiff mode. Shared by git_changes_since_base and git_uncommitted_changes, which differ only in the ref they compare against.
	async function runDiffIncludingUntracked(ref: string, includeDiff: boolean, paths: readonly string[], timeoutSeconds: number): Promise<CommandOutcome> {
		const outcome = await runRequiringSuccess(buildDiffArgv({ ref, nameStatus: !includeDiff, paths }), 'diff', timeoutSeconds)
		if (!outcome.ok) return outcome
		const untrackedPaths = await listUntrackedPaths(paths, timeoutSeconds)
		if (untrackedPaths.length === 0) return outcome
		const untrackedText = includeDiff ? await collectUntrackedDiffs(untrackedPaths, timeoutSeconds) : formatUntrackedNameStatus(untrackedPaths)
		return { ok: true, data: { ...outcome.data, stdout: joinStdoutFragments(outcome.data.stdout, untrackedText) } }
	}

	const gitSetBase: ToolHandler = async (args) => {
		const refRaw = args['ref']
		const ref = refRaw === undefined ? 'HEAD' : refRaw
		if (typeof ref !== 'string' || !isValidBaseRef(ref)) {
			return createToolError('invalid_arguments', 'ref must be a non-empty git revision of letters, digits, dot, slash, underscore, or hyphen that does not start with a hyphen')
		}
		const timeout = resolveToolTimeoutSeconds(args, defaultTimeoutSeconds)
		if (!timeout.ok) return timeout.error
		const outcome = await runRequiringSuccess(buildResolveCommitArgv(ref), 'rev-parse', timeout.timeoutSeconds)
		if (!outcome.ok) return outcome.error
		const hash = outcome.data.stdout.trim()
		if (hash === '') return createToolError('invalid_arguments', `git could not resolve "${ref}" to a commit hash`)
		config.baseTracker.baseHash = hash
		return { kind: 'success', data: { ...outcome.data, stdout: hash } }
	}

	const gitChangesSinceBase: ToolHandler = async (args) => {
		const includeDiff = args['includeDiff']
		if (includeDiff !== undefined && typeof includeDiff !== 'boolean') {
			return createToolError('invalid_arguments', 'includeDiff must be a boolean when present')
		}
		const paths = parseDiffPaths(args['paths'])
		if (!paths.ok) return paths.error
		const timeout = resolveToolTimeoutSeconds(args, defaultTimeoutSeconds)
		if (!timeout.ok) return timeout.error
		const base = config.baseTracker.baseHash
		if (base === undefined) return { kind: 'success', data: diffAbsenceResult('No base commit is recorded for this run, so there are no changes to show; the workspace may not be a git repository.') }
		const outcome = await runDiffIncludingUntracked(base, includeDiff === true, paths.paths, timeout.timeoutSeconds)
		if (!outcome.ok) return outcome.error
		return { kind: 'success', data: outcome.data }
	}

	const gitUncommittedChanges: ToolHandler = async (args) => {
		const includeDiff = args['includeDiff']
		if (includeDiff !== undefined && typeof includeDiff !== 'boolean') {
			return createToolError('invalid_arguments', 'includeDiff must be a boolean when present')
		}
		const paths = parseDiffPaths(args['paths'])
		if (!paths.ok) return paths.error
		const timeout = resolveToolTimeoutSeconds(args, defaultTimeoutSeconds)
		if (!timeout.ok) return timeout.error
		const ref = await resolveUncommittedRef(timeout.timeoutSeconds)
		if (ref === null) return { kind: 'success', data: diffAbsenceResult('The workspace is not a git repository, so there are no uncommitted changes to show.') }
		const outcome = await runDiffIncludingUntracked(ref, includeDiff === true, paths.paths, timeout.timeoutSeconds)
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
		git_set_base: gitSetBase,
		git_changes_since_base: gitChangesSinceBase,
		git_uncommitted_changes: gitUncommittedChanges,
	}
}
