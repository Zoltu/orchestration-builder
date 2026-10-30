import type { OperatorPauseRecord } from './types.js'
import { isObject, isString } from './validation.js'

// Platform-authored copy for an operator pause. Provider text never enters this record.
export const OPERATOR_PAUSE_MESSAGE = 'The operator paused this run.'

export const PAUSE_REQUEST_FILE_NAME = 'pause-requested.json'
export const PAUSE_REQUEST_FORMAT_VERSION = 1

// The durable marker written before the in-memory pause signal is sent, so a crash before the run reaches its safe point still materializes the pause at boot.
export interface PauseIntent {
	version: typeof PAUSE_REQUEST_FORMAT_VERSION
	requestedAt: string
}

function isIsoTimestamp(value: unknown): value is string {
	if (!isString(value)) return false
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return false
	return !Number.isNaN(Date.parse(value))
}

export function isPauseIntent(value: unknown): value is PauseIntent {
	if (!isObject(value)) return false
	if (value.version !== PAUSE_REQUEST_FORMAT_VERSION) return false
	return isIsoTimestamp(value.requestedAt)
}

export function operatorPauseFromIntent(intent: PauseIntent): OperatorPauseRecord {
	return { message: OPERATOR_PAUSE_MESSAGE, pausedAt: intent.requestedAt }
}

export function operatorPauseFromRequestedAt(requestedAt: string): OperatorPauseRecord {
	return { message: OPERATOR_PAUSE_MESSAGE, pausedAt: requestedAt }
}

export interface OperatorPauseQueue {
	request(record: OperatorPauseRecord): void
	consume(): OperatorPauseRecord | undefined
}

// One pause request is enough: a repeated request before the safe point is idempotent, and the first request's timestamp is the pause time.
export function createOperatorPauseQueue(): OperatorPauseQueue {
	let current: OperatorPauseRecord | undefined
	return {
		request(record) {
			if (current === undefined) current = record
		},
		consume() {
			const record = current
			current = undefined
			return record
		},
	}
}

export type PauseSubmitResult = 'accepted' | 'no_active_run'

export interface OperatorPauseChannel {
	bindQueue(queue: OperatorPauseQueue | null): void
	submit(record: OperatorPauseRecord): PauseSubmitResult
}

export function createOperatorPauseChannel(): OperatorPauseChannel {
	let bound: OperatorPauseQueue | null = null
	return {
		bindQueue(queue) {
			bound = queue
		},
		submit(record) {
			if (bound === null) return 'no_active_run'
			bound.request(record)
			return 'accepted'
		},
	}
}
