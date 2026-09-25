import { describe, expect, test } from 'bun:test'
import { parseBuildInfo } from './build-info.ts'
import { buildInfoFromConfig, formatBuildLabel } from './static/build-info.js'

describe('parseBuildInfo', () => {
	test('shapes a valid document, dropping unknown sibling fields', () => {
		expect(parseBuildInfo({ sha: '9f3a2b7c4d1e5a6b', builtAt: '2026-09-25T12:00:00Z', extra: 'noise' })).toEqual({ sha: '9f3a2b7c4d1e5a6b', builtAt: '2026-09-25T12:00:00Z' })
	})

	test('reads the empty sha the Dockerfile bakes as an absent sha', () => {
		expect(parseBuildInfo({ sha: '', builtAt: '2026-09-25T12:00:00Z' })).toEqual({ builtAt: '2026-09-25T12:00:00Z' })
	})

	test('rejects a missing, empty, or non-string builtAt', () => {
		expect(parseBuildInfo({ sha: '9f3a2b7c' })).toBeNull()
		expect(parseBuildInfo({ builtAt: '' })).toBeNull()
		expect(parseBuildInfo({ builtAt: 12345 })).toBeNull()
	})

	test('rejects a non-string sha', () => {
		expect(parseBuildInfo({ sha: 42, builtAt: '2026-09-25T12:00:00Z' })).toEqual({ builtAt: '2026-09-25T12:00:00Z' })
	})

	test('rejects non-object documents', () => {
		expect(parseBuildInfo(null)).toBeNull()
		expect(parseBuildInfo('2026-09-25T12:00:00Z')).toBeNull()
		expect(parseBuildInfo(['2026-09-25T12:00:00Z'])).toBeNull()
		expect(parseBuildInfo(undefined)).toBeNull()
	})
})

describe('buildInfoFromConfig', () => {
	test('reads the build field off a /api/config body', () => {
		const body = { model: { name: 'm' }, build: { sha: '9f3a2b7c4d1e5a6b', builtAt: '2026-09-25T12:00:00Z' } }
		expect(buildInfoFromConfig(body)).toEqual({ sha: '9f3a2b7c4d1e5a6b', builtAt: '2026-09-25T12:00:00Z' })
	})

	test('yields null for a body without a build field, a null build, or a malformed build', () => {
		expect(buildInfoFromConfig({})).toBeNull()
		expect(buildInfoFromConfig({ build: null })).toBeNull()
		expect(buildInfoFromConfig({ build: { sha: '9f3a2b7c' } })).toBeNull()
		expect(buildInfoFromConfig({ build: '2026-09-25' })).toBeNull()
	})

	test('yields null for a non-object body', () => {
		expect(buildInfoFromConfig(null)).toBeNull()
		expect(buildInfoFromConfig('config')).toBeNull()
	})
})

describe('formatBuildLabel', () => {
	test('joins the 7-character short sha with the built UTC date', () => {
		expect(formatBuildLabel({ sha: '9f3a2b7c4d1e5a6b', builtAt: '2026-09-25T12:34:56Z' })).toBe('9f3a2b7 · 2026-09-25')
	})

	test('renders the built date alone when the build carried no sha', () => {
		expect(formatBuildLabel({ builtAt: '2026-09-25T12:34:56Z' })).toBe('2026-09-25')
	})

	test('normalizes a timestamp baked in a non-UTC offset to the UTC date', () => {
		expect(formatBuildLabel({ builtAt: '2026-09-25T23:30:00+02:00' })).toBe('2026-09-25')
	})

	test('shows a raw unparseable timestamp as-is rather than rendering nothing', () => {
		expect(formatBuildLabel({ builtAt: 'not-a-timestamp' })).toBe('not-a-timestamp')
	})

	test('keeps a sha shorter than the short form whole', () => {
		expect(formatBuildLabel({ sha: '9f3a2b7', builtAt: '2026-09-25T12:34:56Z' })).toBe('9f3a2b7 · 2026-09-25')
	})

	test('returns the empty string for a null or malformed build', () => {
		expect(formatBuildLabel(null)).toBe('')
		expect(formatBuildLabel({ builtAt: '' })).toBe('')
	})
})
