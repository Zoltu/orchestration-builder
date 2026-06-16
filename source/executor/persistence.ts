// Leaf factory for run persistence.
// All filesystem access is local to this module and closed over at construction time.

import * as fs from 'node:fs'
import * as path from 'node:path'

import type { LogEvent, RunMeta } from '../shared/types.js'

export interface Persistence {
	createRunDirectory(): string
	copyWorkspace(sourcePath: string): void
	appendLog(event: LogEvent): void
	writeMeta(meta: RunMeta): void
}

export function createPersistence(runId: string, baseDir: string = 'data/runs'): Persistence {
	const runDir = path.resolve(baseDir, runId)
	const workspaceDir = path.resolve(runDir, 'workspace')

	function copyRecursively(source: string, destination: string): void {
		const entries = fs.readdirSync(source)
		for (const entry of entries) {
			if (entry === 'eval.json') continue
			const sourcePathEntry = path.join(source, entry)
			const destinationPathEntry = path.join(destination, entry)
			const stat = fs.statSync(sourcePathEntry)
			if (stat.isDirectory()) {
				fs.mkdirSync(destinationPathEntry, { recursive: true })
				copyRecursively(sourcePathEntry, destinationPathEntry)
			} else {
				fs.copyFileSync(sourcePathEntry, destinationPathEntry)
			}
		}
	}

	function createRunDirectory(): string {
		fs.mkdirSync(runDir, { recursive: true })
		return runDir
	}

	function copyWorkspace(sourcePath: string): void {
		if (!fs.existsSync(sourcePath)) {
			throw new Error(`Workspace source path does not exist: ${sourcePath}`)
		}
		fs.mkdirSync(workspaceDir, { recursive: true })
		copyRecursively(sourcePath, workspaceDir)
	}

	function appendLog(event: LogEvent): void {
		const logPath = path.resolve(runDir, 'log.jsonl')
		fs.appendFileSync(logPath, JSON.stringify(event) + '\n')
	}

	function writeMeta(meta: RunMeta): void {
		const metaPath = path.resolve(runDir, 'meta.json')
		fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2))
	}

	return { createRunDirectory, copyWorkspace, appendLog, writeMeta }
}
