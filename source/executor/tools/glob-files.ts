import * as fs from 'node:fs'
import * as path from 'node:path'
import { createToolError } from '../errors.js'
import type { ToolHandler } from '../tool-dispatch.js'

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

function globToRegex(pattern: string): RegExp {
	let regex = ''
	let i = 0
	while (i < pattern.length) {
		const char = pattern[i]
		if (char === '*' && pattern[i + 1] === '*') {
			const atSegmentStart = i === 0 || pattern[i - 1] === '/'
			if (atSegmentStart && pattern[i + 2] === '/') {
				// A whole-segment `**/` spans zero or more complete segments, so `**/*.ts` must also match a root-level `a.ts`.
				regex += '(?:[^/]+/)*'
				i += 3
				continue
			}
			// A trailing whole-segment `**` and a `**` inside a segment keep the historical `.*`: after the literal `dir/` prefix a zero-segment match would leave a dangling slash no walked path has, so `dir/**` cannot match `dir` itself.
			regex += '.*'
			i += 2
			continue
		}
		if (char === '*') {
			regex += '[^/]*'
			i++
			continue
		}
		if (char === '?') {
			regex += '[^/]'
			i++
			continue
		}
		if (char === '[') {
			const close = pattern.indexOf(']', i)
			if (close === -1) {
				regex += '\\['
				i++
				continue
			}
			regex += pattern.slice(i, close + 1)
			i = close + 1
			continue
		}
		if (char === '{') {
			const close = pattern.indexOf('}', i)
			if (close === -1) {
				regex += '\\{'
				i++
				continue
			}
			const inner = pattern.slice(i + 1, close)
			const alternatives = inner.split(',').map((alt) => alt.replace(/[.+^$()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
			regex += '(?:' + alternatives.join('|') + ')'
			i = close + 1
			continue
		}
		if (char === '.' || char === '+' || char === '(' || char === ')' || char === '|' || char === '^' || char === '$' || char === '\\') {
			regex += '\\' + char
			i++
			continue
		}
		regex += char
		i++
	}
	return new RegExp('^' + regex + '$')
}

function walkFiles(root: string, baseDir: string, filesystem: GlobFilesystem): string[] {
	const results: string[] = []
	for (const entry of filesystem.listEntries(baseDir)) {
		const full = path.join(baseDir, entry.name)
		if (entry.isDirectory()) {
			results.push(...walkFiles(root, full, filesystem))
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
		try {
			const regex = globToRegex(patternValue)
			let files: string[]
			try {
				files = walkFiles(resolvedRoot, resolvedRoot, filesystem)
			} catch (error) {
				const message = error instanceof Error ? error.message : 'cannot walk workspace'
				return createToolError('invalid_arguments', `Cannot glob files: ${message}`)
			}
			const matched = files.filter((file) => regex.test(file))
			matched.sort()
			return { kind: 'success', data: matched }
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Invalid pattern'
			return createToolError('invalid_arguments', `Invalid pattern: ${message}`)
		}
	}
}
