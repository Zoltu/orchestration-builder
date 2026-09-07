import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ToolHandler } from '../tool-dispatch.js'
import { isOrchestrationPath, nodePathFilesystem, resolveWithinWorkspace, wrapIoError } from './shared.js'

export interface ListDirectoryEntry {
	name: string
	type: 'file' | 'directory'
}

export function createListDirectory(workspaceRoot: string): ToolHandler {
	const resolvedRoot = path.resolve(workspaceRoot)
	return (args) => {
		const targetRaw = args['path']
		const target = typeof targetRaw === 'string' && targetRaw !== '' ? targetRaw : '.'
		const resolution = resolveWithinWorkspace(target, resolvedRoot, nodePathFilesystem)
		if (!resolution.ok) return resolution.error
		// The bookkeeping directory itself is refused by the resolution above, but a listing of the workspace root would still reveal its presence (and invite paths the tools then refuse), so the root listing omits it. The root resolves to the empty relative path, not '.'.
		const isWorkspaceRoot = resolution.path.relative === ''
		let entries: string[]
		try {
			entries = fs.readdirSync(resolution.path.absolute)
		} catch (error) {
			return wrapIoError(error, `Cannot list directory: ${target}`)
		}
		const result: ListDirectoryEntry[] = []
		for (const entry of entries) {
			if (isWorkspaceRoot && isOrchestrationPath(entry)) continue
			const entryPath = path.join(resolution.path.absolute, entry)
			try {
				const stat = fs.statSync(entryPath)
				result.push({ name: entry, type: stat.isDirectory() ? 'directory' : 'file' })
			} catch {
				continue
			}
		}
		result.sort((a, b) => {
			if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
			return a.name.localeCompare(b.name)
		})
		return { kind: 'success', data: result }
	}
}
