import { describe, expect, test } from 'bun:test'
import { createRunStage } from './index.js'
import type { RunStage, StageRenderInputs } from './index.js'
import type { InteractionModel, Participant } from '../interaction-model.js'
import { createLabelResolver } from '../labels.js'

interface FakeVnode {
	tag: string
	props: Record<string, unknown>
	children: FakeVnodeChild[]
}
type FakeVnodeChild = FakeVnode | string

function fakeH(tag: string, props: Record<string, unknown>, children: FakeVnodeChild[]): FakeVnode {
	return { tag, props, children }
}

function emptyModel(participants: Participant[]): InteractionModel {
	return { participants, operations: [], status: 'running' }
}

function baseInputs(): StageRenderInputs {
	return {
		model: emptyModel([{ id: 'human', role: 'human', kind: 'human' }]),
		previousModel: emptyModel([]),
		labels: createLabelResolver({}),
		tier: 'detailed',
		viewMode: 'flow',
		rolesOnly: false,
		guildParticipants: [{ id: 'guild:coder', role: 'coder', kind: 'role' }],
		cta: { onclick: () => undefined },
		question: { onclick: () => undefined },
	}
}

function stage(): RunStage {
	return createRunStage({ roleNames: ['coder'], roleOrder: ['orchestrator', 'coder'] })
}

describe('run stage memo', () => {
	test('returns the same vnode by reference for repeated equal inputs, including a fresh wrapper object', () => {
		const runStage = stage()
		const inputs = baseInputs()
		const first = runStage.render(fakeH, inputs)
		const second = runStage.render(fakeH, { ...inputs })

		expect(second).toBe(first)
	})

	test('a changed clock alone reuses the mounted vnode', () => {
		const runStage = stage()
		const inputs = baseInputs()
		const first = runStage.render(fakeH, inputs)
		const ticked = runStage.render(fakeH, { ...inputs, now: 1234 })

		expect(ticked).toBe(first)
	})

	test('fresh affordance wrappers carrying the same handlers do not defeat the memo', () => {
		const runStage = stage()
		const inputs = baseInputs()
		const first = runStage.render(fakeH, inputs)
		const sameHandlers = runStage.render(fakeH, {
			...inputs,
			cta: { onclick: inputs.cta?.onclick },
			question: { onclick: inputs.question?.onclick },
		})

		expect(sameHandlers).toBe(first)
	})

	test('a changed handler rebuilds a new vnode', () => {
		const runStage = stage()
		const inputs = baseInputs()
		const first = runStage.render(fakeH, inputs)

		const changedClick = runStage.render(fakeH, { ...inputs, cta: { onclick: () => undefined } })
		expect(changedClick).not.toBe(first)

		const changedQuestion = runStage.render(fakeH, { ...inputs, question: { onclick: () => undefined } })
		expect(changedQuestion).not.toBe(changedClick)
	})

	test('rebuilds when any memo-visible field changes', () => {
		const runStage = stage()
		const inputs = baseInputs()
		const first = runStage.render(fakeH, inputs)

		const differing: StageRenderInputs[] = [
			{ ...inputs, model: emptyModel([]) },
			{ ...inputs, previousModel: null },
			{ ...inputs, labels: createLabelResolver({}) },
			{ ...inputs, tier: 'whimsical' },
			{ ...inputs, viewMode: 'sequence' },
			{ ...inputs, rolesOnly: true },
			{ ...inputs, guildParticipants: [] },
		]

		for (const candidate of differing) {
			expect(runStage.render(fakeH, candidate)).not.toBe(first)
		}
	})

	test('both modes return an SVG root, so an SVG-namespace host can mount it directly', () => {
		const runStage = stage()
		const flow = runStage.render(fakeH, baseInputs())
		expect(flow.tag).toBe('svg')
		expect(flow.props['class']).toBe('flow-view-svg')
		const sequence = runStage.render(fakeH, { ...baseInputs(), viewMode: 'sequence' })
		expect(sequence.tag).toBe('svg')
		expect(sequence.props['class']).toBe('sequence-view-svg')
	})

	test('an HTML host wraps the sequence SVG itself rather than receiving a stage-owned wrapper', () => {
		const runStage = stage()
		const sequence = runStage.render(fakeH, { ...baseInputs(), viewMode: 'sequence' })
		const hostView = fakeH('div', { class: 'pb-sequence-scroll' }, [sequence])
		expect(hostView.children).toEqual([sequence])
		expect(hostView.children[0]).toBe(sequence)
	})

	test('a different h rebuilds even when every data input is unchanged', () => {
		const runStage = stage()
		const inputs = baseInputs()
		const first = runStage.render(fakeH, inputs)
		const differentH = (tag: string, props: Record<string, unknown>, children: FakeVnodeChild[]): FakeVnode => fakeH(tag, props, children)
		const second = runStage.render(differentH, { ...inputs })

		expect(second).not.toBe(first)
	})

	test('the memo holds one entry: returning to an earlier input after a rebuild constructs a fresh vnode', () => {
		const runStage = stage()
		const inputs = baseInputs()
		const first = runStage.render(fakeH, inputs)
		const changed = runStage.render(fakeH, { ...inputs, tier: 'whimsical' })
		const backAgain = runStage.render(fakeH, { ...inputs })

		expect(changed).not.toBe(first)
		expect(backAgain).not.toBe(first)
		expect(backAgain).not.toBe(changed)
	})

	test('separate stage instances do not share a cached vnode', () => {
		const inputs = baseInputs()
		const first = stage().render(fakeH, inputs)
		const second = stage().render(fakeH, { ...inputs })

		expect(second).not.toBe(first)
	})
})

function chainModel(depth: number): InteractionModel {
	const participants: Participant[] = [{ id: 'human', role: 'human', kind: 'human' }]
	for (let index = 1; index <= depth; index++) participants.push({ id: `role-${index}`, role: `role-${index}`, kind: 'role' })
	const operations = []
	let source = 'human'
	for (let index = 1; index <= depth; index++) {
		const destination = `role-${index}`
		operations.push({ id: `op-${index}`, kind: 'call' as const, stack: 'root', source, destination, startedAt: 't0', settledAt: null, lifecycle: 'in_flight' as const, outcome: null, metrics: null })
		source = destination
	}
	return { participants, operations, status: 'running' }
}

function viewBoxWidth(view: { props: Record<string, unknown> }): number {
	const viewBox = view.props['viewBox']
	if (typeof viewBox !== 'string') throw new Error('the flow view did not render a viewBox')
	return Number(viewBox.split(' ')[2])
}

function chainInputs(model: InteractionModel): StageRenderInputs {
	return { ...baseInputs(), model, previousModel: null, guildParticipants: [] }
}

describe('run stage configure', () => {
	test('configure preserves the flow column high-water mark and resets the memo', () => {
		const runStage = stage()
		const wide = runStage.render(fakeH, chainInputs(chainModel(6)))
		const wideWidth = viewBoxWidth(wide)

		runStage.configure({ roleNames: ['coder'], roleOrder: ['coder'] })

		const shallow = runStage.render(fakeH, chainInputs(chainModel(1)))
		expect(viewBoxWidth(shallow)).toBe(wideWidth)
		expect(shallow).not.toBe(wide)
	})

	test('configure rebuilds even when the next inputs are otherwise unchanged', () => {
		const runStage = stage()
		const inputs = baseInputs()
		const first = runStage.render(fakeH, inputs)

		runStage.configure({ roleNames: ['coder'], roleOrder: ['orchestrator', 'coder'] })
		const afterConfig = runStage.render(fakeH, { ...inputs })

		expect(afterConfig).not.toBe(first)
	})
})
