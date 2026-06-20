import { test, expect } from 'bun:test'
import { capitalize, reverse, vowelCount, kebabCase } from '../src/string-utils.js'

test('capitalize capitalizes the first letter and lowercases the rest', () => {
	expect(capitalize('hELLO')).toBe('Hello')
	expect(capitalize('')).toBe('')
})

test('reverse reverses a string', () => {
	expect(reverse('abc')).toBe('cba')
	expect(reverse('')).toBe('')
})

test('vowelCount counts the vowels in a string', () => {
	expect(vowelCount('hello')).toBe(2)
	expect(vowelCount('sky')).toBe(0)
})

test('kebabCase converts text to kebab-case', () => {
	expect(kebabCase('Hello World')).toBe('hello-world')
	expect(kebabCase('foo_bar  baz')).toBe('foo-bar-baz')
	expect(kebabCase('--Foo--')).toBe('foo')
})
