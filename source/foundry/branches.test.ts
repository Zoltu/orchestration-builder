import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { ValidationError } from '../shared/errors.ts'
import { createGuildLoader } from '../executor/loader.ts'
import { createBranchManager } from './branches.ts'
import type { Hypothesis } from './types.ts'

// A minimal, loader-valid Guild tree. The branch manager validates resulting
// branches with createGuildLoader, so the baseline must itself load cleanly.
const baselineGuildJson = {
	schemaVersion: 1,
	model: { name: 'm', apiBase: 'http://x', contextWindow: 1, generation: {} },
	executor: {
		maxAgentDepth: 1,
		maxToolCallsPerRole: 1,
		maxTokensPerRole: 1,
		maxRunTimeSeconds: 1,
		defaultToolTimeoutSeconds: 1,
		maxRepeatedToolCalls: 1,
		maxCompactionAttempts: 1,
	},
	contextPolicy: { maxToolOutputChars: 1 },
	entryRole: 'orchestrator',
	roles: { orchestrator: { systemPrompt: 'prompts/orchestrator.md', tools: ['agent', 'finish'] } },
	tools: ['tools/agent.json', 'tools/finish.json'],
}

const agentManifest = { name: 'agent', description: 'invoke a role', parameters: { type: 'object', properties: {} } }
const finishManifest = { name: 'finish', description: 'finish a role', parameters: { type: 'object', properties: {} } }

let baseDir: string
let baselineDir: string

beforeEach(() => {
	baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-foundry-'))
	baselineDir = path.join(baseDir, 'baseline')
	fs.mkdirSync(path.join(baselineDir, 'prompts'), { recursive: true })
	fs.mkdirSync(path.join(baselineDir, 'tools'), { recursive: true })
	fs.writeFileSync(path.join(baselineDir, 'guild.json'), JSON.stringify(baselineGuildJson, null, 2))
	fs.writeFileSync(path.join(baselineDir, 'prompts', 'orchestrator.md'), 'you are the orchestrator')
	fs.writeFileSync(path.join(baselineDir, 'tools', 'agent.json'), JSON.stringify(agentManifest))
	fs.writeFileSync(path.join(baselineDir, 'tools', 'finish.json'), JSON.stringify(finishManifest))
})

afterEach(() => {
	fs.rmSync(baseDir, { recursive: true, force: true })
})

function guildJsonString(overrides: Record<string, unknown>): string {
	return JSON.stringify({ ...baselineGuildJson, ...overrides }, null, 2)
}

