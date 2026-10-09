import { describe, expect, test } from 'bun:test'
import { isServerResponse } from '../static/ts/entity-diff/index.js'
import { definitions } from './test-schema.js'

const validUser = { id: 'u1', name: 'Ann', team: 'team-a' }
const validTask = { id: 't1', title: 'one', done: false }

describe('isServerResponse', () => {
	test('accepts a well-formed unchanged response', () => {
		expect(isServerResponse(definitions, { kind: 'unchanged', version: 'v1' })).toBe(true)
	})

	test('accepts a well-formed delta', () => {
		const value = { kind: 'delta', base: 'v1', next: 'v2', collections: { users: { added: [validUser], changed: [], removed: [] } } }
		expect(isServerResponse(definitions, value)).toBe(true)
	})

	test('accepts a well-formed snapshot', () => {
		const value = { kind: 'snapshot', version: 'v1', collections: { users: [validUser], tasks: [validTask] } }
		expect(isServerResponse(definitions, value)).toBe(true)
	})

	test('accepts a snapshot with empty collections', () => {
		expect(isServerResponse(definitions, { kind: 'snapshot', version: 'v1', collections: { users: [], tasks: [] } })).toBe(true)
	})

	test('rejects non-objects', () => {
		expect(isServerResponse(definitions, null)).toBe(false)
		expect(isServerResponse(definitions, [])).toBe(false)
		expect(isServerResponse(definitions, 'text')).toBe(false)
		expect(isServerResponse(definitions, 42)).toBe(false)
		expect(isServerResponse(definitions, undefined)).toBe(false)
	})

	test('rejects an unknown kind', () => {
		expect(isServerResponse(definitions, { kind: 'merge', version: 'v1' })).toBe(false)
	})

	test('rejects missing required fields', () => {
		expect(isServerResponse(definitions, { kind: 'unchanged' })).toBe(false)
		expect(isServerResponse(definitions, { kind: 'delta', next: 'v2', collections: {} })).toBe(false)
		expect(isServerResponse(definitions, { kind: 'delta', base: 'v1', next: 'v2' })).toBe(false)
		expect(isServerResponse(definitions, { kind: 'snapshot', version: 'v1' })).toBe(false)
	})

	test('rejects a delta whose collections field is not an object', () => {
		expect(isServerResponse(definitions, { kind: 'delta', base: 'v1', next: 'v2', collections: [] })).toBe(false)
	})

	test('rejects a delta with an entity that fails its collection guard', () => {
		const value = { kind: 'delta', base: 'v1', next: 'v2', collections: { users: { added: [{ id: 'u1', name: 5, team: 'a' }], changed: [], removed: [] } } }
		expect(isServerResponse(definitions, value)).toBe(false)
	})

	test('rejects a delta with a malformed diff shape', () => {
		expect(isServerResponse(definitions, { kind: 'delta', base: 'v1', next: 'v2', collections: { users: { added: 'nope', changed: [], removed: [] } } })).toBe(false)
		expect(isServerResponse(definitions, { kind: 'delta', base: 'v1', next: 'v2', collections: { users: { added: [], changed: [], removed: [5] } } })).toBe(false)
	})

	test('rejects an unknown collection key', () => {
		const delta = { kind: 'delta', base: 'v1', next: 'v2', collections: { ghosts: { added: [], changed: [], removed: [] } } }
		expect(isServerResponse(definitions, delta)).toBe(false)
		const snapshot = { kind: 'snapshot', version: 'v1', collections: { users: [], tasks: [], ghosts: [] } }
		expect(isServerResponse(definitions, snapshot)).toBe(false)
	})

	test('rejects a snapshot missing a declared collection', () => {
		expect(isServerResponse(definitions, { kind: 'snapshot', version: 'v1', collections: { users: [] } })).toBe(false)
	})

	test('rejects duplicate ids within a single list', () => {
		const value = { kind: 'delta', base: 'v1', next: 'v2', collections: { users: { added: [validUser, { ...validUser }], changed: [], removed: [] } } }
		expect(isServerResponse(definitions, value)).toBe(false)
	})

	test('rejects an id appearing in more than one of added, changed, and removed', () => {
		const inAddedAndRemoved = { kind: 'delta', base: 'v1', next: 'v2', collections: { users: { added: [validUser], changed: [], removed: ['u1'] } } }
		expect(isServerResponse(definitions, inAddedAndRemoved)).toBe(false)
		const inAddedAndChanged = { kind: 'delta', base: 'v1', next: 'v2', collections: { users: { added: [validUser], changed: [{ ...validUser, name: 'Changed' }], removed: [] } } }
		expect(isServerResponse(definitions, inAddedAndChanged)).toBe(false)
		const inChangedAndRemoved = { kind: 'delta', base: 'v1', next: 'v2', collections: { users: { added: [], changed: [{ ...validUser, name: 'Changed' }], removed: ['u1'] } } }
		expect(isServerResponse(definitions, inChangedAndRemoved)).toBe(false)
	})

	test('rejects a snapshot with a duplicate id', () => {
		const value = { kind: 'snapshot', version: 'v1', collections: { users: [validUser, { ...validUser }], tasks: [] } }
		expect(isServerResponse(definitions, value)).toBe(false)
	})
})
