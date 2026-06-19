import * as fs from 'node:fs'
import * as path from 'node:path'
import type { LogEvent, RunMeta } from '../shared/types.js'

export type RunDirectory = () => string
export type CopyWorkspace = (sourcePath: string) => void
export type AppendLog = (event: LogEvent) => void
export type WriteMeta = (meta: RunMeta) => void
export type SnapshotWorkspace = () => void

function copyRecursively(source: string, destination: string): void {
	const entries = fs.readdirSync(source)
	for (const entry of entries) {
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

export function createRunDirectory(runId: string, baseDir: string = 'data/runs'): RunDirectory {
	const runDir = path.resolve(baseDir, runId)
	return () => {
		fs.mkdirSync(runDir, { recursive: true })
		return runDir
	}
}

export function createCopyWorkspace(runId: string, baseDir: string = 'data/runs'): CopyWorkspace {
	const workspaceDir = path.resolve(baseDir, runId, 'workspace')
	return (sourcePath: string) => {
		if (!fs.existsSync(sourcePath)) {
			throw new Error(`Workspace source path does not exist: ${sourcePath}`)
		}
		fs.mkdirSync(workspaceDir, { recursive: true })
		copyRecursively(sourcePath, workspaceDir)
	}
}

export function createAppendLog(runId: string, baseDir: string = 'data/runs'): AppendLog {
	const runDir = path.resolve(baseDir, runId)
	return (event: LogEvent) => {
		const logPath = path.resolve(runDir, 'log.jsonl')
		fs.appendFileSync(logPath, JSON.stringify(event) + '\n')
	}
}

export function createWriteMeta(runId: string, baseDir: string = 'data/runs'): WriteMeta {
	const runDir = path.resolve(baseDir, runId)
	return (meta: RunMeta) => {
		const metaPath = path.resolve(runDir, 'meta.json')
		fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2))
	}
}

export function createSnapshotWorkspace(runId: string, baseDir: string = 'data/runs'): SnapshotWorkspace {
	const workspaceDir = path.resolve(baseDir, runId, 'workspace')
	const snapshotDir = path.resolve(baseDir, runId, 'workspace.snapshot')
	return () => {
		if (!fs.existsSync(workspaceDir)) return
		if (fs.existsSync(snapshotDir)) {
			fs.rmSync(snapshotDir, { recursive: true, force: true })
		}
		fs.mkdirSync(snapshotDir, { recursive: true })
		copyRecursively(workspaceDir, snapshotDir)
	}
}