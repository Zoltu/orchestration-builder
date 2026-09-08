import * as fs from 'node:fs'
import * as path from 'node:path'
import type { RunCheckpoint } from './checkpoint.js'
import { isProjectSettings } from './validation.js'
import type { EffortLevel, LogLevel, LogEvent, RunMeta } from './types.js'

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

export type WriteCheckpoint = (checkpoint: RunCheckpoint) => void
export type DeleteCheckpoint = () => void
export type ReadRunCheckpointById = (runId: string) => string | null

const CHECKPOINT_FILE_NAME = 'state.json'

// The checkpoint is rewritten on every safe point, so it must never be torn: write-temp + rename guarantees the on-disk file is always a complete JSON document (the same pattern settings.json uses). A crash mid-write leaves the previous checkpoint, never a half-written one.
export function createWriteCheckpoint(runId: string, baseDir: string = 'data/runs'): WriteCheckpoint {
	const runDir = path.resolve(baseDir, runId)
	return (checkpoint: RunCheckpoint) => {
		const checkpointPath = path.resolve(runDir, CHECKPOINT_FILE_NAME)
		const tempPath = `${checkpointPath}.${process.pid}.tmp`
		fs.writeFileSync(tempPath, JSON.stringify(checkpoint))
		fs.renameSync(tempPath, checkpointPath)
	}
}

export function createDeleteCheckpoint(runId: string, baseDir: string = 'data/runs'): DeleteCheckpoint {
	const runDir = path.resolve(baseDir, runId)
	return () => {
		const checkpointPath = path.resolve(runDir, CHECKPOINT_FILE_NAME)
		if (fs.existsSync(checkpointPath)) fs.unlinkSync(checkpointPath)
	}
}

