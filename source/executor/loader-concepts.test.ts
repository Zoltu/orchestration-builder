import { describe, expect, test } from 'bun:test'

import { ValidationError } from './errors.js'
import { composeRolePrompt, resolveConceptContents } from './loader.js'

const styleConcept = '## Style standard\n\nWrite tab-indented code.\n'

describe('composeRolePrompt', () => {
	test('a role without concepts keeps its prompt byte-identical', () => {
		expect(composeRolePrompt('You are the coder.\n', [])).toBe('You are the coder.\n')
		expect(composeRolePrompt('', [])).toBe('')
	})
	test('one concept is appended after exactly one blank line, the base without one', () => {
		expect(composeRolePrompt('You are the coder.', [styleConcept])).toBe('You are the coder.\n\n## Style standard\n\nWrite tab-indented code.\n')
	})
	test('a base prompt with a trailing newline composes to exactly one blank line before the concept, not two', () => {
		expect(composeRolePrompt('You are the coder.\n', [styleConcept])).toBe('You are the coder.\n\n## Style standard\n\nWrite tab-indented code.\n')
	})
	test('an empty base prompt composes to the blank-line separator before the concept content', () => {
		expect(composeRolePrompt('', [styleConcept])).toBe('\n\n## Style standard\n\nWrite tab-indented code.\n')
	})
	test('multiple concepts are joined by exactly one blank line in declaration order', () => {
		expect(composeRolePrompt('Base', ['one\n', 'two\n'])).toBe('Base\n\none\n\ntwo\n')
	})
	test('the composed prompt ends with exactly one trailing newline regardless of the inputs', () => {
		expect(composeRolePrompt('Base\n', ['one\n\n\n', 'two'])).toBe('Base\n\none\n\ntwo\n')
	})
})

describe('resolveConceptContents', () => {
	test('a role without concepts reads no file', () => {
		let reads = 0
		const contents = resolveConceptContents('coder', [], { style: 'concepts/style.md' }, () => {
			reads++
			return styleConcept
		})
		expect(contents).toEqual([])
		expect(reads).toBe(0)
	})
	test('concept contents are collected in declaration order', () => {
		const registry = { style: 'concepts/style.md', conventions: 'concepts/conventions.md' }
		const contents = resolveConceptContents('coder', ['conventions', 'style'], registry, (conceptName) => `${conceptName}\n`)
		expect(contents).toEqual(['conventions\n', 'style\n'])
	})
	test('a name absent from the registry is rejected with the role path', () => {
		expect(() => resolveConceptContents('coder', ['missing'], {}, () => '')).toThrow(ValidationError)
		expect(() => resolveConceptContents('coder', ['missing'], {}, () => '')).toThrow(/roles\.coder\.concepts\[0\].*missing/)
	})
	test('a missing concept file surfaces the reader\'s ValidationError naming the concept', () => {
		const readConceptFile = (conceptName: string): string => {
			throw new ValidationError(`concepts.${conceptName}`, 'file not found: concepts/style.md')
		}
		expect(() => resolveConceptContents('coder', ['style'], { style: 'concepts/style.md' }, readConceptFile)).toThrow(ValidationError)
		expect(() => resolveConceptContents('coder', ['style'], { style: 'concepts/style.md' }, readConceptFile)).toThrow(/concepts\.style.*file not found/)
	})
})
