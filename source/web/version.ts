// The opaque version token behind conditional requests: a per-resource fingerprint of every input its payload derives from, so an unchanged poll can be answered with a 304 before any derivation or serialization runs.

export type VersionToken = string

// The values a version input may hold. Object members are hashed by key, so a nested record is described structurally rather than by reference.
export type VersionInput = string | number | boolean | null | VersionInput[] | { [key: string]: VersionInput }

// Object keys are sorted so the serialization depends only on the values, not on the order the producer happened to insert them; arrays keep their order because element order is itself data.
// The parameter admits undefined even though VersionInput does not: a caller can hand the function a value its declared type cannot express (an optional field, an unchecked index), and silently skipping or collapsing it could collide two different inputs onto one token and thus serve a stale 304. Undefined and non-finite numbers throw instead, because the serialization must identify exactly one value.
export function stableSerialize(value: VersionInput | undefined): string {
	if (value === undefined) throw new Error('stableSerialize cannot serialize undefined; a version input must be a concrete value')
	if (value === null) return 'null'
	if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`stableSerialize cannot serialize the non-finite number ${value}`)
	if (Array.isArray(value)) return `[${value.map((element) => stableSerialize(element)).join(',')}]`
	if (typeof value === 'object') {
		const parts: string[] = []
		for (const key of Object.keys(value).sort()) {
			// The index signature admits undefined under noUncheckedIndexedAccess; stableSerialize rejects it rather than skipping it.
			parts.push(`${JSON.stringify(key)}:${stableSerialize(value[key])}`)
		}
		return `{${parts.join(',')}}`
	}
	return JSON.stringify(value)
}

// A cryptographic hash rather than a fast non-cryptographic one: a collision would serve a stale 304 for changed data, so the token must be collision-resistant. The token is opaque to callers, who may only test equality.
export function deriveVersion(inputs: Record<string, VersionInput>): VersionToken {
	return new Bun.CryptoHasher('sha256').update(stableSerialize(inputs)).digest('hex')
}
