import * as fs from 'node:fs'
import * as path from 'node:path'
import { createToolError } from '../errors.js'
import type { ToolResult } from '../types.js'

export interface ResolvedPath {
	absolute: string
	relative: string
}

export type PathResolution = { ok: true; path: ResolvedPath } | { ok: false; error: ToolResult }

export function resolveWithinWorkspace(targetPath: string, workspaceRoot: string): PathResolution {
	const resolvedRoot = path.resolve(workspaceRoot)
	const candidate = path.isAbsolute(targetPath)
		? path.resolve(targetPath)
		: path.resolve(resolvedRoot, targetPath)
	let realCandidate = candidate
	if (fs.existsSync(candidate)) {
		realCandidate = fs.realpathSync(candidate)
	}
	const relative = path.relative(resolvedRoot, realCandidate)
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		return { ok: false, error: createToolError('invalid_arguments', `Path escapes the workspace: ${targetPath}`) }
	}
	return { ok: true, path: { absolute: realCandidate, relative } }
}

export function wrapIoError(error: unknown, fallbackMessage: string): ToolResult {
	const message = error instanceof Error ? error.message : fallbackMessage
	return createToolError('invalid_arguments', message)
}
