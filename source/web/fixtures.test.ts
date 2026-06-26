import { describe, expect, test } from 'bun:test'
import { fixtures, largeGuildConfig, mockConfig } from './static/fixtures.js'
import { isErrorKind } from '../executor/errors.js'
import { isEffortLevel, isResultCard } from '../executor/validation.js'

// The fixtures are mock data shaped exactly like the real /api/config and /api/runs/:id responses (plus the future tiered label/description fields). These guards mirror the RunView/GuildConfigView shapes from source/web/render.ts so a malformed fixture fails loudly here rather than producing a confusing visual in the playback harness.
// The whole-RunView and whole-config guards are local because render.ts only exports producers (renderRunView/renderConfig), not validators; the leaf guards (isResultCard, isEffortLevel, isErrorKind) are reused so the fixture checks stay aligned with the real external-data validation.

// `interrupted` is a forward-looking terminal status the interrupt platform will add; it is modeled here so the visualization is ready when it lands, matching the fixture-first methodology of shaping against the future API surface.
const RUN_STATUSES = new Set(['running', 'success', 'error', 'needs_clarification', 'unknown', 'interrupted'])

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
	return typeof value === 'string'
}

function isNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value)
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isString)
}

function isTiered(value: unknown): boolean {
	if (!isObject(value)) return false
	if (!isString(value.detailed)) return false
	if (value.friendly !== undefined && !isString(value.friendly)) return false
	if (value.playful !== undefined && !isString(value.playful)) return false
	return true
}

function isTokenBreakdown(value: unknown): boolean {
	if (!isObject(value)) return false
	if (!isNumber(value.promptTokens)) return false
	if (!isNumber(value.cachedPromptTokens)) return false
	if (!isNumber(value.completionTokens)) return false
	if (!isNumber(value.totalTokens)) return false
	return true
}

function isBudgets(value: unknown): boolean {
	if (!isObject(value)) return false
	if (!isNumber(value.elapsedSeconds)) return false
	if (!isNumber(value.toolCalls)) return false
	if (value.tokensUsed !== null && !isNumber(value.tokensUsed)) return false
	if (value.tokenBreakdown !== null && !isTokenBreakdown(value.tokenBreakdown)) return false
	return true
}

function isRoleActivity(value: unknown): boolean {
	if (!isObject(value)) return false
	if (!isString(value.role)) return false
	if (!isString(value.firstSeen)) return false
	if (!isString(value.lastSeen)) return false
	if (!isNumber(value.eventCount)) return false
	if (!isNumber(value.llmCalls)) return false
	if (!isNumber(value.toolCalls)) return false
	if (!isStringArray(value.recentTools)) return false
	if (value.lastPromptTokens !== null && !isNumber(value.lastPromptTokens)) return false
	return true
}

function isTreeNode(value: unknown): boolean {
	if (!isObject(value)) return false
	if (!isString(value.role)) return false
	if (!isNumber(value.depth)) return false
	if (value.parent !== null && !isString(value.parent)) return false
	if (value.status !== null && !isString(value.status)) return false
	if (value.summary !== null && !isString(value.summary)) return false
	if (typeof value.active !== 'boolean') return false
	if (!Array.isArray(value.children) || !value.children.every(isTreeNode)) return false
	return true
}

function isDetailSection(value: unknown): boolean {
	if (!isObject(value)) return false
	if (!isString(value.label)) return false
	return true
}

function isRecentLogEntry(value: unknown): boolean {
	if (!isObject(value)) return false
	if (!isString(value.timestamp)) return false
	if (!isString(value.type)) return false
	if (!isString(value.summary)) return false
	if (value.detailSections !== null && !(Array.isArray(value.detailSections) && value.detailSections.every(isDetailSection))) return false
	return true
}

function isQuestionEntry(value: unknown): boolean {
	if (!isObject(value)) return false
	if (value.id !== null && !isString(value.id)) return false
	if (!isString(value.question)) return false
	if (value.context !== undefined && !isString(value.context)) return false
	if (!isString(value.askedAt)) return false
	if (value.answer !== undefined && !isString(value.answer)) return false
	if (value.answeredAt !== undefined && !isString(value.answeredAt)) return false
	return true
}

function isCurrentActivity(value: unknown): boolean {
	if (!isObject(value)) return false
	if (value.role !== null && !isString(value.role)) return false
	if (!isString(value.summary)) return false
	return true
}

function isRunView(value: unknown): boolean {
	if (!isObject(value)) return false
	if (!isString(value.status) || !RUN_STATUSES.has(value.status)) return false
	if (value.runId !== null && !isString(value.runId)) return false
	if (value.task !== null && !isString(value.task)) return false
	if (value.effort !== null && !isEffortLevel(value.effort)) return false
	if (value.startTime !== null && !isString(value.startTime)) return false
	if (value.endTime !== null && !isString(value.endTime)) return false
	if (value.result !== null && !isResultCard(value.result)) return false
	if (value.error !== null) {
		if (!isObject(value.error)) return false
		if (!isErrorKind(value.error.kind)) return false
		if (!isString(value.error.message)) return false
	}
	if (!Array.isArray(value.roles) || !value.roles.every(isRoleActivity)) return false
	if (value.roleTree !== null && !(Array.isArray(value.roleTree) && value.roleTree.every(isTreeNode))) return false
	if (!Array.isArray(value.recentLog) || !value.recentLog.every(isRecentLogEntry)) return false
	if (value.currentActivity !== null && !isCurrentActivity(value.currentActivity)) return false
	if (!Array.isArray(value.questionHistory) || !value.questionHistory.every(isQuestionEntry)) return false
	if (!isBudgets(value.budgets)) return false
	return true
}

