import { test, expect } from 'bun:test'
import { formatLines } from '../src/printer.js'

test('formatLines joins lines with newlines', () => {
	expect(formatLines(['a', 'b', 'c'])).toBe('a\nb\nc')
})

test('formatLines returns an empty string for no lines', () => {
	expect(formatLines([])).toBe('')
})

test('formatLines reverses the order when options.reverse is true', () => {
	expect(formatLines(['a', 'b'], { reverse: true })).toBe('b\na')
})
