import * as fs from 'node:fs'
import * as path from 'node:path'
import { createToolError } from '../../shared/errors.js'
import type { ToolHandler } from '../tool-dispatch.js'
import { assertWithinWorkspace, wrapToolError } from './shared.js'

export interface SearchMatch {
	path: string
	line: number
	text: string
}

const DEFAULT_EXTENSIONS = new Set(['.txt', '.md', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.py', '.rs', '.go', '.java', '.c', '.h', '.cpp', '.hpp', '.yaml', '.yml', '.toml', '.cfg', '.ini', '.sh', '.html', '.css', '.xml'])

function isSearchable(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase()
	return DEFAULT_EXTENSIONS.has(ext)
}

function collectFiles(root: string, baseDir: string, results: string[]): void {
	const entries = fs.readdirSync(baseDir, { withFileTypes: true })
	for (const entry of entries) {
		const full = path.join(baseDir, entry.name)
		if (entry.isDirectory()) {
			collectFiles(root, full, results)
		} else if (entry.isFile() && isSearchable(full)) {
			results.push(full)
		}
	}
}

function compileRegex(pattern: string): RegExp {
	try {
		return new RegExp(pattern)
	} catch {
		return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
	}
}

export function createSearchText(workspaceRoot: string): ToolHandler {
	const resolvedRoot = path.resolve(workspaceRoot)
	return (args) => {
		const patternValue = args['pattern']
		if (typeof patternValue !== 'string' || patternValue === '') {
			return createToolError('invalid_arguments', 'pattern must be a non-empty string')
		}
		const regex = compileRegex(patternValue)
		const pathsValue = args['paths']
		let targets: string[]
		if (pathsValue !== undefined) {
			if (!Array.isArray(pathsValue) || !pathsValue.every((p): p is string => typeof p === 'string')) {
				return createToolError('invalid_arguments', 'paths must be an array of strings')
			}
			targets = []
			for (const p of pathsValue) {
				let resolved
				try {
					resolved = assertWithinWorkspace(p, resolvedRoot)
				} catch (error) {
					return wrapToolError(error, 'Invalid path')
				}
				let stat: fs.Stats
				try {
					stat = fs.statSync(resolved.absolute)
				} catch {
					continue
				}
				if (stat.isDirectory()) {
					collectFiles(resolved.absolute, resolved.absolute, targets)
				} else if (stat.isFile()) {
					targets.push(resolved.absolute)
				}
			}
		} else {
			targets = []
			try {
				collectFiles(resolvedRoot, resolvedRoot, targets)
			} catch (error) {
				const message = error instanceof Error ? error.message : 'cannot walk workspace'
				return createToolError('invalid_arguments', `Cannot search: ${message}`)
			}
		}
		const matches: SearchMatch[] = []
		const MAX_MATCHES_PER_FILE = 100
		const MAX_TOTAL_MATCHES = 1000
		for (const target of targets) {
			let content: string
			try {
				content = fs.readFileSync(target, 'utf8')
			} catch {
				continue
			}
			const lines = content.split('\n')
			let perFile = 0
			for (let i = 0; i < lines.length; i++) {
				if (regex.test(lines[i] ?? '')) {
					matches.push({ path: path.relative(resolvedRoot, target), line: i + 1, text: lines[i] ?? '' })
					perFile++
					if (perFile >= MAX_MATCHES_PER_FILE || matches.length >= MAX_TOTAL_MATCHES) break
				}
			}
			if (matches.length >= MAX_TOTAL_MATCHES) break
		}
		return { kind: 'success', data: matches }
	}
}