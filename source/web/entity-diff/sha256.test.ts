import { describe, expect, test } from 'bun:test'
import { sha256Hex } from '../static/ts/entity-diff/index.js'

const KNOWN_VECTORS: [string, string][] = [
	['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
	['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
	['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
	['The quick brown fox jumps over the lazy dog', 'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592'],
	['a'.repeat(64), 'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb'],
	['a'.repeat(200), 'c2a908d98f5df987ade41b5fce213067efbcc21ef2240212a41e54b5e7c28ae5'],
	['a'.repeat(1_000_000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
]

describe('sha256Hex', () => {
	test('matches every FIPS 180-4 known vector', () => {
		for (const [input, expected] of KNOWN_VECTORS) {
			expect(sha256Hex(input)).toBe(expected)
		}
	})

	test('cross-checks the pure implementation against the Bun.CryptoHasher oracle', () => {
		const samples = ['', 'abc', 'entity-diff', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(63), 'x'.repeat(119), 'x'.repeat(120), JSON.stringify({ hello: 'world', nested: [1, 2, 3] }), 'héllo wörld — ünïcode']
		for (const sample of samples) {
			expect(sha256Hex(sample)).toBe(new Bun.CryptoHasher('sha256').update(sample).digest('hex'))
		}
	})
})
