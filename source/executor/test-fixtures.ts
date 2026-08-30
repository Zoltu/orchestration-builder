import { createCheckpointRecorder, isRunCheckpoint, type CheckpointRecorder, type RunCheckpoint } from './checkpoint.js'
import type { ContextPressureTracker } from './context-pressure.js'
import type { HumanBackend } from './human-backend.js'
import type { LoadedGuild } from './loader.js'
import type { RoleRegistry } from './role-registry.js'
import type { GuildConfig, ToolManifest, ToolResult } from './types.js'

export function defined<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new Error(`${label} is missing`)
	return value
}

export function toolData<T>(result: ToolResult, guard: (value: unknown) => value is T): T {
	if (result.kind !== 'success') throw new Error(`expected a success tool result, got ${result.kind}`)
	if (!guard(result.data)) throw new Error('tool result data did not match the expected shape')
	return result.data
}

export const stubHumanBackend: HumanBackend = {
	ask: async () => 'use your best judgement',
}

export interface RecordingHumanBackend extends HumanBackend {
	questions: Array<{ question: string; context?: string }>
}

export function recordingHumanBackend(): RecordingHumanBackend {
	const questions: Array<{ question: string; context?: string }> = []
	return {
		questions,
		ask: async (question, context) => {
			questions.push({ question, context })
			return 'use your best judgement'
		},
	}
}

export function withTool(guild: LoadedGuild, manifest: ToolManifest, manifestPath?: string): LoadedGuild {
	const tools = { ...guild.tools, [manifest.name]: manifest }
	const config: GuildConfig = {
		...guild.config,
		tools: manifestPath !== undefined ? [...guild.config.tools, manifestPath] : guild.config.tools,
	}
	return { config, prompts: guild.prompts, tools }
}

export interface FakeCheckpointSink {
	recorder: CheckpointRecorder
	checkpoints: RunCheckpoint[]
}

// A real recorder over an in-memory sink. The recorder passes live references to writeCheckpoint, so the sink deep-copies through JSON to freeze each write as made — and re-validates the copy, so every test using this fixture also proves the recorder's output passes the resume-time guard.
export function createFakeCheckpointRecorder(roleRegistry: RoleRegistry, contextPressureTracker: ContextPressureTracker, runId: string = 'test-run'): FakeCheckpointSink {
	const checkpoints: RunCheckpoint[] = []
	const recorder = createCheckpointRecorder({
		writeCheckpoint: (checkpoint) => {
			const copy: unknown = JSON.parse(JSON.stringify(checkpoint))
			if (!isRunCheckpoint(copy)) throw new Error('checkpoint recorder produced a checkpoint its own guard rejects')
			checkpoints.push(copy)
		},
		runId,
		startTime: '2026-01-01T00:00:00.000Z',
		roleRegistry,
		contextPressureTracker,
	})
	return { recorder, checkpoints }
}
