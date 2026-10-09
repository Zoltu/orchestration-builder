// A record is "plain" only when it inherits from Object.prototype or has no prototype. Anything else (Date, Map, Set, class instances) carries behavior canonical serialization cannot represent, so it is rejected rather than flattened.
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object') return false
	if (value === null) return false
	const prototype = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}

// Deterministic serialization. Object keys are sorted so structurally equal values hash identically regardless of insertion order, and unsupported values throw rather than being dropped, because a silently dropped field would yield a version that fails to detect a real change.
export function canonicalSerialize(value: unknown): string {
	if (value === null) return 'null'
	if (typeof value === 'string') return JSON.stringify(value)
	if (typeof value === 'boolean') return value ? 'true' : 'false'
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new Error(`canonicalSerialize cannot serialize the non-finite number ${String(value)}`)
		return JSON.stringify(value)
	}
	if (typeof value === 'undefined') throw new Error('canonicalSerialize cannot serialize undefined')
	if (typeof value === 'bigint') throw new Error('canonicalSerialize cannot serialize a bigint')
	if (typeof value === 'function') throw new Error('canonicalSerialize cannot serialize a function')
	if (typeof value === 'symbol') throw new Error('canonicalSerialize cannot serialize a symbol')
	if (Array.isArray(value)) {
		// A sparse array (a hole, not an explicit undefined) would be skipped by Array.prototype.map, collapsing `[]` and `[,]` to the same string and letting a real content change collide to an unchanged version. Reject it instead of serializing it.
		const elements: string[] = []
		for (let index = 0; index < value.length; index += 1) {
			if (!(index in value)) throw new Error(`canonicalSerialize cannot serialize a sparse array: missing index ${index}`)
			const element: unknown = value[index]
			elements.push(canonicalSerialize(element))
		}
		return `[${elements.join(',')}]`
	}
	if (!isPlainObject(value)) throw new Error(`canonicalSerialize cannot serialize a non-plain object: ${Object.prototype.toString.call(value)}`)
	const members: string[] = []
	for (const key of Object.keys(value).sort()) {
		members.push(`${JSON.stringify(key)}:${canonicalSerialize(value[key])}`)
	}
	return `{${members.join(',')}}`
}
