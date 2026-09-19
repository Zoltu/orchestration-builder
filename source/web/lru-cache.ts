// The shared LRU bookkeeping behind the web read caches: a hit and a refill both re-insert their entry (Map.set on an existing key keeps the original insertion order, so re-inserting is what keeps a re-read entry recency-fresh) and the eldest entry is evicted once the map grows past the cap. What freshness means and how an entry is refilled stay with each cache; this helper owns only the recency and eviction mechanics the caches must not drift on.
export type LruRead<Entry> = (key: string, isFresh: (cached: Entry) => boolean, refill: (cached: Entry | undefined) => Entry) => Entry

export function createLruReadCache<Entry>(maxEntries: number): LruRead<Entry> {
	const entries = new Map<string, Entry>()
	return (key, isFresh, refill) => {
		const cached = entries.get(key)
		if (cached !== undefined && isFresh(cached)) {
			entries.delete(key)
			entries.set(key, cached)
			return cached
		}
		const entry = refill(cached)
		entries.delete(key)
		entries.set(key, entry)
		while (entries.size > maxEntries) {
			const eldest = entries.keys().next()
			if (eldest.done) break
			entries.delete(eldest.value)
		}
		return entry
	}
}
