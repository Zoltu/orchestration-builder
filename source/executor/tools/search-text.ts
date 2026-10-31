import * as fs from 'node:fs'
import * as path from 'node:path'
import { createToolError } from '../errors.js'
import type { ToolHandler } from './tool-dispatch.js'
import type { FileLines } from './file-lines.js'
import { wrapIoError } from './shared.js'
import { isOrchestrationPath, type PathFilesystem, resolveWithinWorkspace } from '../workspace-path.js'

export interface SearchMatch {
	path: string
	line: number
	text: string
}

const DEFAULT_EXTENSIONS = new Set(['.txt', '.md', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.py', '.rs', '.go', '.java', '.c', '.h', '.cpp', '.hpp', '.yaml', '.yml', '.toml', '.cfg', '.ini', '.sh', '.html', '.css', '.xml'])

const MAX_MATCHES_PER_FILE = 100

const MAX_TOTAL_MATCHES = 1000

const MAX_SEARCH_LINE_CHARS = 1024 * 1024

const MAX_MATCH_TEXT_CHARS = 2000

function isSearchable(filePath: string): boolean {
	const extension = path.extname(filePath).toLowerCase()
	return DEFAULT_EXTENSIONS.has(extension)
}

export interface SearchDirectoryEntry {
	name: string
	isDirectory(): boolean
	isFile(): boolean
}

export interface SearchFilesystem {
	listEntries(directory: string): SearchDirectoryEntry[]
	statKind(candidate: string): 'file' | 'directory' | 'other' | 'missing'
}

export const nodeSearchFilesystem: SearchFilesystem = {
	listEntries: (directory) => fs.readdirSync(directory, { withFileTypes: true }),
	statKind: (candidate) => {
		const stats = fs.statSync(candidate, { throwIfNoEntry: false })
		if (stats === undefined) return 'missing'
		if (stats.isDirectory()) return 'directory'
		if (stats.isFile()) return 'file'
		return 'other'
	},
}

export interface SearchTextDependencies {
	fileLines: FileLines
	filesystem: SearchFilesystem
	pathFilesystem: PathFilesystem
}

async function* walkSearchableFiles(root: string, baseDirectory: string, filesystem: SearchFilesystem): AsyncGenerator<string, void, void> {
	for (const entry of filesystem.listEntries(baseDirectory)) {
		const fullPath = path.join(baseDirectory, entry.name)
		if (entry.isDirectory()) {
			// The executor's bookkeeping directory is invisible to the walk the same way it is to the path-resolution chokepoint; a nested project/.orchestration/ has a different relative path and stays searchable.
			if (isOrchestrationPath(path.relative(root, fullPath).split(path.sep).join('/'))) continue
			yield* walkSearchableFiles(root, fullPath, filesystem)
			continue
		}
		if (entry.isFile() && isSearchable(fullPath)) yield fullPath
	}
}

function compileRegex(pattern: string): RegExp {
	try {
		return new RegExp(pattern)
	} catch {
		return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
	}
}

function matchText(line: string): string {
	return line.length > MAX_MATCH_TEXT_CHARS ? `${line.slice(0, MAX_MATCH_TEXT_CHARS)}…` : line
}

async function collectLineMatches(lines: AsyncIterable<string>, relativePath: string, regex: RegExp, maximumMatches: number): Promise<SearchMatch[]> {
	const matches: SearchMatch[] = []
	let lineNumber = 0
	for await (const line of lines) {
		lineNumber += 1
		if (!regex.test(line)) continue
		matches.push({ path: relativePath, line: lineNumber, text: matchText(line) })
		if (matches.length >= maximumMatches) break
	}
	return matches
}

export function createSearchText(workspaceRoot: string, dependencies: SearchTextDependencies): ToolHandler {
	const resolvedRoot = path.resolve(workspaceRoot)
	return async (args) => {
		const patternValue = args['pattern']
		if (typeof patternValue !== 'string' || patternValue === '') {
			return createToolError('invalid_arguments', 'pattern must be a non-empty string')
		}
		const regex = compileRegex(patternValue)
		const matches: SearchMatch[] = []
		const appendFileMatches = async (target: string): Promise<void> => {
			const remainingTotal = MAX_TOTAL_MATCHES - matches.length
			if (remainingTotal <= 0) return
			const perFileLimit = Math.min(MAX_MATCHES_PER_FILE, remainingTotal)
			try {
				const fileMatches = await collectLineMatches(dependencies.fileLines.readLines(target, MAX_SEARCH_LINE_CHARS), path.relative(resolvedRoot, target), regex, perFileLimit)
				matches.push(...fileMatches)
			} catch {
				// A file that vanished or cannot be read contributes nothing, matching the previous whole-file read behavior.
			}
		}
		const pathsValue = args['paths']
		if (pathsValue !== undefined) {
			if (!Array.isArray(pathsValue) || !pathsValue.every((candidate): candidate is string => typeof candidate === 'string')) {
				return createToolError('invalid_arguments', 'paths must be an array of strings')
			}
			try {
				for (const rawPath of pathsValue) {
					const resolution = resolveWithinWorkspace(rawPath, resolvedRoot, dependencies.pathFilesystem)
					if (!resolution.ok) return resolution.error
					let kind: 'file' | 'directory' | 'other' | 'missing'
					try {
						kind = dependencies.filesystem.statKind(resolution.path.absolute)
					} catch {
						continue
					}
					if (kind === 'directory') {
						for await (const target of walkSearchableFiles(resolvedRoot, resolution.path.absolute, dependencies.filesystem)) {
							await appendFileMatches(target)
							if (matches.length >= MAX_TOTAL_MATCHES) break
						}
					} else if (kind === 'file') {
						await appendFileMatches(resolution.path.absolute)
					}
					if (matches.length >= MAX_TOTAL_MATCHES) break
				}
			} catch (error) {
				return wrapIoError(error, 'Cannot search workspace')
			}
			return { kind: 'success', data: matches }
		}
		try {
			for await (const target of walkSearchableFiles(resolvedRoot, resolvedRoot, dependencies.filesystem)) {
				await appendFileMatches(target)
				if (matches.length >= MAX_TOTAL_MATCHES) break
			}
		} catch (error) {
			return wrapIoError(error, 'Cannot search workspace')
		}
		return { kind: 'success', data: matches }
	}
}
