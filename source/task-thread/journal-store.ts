import type { LogEvent } from '../executor/types.js'
import { parseRunMeta } from '../run-log/parse.js'
import { buildThreadJournalFromLog, parseThreadJournal } from './journal.js'
import type { ParsedThreadJournal, ThreadJournalLogStat } from './journal.js'

export interface ThreadJournalStoreDependencies {
	readThreadJournalText: (runId: string) => string | null
	writeThreadJournalText: (runId: string, text: string) => void
	appendThreadJournalCursor: (runId: string, logStat: ThreadJournalLogStat) => void
	readLogText: (runId: string) => string
	readLogStat: (runId: string) => ThreadJournalLogStat | null
	readRunMetaText: (runId: string) => string | null
}

export interface ThreadJournalRead {
	events: LogEvent[]
	complete: boolean
}

export interface ThreadJournalStore {
	read(runId: string): ThreadJournalRead | null
	ensure(runId: string): void
	finalize(runId: string): void
}

function isJournalCurrent(parsed: ParsedThreadJournal, logStat: ThreadJournalLogStat | null): boolean {
	if (parsed.tornTail || parsed.lastCursor === null || logStat === null) return false
	return parsed.lastCursor.logSize === logStat.size && parsed.lastCursor.logMtimeMs === logStat.mtimeMs
}

function rebuildJournal(dependencies: ThreadJournalStoreDependencies, runId: string, logStat: ThreadJournalLogStat): LogEvent[] {
	const logText = dependencies.readLogText(runId)
	const text = buildThreadJournalFromLog(logText, logStat)
	const parsed = parseThreadJournal(text)
	if (!parsed.valid) throw new Error(`thread journal rebuild produced an invalid journal for run ${runId}`)
	dependencies.writeThreadJournalText(runId, text)
	return parsed.events
}

// The journal is derived and rebuildable: missing or corrupt derived data cannot make a run unreadable because read/ensure can reconstruct it, while live journal I/O errors propagate like other write errors.
export function createThreadJournalStore(dependencies: ThreadJournalStoreDependencies): ThreadJournalStore {
	return {
		read(runId) {
			const journalText = dependencies.readThreadJournalText(runId)
			const metaText = dependencies.readRunMetaText(runId)
			const logStat = dependencies.readLogStat(runId)
			if (journalText === null && metaText === null && logStat === null) return null
			const meta = parseRunMeta(metaText)
			const parsed = journalText === null ? null : parseThreadJournal(journalText)
			if (meta !== null && meta.status === 'running') {
				if (parsed !== null && parsed.valid && !parsed.tornTail) return { events: parsed.events, complete: true }
				if (journalText === null) return { events: [], complete: logStat === null || logStat.size === 0 }
				return { events: [], complete: false }
			}
			if (parsed !== null && parsed.valid && isJournalCurrent(parsed, logStat)) return { events: parsed.events, complete: true }
			if (logStat === null) return { events: parsed !== null && parsed.valid ? parsed.events : [], complete: false }
			return { events: rebuildJournal(dependencies, runId, logStat), complete: true }
		},
		ensure(runId) {
			const logStat = dependencies.readLogStat(runId)
			if (logStat === null) return
			const journalText = dependencies.readThreadJournalText(runId)
			const parsed = journalText === null ? null : parseThreadJournal(journalText)
			if (parsed !== null && parsed.valid && !parsed.tornTail && isJournalCurrent(parsed, logStat)) return
			rebuildJournal(dependencies, runId, logStat)
		},
		finalize(runId) {
			const logStat = dependencies.readLogStat(runId)
			if (logStat === null) return
			const journalText = dependencies.readThreadJournalText(runId)
			const parsed = journalText === null ? null : parseThreadJournal(journalText)
			const cursor = parsed?.lastCursor ?? null
			const rewrittenAtSameSize = cursor !== null && logStat.size === cursor.logSize && logStat.mtimeMs !== cursor.logMtimeMs
			if (parsed === null || !parsed.valid || parsed.tornTail || (cursor !== null && logStat.size < cursor.logSize) || rewrittenAtSameSize) {
				rebuildJournal(dependencies, runId, logStat)
				return
			}
			dependencies.appendThreadJournalCursor(runId, logStat)
		},
	}
}
