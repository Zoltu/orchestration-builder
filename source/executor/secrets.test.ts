import { describe, expect, test } from 'bun:test'

import { resolveSecret, type SecretChannels } from './secrets.ts'

function makeChannels(environment: Record<string, string | undefined>, secrets: Record<string, string> = {}): { channels: SecretChannels; secretCalls: string[] } {
	const secretCalls: string[] = []
	const channels: SecretChannels = {
		environment,
		readDockerSecret: (name) => {
			secretCalls.push(name)
			return secrets[name]
		},
	}
	return { channels, secretCalls }
}

describe('resolveSecret', () => {
	test('resolves the environment variable named after the upper-snake form of the secret', () => {
		const { channels } = makeChannels({ ORCHESTRATOR_API_KEY: 'env-key' })
		expect(resolveSecret('orchestrator_api_key', channels)).toBe('env-key')
	})

	test('prefers the environment variable over docker secrets', () => {
		const { channels, secretCalls } = makeChannels({ ORCHESTRATOR_API_KEY: 'env-key' }, { orchestrator_api_key: 'secret-key' })
		expect(resolveSecret('orchestrator_api_key', channels)).toBe('env-key')
		expect(secretCalls).toEqual([])
	})

	test('trims the environment variable', () => {
		const { channels } = makeChannels({ ORCHESTRATOR_API_KEY: '  padded  ' })
		expect(resolveSecret('orchestrator_api_key', channels)).toBe('padded')
	})

	test('treats a whitespace-only environment variable as unset and falls through', () => {
		const { channels } = makeChannels({ ORCHESTRATOR_API_KEY: '   ' }, { orchestrator_api_key: 'secret-key' })
		expect(resolveSecret('orchestrator_api_key', channels)).toBe('secret-key')
	})

	test('falls back to the lowercase docker secret', () => {
		const { channels, secretCalls } = makeChannels({}, { orchestrator_api_key: 'secret-key' })
		expect(resolveSecret('orchestrator_api_key', channels)).toBe('secret-key')
		expect(secretCalls).toEqual(['orchestrator_api_key'])
	})

	test('falls back to the upper-snake docker secret when the lowercase one is absent', () => {
		const { channels, secretCalls } = makeChannels({}, { ORCHESTRATOR_API_KEY: 'upper-key' })
		expect(resolveSecret('orchestrator_api_key', channels)).toBe('upper-key')
		expect(secretCalls).toEqual(['orchestrator_api_key', 'ORCHESTRATOR_API_KEY'])
	})

	test('prefers the lowercase docker secret over the upper-snake one', () => {
		const { channels, secretCalls } = makeChannels({}, { orchestrator_api_key: 'lower-key', ORCHESTRATOR_API_KEY: 'upper-key' })
		expect(resolveSecret('orchestrator_api_key', channels)).toBe('lower-key')
		expect(secretCalls).toEqual(['orchestrator_api_key'])
	})

	test('trims the docker secret value', () => {
		const { channels } = makeChannels({}, { orchestrator_api_key: '  padded  ' })
		expect(resolveSecret('orchestrator_api_key', channels)).toBe('padded')
	})

	test('treats an empty docker secret as unset and falls through to the upper-snake name', () => {
		const { channels, secretCalls } = makeChannels({}, { orchestrator_api_key: '', ORCHESTRATOR_API_KEY: 'upper-key' })
		expect(resolveSecret('orchestrator_api_key', channels)).toBe('upper-key')
		expect(secretCalls).toEqual(['orchestrator_api_key', 'ORCHESTRATOR_API_KEY'])
	})

	test('returns undefined when no channel yields a value', () => {
		const { channels, secretCalls } = makeChannels({})
		expect(resolveSecret('orchestrator_api_key', channels)).toBeUndefined()
		expect(secretCalls).toEqual(['orchestrator_api_key', 'ORCHESTRATOR_API_KEY'])
	})

	test('an explicit environment name overrides the derived one', () => {
		const { channels, secretCalls } = makeChannels({ ORCHESTRATOR_KAGI_API_KEY: 'env-key' }, { kagi_api_key: 'secret-key' })
		expect(resolveSecret('kagi_api_key', channels, 'ORCHESTRATOR_KAGI_API_KEY')).toBe('env-key')
		expect(secretCalls).toEqual([])
	})

	test('an explicit environment name leaves the lowercase secret path unchanged', () => {
		const { channels, secretCalls } = makeChannels({}, { kagi_api_key: 'secret-key' })
		expect(resolveSecret('kagi_api_key', channels, 'ORCHESTRATOR_KAGI_API_KEY')).toBe('secret-key')
		expect(secretCalls).toEqual(['kagi_api_key'])
	})

	test('an explicit environment name derives the upper-snake secret fallback from the environment variable', () => {
		const { channels, secretCalls } = makeChannels({}, { kagi_api_key: '', ORCHESTRATOR_KAGI_API_KEY: 'upper-key' })
		expect(resolveSecret('kagi_api_key', channels, 'ORCHESTRATOR_KAGI_API_KEY')).toBe('upper-key')
		expect(secretCalls).toEqual(['kagi_api_key', 'ORCHESTRATOR_KAGI_API_KEY'])
	})
})