describe('createBranchManager', () => {
	test('copyBaselineIntoBranch creates a branch that is a clean copy of the baseline', () => {
		const manager = createBranchManager(baseDir)
		const branchDir = manager.copyBaselineIntoBranch('b-1')
		expect(fs.existsSync(path.join(branchDir, 'guild.json'))).toBe(true)
		expect(fs.existsSync(path.join(branchDir, 'prompts', 'orchestrator.md'))).toBe(true)
		expect(fs.existsSync(path.join(branchDir, 'tools', 'agent.json'))).toBe(true)
		expect(fs.existsSync(path.join(branchDir, 'tools', 'finish.json'))).toBe(true)
	})

	test('a branch with an applied prompt edit loads cleanly and writes the new content', () => {
		const manager = createBranchManager(baseDir)
		const branchDir = manager.copyBaselineIntoBranch('b-1')
		const hypothesis: Hypothesis = {
			id: 'h-001',
			motivation: 'm',
			mechanism: 'mech',
			predictedImpact: 'impact',
			changes: [{ path: 'prompts/orchestrator.md', edit: 'rewritten orchestrator prompt' }],
		}

		manager.applyHypothesisToBranch('b-1', hypothesis)

		expect(fs.readFileSync(path.join(branchDir, 'prompts', 'orchestrator.md'), 'utf8')).toBe('rewritten orchestrator prompt')
		const loadGuild = createGuildLoader()
		expect(() => loadGuild(branchDir)).not.toThrow()
	})

	test('a branch with a valid guild.json edit loads cleanly', () => {
		const manager = createBranchManager(baseDir)
		manager.copyBaselineIntoBranch('b-1')
		const hypothesis: Hypothesis = {
			id: 'h-002',
			motivation: 'm',
			mechanism: 'mech',
			predictedImpact: 'impact',
			changes: [{ path: 'guild.json', edit: guildJsonString({ entryRole: 'orchestrator' }) }],
		}

		expect(() => manager.applyHypothesisToBranch('b-1', hypothesis)).not.toThrow()
	})

	test('a malformed JSON edit is surfaced as a clear ValidationError, not a crash', () => {
		const manager = createBranchManager(baseDir)
		manager.copyBaselineIntoBranch('b-1')
		const hypothesis: Hypothesis = {
			id: 'h-003',
			motivation: 'm',
			mechanism: 'mech',
			predictedImpact: 'impact',
			changes: [{ path: 'guild.json', edit: '{ not valid json' }],
		}

		let caught: ValidationError | undefined
		try {
			manager.applyHypothesisToBranch('b-1', hypothesis)
		} catch (error) {
			if (error instanceof ValidationError) caught = error
		}
		expect(caught).toBeDefined()
		expect(caught!.path).toBe('changes[0].edit')
		expect(caught!.message).toMatch(/not valid JSON/)
	})

	test('an edit that produces an invalid Guild is rejected with a ValidationError', () => {
		const manager = createBranchManager(baseDir)
		manager.copyBaselineIntoBranch('b-1')
		const hypothesis: Hypothesis = {
			id: 'h-004',
			motivation: 'm',
			mechanism: 'mech',
			predictedImpact: 'impact',
			// Valid JSON, but the Guild is invalid: entryRole is missing.
			changes: [{ path: 'guild.json', edit: JSON.stringify({ ...baselineGuildJson, entryRole: undefined }) }],
		}

		expect(() => manager.applyHypothesisToBranch('b-1', hypothesis)).toThrow(ValidationError)
	})

	test('a hypothesis that adds a new prompt and references it loads cleanly', () => {
		const manager = createBranchManager(baseDir)
		manager.copyBaselineIntoBranch('b-1')
		const newGuild = {
			...baselineGuildJson,
			roles: {
				orchestrator: { systemPrompt: 'prompts/orchestrator.md', tools: ['agent', 'finish'] },
				planner: { systemPrompt: 'prompts/planner.md', tools: ['finish'] },
			},
		}
		const hypothesis: Hypothesis = {
			id: 'h-005',
			motivation: 'm',
			mechanism: 'mech',
			predictedImpact: 'impact',
			changes: [
				{ path: 'guild.json', edit: JSON.stringify(newGuild, null, 2) },
				{ path: 'prompts/planner.md', edit: 'you are the planner' },
			],
		}

		expect(() => manager.applyHypothesisToBranch('b-1', hypothesis)).not.toThrow()
	})

	test('a change path that escapes the branch directory is rejected', () => {
		const manager = createBranchManager(baseDir)
		manager.copyBaselineIntoBranch('b-1')
		const hypothesis: Hypothesis = {
			id: 'h-006',
			motivation: 'm',
			mechanism: 'mech',
			predictedImpact: 'impact',
			changes: [{ path: '../escape.md', edit: 'should not be written' }],
		}

		let caught: ValidationError | undefined
		try {
			manager.applyHypothesisToBranch('b-1', hypothesis)
		} catch (error) {
			if (error instanceof ValidationError) caught = error
		}
		expect(caught).toBeDefined()
		expect(caught!.path).toBe('changes[0].path')
		expect(fs.existsSync(path.join(baseDir, 'escape.md'))).toBe(false)
	})

	test('applyHypothesisToBranch fails clearly when the branch was not copied first', () => {
		const manager = createBranchManager(baseDir)
		const hypothesis: Hypothesis = {
			id: 'h-007',
			motivation: 'm',
			mechanism: 'mech',
			predictedImpact: 'impact',
			changes: [{ path: 'prompts/orchestrator.md', edit: 'x' }],
		}

		expect(() => manager.applyHypothesisToBranch('missing', hypothesis)).toThrow(/copyBaselineIntoBranch/)
	})

	test('copyBaselineIntoBranch fails clearly when no baseline exists', () => {
		const manager = createBranchManager(path.join(baseDir, 'no-foundry-here'))
		expect(() => manager.copyBaselineIntoBranch('b-1')).toThrow(/baseline not found/)
	})

	test('archiveBaselineIntoHistory copies the baseline into a history entry', () => {
		const manager = createBranchManager(baseDir)
		const historyDir = manager.archiveBaselineIntoHistory('2024-01-01T00:00:00Z')
		expect(fs.existsSync(path.join(historyDir, 'guild.json'))).toBe(true)
		expect(fs.existsSync(path.join(historyDir, 'prompts', 'orchestrator.md'))).toBe(true)
		expect(fs.readFileSync(path.join(historyDir, 'guild.json'), 'utf8')).toBe(fs.readFileSync(path.join(baselineDir, 'guild.json'), 'utf8'))
	})

	test('archiveBaselineIntoHistory replaces a same-timestamp history entry', () => {
		const manager = createBranchManager(baseDir)
		const timestamp = '2024-01-01T00:00:00Z'
		manager.archiveBaselineIntoHistory(timestamp)
		fs.writeFileSync(path.join(baselineDir, 'prompts', 'orchestrator.md'), 'mutated baseline')
		manager.archiveBaselineIntoHistory(timestamp)
		expect(fs.readFileSync(path.join(historyRoot(baseDir), timestamp, 'prompts', 'orchestrator.md'), 'utf8')).toBe('mutated baseline')
	})

	test('restoreHistoricalBaseline overwrites a mutated baseline with the archived one', () => {
		const manager = createBranchManager(baseDir)
		const timestamp = '2024-01-01T00:00:00Z'
		manager.archiveBaselineIntoHistory(timestamp)
		fs.writeFileSync(path.join(baselineDir, 'prompts', 'orchestrator.md'), 'mutated baseline')

		manager.restoreHistoricalBaseline(timestamp)

		expect(fs.readFileSync(path.join(baselineDir, 'prompts', 'orchestrator.md'), 'utf8')).toBe('you are the orchestrator')
	})

	test('restoreHistoricalBaseline fails clearly when the history entry is missing', () => {
		const manager = createBranchManager(baseDir)
		expect(() => manager.restoreHistoricalBaseline('never')).toThrow(/history entry not found/)
	})

	test('branches are isolated: editing one branch does not touch the baseline or another branch', () => {
		const manager = createBranchManager(baseDir)
		const branchOne = manager.copyBaselineIntoBranch('b-1')
		manager.copyBaselineIntoBranch('b-2')
		manager.applyHypothesisToBranch('b-1', {
			id: 'h-iso',
			motivation: 'm',
			mechanism: 'mech',
			predictedImpact: 'impact',
			changes: [{ path: 'prompts/orchestrator.md', edit: 'only b-1 should see this' }],
		})

		expect(fs.readFileSync(path.join(branchOne, 'prompts', 'orchestrator.md'), 'utf8')).toBe('only b-1 should see this')
		expect(fs.readFileSync(path.join(baselineDir, 'prompts', 'orchestrator.md'), 'utf8')).toBe('you are the orchestrator')
		expect(fs.readFileSync(path.join(branchesRoot(baseDir), 'b-2', 'prompts', 'orchestrator.md'), 'utf8')).toBe('you are the orchestrator')
	})
})

function branchesRoot(dir: string): string {
	return path.join(dir, 'branches')
}

function historyRoot(dir: string): string {
	return path.join(dir, 'history')
}
