import * as fs from 'node:fs'
import * as path from 'node:path'
import { createToolError } from '../errors.js'
import type { ToolHandler } from './tool-dispatch.js'
import type { FileChunks } from './file-lines.js'
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

const SEGMENT_CHARS = 1024 * 1024

const SEGMENT_OVERLAP_CHARS = 64 * 1024

const SEGMENT_STEP_CHARS = SEGMENT_CHARS - SEGMENT_OVERLAP_CHARS

const CONTEXT_CHARS = 120

const MAX_MATCH_TEXT_CHARS = 2000

const NUL_CHARACTER = '\u0000'

const NEWLINE_CHARACTER = '\n'

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
	fileChunks: FileChunks
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
		if (chunk.includes(NUL_CHARACTER)) return { kind: 'binary' }
		sawInput = true
		let start = 0
		while (start < chunk.length) {
			const newlineIndex = chunk.indexOf(NEWLINE_CHARACTER, start)
			if (newlineIndex === -1) {
				if (appendLinePiece(chunk.slice(start))) return { kind: 'matches', matches }
				break
			}
			if (appendLinePiece(chunk.slice(start, newlineIndex))) return { kind: 'matches', matches }
			if (finishLine()) return { kind: 'matches', matches }
			start = newlineIndex + 1
		}
	}
	if (sawInput && finishLine()) {
		return { kind: 'matches', matches }
	}
	return { kind: 'matches', matches }
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
		const collectFile = async (target: string): Promise<FileScanResult> => {
			const remainingTotal = MAX_TOTAL_MATCHES - matches.length
			if (remainingTotal <= 0) return { kind: 'matches', matches: [] }
			const perFileLimit = Math.min(MAX_MATCHES_PER_FILE, remainingTotal)
			try {
				return await scanFileContent(dependencies.fileChunks.readChunks(target), path.relative(resolvedRoot, target), regex, perFileLimit)
			} catch {
				// A file that vanished or cannot be read contributes nothing, matching the previous whole-file read behavior.
				return { kind: 'matches', matches: [] }
			}
		}
		const appendWalkFile = async (target: string): Promise<void> => {
			const result = await collectFile(target)
			if (result.kind === 'matches') matches.push(...result.matches)
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
							await appendWalkFile(target)
							if (matches.length >= MAX_TOTAL_MATCHES) break
						}
					} else if (kind === 'file') {
						const result = await collectFile(resolution.path.absolute)
						if (result.kind === 'binary') {
							return createToolError('invalid_arguments', `${path.relative(resolvedRoot, resolution.path.absolute)} appears to be binary; search_text is a line-oriented text search and is not designed for binary search.`)
						}
						matches.push(...result.matches)
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
				await appendWalkFile(target)
				if (matches.length >= MAX_TOTAL_MATCHES) break
			}
		} catch (error) {
			return wrapIoError(error, 'Cannot search workspace')
		}
		return { kind: 'success', data: matches }
	}
}