export function createReadRunCheckpointById(baseDir: string = 'data/runs'): ReadRunCheckpointById {
	return (runId: string) => {
		const checkpointPath = path.resolve(baseDir, runId, CHECKPOINT_FILE_NAME)
		return fs.existsSync(checkpointPath) ? fs.readFileSync(checkpointPath, 'utf8') : null
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

export type ReadRunMetaById = (runId: string) => string | null

// Reads only a run's meta.json. The run list renders one summary per run and never touches log events, so it reads the small meta file rather than every run's full (and ever-growing) log on every poll.
export function createReadRunMetaById(baseDir: string = 'data/runs'): ReadRunMetaById {
	return (runId: string) => {
		const metaPath = path.resolve(baseDir, runId, 'meta.json')
		return fs.existsSync(metaPath) ? fs.readFileSync(metaPath, 'utf8') : null
	}
}

export type WriteRunSummary = (summary: string) => void
export type ReadRunSummaryById = (runId: string) => string | null

const SUMMARY_FILE_NAME = 'summary.txt'

// The one-line run summary is plain text, not JSON: there is no schema to validate, and absence (or a whitespace-only file) simply means "no summary", so the UI falls back to the task text. The run directory is created if missing because a start-of-run summary write can land before the executor has created it.
export function createWriteRunSummary(runId: string, baseDir: string = 'data/runs'): WriteRunSummary {
	const runDir = path.resolve(baseDir, runId)
	return (summary: string) => {
		fs.mkdirSync(runDir, { recursive: true })
		fs.writeFileSync(path.resolve(runDir, SUMMARY_FILE_NAME), summary)
	}
}

export function createReadRunSummaryById(baseDir: string = 'data/runs'): ReadRunSummaryById {
	return (runId: string) => {
		const summaryPath = path.resolve(baseDir, runId, SUMMARY_FILE_NAME)
		if (!fs.existsSync(summaryPath)) return null
		const text = fs.readFileSync(summaryPath, 'utf8').trim()
		return text === '' ? null : text
	}
}

export interface RunSummaryStats {
	meta: RunSnapshotFileStat | null
	summary: RunSnapshotFileStat | null
}

export type ReadRunSummaryStats = (runId: string) => RunSummaryStats

// Stats the two files a run-list summary is derived from without reading them, so the run-list cache revalidates each run per poll with two stat calls instead of two file reads plus a meta parse. summary.txt rides in the freshness key because the completion summary replaces the start one at a moment when meta.json does not change.
export function createReadRunSummaryStats(baseDir: string = 'data/runs'): ReadRunSummaryStats {
	return (runId: string) => {
		const metaPath = path.resolve(baseDir, runId, 'meta.json')
		const summaryPath = path.resolve(baseDir, runId, SUMMARY_FILE_NAME)
		return { meta: statOrNull(metaPath), summary: statOrNull(summaryPath) }
	}
}

export type ReadRunPlanById = (runId: string) => string | null

// Written only by the write_plan tool (source/executor/tools/plan.ts), which writes atomically (write-temp + rename), so a reader never sees a torn document.
export const PLAN_FILE_NAME = 'plan.md'

// Reads the run's plan document per request for the run view. Absence is normal (the planner may not have written one yet), and a read failure after the existence check (e.g. a permission or io error) degrades to "no plan" rather than failing the run view that serves it — a plan the UI cannot show must never 500 the view.
export function createReadRunPlanById(baseDir: string = 'data/runs'): ReadRunPlanById {
	return (runId: string) => {
		const planPath = path.resolve(baseDir, runId, PLAN_FILE_NAME)
		if (!fs.existsSync(planPath)) return null
		let text: string
		try {
			text = fs.readFileSync(planPath, 'utf8')
		} catch {
			return null
		}
		const trimmed = text.trim()
		return trimmed === '' ? null : trimmed
	}
}

export interface RunSnapshotFileStat {
	size: number
	mtimeMs: number
}

export interface RunSnapshotStats {
	meta: RunSnapshotFileStat | null
	log: RunSnapshotFileStat | null
}

export type ReadRunSnapshotStats = (runId: string) => RunSnapshotStats

// The freshness comparison the web caches run per request: same size and mtime means the file is unchanged, and null (the file is absent) only matches null.
export function isSameFileStat(a: RunSnapshotFileStat | null, b: RunSnapshotFileStat | null): boolean {
	if (a === null || b === null) return a === b
	return a.size === b.size && a.mtimeMs === b.mtimeMs
}

function statOrNull(filePath: string): RunSnapshotFileStat | null {
	if (!fs.existsSync(filePath)) return null
	const stat = fs.statSync(filePath)
	return { size: stat.size, mtimeMs: stat.mtimeMs }
}

// Stats a run's files without reading them. Size+mtime is the freshness key a snapshot cache validates against (the log is append-only, so every event changes its size), and a run with neither file is unknown — the cheap existence check the per-request handlers need before serving a snapshot.
export function createReadRunSnapshotStats(baseDir: string = 'data/runs'): ReadRunSnapshotStats {
	return (runId: string) => {
		const metaPath = path.resolve(baseDir, runId, 'meta.json')
		const logPath = path.resolve(baseDir, runId, 'log.jsonl')
		return { meta: statOrNull(metaPath), log: statOrNull(logPath) }
	}
}

export type ReadRunLogTextFrom = (runId: string, byteOffset: number) => string

// Reads a run's log.jsonl from a byte offset to the end of the file (offset 0 reads the whole log), so the snapshot cache re-reads only an active run's appended tail per poll instead of the whole ever-growing file. Stored offsets always fall just after a newline byte, which is never part of a multi-byte UTF-8 sequence, so reading from an offset cannot split a character.
export function createReadRunLogTextFrom(baseDir: string = 'data/runs'): ReadRunLogTextFrom {
	return (runId: string, byteOffset: number) => {
		const logPath = path.resolve(baseDir, runId, 'log.jsonl')
		if (!fs.existsSync(logPath)) return ''
		const descriptor = fs.openSync(logPath, 'r')
		try {
			const size = fs.fstatSync(descriptor).size
			if (byteOffset >= size) return ''
			const buffer = Buffer.alloc(size - byteOffset)
			const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, byteOffset)
			return buffer.toString('utf8', 0, bytesRead)
		} finally {
			fs.closeSync(descriptor)
		}
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
	// The project-wide default logging level (docs/reference.md "Logging level"); absent means the deployment default applies.
	logLevel?: LogLevel
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