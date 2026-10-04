import { describe, expect, test } from 'bun:test'
import { extractKagiErrorMessage, parseKagiExtractMarkdown, parseKagiSearchResults, resolveKagiApiKey } from './kagi.ts'

describe('parseKagiSearchResults', () => {
	test('parses a full search envelope and ignores other buckets', () => {
		const body = {
			meta: { id: 'abc' },
			data: {
				search: [
					{ url: 'https://a.example', title: 'A', snippet: 'alpha', time: '2026-01-01T00:00:00Z' },
					{ url: 'https://b.example', title: 'B' },
				],
				news: [{ url: 'https://n.example', title: 'N' }],
			},
		}
		expect(parseKagiSearchResults(body)).toEqual([
			{ url: 'https://a.example', title: 'A', snippet: 'alpha', time: '2026-01-01T00:00:00Z' },
			{ url: 'https://b.example', title: 'B' },
		])
	})

	test('tolerates extra fields on result items', () => {
		const body = { data: { search: [{ url: 'https://a.example', title: 'A', thumbnail: 'x', rank: 1 }] } }
		expect(parseKagiSearchResults(body)).toEqual([{ url: 'https://a.example', title: 'A' }])
	})

	test('returns an empty list when the search bucket is absent', () => {
		expect(parseKagiSearchResults({ meta: {}, data: {} })).toEqual([])
	})

	test('returns an empty list when the search bucket is empty', () => {
		expect(parseKagiSearchResults({ meta: {}, data: { search: [] } })).toEqual([])
	})

	test('returns undefined when the body is not an object', () => {
		expect(parseKagiSearchResults('nope')).toBeUndefined()
		expect(parseKagiSearchResults(null)).toBeUndefined()
		expect(parseKagiSearchResults([])).toBeUndefined()
	})

	test('returns undefined when data is missing or not an object', () => {
		expect(parseKagiSearchResults({})).toBeUndefined()
		expect(parseKagiSearchResults({ data: null })).toBeUndefined()
		expect(parseKagiSearchResults({ data: 'x' })).toBeUndefined()
	})

	test('returns undefined when the search bucket is not an array', () => {
		expect(parseKagiSearchResults({ data: { search: 'x' } })).toBeUndefined()
	})

	test('returns undefined when an item has the wrong shape', () => {
		expect(parseKagiSearchResults({ data: { search: [{ title: 'A' }] } })).toBeUndefined()
		expect(parseKagiSearchResults({ data: { search: [{ url: 1, title: 'A' }] } })).toBeUndefined()
		expect(parseKagiSearchResults({ data: { search: [{ url: 'https://a.example', title: 'A', snippet: 42 }] } })).toBeUndefined()
		expect(parseKagiSearchResults({ data: { search: [{ url: 'https://a.example', title: 'A', time: null }] } })).toBeUndefined()
	})
})

describe('parseKagiExtractMarkdown', () => {
	test('returns the first page markdown', () => {
		const body = { data: [{ url: 'https://a.example', markdown: '# Title' }] }
		expect(parseKagiExtractMarkdown(body)).toBe('# Title')
	})

	test('returns undefined when markdown is null', () => {
		const body = { data: [{ url: 'https://a.example', markdown: null }] }
		expect(parseKagiExtractMarkdown(body)).toBeUndefined()
	})

	test('returns undefined when markdown is absent', () => {
		const body = { data: [{ url: 'https://a.example' }] }
		expect(parseKagiExtractMarkdown(body)).toBeUndefined()
	})

	test('returns undefined when markdown is empty', () => {
		const body = { data: [{ url: 'https://a.example', markdown: '' }] }
		expect(parseKagiExtractMarkdown(body)).toBeUndefined()
	})

	test('returns undefined when the item carries an error', () => {
		expect(parseKagiExtractMarkdown({ data: [{ url: 'https://a.example', markdown: null, error: 'boom' }] })).toBeUndefined()
		expect(parseKagiExtractMarkdown({ data: [{ url: 'https://a.example', markdown: 'text', error: 'partial' }] })).toBeUndefined()
	})

	test('returns undefined on a wrong-shaped body', () => {
		expect(parseKagiExtractMarkdown('nope')).toBeUndefined()
		expect(parseKagiExtractMarkdown({})).toBeUndefined()
		expect(parseKagiExtractMarkdown({ data: {} })).toBeUndefined()
		expect(parseKagiExtractMarkdown({ data: [] })).toBeUndefined()
		expect(parseKagiExtractMarkdown({ data: ['nope'] })).toBeUndefined()
	})
})

