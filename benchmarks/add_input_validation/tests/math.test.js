import { test, expect } from 'bun:test'
import { divide } from '../src/math.js'

test('divide returns the quotient for valid inputs', () => {
	expect(divide(10, 2)).toBe(5)
})

test('divide throws an Error when dividing by zero', () => {
	expect(() => divide(1, 0)).toThrow()
})
