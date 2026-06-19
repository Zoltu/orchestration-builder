import * as fs from 'node:fs'
import * as path from 'node:path'
import { createToolError } from '../../shared/errors.js'
import type { ToolHandler } from '../tool-dispatch.js'
import { wrapToolError } from './shared.js'

function globToRegex(pattern: string): RegExp {
	let regex = ''
	let i = 0
	while (i < pattern.length) {
		const char = pattern[i]
		if (char === '*') {
			if (pattern[i + 1] === '*') {
				regex += '.*'
				i += 2
				if (pattern[i] === '/') {
					regex += '(?:/|$)'
					i++
				}
				continue
			}
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

function walkFiles(root: string, baseDir: string): string[] {
	const results: string[] = []
	const entries = fs.readdirSync(baseDir, { withFileTypes: true })
	for (const entry of entries) {
		const full = path.join(baseDir, entry.name)
		if (entry.isDirectory()) {
			results.push(...walkFiles(root, full))
		} else if (entry.isFile()) {
			results.push(path.relative(root, full))
		}
	}
	return results
}

export function createGlobFiles(workspaceRoot: string): ToolHandler {
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
				files = walkFiles(resolvedRoot, resolvedRoot)
			} catch (error) {
				const message = error instanceof Error ? error.message : 'cannot walk workspace'
				return createToolError('invalid_arguments', `Cannot glob files: ${message}`)
			}
			const matched = files.filter((f) => regex.test(f))
			matched.sort()
			return { kind: 'success', data: matched }
		} catch (error) {
			return wrapToolError(error, 'Invalid pattern')
		}
	}
}