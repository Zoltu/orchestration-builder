import { describe, expect, test } from 'bun:test'
import * as path from 'node:path'
import { createGuildLoader } from './loader.ts'
import { ERROR_KINDS } from '../shared/errors.ts'

const guildDir = path.resolve(import.meta.dir, '..', '..', 'guild')

const expectedRoles = ['orchestrator', 'planner', 'coder', 'critic', 'context_manager', 'recovery'] as const

const expectedToolNames = new Set([
	'agent', 'finish', 'context_info', 'edit_context', 'ask_human',
	'list_directory', 'glob_files', 'read_file', 'read_file_partial', 'search_text', 'fetch_url',
])

describe('seed guild', () => {
	test('loads cleanly through createGuildLoader', () => {
		const loadGuild = createGuildLoader()
		const loaded = loadGuild(guildDir)
		expect(loaded.config.schemaVersion).toBe(1)
		expect(loaded.config.entryRole).toBe('orchestrator')
		for (const role of expectedRoles) {
			expect(loaded.config.roles[role]).toBeDefined()
			expect(loaded.prompts[role]).toBeTruthy()
		}
	})

	test('declares exactly the v1 tool manifests', () => {
		const loadGuild = createGuildLoader()
		const loaded = loadGuild(guildDir)
		expect(new Set(Object.keys(loaded.tools))).toEqual(expectedToolNames)
		expect(loaded.config.tools).toHaveLength(expectedToolNames.size)
	})

	test('every role tool is a declared tool manifest name', () => {
		const loadGuild = createGuildLoader()
		const loaded = loadGuild(guildDir)
		for (const role of Object.values(loaded.config.roles)) {
			for (const toolName of role.tools) {
				expect(expectedToolNames.has(toolName)).toBe(true)
				expect(loaded.tools[toolName]).toBeDefined()
			}
		}
	})

	test('the entry role (orchestrator) exists and can delegate', () => {
		const loadGuild = createGuildLoader()
		const loaded = loadGuild(guildDir)
		const orchestrator = loaded.config.roles[loaded.config.entryRole]
		expect(orchestrator).toBeDefined()
		if (orchestrator === undefined) return
		expect(orchestrator.tools).toContain('agent')
		expect(orchestrator.tools).toContain('finish')
		expect(orchestrator.tools).toContain('ask_human')
	})

	test('orchestrator prompt contains explicit clarifying-question guidance', () => {
		const loadGuild = createGuildLoader()
		const loaded = loadGuild(guildDir)
		const prompt = loaded.prompts['orchestrator']
		expect(prompt).toBeTruthy()
		if (prompt === undefined) return
		expect(prompt.toLowerCase()).toContain('clarifying')
		expect(prompt.toLowerCase()).toContain('ask_human')
	})

	test('recovery prompt lists the available error kinds and how to handle them', () => {
		const loadGuild = createGuildLoader()
		const loaded = loadGuild(guildDir)
		const prompt = loaded.prompts['recovery']
		expect(prompt).toBeTruthy()
		if (prompt === undefined) return
		const lower = prompt.toLowerCase()
		for (const kind of ERROR_KINDS) {
			expect(lower).toContain(kind)
		}
	})

	test('budgets support long-horizon runs', () => {
		const loadGuild = createGuildLoader()
		const loaded = loadGuild(guildDir)
		expect(loaded.config.executor.maxAgentDepth).toBeGreaterThanOrEqual(8)
		expect(loaded.config.executor.maxToolCallsPerRole).toBeGreaterThanOrEqual(50)
		expect(loaded.config.executor.maxRunTimeSeconds).toBeGreaterThanOrEqual(3600)
		expect(loaded.config.contextPolicy.maxToolOutputChars).toBeGreaterThan(0)
	})
})
