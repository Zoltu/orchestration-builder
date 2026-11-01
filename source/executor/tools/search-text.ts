import * as fs from 'node:fs'
import * as path from 'node:path'
import { createToolError } from '../errors.js'
import type { ToolHandler } from './tool-dispatch.js'
import type { FileChunks } from './file-lines.js'
import { wrapIoError } from './shared.js'
import { type PathFilesystem, resolveWithinWorkspace } from '../workspace-path.js'
import { compileGlobMatchers, compileGlobPattern, matchesGlobPath, matchesGlobSegment, type GlobMatchers } from './glob-pattern.js'

export interface SearchMatch {
	path: string
	line: number
	text: string
}

export interface SearchTextResult {
	matches: SearchMatch[]
	// A reached cap means more matches may exist; it does not prove any were omitted.
	truncated: boolean
	truncatedReason: 'per-file' | 'total' | null
}

const DEFAULT_EXCLUDED_DIRECTORY_NAMES = new Set(['.git', '.orchestration', 'node_modules', 'vendor', 'dist', 'build', 'out', 'coverage'])

const MAX_MATCHES_PER_FILE = 100

const MAX_TOTAL_MATCHES = 1000

const SEGMENT_CHARS = 1024 * 1024

const SEGMENT_OVERLAP_CHARS = 64 * 1024

const SEGMENT_STEP_CHARS = SEGMENT_CHARS - SEGMENT_OVERLAP_CHARS

const CONTEXT_CHARS = 120

const MAX_MATCH_TEXT_CHARS = 2000

const NUL_CHARACTER = '\u0000'

const NEWLINE_CHARACTER = '\n'

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
	fileChunks: FileChunks
	filesystem: SearchFilesystem
	pathFilesystem: PathFilesystem
}

interface SearchTarget {
	kind: 'file' | 'directory'
	absolute: string
	relative: string
}

// A pattern without "/" names a basename at any depth; a pattern with "/" names the whole workspace-relative path.
interface IncludeMatchers {
	pathMatchers: RegExp[]
	basenameMatchers: RegExp[]
}

function compileIncludeMatchers(patterns: readonly string[]): IncludeMatchers {
	const matchers: IncludeMatchers = { pathMatchers: [], basenameMatchers: [] }
	for (const pattern of patterns) {
		const regex = compileGlobPattern(pattern)
		if (pattern.includes('/')) matchers.pathMatchers.push(regex)
		else matchers.basenameMatchers.push(regex)
	}
	return matchers
}

function isIncluded(relativePath: string, matchers: IncludeMatchers | null): boolean {
	if (matchers === null) return true
	for (const regex of matchers.pathMatchers) {
		if (regex.test(relativePath)) return true
	}
	const segments = relativePath.split('/')
	const basename = segments[segments.length - 1] ?? ''
	return matchers.basenameMatchers.some((regex) => regex.test(basename))
}

function parsePatternList(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null
	const patterns: string[] = []
	for (const entry of value) {
		if (typeof entry !== 'string' || entry === '') return null
		patterns.push(entry)
	}
	return patterns
}

function workspaceRelativePath(root: string, target: string): string {
	return path.relative(root, target).split(path.sep).join('/')
}

function shouldSearchFile(relativePath: string, includeMatchers: IncludeMatchers | null, excludeMatchers: GlobMatchers): boolean {
	if (matchesGlobPath(relativePath, excludeMatchers)) return false
	return isIncluded(relativePath, includeMatchers)
}

