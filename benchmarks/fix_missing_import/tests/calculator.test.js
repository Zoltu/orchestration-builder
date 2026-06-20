import { test, expect } from 'bun:test'
import { add } from '../src/index.js'

test('add returns the sum of two numbers', () => {
	expect(add(2, 3)).toBe(5)
})
