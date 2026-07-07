import { describe, expect, test } from 'bun:test'
import * as path from 'node:path'
import { createGuildLoader } from './loader.ts'
import { ERROR_KINDS } from './errors.ts'

const guildDir = path.resolve(import.meta.dir, '..', '..', 'guild')

const expectedRoles = ['orchestrator', 'planner', 'coder', 'critic', 'context_manager', 'recovery'] as const

const expectedToolNames = new Set([
	'agent', 'finish', 'context_info', 'edit_context', 'ask_human',
	'list_directory', 'glob_files', 'read_file', 'read_file_partial', 'search_text', 'write_file', 'fetch_url', 'typecheck', 'test',
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
		expect(loaded.config.executor.defaultToolTimeoutSeconds).toBeGreaterThan(0)
		expect(loaded.config.executor.maxCompactionAttempts).toBeGreaterThan(0)
		expect(loaded.config.contextPolicy.maxToolOutputChars).toBeGreaterThan(0)
	})

	test('every role has tiered label and description', () => {
		const loadGuild = createGuildLoader()
		const loaded = loadGuild(guildDir)
		for (const [_name, role] of Object.entries(loaded.config.roles)) {
			expect(role.label).toBeDefined()
			expect(role.label!.detailed).toBeTruthy()
			if (role.label!.playful) expect(typeof role.label!.playful).toBe('string')
			if (role.label!.friendly) expect(typeof role.label!.friendly).toBe('string')
			expect(role.description).toBeDefined()
			expect(role.description!.detailed).toBeTruthy()
			if (role.description!.playful) expect(typeof role.description!.playful).toBe('string')
			if (role.description!.friendly) expect(typeof role.description!.friendly).toBe('string')
		}
	})

	test('every role has a tiered workingLabel with the {participant} placeholder in each tier', () => {
		const loadGuild = createGuildLoader()
		const loaded = loadGuild(guildDir)
		for (const [_name, role] of Object.entries(loaded.config.roles)) {
			expect(role.workingLabel).toBeDefined()
			expect(role.workingLabel!.detailed).toContain('{participant}')
			expect(role.workingLabel!.friendly).toContain('{participant}')
			expect(role.workingLabel!.playful).toContain('{participant}')
		}
	})

	test('the visualization section carries generic working templates for roles and tools', () => {
		const loadGuild = createGuildLoader()
		const loaded = loadGuild(guildDir)
		expect(loaded.config.visualization).toBeDefined()
		const working = loaded.config.visualization!.workingTemplates
		expect(working).toBeDefined()
		expect(working!.role!.detailed).toContain('{participant}')
		expect(working!.tool!.detailed).toContain('{participant}')
	})

	test('every tool has tiered humanLabel and humanDescription', () => {
		const loadGuild = createGuildLoader()
		const loaded = loadGuild(guildDir)
		for (const [_name, tool] of Object.entries(loaded.tools)) {
			expect(tool.humanLabel).toBeDefined()
			expect(tool.humanLabel!.detailed).toBeTruthy()
			if (tool.humanLabel!.playful) expect(typeof tool.humanLabel!.playful).toBe('string')
			if (tool.humanLabel!.friendly) expect(typeof tool.humanLabel!.friendly).toBe('string')
			expect(tool.humanDescription).toBeDefined()
			expect(tool.humanDescription!.detailed).toBeTruthy()
			if (tool.humanDescription!.playful) expect(typeof tool.humanDescription!.playful).toBe('string')
			if (tool.humanDescription!.friendly) expect(typeof tool.humanDescription!.friendly).toBe('string')
		}
	})

	test('every tool has tiered humanCallLabel with {source} and humanWorkingLabel', () => {
		const loadGuild = createGuildLoader()
		const loaded = loadGuild(guildDir)
		for (const [_name, tool] of Object.entries(loaded.tools)) {
			expect(tool.humanCallLabel).toBeDefined()
			expect(tool.humanCallLabel!.detailed).toContain('{source}')
			expect(tool.humanCallLabel!.friendly).toContain('{source}')
			expect(tool.humanCallLabel!.playful).toContain('{source}')
			expect(tool.humanWorkingLabel).toBeDefined()
			expect(tool.humanWorkingLabel!.detailed).toBeTruthy()
			expect(tool.humanWorkingLabel!.friendly).toBeTruthy()
			expect(tool.humanWorkingLabel!.playful).toBeTruthy()
		}
	})
})
