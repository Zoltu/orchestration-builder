import { describe, expect, test } from 'bun:test'
import * as path from 'node:path'
import { createGuildLoader } from './loader.ts'
import { ERROR_KINDS } from './errors.ts'

const guildDir = path.resolve(import.meta.dir, '..', '..', 'guild')

const expectedRoles = [
	'orchestrator', 'planner', 'coder',
	'architecture_lead', 'architecture_reviewer',
	'style_lead', 'style_reviewer',
	'security_lead', 'security_reviewer',
	'acceptance_lead', 'acceptance_reviewer',
	'context_manager', 'recovery',
] as const

const expectedToolNames = new Set([
	'agent', 'finish', 'context_info', 'edit_context', 'ask_human',
	'list_directory', 'glob_files', 'read_file', 'read_file_partial', 'search_text', 'write_file', 'fetch_url', 'typecheck', 'test',
])

function isNonEmptyStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string')
}

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

	test('review leads delegate and hold no workspace tools', () => {
		const loadGuild = createGuildLoader()
		const loaded = loadGuild(guildDir)
		for (const role of expectedRoles) {
			if (!role.endsWith('_lead')) continue
			const lead = loaded.config.roles[role]
			if (lead === undefined) continue
			expect(lead.tools).toContain('agent')
			expect(lead.tools).toContain('finish')
			expect(lead.tools).not.toContain('write_file')
			expect(lead.tools).not.toContain('read_file')
		}
	})

	test('reviewers are read-only leaves that cannot delegate', () => {
		const loadGuild = createGuildLoader()
		const loaded = loadGuild(guildDir)
		for (const role of expectedRoles) {
			if (!role.endsWith('_reviewer')) continue
			const reviewer = loaded.config.roles[role]
			if (reviewer === undefined) continue
			expect(reviewer.tools).not.toContain('agent')
			expect(reviewer.tools).not.toContain('write_file')
			expect(reviewer.tools).toContain('read_file')
			const prompt = loaded.prompts[role]
			expect(prompt).toBeTruthy()
			if (prompt === undefined) continue
			// The shared reviewer contract: severity tags and the compact-digest return.
			expect(prompt.toLowerCase()).toContain('blocking')
			expect(prompt.toLowerCase()).toContain('suggestion')
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

	test('every role has tiered label and description as non-empty string arrays', () => {
		const loadGuild = createGuildLoader()
		const loaded = loadGuild(guildDir)
		for (const [_name, role] of Object.entries(loaded.config.roles)) {
			expect(role.label).toBeDefined()
			expect(isNonEmptyStringArray(role.label!.detailed)).toBe(true)
			if (role.label!.whimsical !== undefined) expect(isNonEmptyStringArray(role.label!.whimsical)).toBe(true)
			if (role.label!.friendly !== undefined) expect(isNonEmptyStringArray(role.label!.friendly)).toBe(true)
			expect(role.description).toBeDefined()
			expect(isNonEmptyStringArray(role.description!.detailed)).toBe(true)
			if (role.description!.whimsical !== undefined) expect(isNonEmptyStringArray(role.description!.whimsical)).toBe(true)
			if (role.description!.friendly !== undefined) expect(isNonEmptyStringArray(role.description!.friendly)).toBe(true)
		}
	})

	test('every role has a tiered workingLabel as non-empty string arrays', () => {
		const loadGuild = createGuildLoader()
		const loaded = loadGuild(guildDir)
		for (const [_name, role] of Object.entries(loaded.config.roles)) {
			expect(role.workingLabel).toBeDefined()
			expect(isNonEmptyStringArray(role.workingLabel!.detailed)).toBe(true)
			expect(isNonEmptyStringArray(role.workingLabel!.friendly)).toBe(true)
			expect(isNonEmptyStringArray(role.workingLabel!.whimsical)).toBe(true)
			// The whimsical working list has more than one phrase so the caption rotates between operations rather than repeating.
			expect(role.workingLabel!.whimsical!.length).toBeGreaterThan(1)
		}
	})

	test('the visualization section carries generic working templates for roles and tools as non-empty string arrays', () => {
		const loadGuild = createGuildLoader()
		const loaded = loadGuild(guildDir)
		expect(loaded.config.visualization).toBeDefined()
		const working = loaded.config.visualization!.workingTemplates
		expect(working).toBeDefined()
		expect(isNonEmptyStringArray(working!.role!.detailed)).toBe(true)
		expect(isNonEmptyStringArray(working!.tool!.detailed)).toBe(true)
	})

	test('every tool has tiered humanLabel and humanDescription as non-empty string arrays', () => {
		const loadGuild = createGuildLoader()
		const loaded = loadGuild(guildDir)
		for (const [_name, tool] of Object.entries(loaded.tools)) {
			expect(tool.humanLabel).toBeDefined()
			expect(isNonEmptyStringArray(tool.humanLabel!.detailed)).toBe(true)
			if (tool.humanLabel!.whimsical !== undefined) expect(isNonEmptyStringArray(tool.humanLabel!.whimsical)).toBe(true)
			if (tool.humanLabel!.friendly !== undefined) expect(isNonEmptyStringArray(tool.humanLabel!.friendly)).toBe(true)
			expect(tool.humanDescription).toBeDefined()
			expect(isNonEmptyStringArray(tool.humanDescription!.detailed)).toBe(true)
			if (tool.humanDescription!.whimsical !== undefined) expect(isNonEmptyStringArray(tool.humanDescription!.whimsical)).toBe(true)
			if (tool.humanDescription!.friendly !== undefined) expect(isNonEmptyStringArray(tool.humanDescription!.friendly)).toBe(true)
		}
	})

	test('every tool has tiered humanCallLabel and humanWorkingLabel as non-empty string arrays', () => {
		const loadGuild = createGuildLoader()
		const loaded = loadGuild(guildDir)
		for (const [_name, tool] of Object.entries(loaded.tools)) {
			expect(tool.humanCallLabel).toBeDefined()
			expect(isNonEmptyStringArray(tool.humanCallLabel!.detailed)).toBe(true)
			expect(isNonEmptyStringArray(tool.humanCallLabel!.friendly)).toBe(true)
			expect(isNonEmptyStringArray(tool.humanCallLabel!.whimsical)).toBe(true)
			// The whimsical call list has more than one phrase so a tool invoked repeatedly varies in the caption.
			expect(tool.humanCallLabel!.whimsical!.length).toBeGreaterThan(1)
			expect(tool.humanWorkingLabel).toBeDefined()
			expect(isNonEmptyStringArray(tool.humanWorkingLabel!.detailed)).toBe(true)
			expect(isNonEmptyStringArray(tool.humanWorkingLabel!.friendly)).toBe(true)
			expect(isNonEmptyStringArray(tool.humanWorkingLabel!.whimsical)).toBe(true)
			expect(tool.humanWorkingLabel!.whimsical!.length).toBeGreaterThan(1)
		}
	})
})
