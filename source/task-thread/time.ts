const CANONICAL_UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/

// Locale-independent UTF-16 code-unit comparison: deterministic across hosts, though it is not a Unicode code-point or collation order.
export function compareCodeUnits(left: string, right: string): number {
	const length = Math.min(left.length, right.length)
	for (let index = 0; index < length; index++) {
		const leftCode = left.charCodeAt(index)
		const rightCode = right.charCodeAt(index)
		if (leftCode !== rightCode) return leftCode < rightCode ? -1 : 1
	}
	if (left.length === right.length) return 0
	return left.length < right.length ? -1 : 1
}

// Timestamps sort through a strict UTC parser rather than Date.parse, whose acceptance of non-ISO strings and host timezone behavior would make ordering depend on the machine reading the log.
export function canonicalTimestampMillis(timestamp: string): number | null {
	const match = CANONICAL_UTC_TIMESTAMP.exec(timestamp)
	if (match === null) return null
	const year = Number(match[1])
	const month = Number(match[2])
	const day = Number(match[3])
	const hour = Number(match[4])
	const minute = Number(match[5])
	const second = Number(match[6])
	const fraction = match[7]
	const millisecond = fraction === undefined ? 0 : Number(fraction.padEnd(3, '0'))
	if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null
	if (!Number.isInteger(hour) || !Number.isInteger(minute) || !Number.isInteger(second) || !Number.isInteger(millisecond)) return null
	if (month < 1 || month > 12) return null
	if (day < 1 || day > 31) return null
	if (hour < 0 || hour > 23) return null
	if (minute < 0 || minute > 59) return null
	if (second < 0 || second > 59) return null
	const millis = Date.UTC(year, month - 1, day, hour, minute, second, millisecond)
	const parsed = new Date(millis)
	if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null
	if (parsed.getUTCHours() !== hour || parsed.getUTCMinutes() !== minute || parsed.getUTCSeconds() !== second) return null
	if (parsed.getUTCMilliseconds() !== millisecond) return null
	return millis
}

// Valid canonical timestamps sort before malformed ones; malformed timestamps still get a deterministic code-point order so a torn log never becomes order-dependent.
export function compareTimestamps(left: string, right: string): number {
	const leftMillis = canonicalTimestampMillis(left)
	const rightMillis = canonicalTimestampMillis(right)
	if (leftMillis !== null && rightMillis !== null) {
		if (leftMillis === rightMillis) return 0
		return leftMillis < rightMillis ? -1 : 1
	}
	if (leftMillis !== null) return -1
	if (rightMillis !== null) return 1
	return compareCodeUnits(left, right)
}

export function isTimestampAtOrBefore(left: string, right: string): boolean {
	return compareTimestamps(left, right) <= 0
}
