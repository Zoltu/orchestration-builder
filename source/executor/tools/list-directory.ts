import * as fs from 'node:fs'
import * as path from 'node:path'
import { createToolError } from '../../shared/errors.js'
import type { ToolHandler } from '../tool-dispatch.js'
import { assertWithinWorkspace, wrapToolError } from './shared.js'

export interface ListDirectoryEntry {
	name: string
	type: 'file' | 'directory'
}

export function createListDirectory(workspaceRoot: string): ToolHandler {
	const resolvedRoot = path.resolve(workspaceRoot)
	return (args) => {
		const targetRaw = args['path']
		const target = typeof targetRaw === 'string' && targetRaw !== '' ? targetRaw : '.'
		let resolved
		try {
			resolved = assertWithinWorkspace(target, resolvedRoot)
		} catch (error) {
			return wrapToolError(error, 'Invalid path')
		}
		let entries: string[]
		try {
			entries = fs.readdirSync(resolved.absolute)
		} catch (error) {
			const message = error instanceof Error ? error.message : 'cannot read directory'
			return createToolError('invalid_arguments', `Cannot list directory: ${message}`)
		}
		const result: ListDirectoryEntry[] = []
		for (const entry of entries) {
			const entryPath = path.join(resolved.absolute, entry)
			let stat: fs.Stats
			try {
				stat = fs.statSync(entryPath)
			} catch {
				continue
			}
			result.push({ name: entry, type: stat.isDirectory() ? 'directory' : 'file' })
		}
		result.sort((a, b) => {
			if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
			return a.name.localeCompare(b.name)
		})
		return { kind: 'success', data: result }
	}
}