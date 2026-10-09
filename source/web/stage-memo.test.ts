import { describe, expect, test } from 'bun:test'
import { buildStageMemoInputs, createStageMemo, stageInputsEqual } from './static/ts/stage-memo.js'
import type { StageMemoInputs } from './static/ts/stage-memo.js'
import type { InteractionModel, Participant } from './static/ts/interaction-model.js'
import { createLabelResolver } from './static/ts/labels.js'
import { nullRoleAccents } from './test-fixtures.js'

function emptyModel(participants: Participant[]): InteractionModel {
	return { participants, operations: [], status: 'running' }
}

function baseInputs(): StageMemoInputs {
	return {
		serverModel: emptyModel([{ id: 'human', role: 'human', kind: 'human' }]),
		previousModel: emptyModel([]),
		labels: createLabelResolver({}),
		tier: 'detailed',
		roleAccents: nullRoleAccents,
		guildParticipants: [{ id: 'guild:coder', role: 'coder', kind: 'role' }],
		viewMode: 'flow',
		rolesOnly: false,
	}
}

describe('buildStageMemoInputs', () => {
	test('keeps every stable field by reference across calls', () => {
		const serverModel = emptyModel([{ id: 'human', role: 'human', kind: 'human' }])
		const previousModel = emptyModel([])
		const labels = createLabelResolver({})
		const guildParticipants: Participant[] = [{ id: 'guild:coder', role: 'coder', kind: 'role' }]
		const source: StageMemoInputs = {
			serverModel,
			previousModel,
			labels,
			tier: 'detailed',
			roleAccents: nullRoleAccents,
			guildParticipants,
			viewMode: 'flow',
			rolesOnly: false,
		}

		const first = buildStageMemoInputs(source)
		const second = buildStageMemoInputs(source)

		expect(first.serverModel).toBe(serverModel)
		expect(first.previousModel).toBe(previousModel)
		expect(first.labels).toBe(labels)
		expect(first.tier).toBe('detailed')
		expect(first.roleAccents).toBe(nullRoleAccents)
		expect(first.guildParticipants).toBe(guildParticipants)
		expect(first.viewMode).toBe('flow')
		expect(first.rolesOnly).toBe(false)

		expect(second.serverModel).toBe(first.serverModel)
		expect(second.previousModel).toBe(first.previousModel)
		expect(second.labels).toBe(first.labels)
		expect(second.tier).toBe(first.tier)
		expect(second.roleAccents).toBe(first.roleAccents)
		expect(second.guildParticipants).toBe(first.guildParticipants)
		expect(second.viewMode).toBe(first.viewMode)
		expect(second.rolesOnly).toBe(first.rolesOnly)
	})

	test('drops a clock value carried by the source', () => {
		const source: StageMemoInputs & { now: number } = {
			serverModel: emptyModel([]),
			previousModel: null,
			labels: createLabelResolver({}),
			tier: 'detailed',
			roleAccents: nullRoleAccents,
			guildParticipants: [],
			viewMode: 'sequence',
			rolesOnly: true,
			now: 1234,
		}

		const inputs = buildStageMemoInputs(source)

		expect('now' in inputs).toBe(false)
	})
})

describe('stageInputsEqual', () => {
	test('is true for equal fields and false when any one field differs', () => {
		const base = baseInputs()
		expect(stageInputsEqual(base, { ...base })).toBe(true)

		const differing: StageMemoInputs[] = [
			{ ...base, serverModel: emptyModel([]) },
			{ ...base, previousModel: null },
			{ ...base, labels: createLabelResolver({}) },
			{ ...base, tier: 'whimsical' },
			{ ...base, roleAccents: () => null },
			{ ...base, guildParticipants: [] },
			{ ...base, viewMode: 'sequence' },
			{ ...base, rolesOnly: true },
		]

		for (const candidate of differing) {
			expect(stageInputsEqual(base, candidate)).toBe(false)
		}
	})
})

describe('createStageMemo', () => {
	test('builds once for repeated equal inputs and rebuilds when a field changes', () => {
		let buildCalls = 0
		const memo = createStageMemo((inputs: StageMemoInputs) => {
			buildCalls += 1
			return { model: inputs.serverModel }
		})

		const inputs = baseInputs()
		const first = memo(inputs)
		expect(buildCalls).toBe(1)

		// A fresh object with equal fields (as buildStageMemoInputs returns) must hit the cache and reuse the exact value reference.
		const second = memo({ ...inputs })
		expect(buildCalls).toBe(1)
		expect(second).toBe(first)

		// Any one changed field rebuilds a new value.
		const changed = memo({ ...inputs, tier: 'whimsical' })
		expect(buildCalls).toBe(2)
		expect(changed).not.toBe(first)
	})

	test('rebuilds a new value when the serverModel reference changes', () => {
		let buildCalls = 0
		const memo = createStageMemo((inputs: StageMemoInputs) => {
			buildCalls += 1
			return { model: inputs.serverModel }
		})

		const inputs = baseInputs()
		const first = memo(inputs)
		expect(buildCalls).toBe(1)

		const replacementModel = emptyModel([{ id: 'human', role: 'human', kind: 'human' }])
		expect(replacementModel).not.toBe(inputs.serverModel)
		const changed = memo({ ...inputs, serverModel: replacementModel })
		expect(buildCalls).toBe(2)
		expect(changed).not.toBe(first)
	})
})
