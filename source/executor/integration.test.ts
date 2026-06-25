import { describe, expect, test, afterAll } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { LogEvent, ToolCall } from './types.js'
import { createGuildLoader } from './loader.ts'
import {
	createAppendLog, createRunDirectory, createWriteMeta,
} from './persistence.ts'
import { createToolHandlers } from './tools.ts'
import { stubHumanBackend } from './test-fixtures.ts'
import { createScriptedLlm, resolveRoleBySystemPrompt, scriptedToolCallResponse, toolCall } from './test-fixtures.ts'
import { runExecutor } from './executor.ts'

const guildDir = path.resolve(import.meta.dir, '..', '..', 'guild')
const benchmarkDir = path.resolve(import.meta.dir, '..', '..', 'benchmarks', 'hello_001')

let tempRoot: string

function makeTempRunRoot(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-integration-'))
	return dir
}

afterAll(() => {
	if (tempRoot !== undefined && fs.existsSync(tempRoot)) {
		fs.rmSync(tempRoot, { recursive: true, force: true })
	}
})

function isLogEvent(value: unknown): value is LogEvent {
	if (typeof value !== 'object') return false
	if (value === null) return false
	if (!('type' in value)) return false
	return true
}

function readLogEvents(runDir: string): LogEvent[] {
	const logPath = path.join(runDir, 'log.jsonl')
	if (!fs.existsSync(logPath)) return []
	const text = fs.readFileSync(logPath, 'utf8')
	const events: LogEvent[] = []
	for (const line of text.split('\n')) {
		if (line === '') continue
		const parsed: unknown = JSON.parse(line)
		if (isLogEvent(parsed)) events.push(parsed)
	}
	return events
}

function readMetaStatus(runDir: string): unknown {
	const metaPath = path.join(runDir, 'meta.json')
	const text = fs.readFileSync(metaPath, 'utf8')
	const parsed: unknown = JSON.parse(text)
	if (typeof parsed !== 'object' || parsed === null) throw new Error('meta.json is not an object')
	if (!('status' in parsed)) throw new Error('meta.json is missing status')
	return parsed.status
}

function toolNameFromEvent(event: LogEvent): string | undefined {
	const payload = event.payload
	if (typeof payload !== 'object' || payload === null) return undefined
	if (!('tool' in payload)) return undefined
	const tool = payload.tool
	return typeof tool === 'string' ? tool : undefined
}

function roleFromStart(event: LogEvent): string | undefined {
	const payload = event.payload
	if (typeof payload !== 'object' || payload === null) return undefined
	if (!('role' in payload)) return undefined
	const role = payload.role
	return typeof role === 'string' ? role : undefined
}

function parentOf(event: LogEvent): string | null {
	const payload = event.payload
	if (typeof payload !== 'object' || payload === null) return null
	if (!('parent' in payload)) return null
	const parent = payload.parent
	return typeof parent === 'string' ? parent : null
}

const orchestratorDelegatesToCoder: ToolCall[] = [
	toolCall('orch-1', 'agent', {
		role: 'coder',
		task: 'Write a file called output.txt containing the text hello world.',
	}),
]

const orchestratorFinishes: ToolCall[] = [
	toolCall('orch-2', 'finish', {
		status: 'success',
		summary: 'I created output.txt containing "hello world".',
		artifacts: ['output.txt'],
	}),
]

const coderWritesAndFinishes: ToolCall[] = [
	toolCall('coder-1', 'write_file', { path: 'output.txt', content: 'hello world\n' }),
	toolCall('coder-2', 'finish', {
		status: 'success',
		summary: 'Wrote output.txt containing "hello world".',
		artifacts: ['output.txt'],
	}),
]

describe('runExecutor end-to-end against the seed Guild and hello_001', () => {
	test('traverses orchestrator → coder → write_file → finish and materializes output.txt in place', async () => {
		tempRoot = makeTempRunRoot()
		const runId = 'integration-hello'

		// The executor modifies the workspace in place, so the test gives it a throwaway copy of the benchmark (mirroring how the Foundry will hand the executor a copy of each benchmark it wants to protect).
		const workspaceRoot = path.resolve(tempRoot, 'workspace')
		fs.cpSync(benchmarkDir, workspaceRoot, { recursive: true })
		const runsBaseDir = path.resolve(workspaceRoot, '.orchestration', 'runs')

		const loadGuild = createGuildLoader()
		const loadedGuild = loadGuild(guildDir)
		const resolveRole = resolveRoleBySystemPrompt(loadedGuild)

		const llmCaller = createScriptedLlm(
			{
				orchestrator: [
					scriptedToolCallResponse(orchestratorDelegatesToCoder),
					scriptedToolCallResponse(orchestratorFinishes),
				],
				coder: [scriptedToolCallResponse(coderWritesAndFinishes)],
			},
			resolveRole,
		)

		const additionalToolHandlers = createToolHandlers({
			workspaceRoot,
			defaultToolTimeoutSeconds: loadedGuild.config.executor.defaultToolTimeoutSeconds,
		})

		const meta = await runExecutor(
			{
				llmCaller,
				loadGuild: () => loadedGuild,
				appendLog: createAppendLog(runId, runsBaseDir),
				createRunDirectory: createRunDirectory(runId, runsBaseDir),
				writeMeta: createWriteMeta(runId, runsBaseDir),
				additionalToolHandlers,
				humanBackend: stubHumanBackend,
			},
			{
				runId,
				guildPath: guildDir,
				benchmarkPath: workspaceRoot,
				task: 'Write a file called output.txt containing the text hello world.',
				effort: 3,
			},
		)

		expect(meta.status).toBe('success')
		const runDir = path.resolve(runsBaseDir, runId)
		expect(readMetaStatus(runDir)).toBe('success')

		const workspaceOutputPath = path.resolve(workspaceRoot, 'output.txt')
		expect(fs.existsSync(workspaceOutputPath)).toBe(true)
		expect(fs.readFileSync(workspaceOutputPath, 'utf8').trim()).toBe('hello world')

		const events = readLogEvents(runDir)
		const types = events.map((e) => e.type)
		expect(types).toContain('llm_call')
		expect(types).toContain('tool_call')
		const toolCallEvents = events.filter((e) => e.type === 'tool_call')
		const toolNames = toolCallEvents.map(toolNameFromEvent)
		expect(toolNames).toContain('write_file')

		// The entry orchestrator and its spawned coder each emit a role_start/role_finished pair, and an agent_call links them.
		const roleStarts = events.filter((e) => e.type === 'role_start')
		expect(roleStarts.length).toBe(2)
		const orchestratorStart = roleStarts.find((e) => roleFromStart(e) === 'orchestrator')
		const coderStart = roleStarts.find((e) => roleFromStart(e) === 'coder')
		expect(orchestratorStart).toBeDefined()
		expect(coderStart).toBeDefined()
		expect(parentOf(coderStart!)).toBe('orchestrator')
		expect(parentOf(orchestratorStart!)).toBeNull()
		expect(events.some((e) => e.type === 'agent_call')).toBe(true)
		const roleFinishes = events.filter((e) => e.type === 'role_finished')
		expect(roleFinishes.length).toBe(2)
	})
})
