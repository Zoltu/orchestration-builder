import * as fs from 'node:fs'
import * as path from 'node:path'
import { createToolError } from '../../shared/errors.js'
import type { ToolResult } from '../../shared/types.js'

export interface ResolvedPath {
	absolute: string
	relative: string
}

export function resolveWithinWorkspace(targetPath: string, workspaceRoot: string): ResolvedPath {
	const resolvedRoot = path.resolve(workspaceRoot)
	const candidate = path.isAbsolute(targetPath)
		? path.resolve(targetPath)
		: path.resolve(resolvedRoot, targetPath)
	const relative = path.relative(resolvedRoot, candidate)
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		throw createToolError('invalid_arguments', `Path escapes the workspace: ${targetPath}`)
	}
	return { absolute: candidate, relative }
}

export function assertWithinWorkspace(targetPath: string, workspaceRoot: string): ResolvedPath {
	const resolvedRoot = path.resolve(workspaceRoot)
	const candidate = path.isAbsolute(targetPath)
		? path.resolve(targetPath)
		: path.resolve(resolvedRoot, targetPath)
	let realCandidate: string
	try {
		realCandidate = fs.realpathSync(candidate)
	} catch {
		realCandidate = candidate
	}
	const relative = path.relative(resolvedRoot, realCandidate)
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		throw createToolError('invalid_arguments', `Path escapes the workspace: ${targetPath}`)
	}
	return { absolute: realCandidate, relative }
}

export function wrapToolError(error: unknown, fallbackMessage: string): ToolResult {
	if (error && typeof error === 'object' && 'kind' in error) {
		const maybe = error as { kind: string; message?: string; details?: unknown }
		if (maybe.kind !== 'success' && typeof maybe.kind === 'string') {
			return { kind: maybe.kind as ToolResult['kind'], message: maybe.message ?? fallbackMessage, details: maybe.details }
		}
	}
	const message = error instanceof Error ? error.message : fallbackMessage
	return createToolError('invalid_arguments', message)
}