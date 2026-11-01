import { describe, expect, test } from 'bun:test'
import {
	DEFAULT_EFFORT,
	DEFAULT_INVOLVEMENT,
	EFFORT_OPTIONS,
	effortDescription,
	effortLabel,
	INVOLVEMENT_OPTIONS,
	involvementDescription,
	involvementLabel,
	isEffort,
	isInvolvement,
	selectRunLevels,
} from './run-levels.js'
import type { RunLevelSource } from './run-levels.js'

describe('run-levels', () => {
	test('exposes the three effort levels and the standard recommended default', () => {
		expect(DEFAULT_EFFORT).toBe('standard')
		expect(EFFORT_OPTIONS.map((option) => option.value)).toEqual(['quick', 'standard', 'thorough'])
		expect(EFFORT_OPTIONS.filter((option) => option.recommended === true).map((option) => option.value)).toEqual(['standard'])
		expect(isEffort('quick')).toBe(true)
		expect(isEffort('standard')).toBe(true)
		expect(isEffort('thorough')).toBe(true)
		expect(isEffort('Quick')).toBe(false)
		expect(isEffort(null)).toBe(false)
	})

	test('exposes the three involvement levels and the early-engagement default', () => {
		expect(DEFAULT_INVOLVEMENT).toBe('early-engagement')
		expect(INVOLVEMENT_OPTIONS.map((option) => option.value)).toEqual(['autonomous', 'early-engagement', 'collaborative'])
		expect(isInvolvement('autonomous')).toBe(true)
		expect(isInvolvement('early-engagement')).toBe(true)
		expect(isInvolvement('collaborative')).toBe(true)
		expect(isInvolvement('none')).toBe(false)
		expect(isInvolvement(null)).toBe(false)
	})

	test('capitalizes effort labels and falls back to an em dash for invalid values', () => {
		expect(effortLabel('quick')).toBe('Quick')
		expect(effortLabel('standard')).toBe('Standard')
		expect(effortLabel('thorough')).toBe('Thorough')
		expect(effortLabel('unknown')).toBe('—')
	})

	test('capitalizes involvement labels, keeps the Early engagement special case, and falls back to an em dash', () => {
		expect(involvementLabel('autonomous')).toBe('Autonomous')
		expect(involvementLabel('early-engagement')).toBe('Early engagement')
		expect(involvementLabel('collaborative')).toBe('Collaborative')
		expect(involvementLabel('unknown')).toBe('—')
	})

	test('returns each level description and an empty string for an invalid value', () => {
		expect(effortDescription('quick')).toBe('The fastest, lightest pass. Good for small fixes and simple tasks.')
		expect(effortDescription('unknown')).toBe('')
		expect(involvementDescription('collaborative')).toBe('Checks in with you as it goes.')
		expect(involvementDescription('unknown')).toBe('')
	})
})

function source(runId: string, effort: string | null, involvement: string | null): RunLevelSource {
	return { runId, effort, involvement }
}

describe('selectRunLevels', () => {
	test('returns nulls when no run is selected', () => {
		expect(selectRunLevels(null, source('run-1', 'quick', 'autonomous'), [source('run-1', 'thorough', 'collaborative')], source('run-1', 'standard', 'early-engagement'))).toEqual({ effort: null, involvement: null })
		expect(selectRunLevels('', source('run-1', 'quick', 'autonomous'), [], null)).toEqual({ effort: null, involvement: null })
	})

	test('prefers the matching view over the summary and thread run', () => {
		expect(selectRunLevels('run-1', source('run-1', 'quick', 'autonomous'), [source('run-1', 'thorough', 'collaborative')], source('run-1', 'standard', 'early-engagement'))).toEqual({ effort: 'quick', involvement: 'autonomous' })
	})

	test('falls back to the matching summary when the view is absent or for another run', () => {
		expect(selectRunLevels('run-1', null, [source('run-1', 'thorough', 'collaborative')], source('run-1', 'quick', 'autonomous'))).toEqual({ effort: 'thorough', involvement: 'collaborative' })
		expect(selectRunLevels('run-1', source('run-2', 'quick', 'autonomous'), [source('run-1', 'thorough', 'collaborative')], null)).toEqual({ effort: 'thorough', involvement: 'collaborative' })
	})

	test('falls back to the matching thread run when the view and summary are absent or mismatched', () => {
		expect(selectRunLevels('run-1', null, [], source('run-1', 'standard', 'early-engagement'))).toEqual({ effort: 'standard', involvement: 'early-engagement' })
		expect(selectRunLevels('run-1', source('run-2', 'quick', 'autonomous'), [source('run-2', 'thorough', 'collaborative')], source('run-1', 'standard', 'early-engagement'))).toEqual({ effort: 'standard', involvement: 'early-engagement' })
	})

	test('takes each field from the first matching source that has a valid level', () => {
		expect(selectRunLevels('run-1', source('run-1', 'quick', null), [source('run-1', 'thorough', 'collaborative')], source('run-1', 'standard', 'early-engagement'))).toEqual({ effort: 'quick', involvement: 'collaborative' })
		expect(selectRunLevels('run-1', source('run-1', null, null), [source('run-1', null, 'collaborative')], source('run-1', 'standard', 'early-engagement'))).toEqual({ effort: 'standard', involvement: 'collaborative' })
	})

	test('ignores every mismatched source', () => {
		expect(selectRunLevels('run-1', source('run-2', 'quick', 'autonomous'), [source('run-3', 'thorough', 'collaborative')], source('run-4', 'standard', 'early-engagement'))).toEqual({ effort: null, involvement: null })
	})

	test('treats invalid levels as absent and validates the chosen values', () => {
		expect(selectRunLevels('run-1', source('run-1', 'Quick', 'sometimes'), [source('run-1', 'thorough', 'collaborative')], null)).toEqual({ effort: 'thorough', involvement: 'collaborative' })
		expect(selectRunLevels('run-1', source('run-1', 'Quick', 'sometimes'), [], null)).toEqual({ effort: null, involvement: null })
	})
})
