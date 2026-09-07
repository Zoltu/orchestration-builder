// Run ids are timestamps in one canonical shape: the generator and the guard live together so a runId accepted anywhere is one a run actually produced.
const RUN_ID_PATTERN = /^run-\d{8}-\d{6}$/

export function generateRunId(now: Date): string {
	const pad = (n: number) => n.toString().padStart(2, '0')
	const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`
	const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
	return `run-${date}-${time}`
}

export function isRunIdShape(value: unknown): value is string {
	return typeof value === 'string' && RUN_ID_PATTERN.test(value)
}
