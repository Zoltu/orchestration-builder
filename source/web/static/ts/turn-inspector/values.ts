// The small field readers the turn-inspector derivations share: each turns an untrusted wire value into the typed value it can safely stand for, or null.
export function readEventIndex(value: unknown): number | null {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null
	return value
}

export function readInstanceId(value: unknown): string | null {
	if (typeof value !== 'string' || value === '') return null
	return value
}