async function* walkFiles(baseDirectory: string, filesystem: SearchFilesystem, excludeMatchers: GlobMatchers): AsyncGenerator<string, void, void> {
	for (const entry of filesystem.listEntries(baseDirectory)) {
		const fullPath = path.join(baseDirectory, entry.name)
		if (entry.isDirectory()) {
			if (DEFAULT_EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue
			if (matchesGlobSegment(entry.name, excludeMatchers)) continue
			yield* walkFiles(fullPath, filesystem, excludeMatchers)
			continue
		}
		if (entry.isFile()) yield fullPath
	}
}

function createGlobalRegex(regex: RegExp): RegExp {
	const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`
	return new RegExp(regex.source, flags)
}

function capMatchText(text: string): string {
	return text.length > MAX_MATCH_TEXT_CHARS ? `${text.slice(0, MAX_MATCH_TEXT_CHARS)}…` : text
}

function buildContextText(buffer: string, bufferStart: number, matchIndex: number, matchLength: number, lineContinues: boolean): string {
	const snippetStart = Math.max(0, matchIndex - CONTEXT_CHARS)
	const snippetEnd = Math.min(buffer.length, matchIndex + matchLength + CONTEXT_CHARS)
	const hasLeadingEllipsis = bufferStart + snippetStart > 0
	const hasTrailingEllipsis = lineContinues || snippetEnd < buffer.length
	return capMatchText(`${hasLeadingEllipsis ? '…' : ''}${buffer.slice(snippetStart, snippetEnd)}${hasTrailingEllipsis ? '…' : ''}`)
}

interface MatchesScanResult {
	kind: 'matches'
	matches: SearchMatch[]
	reachedCap: boolean
}

interface BinaryScanResult {
	kind: 'binary'
}

type FileScanResult = MatchesScanResult | BinaryScanResult

function scanWindow(
	windowText: string,
	buffer: string,
	bufferStart: number,
	windowTextStartIndex: number,
	minimumStart: number,
	maximumStartExclusive: number,
	maximumEnd: number,
	regex: RegExp,
	lineNumber: number,
	relativePath: string,
	matches: SearchMatch[],
	seenOffsets: Set<number>,
	maximumMatches: number,
	lineContinues: boolean,
): boolean {
	const globalRegex = createGlobalRegex(regex)
	while (true) {
		const match = globalRegex.exec(windowText)
		if (match === null) return false
		const matchedText = match[0]
		if (matchedText === undefined) return false
		const matchIndex = windowTextStartIndex + match.index
		const absoluteOffset = bufferStart + matchIndex
		const matchEnd = absoluteOffset + matchedText.length
		// The extended window carries prefix and suffix context, so a window edge never acts as a line edge; the accepted start/end bounds keep only matches that belong to this window and are complete within it.
		const accepted = absoluteOffset >= minimumStart && absoluteOffset < maximumStartExclusive && matchEnd <= maximumEnd
		if (accepted && !seenOffsets.has(absoluteOffset)) {
			seenOffsets.add(absoluteOffset)
			const text = buildContextText(buffer, bufferStart, matchIndex, matchedText.length, lineContinues)
			matches.push({ path: relativePath, line: lineNumber, text })
			if (matches.length >= maximumMatches) return true
		}
		if (matchedText.length === 0) {
			globalRegex.lastIndex += 1
			if (globalRegex.lastIndex > windowText.length) return false
		}
	}
}

async function scanFileContent(chunks: AsyncIterable<string>, relativePath: string, regex: RegExp, maximumMatches: number): Promise<FileScanResult> {
	const matches: SearchMatch[] = []
	let lineNumber = 1
	let sawInput = false
	let lineIsLong = false
	let lineBuffer = ''
	let bufferStart = 0
	let nextWindowStart = 0
	let seenOffsets = new Set<number>()
	let reachedCap = false

	const resetLine = (): void => {
		lineNumber += 1
		lineIsLong = false
		lineBuffer = ''
		bufferStart = 0
		nextWindowStart = 0
		seenOffsets = new Set<number>()
	}

	const flushLongLineWindows = (): void => {
		while (lineBuffer.length - (nextWindowStart - bufferStart) >= SEGMENT_CHARS + CONTEXT_CHARS + 1) {
			const windowStart = nextWindowStart
			const prefixStart = Math.max(bufferStart, windowStart - CONTEXT_CHARS)
			const textStartIndex = prefixStart - bufferStart
			const textEndIndex = Math.min(lineBuffer.length, windowStart - bufferStart + SEGMENT_CHARS + CONTEXT_CHARS)
			const windowText = lineBuffer.slice(textStartIndex, textEndIndex)
			if (scanWindow(windowText, lineBuffer, bufferStart, textStartIndex, windowStart, windowStart + SEGMENT_CHARS, windowStart + SEGMENT_CHARS, regex, lineNumber, relativePath, matches, seenOffsets, maximumMatches, true)) {
				reachedCap = true
				return
			}
			nextWindowStart += SEGMENT_STEP_CHARS
			const keepFrom = Math.max(bufferStart, nextWindowStart - CONTEXT_CHARS)
			const dropCount = keepFrom - bufferStart
			if (dropCount > 0) {
				lineBuffer = lineBuffer.slice(dropCount)
				bufferStart = keepFrom
			}
		}
	}

	const finishLongLine = (): boolean => {
		const windowStart = nextWindowStart
		const lineEnd = bufferStart + lineBuffer.length
		const maximumStartExclusive = lineEnd + 1
		if (windowStart < lineEnd) {
			const prefixStart = Math.max(bufferStart, windowStart - CONTEXT_CHARS)
			const textStartIndex = prefixStart - bufferStart
			const windowText = lineBuffer.slice(textStartIndex)
			if (scanWindow(windowText, lineBuffer, bufferStart, textStartIndex, windowStart, maximumStartExclusive, lineEnd, regex, lineNumber, relativePath, matches, seenOffsets, maximumMatches, false)) {
				reachedCap = true
				return true
			}
		}
		return false
	}

	const appendLinePiece = (piece: string): boolean => {
		let position = 0
		while (position < piece.length) {
			if (!lineIsLong) {
				const room = SEGMENT_CHARS - lineBuffer.length
				const remaining = piece.length - position
				if (remaining <= room) {
					lineBuffer += piece.slice(position)
					position = piece.length
					continue
				}
				lineBuffer += piece.slice(position, position + room)
				position += room
				lineIsLong = true
			}
			const take = Math.min(piece.length - position, SEGMENT_CHARS)
			lineBuffer += piece.slice(position, position + take)
			position += take
			flushLongLineWindows()
			if (reachedCap) return true
		}
		return false
	}

	const finishLine = (): boolean => {
		if (lineIsLong) {
			if (finishLongLine()) return true
		} else {
			const match = regex.exec(lineBuffer)
			if (match !== null) {
				const matchedText = match[0]
				if (matchedText !== undefined) {
					const text = lineBuffer.length > MAX_MATCH_TEXT_CHARS ? buildContextText(lineBuffer, 0, match.index, matchedText.length, false) : lineBuffer
					matches.push({ path: relativePath, line: lineNumber, text })
					if (matches.length >= maximumMatches) return true
				}
			}
		}
		resetLine()
		return false
	}

	for await (const chunk of chunks) {
		if (chunk.length === 0) continue
		// A NUL byte anywhere in the read content is the binary heuristic; stopping here keeps the rest of the file unread.
		if (chunk.includes(NUL_CHARACTER)) return { kind: 'binary' }
		sawInput = true
		let start = 0
		while (start < chunk.length) {
			const newlineIndex = chunk.indexOf(NEWLINE_CHARACTER, start)
			if (newlineIndex === -1) {
				if (appendLinePiece(chunk.slice(start))) return { kind: 'matches', matches, reachedCap: true }
				break
			}
			if (appendLinePiece(chunk.slice(start, newlineIndex))) return { kind: 'matches', matches, reachedCap: true }
			if (finishLine()) return { kind: 'matches', matches, reachedCap: true }
			start = newlineIndex + 1
		}
	}
	if (sawInput && finishLine()) {
		return { kind: 'matches', matches, reachedCap: true }
	}
	return { kind: 'matches', matches, reachedCap: false }
}

export function createSearchText(workspaceRoot: string, dependencies: SearchTextDependencies): ToolHandler {
	const resolvedRoot = path.resolve(workspaceRoot)
	return async (args) => {
		const patternValue = args['pattern']
		if (typeof patternValue !== 'string' || patternValue === '') {
			return createToolError('invalid_arguments', 'pattern must be a non-empty string')
		}
		let regex: RegExp
		try {
			regex = new RegExp(patternValue)
		} catch (error) {
			const message = error instanceof Error ? error.message : 'invalid regular expression'
			return createToolError('invalid_arguments', `Invalid pattern: ${message}`)
		}
		let includeMatchers: IncludeMatchers | null = null
		const includeValue = args['include']
		if (includeValue !== undefined) {
			const patterns = parsePatternList(includeValue)
			if (patterns === null) return createToolError('invalid_arguments', 'include must be an array of non-empty strings')
			try {
				includeMatchers = compileIncludeMatchers(patterns)
			} catch (error) {
				const message = error instanceof Error ? error.message : 'invalid glob'
				return createToolError('invalid_arguments', `Invalid include pattern: ${message}`)
			}
		}
		let excludeMatchers = compileGlobMatchers([])
		const excludeValue = args['exclude']
		if (excludeValue !== undefined) {
			const patterns = parsePatternList(excludeValue)
			if (patterns === null) return createToolError('invalid_arguments', 'exclude must be an array of non-empty strings')
			try {
				excludeMatchers = compileGlobMatchers(patterns)
			} catch (error) {
				const message = error instanceof Error ? error.message : 'invalid glob'
				return createToolError('invalid_arguments', `Invalid exclude pattern: ${message}`)
			}
		}

		const targets: SearchTarget[] = []
		const pathsValue = args['paths']
		if (pathsValue !== undefined) {
			if (!Array.isArray(pathsValue)) return createToolError('invalid_arguments', 'paths must be an array of strings')
			if (pathsValue.length === 0) return createToolError('invalid_arguments', 'paths must be a non-empty array of strings')
			for (const rawPath of pathsValue) {
				if (typeof rawPath !== 'string') return createToolError('invalid_arguments', 'paths must be an array of strings')
				if (rawPath === '') return createToolError('invalid_arguments', 'paths must not contain an empty string')
				const resolution = resolveWithinWorkspace(rawPath, resolvedRoot, dependencies.pathFilesystem)
				if (!resolution.ok) return resolution.error
				let kind: 'file' | 'directory' | 'other' | 'missing'
				try {
					kind = dependencies.filesystem.statKind(resolution.path.absolute)
				} catch (error) {
					return wrapIoError(error, `Cannot inspect path: ${rawPath}`)
				}
				if (kind === 'missing') return createToolError('invalid_arguments', `Path does not exist: ${rawPath}`)
				if (kind === 'other') return createToolError('invalid_arguments', `Path is not a regular file or directory: ${rawPath}`)
				targets.push({ kind, absolute: resolution.path.absolute, relative: workspaceRelativePath(resolvedRoot, resolution.path.absolute) })
			}
		}

		const matches: SearchMatch[] = []
		let truncatedReason: SearchTextResult['truncatedReason'] = null
		const markTruncated = (reason: 'per-file' | 'total'): void => {
			if (reason === 'total') {
				truncatedReason = 'total'
				return
			}
			if (truncatedReason === null) truncatedReason = 'per-file'
		}
		const absorbMatches = (result: MatchesScanResult): void => {
			matches.push(...result.matches)
			if (matches.length >= MAX_TOTAL_MATCHES) markTruncated('total')
			else if (result.reachedCap) markTruncated('per-file')
		}
		const collectFile = async (target: string): Promise<FileScanResult> => {
			const remainingTotal = MAX_TOTAL_MATCHES - matches.length
			if (remainingTotal <= 0) return { kind: 'matches', matches: [], reachedCap: false }
			const perFileLimit = Math.min(MAX_MATCHES_PER_FILE, remainingTotal)
			try {
				return await scanFileContent(dependencies.fileChunks.readChunks(target), workspaceRelativePath(resolvedRoot, target), regex, perFileLimit)
			} catch {
				// A file that vanished or cannot be read contributes nothing, matching the previous whole-file read behavior.
				return { kind: 'matches', matches: [], reachedCap: false }
			}
		}
		const searchDirectory = async (root: string): Promise<void> => {
			for await (const target of walkFiles(root, dependencies.filesystem, excludeMatchers)) {
				if (matches.length >= MAX_TOTAL_MATCHES) {
					markTruncated('total')
					return
				}
				const relativePath = workspaceRelativePath(resolvedRoot, target)
				if (!shouldSearchFile(relativePath, includeMatchers, excludeMatchers)) continue
				const result = await collectFile(target)
				if (result.kind === 'matches') absorbMatches(result)
				if (matches.length >= MAX_TOTAL_MATCHES) return
			}
		}

		try {
			if (targets.length === 0) {
				await searchDirectory(resolvedRoot)
			} else {
				for (const target of targets) {
					if (target.kind === 'directory') {
						await searchDirectory(target.absolute)
						continue
					}
					if (!shouldSearchFile(target.relative, includeMatchers, excludeMatchers)) continue
					const result = await collectFile(target.absolute)
					if (result.kind === 'binary') {
						return createToolError('invalid_arguments', `${target.relative} appears to be binary; search_text is a line-oriented text search and is not designed for binary search.`)
					}
					absorbMatches(result)
					if (matches.length >= MAX_TOTAL_MATCHES) break
				}
			}
		} catch (error) {
			return wrapIoError(error, 'Cannot search workspace')
		}
		return { kind: 'success', data: { matches, truncated: truncatedReason !== null, truncatedReason } }
	}
}
