import { describe, expect, test } from 'bun:test'
import { deriveDemoFrameModel, DEMO_SCENARIOS } from './demo-fixtures.js'

function frameModel(scenarioId: string, frameIndex: number): ReturnType<typeof deriveDemoFrameModel> {
	const scenario = DEMO_SCENARIOS.find((s) => s.id === scenarioId)!
	return deriveDemoFrameModel(scenario, frameIndex)
}

// Two frames are structurally identical when every participant and every operation's kind,
// lifecycle, settledAt, and outcome match — the flow/sequence views render the same structure,
// ignoring only the per-invocation metric numbers (tokens, elapsed). A structurally identical
// consecutive frame is a "duplicated step" the scrubber steps through without any visual change.
function structuralKey(model: ReturnType<typeof deriveDemoFrameModel>): string {
	const parts = model.participants.map((p) => `${p.id}:${p.role}:${p.kind}`)
	for (const op of model.operations) {
		parts.push(`${op.id}|${op.kind}|${op.lifecycle}|${op.settledAt}|${op.outcome}|${op.source}>${op.destination}|${op.stack}`)
	}
	return parts.join('\n')
}

describe('demo fixtures — no structurally duplicated consecutive frames', () => {
	test('no two consecutive frames in any scenario are structurally identical', () => {
		const duplicates: string[] = []
		for (const scenario of DEMO_SCENARIOS) {
			for (let frame = 1; frame < scenario.events.length; frame += 1) {
				const prev = structuralKey(frameModel(scenario.id, frame - 1))
				const curr = structuralKey(frameModel(scenario.id, frame))
				if (curr === prev) duplicates.push(`${scenario.id} frame ${frame} (${scenario.events[frame]!.type})`)
			}
		}
		expect(duplicates).toEqual([])
	})
})
