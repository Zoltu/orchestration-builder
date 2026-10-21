import { describe, expect, test } from 'bun:test'

import { CHECKPOINT_FORMAT_VERSION, classifyVersion, QUEUE_FORMAT_VERSION, ROLE_SNAPSHOT_FORMAT_VERSION, RUN_MANIFEST_VERSION, SETTINGS_FORMAT_VERSION } from './orchestration-version.ts'

describe('format constants', () => {
	test('declare one integer per persistence unit', () => {
		expect(RUN_MANIFEST_VERSION).toBe(1)
		expect(QUEUE_FORMAT_VERSION).toBe(1)
		expect(SETTINGS_FORMAT_VERSION).toBe(1)
		expect(CHECKPOINT_FORMAT_VERSION).toBe(2)
		expect(ROLE_SNAPSHOT_FORMAT_VERSION).toBe(1)
	})
})

describe('classifyVersion', () => {
	test('classifies the current version', () => {
		expect(classifyVersion({ version: 2 }, 2)).toBe('current')
	})

	test('classifies an older supported-format number as old', () => {
		expect(classifyVersion({ version: 1 }, 2)).toBe('old')
	})

	test('classifies a newer format number as newer', () => {
		expect(classifyVersion({ version: 3 }, 2)).toBe('newer')
	})

	test('classifies a document without a version field as missing', () => {
		expect(classifyVersion({}, 2)).toBe('missing')
		expect(classifyVersion({ items: [] }, 2)).toBe('missing')
	})

	test('classifies a present but invalid version as malformed', () => {
		expect(classifyVersion({ version: 0 }, 2)).toBe('malformed')
		expect(classifyVersion({ version: -1 }, 2)).toBe('malformed')
		expect(classifyVersion({ version: 1.5 }, 2)).toBe('malformed')
		expect(classifyVersion({ version: '2' }, 2)).toBe('malformed')
		expect(classifyVersion({ version: null }, 2)).toBe('malformed')
	})

	test('classifies a non-object document as malformed', () => {
		expect(classifyVersion(null, 2)).toBe('malformed')
		expect(classifyVersion([], 2)).toBe('malformed')
		expect(classifyVersion('2', 2)).toBe('malformed')
	})
})
