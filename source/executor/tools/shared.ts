import * as fs from 'node:fs'
import * as path from 'node:path'
import { createToolError } from '../errors.js'
import type { ToolResult } from '../types.js'

export interface ResolvedPath {
	absolute: string
	relative: string
}

export type PathResolution = { ok: true; path: ResolvedPath } | { ok: false; error: ToolResult }

// The nearest existing ancestor of a path that may not exist yet (a file about to be written). Always terminates: every path eventually bottoms out at the filesystem root, which exists.
function nearestExistingAncestor(candidate: string): string {
	let current = candidate
	while (!fs.existsSync(current)) {
		const parent = path.dirname(current)
		if (parent === current) return current
		current = parent
	}
	return current
}

// Resolves a caller-supplied path against the workspace root, rejecting escapes. Both the root and the candidate are canonicalized through realpath so a symlink cannot smuggle the candidate outside the workspace: the root is realpath'd (otherwise a symlinked root would make every legitimate path read as an escape), an existing candidate is realpath'd directly, and a not-yet-existing candidate (a file about to be written) is canonicalized through its nearest existing ancestor — without that, writing a new file under a symlinked directory inside the workspace would pass the lexical check and land outside the workspace.
export function resolveWithinWorkspace(targetPath: string, workspaceRoot: string): PathResolution {
	const resolvedRoot = path.resolve(workspaceRoot)
	const realRoot = fs.existsSync(resolvedRoot) ? fs.realpathSync(resolvedRoot) : resolvedRoot
	const candidate = path.isAbsolute(targetPath)
		? path.resolve(targetPath)
		: path.resolve(realRoot, targetPath)
	let realCandidate = candidate
	if (fs.existsSync(candidate)) {
		realCandidate = fs.realpathSync(candidate)
	} else {
		const ancestor = nearestExistingAncestor(candidate)
		realCandidate = path.join(fs.realpathSync(ancestor), path.relative(ancestor, candidate))
	}
	const relative = path.relative(realRoot, realCandidate)
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		return { ok: false, error: createToolError('invalid_arguments', `Path escapes the workspace: ${targetPath}`) }
	}
	return { ok: true, path: { absolute: realCandidate, relative } }
}

export function wrapIoError(error: unknown, fallbackMessage: string): ToolResult {
	const message = error instanceof Error ? error.message : fallbackMessage
	return createToolError('invalid_arguments', message)
}
