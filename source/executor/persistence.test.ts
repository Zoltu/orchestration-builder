import { describe, expect, test } from 'bun:test'

import { QUEUE_FORMAT_VERSION, RUN_MANIFEST_VERSION, SETTINGS_FORMAT_VERSION, type VersionStatus } from './orchestration-version.ts'
import { classifyManifestText, createListCurrentRunIds, parseProjectSettingsText, serializeProjectSettings, serializeRunManifest, type ListRunIds, type ReadRunFormat } from './persistence.ts'
import { readQueue, writeQueue, type QueueStore } from './queue/persistence.ts'
import type { QueueItem } from './queue/model.ts'

function item(id: string): QueueItem {
	return { id, task: 'do it', status: 'waiting', queuedAt: '2026-01-01T00:00:00.000Z' }
}

function fakeStore(initial: string | null): QueueStore & { writes: string[] } {
	let text = initial
	const writes: string[] = []
	return {
		read: () => text,
		write: (contents) => {
			text = contents
			writes.push(contents)
		},
		writes,
	}
}

describe('run manifest', () => {
	test('writes the current version and reads it back as current', () => {
		const text = serializeRunManifest()
		expect(JSON.parse(text)).toEqual({ version: RUN_MANIFEST_VERSION })
		expect(classifyManifestText(text)).toBe('current')
	})

	test('classifies absence, malformed JSON, and unsupported versions', () => {
		expect(classifyManifestText(null)).toBe('missing')
		expect(classifyManifestText('{not json')).toBe('malformed')
		expect(classifyManifestText('{}')).toBe('missing')
		expect(classifyManifestText(JSON.stringify({ version: 0 }))).toBe('malformed')
		expect(classifyManifestText(JSON.stringify({ version: 0.5 }))).toBe('malformed')
		expect(classifyManifestText(JSON.stringify({ version: RUN_MANIFEST_VERSION + 1 }))).toBe('newer')
	})
})

describe('project settings document', () => {
	test('serializes a versioned wrapper and parses the version-free settings', () => {
		const text = serializeProjectSettings({ effort: 'thorough', logLevel: 'standard' })
		expect(JSON.parse(text)).toEqual({ version: SETTINGS_FORMAT_VERSION, effort: 'thorough', logLevel: 'standard' })
		expect(parseProjectSettingsText(text)).toEqual({ effort: 'thorough', logLevel: 'standard' })
	})

	test('missing, old, newer, and malformed documents fall back to empty settings', () => {
		expect(parseProjectSettingsText(null)).toEqual({})
		expect(parseProjectSettingsText(JSON.stringify({ effort: 'quick' }))).toEqual({})
		expect(parseProjectSettingsText(JSON.stringify({ version: SETTINGS_FORMAT_VERSION + 1, effort: 'quick' }))).toEqual({})
		expect(parseProjectSettingsText('{not json')).toEqual({})
		expect(parseProjectSettingsText(JSON.stringify({ version: SETTINGS_FORMAT_VERSION, effort: 'invalid' }))).toEqual({})
	})

	test('accepts the current version with no settings', () => {
		expect(parseProjectSettingsText(JSON.stringify({ version: SETTINGS_FORMAT_VERSION }))).toEqual({})
	})
})

describe('task queue document', () => {
	test('reads a current-version queue with its items', () => {
		const store = fakeStore(JSON.stringify({ version: QUEUE_FORMAT_VERSION, items: [item('a')] }))
		expect(readQueue(store)).toEqual({ version: QUEUE_FORMAT_VERSION, items: [item('a')] })
	})

	test('missing, old, newer, and malformed documents read as an empty current-version queue', () => {
		const cases = [
			null,
			JSON.stringify({ items: [item('a')] }),
			JSON.stringify({ version: QUEUE_FORMAT_VERSION + 1, items: [item('a')] }),
			JSON.stringify({ version: 0, items: [item('a')] }),
			'{not json',
			JSON.stringify({ version: QUEUE_FORMAT_VERSION, items: 'nope' }),
		]
		for (const text of cases) {
			expect(readQueue(fakeStore(text))).toEqual({ version: QUEUE_FORMAT_VERSION, items: [] })
		}
	})

	test('always writes the current version', () => {
		const store = fakeStore(null)
		writeQueue(store, { version: QUEUE_FORMAT_VERSION, items: [item('a')] })
		expect(store.writes).toHaveLength(1)
		expect(JSON.parse(store.writes[0] ?? '')).toEqual({ version: QUEUE_FORMAT_VERSION, items: [item('a')] })
	})
})

describe('run-list format gate', () => {
	test('lists only current-format run directories', () => {
		const formats = new Map<string, VersionStatus>([
			['run-current', 'current'],
			['run-missing', 'missing'],
			['run-old', 'old'],
			['run-newer', 'newer'],
			['run-malformed', 'malformed'],
		])
		const rawListRunIds: ListRunIds = () => [...formats.keys()]
		const readRunFormat: ReadRunFormat = (runId) => formats.get(runId) ?? 'missing'
		expect(createListCurrentRunIds(rawListRunIds, readRunFormat)()).toEqual(['run-current'])
	})
})
