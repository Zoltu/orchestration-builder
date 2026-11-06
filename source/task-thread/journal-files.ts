import * as fs from 'node:fs'
import * as path from 'node:path'
import { LOG_FILE_NAME, type ReadRunFormat, type WriteFileAtomically } from '../executor/persistence.js'
import type { LogEvent } from '../executor/types.js'
import { planThreadJournalAppend, serializeThreadJournalCursorLine, serializeThreadJournalHeaderLine } from './journal.js'
import type { ThreadJournalLogStat, ThreadJournalTailState } from './journal.js'

export const THREAD_JOURNAL_FILE_NAME = 'thread.jsonl'

export type AppendThreadJournal = (event: LogEvent) => void
export type AppendThreadJournalCursor = (runId: string, logStat: ThreadJournalLogStat) => void
export type ReadThreadJournalText = (runId: string) => string | null
export type WriteThreadJournalText = (runId: string, text: string) => void
export type ReadRunLogStat = (runId: string) => ThreadJournalLogStat | null

function threadJournalPath(runId: string, baseDir: string): string {
	return path.resolve(baseDir, runId, THREAD_JOURNAL_FILE_NAME)
}

function statOrNull(filePath: string): ThreadJournalLogStat | null {
	if (!fs.existsSync(filePath)) return null
	const stat = fs.statSync(filePath)
	return { size: stat.size, mtimeMs: stat.mtimeMs }
}

function journalTailState(journalPath: string): ThreadJournalTailState {
	if (!fs.existsSync(journalPath)) return { exists: false, endsWithNewline: false }
	const stat = fs.statSync(journalPath)
	if (stat.size === 0) return { exists: true, endsWithNewline: false }
	const descriptor = fs.openSync(journalPath, 'r')
	try {
		const buffer = Buffer.alloc(1)
		const bytesRead = fs.readSync(descriptor, buffer, 0, 1, stat.size - 1)
		return { exists: true, endsWithNewline: bytesRead === 1 && buffer[0] === 0x0a }
	} finally {
		fs.closeSync(descriptor)
	}
}

// Called only after the corresponding log append has landed, so the current log stat is the event's end offset and the journal's cursor records how much of the authoritative log the view has consumed.
export function createAppendThreadJournal(runId: string, baseDir: string, writeFileAtomically: WriteFileAtomically): AppendThreadJournal {
	const journalPath = threadJournalPath(runId, baseDir)
	const logPath = path.resolve(baseDir, runId, LOG_FILE_NAME)
	return (event: LogEvent) => {
		const logStat = statOrNull(logPath)
		if (logStat === null) throw new Error(`thread journal: log.jsonl is missing for run ${runId}`)
		const plan = planThreadJournalAppend(journalTailState(journalPath), () => fs.readFileSync(logPath, 'utf8'), logStat, event)
		if (plan.kind === 'none') return
		if (plan.kind === 'rewrite') {
			writeFileAtomically(journalPath, plan.text)
			return
		}
		fs.appendFileSync(journalPath, plan.text)
	}
}

export function createAppendThreadJournalCursor(baseDir: string): AppendThreadJournalCursor {
	return (runId, logStat) => {
		const journalPath = threadJournalPath(runId, baseDir)
		const lines: string[] = []
		if (!fs.existsSync(journalPath)) lines.push(serializeThreadJournalHeaderLine())
		lines.push(serializeThreadJournalCursorLine(logStat))
		fs.appendFileSync(journalPath, lines.join(''))
	}
}

export function createReadThreadJournalText(baseDir: string, readRunFormat: ReadRunFormat): ReadThreadJournalText {
	return (runId) => {
		if (readRunFormat(runId) !== 'current') return null
		const journalPath = threadJournalPath(runId, baseDir)
		if (!fs.existsSync(journalPath)) return null
		return fs.readFileSync(journalPath, 'utf8')
	}
}

export function createWriteThreadJournalText(baseDir: string, writeFileAtomically: WriteFileAtomically): WriteThreadJournalText {
	return (runId, text) => {
		const runDir = path.resolve(baseDir, runId)
		fs.mkdirSync(runDir, { recursive: true })
		writeFileAtomically(threadJournalPath(runId, baseDir), text)
	}
}

export function createReadRunLogStat(baseDir: string, readRunFormat: ReadRunFormat): ReadRunLogStat {
	return (runId) => {
		if (readRunFormat(runId) !== 'current') return null
		return statOrNull(path.resolve(baseDir, runId, LOG_FILE_NAME))
	}
}
