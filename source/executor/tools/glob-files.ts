import * as fs from 'node:fs'
import * as path from 'node:path'
import { createToolError } from '../errors.js'
import type { ToolHandler } from './tool-dispatch.js'
import { isOrchestrationPath } from '../workspace-path.js'
import { compileGlobMatchers, compileGlobPattern, matchesGlobPath, matchesGlobSegment, type GlobMatchers } from './glob-pattern.js'

// Only the dirent surface the walk consumes: fs.Dirent satisfies it structurally, and tests script it in memory.
export interface WalkEntry {
	name: string
	isDirectory(): boolean
	isFile(): boolean
}

// Injected so the recursive walk is exercisable against a scripted filesystem rather than a real one, mirroring the PathFilesystem precedent in shared.ts.
export interface GlobFilesystem {
	listEntries(directory: string): WalkEntry[]
}

export const nodeGlobFilesystem: GlobFilesystem = {
	listEntries: (directory) => fs.readdirSync(directory, { withFileTypes: true }),
}

// Pruning is safe against directory symlinks: withFileTypes dirents report their own type without following the link, so a symlinked directory never satisfies isDirectory() and is never descended into.
function walkFiles(root: string, baseDir: string, filesystem: GlobFilesystem, matchers: GlobMatchers): string[] {
	const results: string[] = []
	for (const entry of filesystem.listEntries(baseDir)) {
		const full = path.join(baseDir, entry.name)
		if (entry.isDirectory()) {
			if (matchesGlobSegment(entry.name, matchers)) continue
			// The executor's bookkeeping directory is invisible to the walk the same way it is to the path-resolution chokepoint; a nested project/.orchestration/ has a different relative path and stays walkable.
			if (isOrchestrationPath(path.relative(root, full).split(path.sep).join('/'))) continue
			results.push(...walkFiles(root, full, filesystem, matchers))
		} else if (entry.isFile()) {
			results.push(path.relative(root, full).split(path.sep).join('/'))
		}
	}
	return results
}

export function createGlobFiles(workspaceRoot: string, filesystem: GlobFilesystem): ToolHandler {
	const resolvedRoot = path.resolve(workspaceRoot)
	return (args) => {
		const patternValue = args['pattern']
		if (typeof patternValue !== 'string' || patternValue === '') {
			return createToolError('invalid_arguments', 'pattern must be a non-empty string')
		}
		let excludeMatchers = compileGlobMatchers([])
		const excludeValue = args['exclude']
		if (excludeValue !== undefined) {
			if (!Array.isArray(excludeValue) || !excludeValue.every((entry): entry is string => typeof entry === 'string' && entry !== '')) {
				return createToolError('invalid_arguments', 'exclude must be an array of non-empty strings')
			}
			try {
				excludeMatchers = compileGlobMatchers(excludeValue)
			} catch (error) {
				const message = error instanceof Error ? error.message : 'invalid glob'
				return createToolError('invalid_arguments', `Invalid exclude pattern: ${message}`)
			}
		}
		try {
			const regex = compileGlobPattern(patternValue)
			let files: string[]
			try {
				files = walkFiles(resolvedRoot, resolvedRoot, filesystem, excludeMatchers)
			} catch (error) {
				const message = error instanceof Error ? error.message : 'cannot walk workspace'
				return createToolError('invalid_arguments', `Cannot glob files: ${message}`)
			}
			const matched = files.filter((file) => regex.test(file) && !matchesGlobPath(file, excludeMatchers))
			matched.sort()
			return { kind: 'success', data: matched }
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Invalid pattern'
			return createToolError('invalid_arguments', `Invalid pattern: ${message}`)
		}
	}
}
