import * as fs from 'node:fs'
import * as path from 'node:path'
import { createToolError } from '../errors.js'
import type { ToolResult } from '../types.js'

export interface ResolvedPath {
	absolute: string
	relative: string
}

// The run-bookkeeping directory at the workspace top level. Only the top-level entry is reserved: a nested project/.orchestration/ is ordinary project content.
const ORCHESTRATION_DIR_NAME = '.orchestration'

// True only for the executor's own bookkeeping directory at the workspace top level. Relative paths come from path.relative and so carry the platform separator, which is normalized here the same way the walk tools normalize their output (nested .orchestration directories deliberately stay accessible).
export function isOrchestrationPath(relativePath: string): boolean {
	const normalized = relativePath.split(path.sep).join('/')
	return normalized === ORCHESTRATION_DIR_NAME || normalized.startsWith(`${ORCHESTRATION_DIR_NAME}/`)
}

export type PathResolution = { ok: true; path: ResolvedPath } | { ok: false; error: ToolResult }

// The existence/realpath pair resolveWithinWorkspace canonicalizes against. Injected so the escape logic is exercisable against a scripted filesystem rather than a real one.
export interface PathFilesystem {
	exists(candidate: string): boolean
	realpath(candidate: string): string
}

export const nodePathFilesystem: PathFilesystem = {
	exists: (candidate) => fs.existsSync(candidate),
	realpath: (candidate) => fs.realpathSync(candidate),
}

// The nearest existing ancestor of a path that may not exist yet (a file about to be written). Always terminates: every path eventually bottoms out at the filesystem root, which exists.
function nearestExistingAncestor(candidate: string, filesystem: PathFilesystem): string {
	let current = candidate
	while (!filesystem.exists(current)) {
		const parent = path.dirname(current)
		if (parent === current) return current
		current = parent
	}
	return current
}

// Resolves a caller-supplied path against the workspace root, rejecting escapes. Both the root and the candidate are canonicalized through realpath so a symlink cannot smuggle the candidate outside the workspace: the root is realpath'd (otherwise a symlinked root would make every legitimate path read as an escape), an existing candidate is realpath'd directly, and a not-yet-existing candidate (a file about to be written) is canonicalized through its nearest existing ancestor — without that, writing a new file under a symlinked directory inside the workspace would pass the lexical check and land outside the workspace.
export function resolveWithinWorkspace(targetPath: string, workspaceRoot: string, filesystem: PathFilesystem): PathResolution {
	const resolvedRoot = path.resolve(workspaceRoot)
	const realRoot = filesystem.exists(resolvedRoot) ? filesystem.realpath(resolvedRoot) : resolvedRoot
	const candidate = path.isAbsolute(targetPath)
		? path.resolve(targetPath)
		: path.resolve(realRoot, targetPath)
	let realCandidate = candidate
	if (filesystem.exists(candidate)) {
		realCandidate = filesystem.realpath(candidate)
	} else {
		const ancestor = nearestExistingAncestor(candidate, filesystem)
		realCandidate = path.join(filesystem.realpath(ancestor), path.relative(ancestor, candidate))
	}
	const relative = path.relative(realRoot, realCandidate)
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		return { ok: false, error: createToolError('invalid_arguments', `Path escapes the workspace: ${targetPath}`) }
	}
	// Checked after canonicalization so a symlink resolving into .orchestration is caught by the same refusal. The message is terminal on purpose: the directory is the executor's, so no phrasing may invite a retry.
	if (isOrchestrationPath(relative)) {
		return { ok: false, error: createToolError('permission_denied', `${targetPath} is inside .orchestration, the executor's bookkeeping directory, which cannot be accessed or modified`) }
	}
	return { ok: true, path: { absolute: realCandidate, relative } }
}

export function wrapIoError(error: unknown, fallbackMessage: string): ToolResult {
	const message = error instanceof Error ? error.message : fallbackMessage
	return createToolError('invalid_arguments', message)
}
