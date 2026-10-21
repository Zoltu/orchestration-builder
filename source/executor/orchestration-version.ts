export type VersionStatus = 'current' | 'old' | 'newer' | 'missing' | 'malformed'

export const RUN_MANIFEST_VERSION = 1
export const QUEUE_FORMAT_VERSION = 1
export const SETTINGS_FORMAT_VERSION = 1
export const CHECKPOINT_FORMAT_VERSION = 2
export const ROLE_SNAPSHOT_FORMAT_VERSION = 1

function isDocumentObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// A persistence unit carries one monotonically increasing integer. A document without the field predates the versioned format; a present field that is not a positive integer is structurally invalid. Both are distinct from a valid version that this build does not support.
export function classifyVersion(value: unknown, current: number): VersionStatus {
	if (!isDocumentObject(value)) return 'malformed'
	if (!('version' in value)) return 'missing'
	const version = value['version']
	if (typeof version !== 'number' || !Number.isInteger(version) || version <= 0) return 'malformed'
	if (version < current) return 'old'
	if (version > current) return 'newer'
	return 'current'
}
