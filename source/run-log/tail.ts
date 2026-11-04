// The tail read starts one byte before the desired window so its first newline is either the line boundary itself or the end of a genuinely partial line. Dropping through that first newline then always leaves only complete JSONL records.

export interface TailReadPlan {
	start: number
	length: number
	dropLeadingPartialLine: boolean
}

export function planTailRead(fileSize: number, maxBytes: number): TailReadPlan {
	if (!Number.isSafeInteger(fileSize) || fileSize < 0) throw new Error(`planTailRead: fileSize must be a non-negative integer (got ${String(fileSize)})`)
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error(`planTailRead: maxBytes must be a positive integer (got ${String(maxBytes)})`)
	if (fileSize <= maxBytes) return { start: 0, length: fileSize, dropLeadingPartialLine: false }
	const start = fileSize - maxBytes - 1
	return { start, length: fileSize - start, dropLeadingPartialLine: start > 0 }
}

export function trimTailText(text: string, dropLeadingPartialLine: boolean): string {
	if (!dropLeadingPartialLine) return text
	const firstNewline = text.indexOf('\n')
	if (firstNewline === -1) return ''
	return text.slice(firstNewline + 1)
}
