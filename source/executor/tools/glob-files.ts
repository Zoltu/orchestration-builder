import * as fs from 'node:fs'
import * as path from 'node:path'
import { createToolError } from '../errors.js'
import type { ToolHandler } from '../tool-dispatch.js'
import { isOrchestrationPath } from './shared.js'

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

// A matcher containing no "/" anchors to single path segments, so it can prune the walk by directory name; a matcher containing "/" anchors to the whole workspace-relative path and only filters results, because pruning happens on bare entry names before any relative path exists.
interface ExcludeMatchers {
	pathMatchers: RegExp[]
	segmentMatchers: RegExp[]
}

// Fresh object per call rather than a shared constant: compileExcludeMatchers pushes into the arrays it starts from, so a module-level value would alias and grow across calls.
function emptyExcludeMatchers(): ExcludeMatchers {
	return { pathMatchers: [], segmentMatchers: [] }
}

function compileExcludeMatchers(exclude: string[]): ExcludeMatchers {
	const matchers = emptyExcludeMatchers()
	for (const matcher of exclude) {
		const regex = globToRegex(matcher)
		if (matcher.includes('/')) matchers.pathMatchers.push(regex)
		else matchers.segmentMatchers.push(regex)
	}
	return matchers
}

function isExcluded(relativePath: string, matchers: ExcludeMatchers): boolean {
	for (const regex of matchers.pathMatchers) {
		if (regex.test(relativePath)) return true
	}
	for (const segment of relativePath.split('/')) {
		for (const regex of matchers.segmentMatchers) {
			if (regex.test(segment)) return true
		}
	}
	return false
}

// Only segment matchers prune: a path matcher like **/*.md legitimately matches a directory name, but stopping the walk there would also drop files below it that the include pattern still wants.
function prunesWalk(directoryName: string, matchers: ExcludeMatchers): boolean {
	return matchers.segmentMatchers.some((regex) => regex.test(directoryName))
}

// Pruning is safe against directory symlinks: withFileTypes dirents report their own type without following the link, so a symlinked directory never satisfies isDirectory() and is never descended into.
function walkFiles(root: string, baseDir: string, filesystem: GlobFilesystem, matchers: ExcludeMatchers): string[] {
	const results: string[] = []
	for (const entry of filesystem.listEntries(baseDir)) {
		const full = path.join(baseDir, entry.name)
		if (entry.isDirectory()) {
			if (prunesWalk(entry.name, matchers)) continue
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
		let excludeMatchers = emptyExcludeMatchers()
		const excludeValue = args['exclude']
		if (excludeValue !== undefined) {
			if (!Array.isArray(excludeValue) || !excludeValue.every((entry): entry is string => typeof entry === 'string' && entry !== '')) {
				return createToolError('invalid_arguments', 'exclude must be an array of non-empty strings')
			}
			try {
				excludeMatchers = compileExcludeMatchers(excludeValue)
			} catch (error) {
				const message = error instanceof Error ? error.message : 'invalid glob'
				return createToolError('invalid_arguments', `Invalid exclude pattern: ${message}`)
			}
		}
		try {
			const regex = globToRegex(patternValue)
			let files: string[]
			try {
				files = walkFiles(resolvedRoot, resolvedRoot, filesystem, excludeMatchers)
			} catch (error) {
				const message = error instanceof Error ? error.message : 'cannot walk workspace'
				return createToolError('invalid_arguments', `Cannot glob files: ${message}`)
			}
			const matched = files.filter((file) => regex.test(file) && !isExcluded(file, excludeMatchers))
			matched.sort()
			return { kind: 'success', data: matched }
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Invalid pattern'
			return createToolError('invalid_arguments', `Invalid pattern: ${message}`)
		}
	}
}
