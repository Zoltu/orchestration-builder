import { describe, expect, test } from 'bun:test'

import { DEFAULT_EFFORT, effortDirective } from './effort.ts'

describe('effortDirective', () => {
	// The directive string is a stable contract the Guild prompts branch on; pin it exactly.
	test('renders the tier and the fixed tier list for each level', () => {
		expect(effortDirective('quick')).toBe('Quality level: quick (one of quick, standard, thorough — quick is fastest and most direct; thorough is slowest and most careful).')
		expect(effortDirective('standard')).toBe('Quality level: standard (one of quick, standard, thorough — quick is fastest and most direct; thorough is slowest and most careful).')
		expect(effortDirective('thorough')).toBe('Quality level: thorough (one of quick, standard, thorough — quick is fastest and most direct; thorough is slowest and most careful).')
	})
})

describe('DEFAULT_EFFORT', () => {
	test('is the standard tier', () => {
		expect(DEFAULT_EFFORT).toBe('standard')
	})
})
