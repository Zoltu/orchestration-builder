import { describe, expect, test } from 'bun:test'

import { ValidationError } from './errors.js'
import {
	isEffortLevel,
	isProjectSettings,
	isResultCard,
	isRunMeta,
	isTerminalRunStatus,
	validateDeploymentFileConfig,
	validateDeploymentRoleReferences,
	validateGuildConfig,
	validateToolManifest,
} from './validation.ts'
import type { DeploymentFileConfig } from './types.js'

const validGuild = {
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

const validDeployment: DeploymentFileConfig = {
	model: { name: 'm', apiBase: 'http://x', contextWindow: 1, generation: {} },
	executor: {
		maxAgentDepth: 1,
		defaultToolTimeoutSeconds: 1,
		maxCompactionAttempts: 1,
	},
	contextPolicy: { maxToolOutputChars: 1 },
}

describe('boolean guards', () => {
	test('isResultCard accepts a valid ResultCard', () => {
		expect(isResultCard(validResultCard)).toBe(true)
	})
	test('isResultCard rejects an invalid status', () => {
		expect(isResultCard({ status: 'ok', summary: 'x' })).toBe(false)
	})
	test('isResultCard accepts every declared error kind, including context_handoff', () => {
		expect(isResultCard({ status: 'error', summary: 'x', error: { kind: 'context_handoff' } })).toBe(true)
		expect(isResultCard({ status: 'error', summary: 'x', error: { kind: 'not_a_kind' } })).toBe(false)
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
		// An interrupted meta composed from lost run data omits the absent optional fields rather than pinning empty-string sentinels.
		expect(isRunMeta({
			runId: 'r',
			task: 't',
			status: 'interrupted',
			startTime: 'now',
			endTime: 'later',
			error: { kind: 'interrupted', message: 'lost' },
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
		expect(isRunMeta({ ...base, effort: 'thorough' })).toBe(true)
		expect(isRunMeta({ ...base, effort: 3 })).toBe(false)
		expect(isRunMeta({ ...base, effort: 'copious' })).toBe(false)
	})
	test('isRunMeta accepts an optional logLevel and rejects an invalid one', () => {
		const base = {
			runId: 'r',
			guildPath: 'g',
			benchmarkPath: 'b',
			task: 't',
			status: 'running' as const,
			startTime: 'now',
		}
		expect(isRunMeta(base)).toBe(true)
		expect(isRunMeta({ ...base, logLevel: 'standard' })).toBe(true)
		expect(isRunMeta({ ...base, logLevel: 'full' })).toBe(true)
		expect(isRunMeta({ ...base, logLevel: 'copious' })).toBe(false)
		expect(isRunMeta({ ...base, logLevel: 3 })).toBe(false)
	})
	test('isRunMeta accepts a run-id-shaped continuesFrom and rejects a malformed one', () => {
		const base = {
			runId: 'r',
			guildPath: 'g',
			benchmarkPath: 'b',
			task: 't',
			status: 'running' as const,
			startTime: 'now',
		}
		expect(isRunMeta({ ...base, continuesFrom: 'run-20260101-000000' })).toBe(true)
		expect(isRunMeta({ ...base, continuesFrom: 'not-a-run-id' })).toBe(false)
		expect(isRunMeta({ ...base, continuesFrom: 7 })).toBe(false)
	})
	test('isEffortLevel accepts the three tier strings and rejects everything else', () => {
		expect(isEffortLevel('quick')).toBe(true)
		expect(isEffortLevel('standard')).toBe(true)
		expect(isEffortLevel('thorough')).toBe(true)
		expect(isEffortLevel('Quick')).toBe(false)
		expect(isEffortLevel('')).toBe(false)
		expect(isEffortLevel(3)).toBe(false)
		expect(isEffortLevel(0)).toBe(false)
		expect(isEffortLevel(null)).toBe(false)
		expect(isEffortLevel(undefined)).toBe(false)
	})
	test('isTerminalRunStatus accepts every settled status and rejects running', () => {
		expect(isTerminalRunStatus('success')).toBe(true)
		expect(isTerminalRunStatus('error')).toBe(true)
		expect(isTerminalRunStatus('needs_clarification')).toBe(true)
		expect(isTerminalRunStatus('interrupted')).toBe(true)
		expect(isTerminalRunStatus('running')).toBe(false)
	})
	test('isProjectSettings accepts empty, valid effort, and rejects invalid effort', () => {
		expect(isProjectSettings({})).toBe(true)
		expect(isProjectSettings({ effort: 'quick' })).toBe(true)
		expect(isProjectSettings({ effort: 'copious' })).toBe(false)
		expect(isProjectSettings({ effort: 3 })).toBe(false)
		expect(isProjectSettings('not an object')).toBe(false)
		expect(isProjectSettings(null)).toBe(false)
	})
	test('isProjectSettings accepts a valid logLevel and rejects an invalid one', () => {
		expect(isProjectSettings({ logLevel: 'standard' })).toBe(true)
		expect(isProjectSettings({ effort: 'quick', logLevel: 'full' })).toBe(true)
		expect(isProjectSettings({ logLevel: 'copious' })).toBe(false)
		expect(isProjectSettings({ logLevel: 1 })).toBe(false)
	})
})

describe('validateGuildConfig throws ValidationError with a path-based message', () => {
	test('validateGuildConfig passes on a valid GuildConfig', () => {
		expect(() => validateGuildConfig(validGuild)).not.toThrow()
	})
	test('validateGuildConfig throws with entryRole path', () => {
		const bad = { ...validGuild, entryRole: 42 }
		try {
			validateGuildConfig(bad)
		} catch (e) {
			if (e instanceof ValidationError) {
				expect(e.message).toMatch(/entryRole/)
				expect(e.path).toBe('entryRole')
			}
		}
	})
	test('validateGuildConfig throws with roles path', () => {
		const bad = { ...validGuild, roles: 'no' }
		expect(() => validateGuildConfig(bad)).toThrow(/roles/)
	})
	test('validateGuildConfig throws with nested roles path', () => {
		const bad = { ...validGuild, roles: { orchestrator: { systemPrompt: 42, tools: ['finish'] } } }
		try {
			validateGuildConfig(bad)
		} catch (e) {
			if (e instanceof ValidationError) {
				expect(e.message).toMatch(/roles\.orchestrator\.systemPrompt/)
			}
		}
	})
	test.each(['schemaVersion', 'model', 'executor', 'contextPolicy'])('validateGuildConfig rejects the deployment-shaped key %s with a pointer to deployment.json', (key) => {
		const bad: Record<string, unknown> = { ...validGuild, [key]: {} }
		try {
			validateGuildConfig(bad)
		} catch (e) {
			if (e instanceof ValidationError) {
				expect(e.path).toBe(key)
				expect(e.message).toMatch(/deployment\.json/)
			}
		}
		expect(() => validateGuildConfig(bad)).toThrow(ValidationError)
	})
	test('rejects includeReasoning as an unknown key inside a role definition', () => {
		const bad = { ...validGuild, roles: { orchestrator: { systemPrompt: 'p', tools: ['finish'], includeReasoning: true } } }
		expect(() => validateGuildConfig(bad)).toThrow(/roles\.orchestrator\.includeReasoning.*unknown key "includeReasoning"/)
	})
	test('validateToolManifest throws on non-string name', () => {
		expect(() => validateToolManifest({ ...validToolManifest, name: 123 })).toThrow(/name/)
	})
	test('validateToolManifest throws when parameters type is not object', () => {
		expect(() => validateToolManifest({ ...validToolManifest, parameters: { type: 'array' } })).toThrow(/parameters\.type/)
	})
	test('validateToolManifest rejects a property whose declared type drifts from the expected type', () => {
		const drifted = { ...validToolManifest, parameters: { type: 'object', required: ['commands'], properties: { commands: { type: 'string' } } } }
		expect(() => validateToolManifest(drifted, { commands: 'array' })).toThrow(/parameters\.properties\.commands\.type/)
		const pinned = { ...validToolManifest, parameters: { type: 'object', required: ['commands'], properties: { commands: { type: 'array' } } } }
		expect(() => validateToolManifest(pinned, { commands: 'array' })).not.toThrow()
	})
})

describe('validateDeploymentFileConfig throws ValidationError with a path-based message', () => {
	test('passes on a valid DeploymentFileConfig', () => {
		expect(() => validateDeploymentFileConfig(validDeployment)).not.toThrow()
	})
	test('tolerates every optional field', () => {
		const full: unknown = {
			model: { name: 'm', apiBase: 'http://x', contextWindow: 1, generation: { temperature: 0.2, maxTokens: 512 } },
			executor: {
				maxAgentDepth: 1,
				defaultToolTimeoutSeconds: 1,
				maxCompactionAttempts: 1,
				contextPressureThreshold: 0.8,
				contextHandlerRole: 'context_manager',
				inquiryHandlerRole: 'inquiry_responder',
				interruptTriggers: { handlerRole: 'loop_detector', everyToolCalls: 12, everyTokens: 30000, planOwnerRole: 'planner' },
			},
			contextPolicy: { maxToolOutputChars: 1 },
		}
		expect(() => validateDeploymentFileConfig(full)).not.toThrow()
	})
	test('accepts a model without name and contextWindow (the fields the model API can also report)', () => {
		const incomplete: unknown = { ...validDeployment, model: { apiBase: 'http://x', generation: {} } }
		expect(() => validateDeploymentFileConfig(incomplete)).not.toThrow()
	})
	test('rejects a present-but-empty model.name and non-positive model.contextWindow', () => {
		const emptyName = { ...validDeployment, model: { ...validDeployment.model, name: '' } }
		expect(() => validateDeploymentFileConfig(emptyName)).toThrow(/model\.name/)
		for (const window of [0, -1]) {
			const nonPositive = { ...validDeployment, model: { ...validDeployment.model, contextWindow: window } }
			expect(() => validateDeploymentFileConfig(nonPositive)).toThrow(/model\.contextWindow/)
		}
	})
	test('rejects a non-object', () => {
		expect(() => validateDeploymentFileConfig('nope')).toThrow(ValidationError)
		expect(() => validateDeploymentFileConfig(null)).toThrow(ValidationError)
		expect(() => validateDeploymentFileConfig([])).toThrow(ValidationError)
	})
	test.each(['model', 'executor', 'contextPolicy'])('rejects a missing or malformed %s', (section) => {
		const bad: Record<string, unknown> = { ...validDeployment }
		bad[section] = 42
		expect(() => validateDeploymentFileConfig(bad)).toThrow(new RegExp(`${section}`))
	})
	test.each([
		['name', 42],
		['apiBase', 42],
		['contextWindow', 'big'],
		['generation', 42],
	])('rejects a malformed model.%s', (field, value) => {
		const bad = { ...validDeployment, model: { ...validDeployment.model, [field]: value } }
		expect(() => validateDeploymentFileConfig(bad)).toThrow(new RegExp(`model\\.${field}`))
	})
	test('rejects reasoningField as an unknown key inside model', () => {
		const bad = { ...validDeployment, model: { ...validDeployment.model, reasoningField: 'reasoning' } }
		expect(() => validateDeploymentFileConfig(bad)).toThrow(/model\.reasoningField.*unknown key "reasoningField"/)
	})
	test.each([
		['maxAgentDepth', 'deep'],
		['defaultToolTimeoutSeconds', 'long'],
		['maxCompactionAttempts', 'many'],
	])('rejects a malformed executor.%s', (field, value) => {
		const bad = { ...validDeployment, executor: { ...validDeployment.executor, [field]: value } }
		expect(() => validateDeploymentFileConfig(bad)).toThrow(new RegExp(`executor\\.${field}`))
	})
	test('rejects a malformed generation.temperature and maxTokens', () => {
		const hot = { ...validDeployment, model: { ...validDeployment.model, generation: { temperature: 'hot' } } }
		expect(() => validateDeploymentFileConfig(hot)).toThrow(/model\.generation\.temperature/)
		const big = { ...validDeployment, model: { ...validDeployment.model, generation: { maxTokens: 'big' } } }
		expect(() => validateDeploymentFileConfig(big)).toThrow(/model\.generation\.maxTokens/)
	})
	test('rejects an unknown key inside model.generation (near-miss maxtokens)', () => {
		const bad = { ...validDeployment, model: { ...validDeployment.model, generation: { maxtokens: 512 } } }
		try {
			validateDeploymentFileConfig(bad)
		} catch (e) {
			if (e instanceof ValidationError) {
				expect(e.path).toBe('model.generation.maxtokens')
			}
		}
		expect(() => validateDeploymentFileConfig(bad)).toThrow(/model\.generation\.maxtokens.*unknown key "maxtokens"/)
	})
	test('rejects a contextPressureThreshold outside (0, 1)', () => {
		const withThreshold = (contextPressureThreshold: unknown) => ({
			...validDeployment,
			executor: { ...validDeployment.executor, contextPressureThreshold },
		})
		expect(() => validateDeploymentFileConfig(withThreshold(0.8))).not.toThrow()
		expect(() => validateDeploymentFileConfig(withThreshold(0.01))).not.toThrow()
		expect(() => validateDeploymentFileConfig(withThreshold(0))).toThrow(/executor\.contextPressureThreshold/)
		expect(() => validateDeploymentFileConfig(withThreshold(1))).toThrow(/executor\.contextPressureThreshold/)
		expect(() => validateDeploymentFileConfig(withThreshold(1.5))).toThrow(/executor\.contextPressureThreshold/)
		expect(() => validateDeploymentFileConfig(withThreshold('high'))).toThrow(/executor\.contextPressureThreshold/)
	})
	test('accepts a contextHandlerRole string and rejects empty or non-string values', () => {
		const withHandler = (contextHandlerRole: unknown) => ({
			...validDeployment,
			executor: { ...validDeployment.executor, contextHandlerRole },
		})
		expect(() => validateDeploymentFileConfig(withHandler('context_manager'))).not.toThrow()
		expect(() => validateDeploymentFileConfig(withHandler(''))).toThrow(/executor\.contextHandlerRole/)
		expect(() => validateDeploymentFileConfig(withHandler(42))).toThrow(/executor\.contextHandlerRole/)
	})
	test('accepts an inquiryHandlerRole string and rejects empty or non-string values', () => {
		const withHandler = (inquiryHandlerRole: unknown) => ({
			...validDeployment,
			executor: { ...validDeployment.executor, inquiryHandlerRole },
		})
		expect(() => validateDeploymentFileConfig(withHandler('inquirer'))).not.toThrow()
		expect(() => validateDeploymentFileConfig(withHandler(''))).toThrow(/executor\.inquiryHandlerRole/)
		expect(() => validateDeploymentFileConfig(withHandler(42))).toThrow(/executor\.inquiryHandlerRole/)
	})
	test('rejects unknown top-level keys', () => {
		const bad = { ...validDeployment, budgest: {} }
		try {
			validateDeploymentFileConfig(bad)
		} catch (e) {
			if (e instanceof ValidationError) {
				expect(e.path).toBe('budgest')
			}
		}
		expect(() => validateDeploymentFileConfig(bad)).toThrow(/unknown key "budgest"/)
	})
	test('rejects unknown keys inside model', () => {
		const bad = { ...validDeployment, model: { ...validDeployment.model, contextwindow: 1 } }
		try {
			validateDeploymentFileConfig(bad)
		} catch (e) {
			if (e instanceof ValidationError) {
				expect(e.path).toBe('model.contextwindow')
			}
		}
		expect(() => validateDeploymentFileConfig(bad)).toThrow(/unknown key "contextwindow"/)
	})
	test('rejects unknown keys inside executor', () => {
		const bad = { ...validDeployment, executor: { ...validDeployment.executor, maxAgentDepht: 8 } }
		try {
			validateDeploymentFileConfig(bad)
		} catch (e) {
			if (e instanceof ValidationError) {
				expect(e.path).toBe('executor.maxAgentDepht')
			}
		}
		expect(() => validateDeploymentFileConfig(bad)).toThrow(/unknown key "maxAgentDepht"/)
	})
	test('rejects unknown keys inside contextPolicy', () => {
		const bad = { ...validDeployment, contextPolicy: { maxToolOutputChars: 1, maxOutpuChars: 1 } }
		expect(() => validateDeploymentFileConfig(bad)).toThrow(/contextPolicy\.maxOutpuChars.*unknown key "maxOutpuChars"/)
	})
	test('accepts an optional logging section with a valid level', () => {
		expect(() => validateDeploymentFileConfig({ ...validDeployment, logging: {} })).not.toThrow()
		expect(() => validateDeploymentFileConfig({ ...validDeployment, logging: { level: 'full' } })).not.toThrow()
		expect(() => validateDeploymentFileConfig({ ...validDeployment, logging: { level: 'standard' } })).not.toThrow()
	})
	test('rejects a malformed logging.level', () => {
		const bad = { ...validDeployment, logging: { level: 'quiet' } }
		expect(() => validateDeploymentFileConfig(bad)).toThrow(/logging\.level/)
		const numeric = { ...validDeployment, logging: { level: 3 } }
		expect(() => validateDeploymentFileConfig(numeric)).toThrow(/logging\.level/)
	})
	test('rejects unknown keys inside logging (near-miss levels)', () => {
		const bad = { ...validDeployment, logging: { levels: 'full' } }
		expect(() => validateDeploymentFileConfig(bad)).toThrow(/logging\.levels.*unknown key "levels"/)
	})
	test('rejects unknown keys inside executor.interruptTriggers (near-miss planOwnerRol)', () => {
		const bad = {
			...validDeployment,
			executor: {
				...validDeployment.executor,
				interruptTriggers: { handlerRole: 'loop_detector', everyToolCalls: 12, everyTokens: 30000, planOwnerRol: 'planner' },
			},
		}
		try {
			validateDeploymentFileConfig(bad)
		} catch (e) {
			if (e instanceof ValidationError) {
				expect(e.path).toBe('executor.interruptTriggers.planOwnerRol')
			}
		}
		expect(() => validateDeploymentFileConfig(bad)).toThrow(/executor\.interruptTriggers\.planOwnerRol.*unknown key "planOwnerRol"/)
	})
	test('rejects model.apiKey with a pointer to the ORCHESTRATOR_API_KEY environment variable', () => {
		const bad = { ...validDeployment, model: { ...validDeployment.model, apiKey: 'secret' } }
		try {
			validateDeploymentFileConfig(bad)
		} catch (e) {
			if (e instanceof ValidationError) {
				expect(e.path).toBe('model.apiKey')
				expect(e.message).toMatch(/ORCHESTRATOR_API_KEY/)
			}
		}
		expect(() => validateDeploymentFileConfig(bad)).toThrow(ValidationError)
	})
})

describe('validateDeploymentRoleReferences', () => {
	const roleNames = new Set(['orchestrator', 'context_manager', 'inquiry_responder', 'loop_detector', 'planner'])
	const validDeploymentFor: (executor: Partial<DeploymentFileConfig['executor']>) => DeploymentFileConfig = (executor) => ({
		...validDeployment,
		executor: { ...validDeployment.executor, ...executor },
	})

	test('accepts unset handler roles and interrupt triggers', () => {
		expect(() => validateDeploymentRoleReferences(validDeployment, roleNames)).not.toThrow()
	})
	test('accepts handler roles and interrupt triggers that exist in the guild', () => {
		const deployment = validDeploymentFor({
			contextHandlerRole: 'context_manager',
			inquiryHandlerRole: 'inquiry_responder',
			interruptTriggers: { handlerRole: 'loop_detector', everyToolCalls: 12, everyTokens: 30000, planOwnerRole: 'planner' },
		})
		expect(() => validateDeploymentRoleReferences(deployment, roleNames)).not.toThrow()
	})
	test('rejects an unknown executor.contextHandlerRole with the precise path', () => {
		const deployment = validDeploymentFor({ contextHandlerRole: 'compactor' })
		try {
			validateDeploymentRoleReferences(deployment, roleNames)
		} catch (e) {
			if (e instanceof ValidationError) {
				expect(e.path).toBe('executor.contextHandlerRole')
				expect(e.message).toContain('compactor')
			}
		}
		expect(() => validateDeploymentRoleReferences(deployment, roleNames)).toThrow(ValidationError)
	})
	test('rejects an unknown executor.inquiryHandlerRole with the precise path', () => {
		const deployment = validDeploymentFor({ inquiryHandlerRole: 'responder' })
		try {
			validateDeploymentRoleReferences(deployment, roleNames)
		} catch (e) {
			if (e instanceof ValidationError) {
				expect(e.path).toBe('executor.inquiryHandlerRole')
				expect(e.message).toContain('responder')
			}
		}
		expect(() => validateDeploymentRoleReferences(deployment, roleNames)).toThrow(ValidationError)
	})
	test('rejects an unknown interruptTriggers.handlerRole with the precise path', () => {
		const deployment = validDeploymentFor({ interruptTriggers: { handlerRole: 'watchdog', everyToolCalls: 1, everyTokens: 1 } })
		try {
			validateDeploymentRoleReferences(deployment, roleNames)
		} catch (e) {
			if (e instanceof ValidationError) {
				expect(e.path).toBe('executor.interruptTriggers.handlerRole')
				expect(e.message).toContain('watchdog')
			}
		}
		expect(() => validateDeploymentRoleReferences(deployment, roleNames)).toThrow(ValidationError)
	})
	test('rejects an unknown interruptTriggers.planOwnerRole with the precise path', () => {
		const deployment = validDeploymentFor({ interruptTriggers: { handlerRole: 'loop_detector', everyToolCalls: 1, everyTokens: 1, planOwnerRole: 'owner' } })
		try {
			validateDeploymentRoleReferences(deployment, roleNames)
		} catch (e) {
			if (e instanceof ValidationError) {
				expect(e.path).toBe('executor.interruptTriggers.planOwnerRole')
				expect(e.message).toContain('owner')
			}
		}
		expect(() => validateDeploymentRoleReferences(deployment, roleNames)).toThrow(ValidationError)
	})
	test('accepts interrupt triggers without a planOwnerRole', () => {
		const deployment = validDeploymentFor({ interruptTriggers: { handlerRole: 'loop_detector', everyToolCalls: 1, everyTokens: 1 } })
		expect(() => validateDeploymentRoleReferences(deployment, roleNames)).not.toThrow()
	})
})
