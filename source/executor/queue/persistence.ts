import { safeJsonParse } from '../validation.js'
import { isTaskQueue, type TaskQueue } from './model.js'

// The module's persistence port: text in and text out, with the write side owning atomic file replacement. Serialization, validation, and tolerance of a missing or malformed file stay inside the queue module, so the persisted shape never crosses the boundary.
export interface QueueStore {
	read(): string | null
	write(contents: string): void
}

export function readQueue(store: QueueStore): TaskQueue {
	const text = store.read()
	if (text === null) return { items: [] }
	const parsed = safeJsonParse(text)
	if (!parsed.ok) return { items: [] }
	return isTaskQueue(parsed.value) ? parsed.value : { items: [] }
}

export function writeQueue(store: QueueStore, queue: TaskQueue): void {
	store.write(JSON.stringify(queue, null, 2))
}
