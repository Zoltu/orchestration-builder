import { describe, expect, test } from 'bun:test'

import { ValidationError } from './errors.js'
import {
	isEffortLevel,
	isProjectSettings,
	isResultCard,
	isRunMeta,
	validateGuildConfig,
	validateToolManifest,
} from './validation.ts'

const validGuild = {
	schemaVersion: 1,
	model: { name: 'm', apiBase: 'http://x', contextWindow: 1, generation: {} },
	executor: {
		maxAgentDepth: 1,
		defaultToolTimeoutSeconds: 1,
		maxCompactionAttempts: 1,
	},
	contextPolicy: { maxToolOutputChars: 1 },
	entryRole: 'orchestrator',
	roles: { orchestrator: { systemPrompt: 'p', tools: ['finish'] } },
	tools: ['t.json'],
}

const validToolManifest = {
	name: 'finish',
	description: 'finish a role',
	parameters: { type: 'object', properties: {} },
}

const validResultCard = { status: 'success' as const, summary: 'done' }

describe('boolean guards', () => {
	test('isResultCard accepts a valid ResultCard', () => {
		expect(isResultCard(validResultCard)).toBe(true)
	})
	test('isResultCard rejects an invalid status', () => {
		expect(isResultCard({ status: 'ok', summary: 'x' })).toBe(false)
	})
	test('isRunMeta accepts a minimal valid RunMeta', () => {
		expect(isRunMeta({
			runId: 'r',
			guildPath: 'g',
			benchmarkPath: 'b',
			task: 't',
			status: 'running',
			startTime: 'now',
		})).toBe(true)
	})
	test('isRunMeta accepts an optional effort and rejects an invalid one', () => {
		const base = {
			runId: 'r',
			guildPath: 'g',
			benchmarkPath: 'b',
			task: 't',
			status: 'running' as const,
			startTime: 'now',
		}
		expect(isRunMeta({ ...base, effort: 3 })).toBe(true)
		expect(isRunMeta({ ...base, effort: 9 })).toBe(false)
		expect(isRunMeta({ ...base, effort: 1.5 })).toBe(false)
	})
	test('isEffortLevel accepts integers 0–5 and rejects everything else', () => {
		for (let i = 0; i <= 5; i++) expect(isEffortLevel(i)).toBe(true)
		expect(isEffortLevel(-1)).toBe(false)
		expect(isEffortLevel(6)).toBe(false)
		expect(isEffortLevel(2.5)).toBe(false)
		expect(isEffortLevel('3')).toBe(false)
		expect(isEffortLevel(null)).toBe(false)
		expect(isEffortLevel(undefined)).toBe(false)
		expect(isEffortLevel(Number.NaN)).toBe(false)
	})
	test('isProjectSettings accepts empty, valid effort, and rejects invalid effort', () => {
		expect(isProjectSettings({})).toBe(true)
		expect(isProjectSettings({ effort: 3 })).toBe(true)
		expect(isProjectSettings({ effort: 9 })).toBe(false)
		expect(isProjectSettings({ effort: '3' })).toBe(false)
		expect(isProjectSettings('not an object')).toBe(false)
		expect(isProjectSettings(null)).toBe(false)
	})
})

describe('validate* throws ValidationError with a path-based message', () => {
	test('validateGuildConfig passes on a valid GuildConfig', () => {
		expect(() => validateGuildConfig(validGuild)).not.toThrow()
	})
	test('validateGuildConfig throws with schemaVersion path', () => {
		expect(() => validateGuildConfig({ schemaVersion: 'no' })).toThrow(ValidationError)
		try {
			validateGuildConfig({ schemaVersion: 'no' })
		} catch (e) {
			if (e instanceof ValidationError) {
				expect(e.message).toMatch(/schemaVersion/)
				expect(e.path).toBe('schemaVersion')
			}
		}
	})
	test('validateGuildConfig throws with nested model.apiBase path', () => {
		const bad = { ...validGuild, model: { ...validGuild.model, apiBase: 123 } }
		try {
			validateGuildConfig(bad)
		} catch (e) {
			if (e instanceof ValidationError) {
				expect(e.message).toMatch(/model\.apiBase/)
			}
		}
	})
	test('validateToolManifest throws on non-string name', () => {
		expect(() => validateToolManifest({ ...validToolManifest, name: 123 })).toThrow(/name/)
	})
	test('validateToolManifest throws when parameters type is not object', () => {
		expect(() => validateToolManifest({ ...validToolManifest, parameters: { type: 'array' } })).toThrow(/parameters\.type/)
	})
})
