// The shared record guard for the browser modules: a plain object (not null, not an array). One definition so the view modules' input checks cannot drift apart, mirroring the exported isObject the server-side modules share (source/executor/validation.ts) — the static bundle cannot import from the executor, so the browser side keeps its own copy of the same semantics.
export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
