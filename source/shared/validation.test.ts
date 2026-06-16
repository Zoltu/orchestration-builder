import { describe, expect, test } from 'bun:test'

import { ValidationError } from './errors.js'
import {
	isAssistantResponse,
	isGuildConfig,
	isLogEvent,
	isMessage,
	isResultCard,
	isRunMeta,
	isToolCall,
	isToolManifest,
	isToolResult,
	validateGuildConfig,
	validateMessage,
	validateResultCard,
	validateToolCall,
	validateToolManifest,
} from './validation.ts'

const validGuild = {
	schemaVersion: 1,
	model: { name: 'm', apiBase: 'http://x', contextWindow: 1, generation: {} },
	executor: {
		maxAgentDepth: 1,
		maxToolCallsPerRole: 1,
		maxTokensPerRole: 1,
		maxRunTimeSeconds: 1,
		defaultToolTimeoutSeconds: 1,
		maxRepeatedToolCalls: 1,
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

const validMessage = { role: 'user' as const, content: 'hi' }

const validToolCall = {
	id: '1',
	type: 'function' as const,
	function: { name: 'f', arguments: '{}' },
}

const validResultCard = { status: 'success' as const, summary: 'done' }

describe('boolean guards', () => {
	test('isGuildConfig accepts a valid GuildConfig', () => {
		expect(isGuildConfig(validGuild)).toBe(true)
	})
	test('isGuildConfig rejects missing fields', () => {
		expect(isGuildConfig({ schemaVersion: 1 })).toBe(false)
	})
	test('isToolManifest accepts a valid tool manifest', () => {
		expect(isToolManifest(validToolManifest)).toBe(true)
	})
	test('isToolManifest rejects parameters whose type is not object', () => {
		expect(isToolManifest({ ...validToolManifest, parameters: { type: 'array' } })).toBe(false)
	})
	test('isMessage accepts a valid Message', () => {
		expect(isMessage(validMessage)).toBe(true)
	})
	test('isMessage rejects an invalid role', () => {
		expect(isMessage({ role: 'wizard', content: 'hi' })).toBe(false)
	})
	test('isToolCall accepts a valid ToolCall', () => {
		expect(isToolCall(validToolCall)).toBe(true)
	})
	test('isToolCall rejects wrong type', () => {
		expect(isToolCall({ ...validToolCall, type: 'action' })).toBe(false)
	})
	test('isResultCard accepts a valid ResultCard', () => {
		expect(isResultCard(validResultCard)).toBe(true)
	})
	test('isResultCard rejects an invalid status', () => {
		expect(isResultCard({ status: 'ok', summary: 'x' })).toBe(false)
	})
	test('isAssistantResponse accepts an empty object (all fields optional)', () => {
		expect(isAssistantResponse({})).toBe(true)
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
	test('isLogEvent accepts a minimal valid LogEvent', () => {
		expect(isLogEvent({ timestamp: 'now', type: 'x' })).toBe(true)
	})
	test('isToolResult accepts a success result', () => {
		expect(isToolResult({ kind: 'success', data: 1 })).toBe(true)
	})
	test('isToolResult accepts a known error kind', () => {
		expect(isToolResult({ kind: 'timeout', message: 'x' })).toBe(true)
	})
	test('isToolResult rejects an unknown kind', () => {
		expect(isToolResult({ kind: 'mystery' })).toBe(false)
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
	test('validateMessage throws on invalid role', () => {
		expect(() => validateMessage({ role: 'wizard', content: 'hi' })).toThrow(/role/)
	})
	test('validateToolCall throws when type is not function', () => {
		const bad = { id: '1', type: 'x', function: { name: 'f', arguments: '{}' } }
		try {
			validateToolCall(bad)
		} catch (e) {
			if (e instanceof ValidationError) {
				expect(e.message).toMatch(/\.type/)
			}
		}
	})
	test('validateResultCard throws on invalid status', () => {
		expect(() => validateResultCard({ status: 'x', summary: 's' })).toThrow(/status/)
	})
})
