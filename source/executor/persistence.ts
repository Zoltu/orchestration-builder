import * as fs from 'node:fs'
import * as path from 'node:path'
import { isProjectSettings } from './validation.js'
import type { EffortLevel, LogEvent, RunMeta } from './types.js'

export type RunDirectory = () => string
export type AppendLog = (event: LogEvent) => void
export type WriteMeta = (meta: RunMeta) => void

export function copyRecursively(source: string, destination: string): void {
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

export interface RunSnapshotRaw {
	metaText: string | null
	logText: string
}

export type ReadRunSnapshotById = (runId: string) => RunSnapshotRaw

// Reads any run's artifacts by id, so the server can serve the active run and any completed run without re-deriving closures per run.
// The single-active-run invariant is enforced at the submission layer, not here.
export function createReadRunSnapshotById(baseDir: string = 'data/runs'): ReadRunSnapshotById {
	return (runId: string) => {
		const metaPath = path.resolve(baseDir, runId, 'meta.json')
		const logPath = path.resolve(baseDir, runId, 'log.jsonl')
		const metaText = fs.existsSync(metaPath) ? fs.readFileSync(metaPath, 'utf8') : null
		const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
		return { metaText, logText }
	}
}

export type ListRunIds = () => string[]

export function createListRunIds(baseDir: string = 'data/runs'): ListRunIds {
	return () => {
		if (!fs.existsSync(baseDir)) return []
		return fs.readdirSync(baseDir).filter((entry) => fs.statSync(path.resolve(baseDir, entry)).isDirectory())
	}
}

export interface ProjectSettings {
	effort?: EffortLevel
}

export type ReadProjectSettings = () => ProjectSettings
export type WriteProjectSettings = (settings: ProjectSettings) => void

const SETTINGS_FILE_NAME = 'settings.json'

function settingsFilePath(workspaceRoot: string): string {
	return path.resolve(workspaceRoot, '.orchestration', SETTINGS_FILE_NAME)
}

export function createReadProjectSettings(workspaceRoot: string): ReadProjectSettings {
	const filePath = settingsFilePath(workspaceRoot)
	return () => {
		if (!fs.existsSync(filePath)) return {}
		let text: string
		try {
			text = fs.readFileSync(filePath, 'utf8')
		} catch {
			return {}
		}
		let parsed: unknown
		try {
			parsed = JSON.parse(text)
		} catch {
			return {}
		}
		return isProjectSettings(parsed) ? parsed : {}
	}
}

// Writes the project settings atomically (write-temp + rename) so a torn write cannot leave the file malformed for the next submission.
// The .orchestration directory is created if missing, since the first settings write may precede any run.
export function createWriteProjectSettings(workspaceRoot: string): WriteProjectSettings {
	const filePath = settingsFilePath(workspaceRoot)
	return (settings) => {
		const dir = path.dirname(filePath)
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
		const tempPath = `${filePath}.${process.pid}.tmp`
		fs.writeFileSync(tempPath, JSON.stringify(settings, null, 2))
		fs.renameSync(tempPath, filePath)
	}
}