describe('extractKagiErrorMessage', () => {
	test('returns the first error entry message', () => {
		const body = { error: [{ code: '429', message: 'Rate limit exceeded' }] }
		expect(extractKagiErrorMessage(body)).toBe('Rate limit exceeded')
	})

	test('falls back to the code when the message is null', () => {
		const body = { error: [{ code: '401', message: null }] }
		expect(extractKagiErrorMessage(body)).toBe('401')
	})

	test('returns undefined when there is no usable error entry', () => {
		expect(extractKagiErrorMessage({})).toBeUndefined()
		expect(extractKagiErrorMessage({ error: null })).toBeUndefined()
		expect(extractKagiErrorMessage({ error: [] })).toBeUndefined()
		expect(extractKagiErrorMessage({ error: ['nope'] })).toBeUndefined()
		expect(extractKagiErrorMessage({ error: [{}] })).toBeUndefined()
		expect(extractKagiErrorMessage('nope')).toBeUndefined()
	})
})

describe('resolveKagiApiKey', () => {
	function makeSecretReader(secrets: Record<string, string>): { readSecret: (name: string) => string | undefined; calls: string[] } {
		const calls: string[] = []
		const readSecret = (name: string): string | undefined => {
			calls.push(name)
			return secrets[name]
		}
		return { readSecret, calls }
	}

	test('prefers the environment variable over secrets', () => {
		const reader = makeSecretReader({ kagi_api_key: 'secret-key' })
		const key = resolveKagiApiKey({ ORCHESTRATOR_KAGI_API_KEY: 'env-key' }, reader.readSecret)
		expect(key).toBe('env-key')
		expect(reader.calls).toEqual([])
	})

	test('trims the environment variable', () => {
		const reader = makeSecretReader({})
		const key = resolveKagiApiKey({ ORCHESTRATOR_KAGI_API_KEY: '  padded  ' }, reader.readSecret)
		expect(key).toBe('padded')
	})

	test('falls through to secrets when the environment variable is empty', () => {
		const reader = makeSecretReader({ kagi_api_key: 'secret-key' })
		const key = resolveKagiApiKey({ ORCHESTRATOR_KAGI_API_KEY: '' }, reader.readSecret)
		expect(key).toBe('secret-key')
		expect(reader.calls).toEqual(['kagi_api_key'])
	})

	test('falls through to secrets when the environment variable is whitespace only', () => {
		const reader = makeSecretReader({ kagi_api_key: 'secret-key' })
		const key = resolveKagiApiKey({ ORCHESTRATOR_KAGI_API_KEY: '   ' }, reader.readSecret)
		expect(key).toBe('secret-key')
	})

	test('reads the lowercase secret before the upper-snake one', () => {
		const reader = makeSecretReader({ kagi_api_key: 'lower', ORCHESTRATOR_KAGI_API_KEY: 'upper' })
		const key = resolveKagiApiKey({}, reader.readSecret)
		expect(key).toBe('lower')
		expect(reader.calls).toEqual(['kagi_api_key'])
	})

	test('reads the upper-snake secret when the lowercase one is absent', () => {
		const reader = makeSecretReader({ ORCHESTRATOR_KAGI_API_KEY: 'upper' })
		const key = resolveKagiApiKey({}, reader.readSecret)
		expect(key).toBe('upper')
		expect(reader.calls).toEqual(['kagi_api_key', 'ORCHESTRATOR_KAGI_API_KEY'])
	})

	test('returns undefined when nothing yields a key', () => {
		const reader = makeSecretReader({})
		const key = resolveKagiApiKey({}, reader.readSecret)
		expect(key).toBeUndefined()
		expect(reader.calls).toEqual(['kagi_api_key', 'ORCHESTRATOR_KAGI_API_KEY'])
	})
})
