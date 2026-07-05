import { test, expect } from 'bun:test'
import { parseArgs } from '../src/args.js'

test('parseArgs reads --count N as a number', () => {
	expect(parseArgs(['--count', '3'])).toEqual({ count: 3, reverse: false })
})

test('parseArgs reads --count=N as a number', () => {
	expect(parseArgs(['--count=3'])).toEqual({ count: 3, reverse: false })
})

test('parseArgs defaults count to null when no --count is given', () => {
	expect(parseArgs([])).toEqual({ count: null, reverse: false })
})

test('parseArgs sets reverse to true when --reverse is present', () => {
	expect(parseArgs(['--reverse'])).toEqual({ count: null, reverse: true })
})

test('parseArgs supports --reverse together with --count', () => {
 	expect(parseArgs(['--count', '2', '--reverse'])).toEqual({ count: 2, reverse: true })
	})

	test('parseArgs throws on unknown arguments', () => {
 	expect(() => parseArgs(['--unknown'])).toThrow('Unknown argument: --unknown')
	})