function isConfig(value: unknown): boolean {
	if (!isObject(value)) return false
	if (!isObject(value.model) || !isString(value.model.name) || !isNumber(value.model.contextWindow)) return false
	if (!isObject(value.executor)) return false
	if (!isNumber(value.executor.maxAgentDepth)) return false
	if (!isNumber(value.executor.defaultToolTimeoutSeconds)) return false
	if (!isNumber(value.executor.maxCompactionAttempts)) return false
	if (!isString(value.entryRole)) return false
	if (!isObject(value.roles)) return false
	for (const role of Object.values(value.roles)) {
		if (!isObject(role)) return false
		if (!isStringArray(role.tools)) return false
		if (!isTiered(role.label)) return false
		if (!isTiered(role.description)) return false
	}
	if (!isObject(value.tools)) return false
	for (const tool of Object.values(value.tools)) {
		if (!isObject(tool)) return false
		if (!isTiered(tool.humanLabel)) return false
		if (!isTiered(tool.humanDescription)) return false
	}
	return true
}

// Throws the first malformation with a path that names the scenario, frame, and field so a broken fixture is trivial to locate.
function assertValidFrame(scenarioId: string, frameIndex: number, frame: unknown): void {
	if (!isObject(frame)) throw new Error(`${scenarioId}[frame ${frameIndex}]: expected an object`)
	if (!isString(frame.now)) throw new Error(`${scenarioId}[frame ${frameIndex}].now: expected an ISO timestamp string`)
	if (!isConfig(frame.config)) throw new Error(`${scenarioId}[frame ${frameIndex}].config: does not match the /api/config shape (with tiered labels)`)
	if (!isRunView(frame.runView)) throw new Error(`${scenarioId}[frame ${frameIndex}].runView: does not match the /api/runs/:id RunView shape`)
}

describe('playback fixtures', () => {
	test('the set covers all thirteen scenarios', () => {
		const expectedIds = [
			'single-role-in-progress',
			'delegation-in-progress',
			'tool-call-in-progress',
			'retry',
			'pending-question',
			'completed-success',
			'failed-run',
			'effort-set',
			'deep-multi-role-tree',
			'self-delegation',
			'detected-loop',
			'user-interrupt',
			'large-guild',
		]
		expect(fixtures.map((scenario) => scenario.id)).toEqual(expectedIds)
	})

	test('every scenario is well-formed with a multi-frame timeline', () => {
		for (const scenario of fixtures) {
			if (!isObject(scenario)) throw new Error(`scenario is not an object: ${JSON.stringify(scenario)}`)
			if (!isString(scenario.id)) throw new Error(`scenario.id is not a string: ${JSON.stringify(scenario)}`)
			if (!isString(scenario.label)) throw new Error(`scenario.label is not a string: ${scenario.id}`)
			if (!isString(scenario.description)) throw new Error(`scenario.description is not a string: ${scenario.id}`)
			if (!Array.isArray(scenario.frames)) throw new Error(`scenario.frames is not an array: ${scenario.id}`)
			expect(scenario.frames.length).toBeGreaterThanOrEqual(2)
		}
	})

	test('every frame conforms to the real RunView and config shape', () => {
		for (const scenario of fixtures) {
			scenario.frames.forEach((frameValue, frameIndex) => {
				assertValidFrame(scenario.id, frameIndex, frameValue)
			})
		}
	})

	test('the mock config and the large-guild config are each valid config snapshots', () => {
		expect(isConfig(mockConfig)).toBe(true)
		expect(isConfig(largeGuildConfig)).toBe(true)
	})

	test('frames within a scenario advance their `now` and keep a stable config', () => {
		for (const scenario of fixtures) {
			let previousNow = ''
			let scenarioConfig = null
			for (const frameValue of scenario.frames) {
				if (!isObject(frameValue)) throw new Error(`${scenario.id}: frame is not an object`)
				const now = frameValue.now
				if (typeof now !== 'string') throw new Error(`${scenario.id}: frame.now is not a string`)
				if (previousNow !== '') {
					expect(Date.parse(now)).toBeGreaterThanOrEqual(Date.parse(previousNow))
				}
				previousNow = now
				// Every frame in a scenario shares the same config object reference, so the layout seed is stable across the run's timeline.
				if (scenarioConfig === null) scenarioConfig = frameValue.config
				expect(frameValue.config).toBe(scenarioConfig)
			}
		}
	})
})
