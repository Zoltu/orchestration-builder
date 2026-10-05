import { describe, expect, test } from 'bun:test'

import { ValidationError } from './errors.js'
import { composeRolePrompt } from './loader.js'
import { validateGuildConfig } from './validation.ts'

const styleGuide = '## Style standard\n\nWrite tab-indented code.\n'

function guildWithRole(role: unknown): unknown {
	return { entryRole: 'orchestrator', roles: { coder: role }, tools: ['t.json'] }
}

describe('composeRolePrompt', () => {
	test('a role without a styleGuide keeps its prompt byte-identical and never reads a file', () => {
		let reads = 0
		const readStyleGuide = (): string => {
			reads++
			return styleGuide
		}
		const composed = composeRolePrompt('You are the coder.\n', undefined, readStyleGuide)
		expect(composed).toBe('You are the coder.\n')
		expect(reads).toBe(0)
	})
	test('a declared styleGuide is appended after exactly one blank line, the base without one', () => {
		const composed = composeRolePrompt('You are the coder.', 'prompts/style.md', () => styleGuide)
		expect(composed).toBe('You are the coder.\n\n## Style standard\n\nWrite tab-indented code.\n')
	})
	test('a base prompt with a trailing newline composes to exactly one blank line before the standard, not two', () => {
		const composed = composeRolePrompt('You are the coder.\n', 'prompts/style.md', () => styleGuide)
		expect(composed).toBe('You are the coder.\n\n## Style standard\n\nWrite tab-indented code.\n')
	})
	test('an empty base prompt composes to the blank-line separator before the style content', () => {
		const composed = composeRolePrompt('', 'prompts/style.md', () => styleGuide)
		expect(composed).toBe('\n\n## Style standard\n\nWrite tab-indented code.\n')
	})
	test('a missing style file surfaces the reader\'s error unchanged', () => {
		const readStyleGuide = (): string => {
			throw new ValidationError('roles.coder.styleGuide', 'file not found: prompts/style.md')
		}
		expect(() => composeRolePrompt('You are the coder.\n', 'prompts/style.md', readStyleGuide)).toThrow(ValidationError)
		expect(() => composeRolePrompt('You are the coder.\n', 'prompts/style.md', readStyleGuide)).toThrow(/roles\.coder\.styleGuide.*file not found/)
	})
})

describe('role styleGuide validation', () => {
	const baseRole = { systemPrompt: 'p', tools: ['finish'] }
	test('a valid styleGuide passes validateGuildConfig', () => {
		expect(() => validateGuildConfig(guildWithRole({ ...baseRole, styleGuide: 'prompts/style.md' }))).not.toThrow()
	})
	test('a non-string styleGuide is rejected with the role path', () => {
		expect(() => validateGuildConfig(guildWithRole({ ...baseRole, styleGuide: 42 }))).toThrow(ValidationError)
		expect(() => validateGuildConfig(guildWithRole({ ...baseRole, styleGuide: 42 }))).toThrow(/roles\.coder\.styleGuide/)
	})
	test('an empty styleGuide is rejected with the role path', () => {
		expect(() => validateGuildConfig(guildWithRole({ ...baseRole, styleGuide: '' }))).toThrow(ValidationError)
		expect(() => validateGuildConfig(guildWithRole({ ...baseRole, styleGuide: '' }))).toThrow(/roles\.coder\.styleGuide/)
	})
})
