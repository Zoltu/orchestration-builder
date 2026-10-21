import { classifyVersion, QUEUE_FORMAT_VERSION } from '../orchestration-version.js'
import { safeJsonParse } from '../validation.js'
import { isTaskQueue, type TaskQueue } from './model.js'

// The module's persistence port: text in and text out, with the write side owning atomic file replacement. Serialization, validation, and tolerance of a missing or malformed file stay inside the queue module, so the persisted shape never crosses the boundary.
export interface QueueStore {
	read(): string | null
	write(contents: string): void
}

function emptyQueue(): TaskQueue {
	return { version: QUEUE_FORMAT_VERSION, items: [] }
}

export function readQueue(store: QueueStore): TaskQueue {
	const text = store.read()
	if (text === null) return emptyQueue()
	const parsed = safeJsonParse(text)
	if (!parsed.ok) return emptyQueue()
	if (classifyVersion(parsed.value, QUEUE_FORMAT_VERSION) !== 'current') return emptyQueue()
	return isTaskQueue(parsed.value) ? parsed.value : emptyQueue()
}

export function writeQueue(store: QueueStore, queue: TaskQueue): void {
	store.write(JSON.stringify({ version: QUEUE_FORMAT_VERSION, items: queue.items }, null, 2))
}
