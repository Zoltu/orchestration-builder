import { describe, expect, test } from 'bun:test'
import type { RunCheckpoint } from './checkpoint.ts'
import { DEFAULT_LOG_LEVEL } from './log-level.ts'
import type { EffortLevel, InvolvementLevel, LogEvent, LogLevel, RunContinuation, RunMeta } from './types.js'
import type { ReadProjectSettings, ReadRunCheckpointById, ReadRunMetaById, RunDirectoryExists } from './persistence.ts'
import { DEFAULT_EFFORT } from './effort.ts'
import { DEFAULT_INVOLVEMENT } from './involvement.ts'
import { createReadParkedAskById, createResumeErroredRun, createResumeParkedRun, createRunSubmission, createTerminateParkedRun, type ResumeErroredRunDependencies, type ResumeRun, type RunSubmission, type StartRun } from './run-submission.ts'
import { isRunMeta } from './validation.ts'
import { createTaskQueue, type QueueItemView, type QueueView, type TaskQueueModule } from './queue/index.ts'
import { defined, flushMicrotasks } from './test-fixtures.ts'

function sampleMeta(runId: string): RunMeta {
	return {
		runId,
		guildPath: 'guild',
		benchmarkPath: 'bench',
		task: 'do it',
		status: 'success',
		startTime: '2026-01-01T00:00:00.000Z',
		endTime: '2026-01-01T00:01:00.000Z',
	}
}

function parkedCheckpointFor(runId: string): RunCheckpoint {
	return {
		version: 1,
		runId,
		startTime: '2026-01-01T00:00:00.000Z',
		registryCounter: 1,
		parkedAsk: { roleId: 'main-0-1', toolCallId: 'ask_1', question: 'which database?' },
		frames: [
			{
				roleId: 'main-0-1',
				roleName: 'main',
				depth: 0,
				task: 'do it',
				roleState: {
					history: [
						{ role: 'system', content: 'prompt' },
						{ role: 'user', content: 'do it' },
						{ role: 'assistant', content: '', tool_calls: [{ id: 'ask_1', type: 'function', function: { name: 'ask_human', arguments: '{"question":"which database?"}' } }] },
						{ role: 'tool', content: '{"question":"which database?","parked":true}', tool_call_id: 'ask_1' },
					],
					lastPromptTokens: 0,
					recentCompactionPromptTokens: [],
					recentToolCalls: [],
					toolCallCount: 1,
					generatedTokens: 0,
					contextExceededAttempts: 0,
					loopCheckToolCallWatermark: 0,
					loopCheckTokenWatermark: 0,
				},
			},
		],
	}
}

const emptySettings: ReadProjectSettings = () => ({})

// Most tests exercise submit(); this stand-in satisfies the collision guard where no run directory is taken.
const emptyRunsDir: RunDirectoryExists = () => false

// The settlement hook most tests never observe; the hook tests below record with their own.
const settleNothing = async (): Promise<void> => {}

// Most tests exercise submit(); this stand-in satisfies the dependency where resume is not under test.
const unusedResumeRun: ResumeRun = async () => sampleMeta('resumed')

// The resume tests' stand-in for startRun, which they never drive.
const unusedStartRun: StartRun = async (runId) => sampleMeta(runId)

describe('createRunSubmission', () => {
	test('submit accepts a task, starts the run, and returns its id', async () => {
		let startedRunId: string | undefined
		const startRun: StartRun = async (runId) => {
			startedRunId = runId
			return sampleMeta(runId)
		}
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })

		const result = submission.submit('do it')
		expect(result).toEqual({ ok: true, runId: 'run-1' })
		expect(startedRunId).toBe('run-1')
		expect(submission.activeRunId()).toBe('run-1')

		await submission.awaitActive()
	})

	test('submit marks every started run queue-tracked — the bit that gates the pre-write park', async () => {
		const marks: boolean[] = []
		const startRun: StartRun = async (_runId, _task, _effort, _involvement, _logLevel, _continuation, queueTracked) => {
			marks.push(queueTracked)
			return sampleMeta('run-1')
		}
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })

		// The queue is universal and the scheduler is submit's only caller, so every submission is a queue dispatch.
		submission.submit('do it')
		await submission.awaitActive()
		expect(marks).toEqual([true])
	})

	test('submit rejects a second task while a run is active', async () => {
		let resolveFirst: (meta: RunMeta) => void = () => {}
		const startRun: StartRun = () => new Promise<RunMeta>((resolve) => {
			resolveFirst = resolve
		})
		const ids = ['run-1', 'run-2']
		let next = 0
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => defined(ids[next++], 'run id'), readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })

		const first = submission.submit('first')
		expect(first).toEqual({ ok: true, runId: 'run-1' })

		const second = submission.submit('second')
		expect(second).toEqual({ ok: false, error: 'run_in_progress' })
		expect(submission.activeRunId()).toBe('run-1')

		resolveFirst(sampleMeta('run-1'))
		await submission.awaitActive()
	})

	test('submit refuses a run id whose directory already exists instead of sharing it', async () => {
		let started = 0
		const startRun: StartRun = async (runId) => {
			started++
			return sampleMeta(runId)
		}
		// Run ids have one-second resolution, so a previous run that failed instantly can still own the directory the fresh id maps to.
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', runDirectoryExists: () => true, readProjectSettings: emptySettings })

		expect(submission.submit('do it')).toEqual({ ok: false, error: 'run_id_collision' })
		expect(started).toBe(0)
		expect(submission.activeRunId()).toBeUndefined()
	})

	test('a collision refusal does not consume the run, so the same id is started once its directory is free', async () => {
		let directoryTaken = true
		const startRun: StartRun = async (runId) => sampleMeta(runId)
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', runDirectoryExists: () => directoryTaken, readProjectSettings: emptySettings })

		expect(submission.submit('do it')).toEqual({ ok: false, error: 'run_id_collision' })

		directoryTaken = false
		expect(submission.submit('do it')).toEqual({ ok: true, runId: 'run-1' })
		await submission.awaitActive()
	})

	test('activeRunId clears when the run completes, allowing a new submit', async () => {
		let resolveRun: (meta: RunMeta) => void = () => {}
		const startRun: StartRun = () => new Promise<RunMeta>((resolve) => {
			resolveRun = resolve
		})
		const ids = ['run-1', 'run-2']
		let next = 0
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => defined(ids[next++], 'run id'), readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })

		submission.submit('first')
		expect(submission.activeRunId()).toBe('run-1')

		resolveRun(sampleMeta('run-1'))
		await submission.awaitActive()
		expect(submission.activeRunId()).toBeUndefined()

		const second = submission.submit('second')
		expect(second).toEqual({ ok: true, runId: 'run-2' })
		resolveRun(sampleMeta('run-2'))
		await submission.awaitActive()
	})

	test('lastRunId survives completion so the alias API can keep surfacing the most recent run', async () => {
		let resolveRun: (meta: RunMeta) => void = () => {}
		const startRun: StartRun = () => new Promise<RunMeta>((resolve) => {
			resolveRun = resolve
		})
		const ids = ['run-1', 'run-2']
		let next = 0
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => defined(ids[next++], 'run id'), readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })

		submission.submit('first')
		resolveRun(sampleMeta('run-1'))
		await submission.awaitActive()

		expect(submission.activeRunId()).toBeUndefined()
		expect(submission.lastRunId()).toBe('run-1')

		submission.submit('second')
		expect(submission.lastRunId()).toBe('run-2')
		resolveRun(sampleMeta('run-2'))
		await submission.awaitActive()
	})

	test('awaitActive resolves with the run meta for the active run', async () => {
		const meta = sampleMeta('run-1')
		const startRun: StartRun = async () => meta
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })

		submission.submit('do it')
		expect(await submission.awaitActive()).toEqual(meta)
	})

	test('awaitActive resolves with undefined when no run has been started', async () => {
		const startRun: StartRun = async () => sampleMeta('run-1')
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })

		expect(await submission.awaitActive()).toBeUndefined()
	})

	test('awaitActive still returns the completed run meta after it has already been awaited', async () => {
		const meta = sampleMeta('run-1')
		const startRun: StartRun = async () => meta
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })

		submission.submit('do it')
		const first = await submission.awaitActive()
		const second = await submission.awaitActive()
		expect(first).toEqual(meta)
		expect(second).toEqual(meta)
		expect(submission.activeRunId()).toBeUndefined()
	})

	test('a hand-written fake can satisfy the RunSubmission contract', () => {
		const fake: RunSubmission = {
			submit: () => ({ ok: false, error: 'run_in_progress' }),
			resume: () => {},
			activeRunId: () => undefined,
			lastRunId: () => undefined,
			awaitActive: () => Promise.resolve(undefined),
			awaitFatalError: () => new Promise<Error>(() => {}),
		}

		expect(fake.submit('x')).toEqual({ ok: false, error: 'run_in_progress' })
		expect(fake.activeRunId()).toBeUndefined()
		expect(fake.lastRunId()).toBeUndefined()
	})

	test('a fatal startRun rejection clears the active slot and resolves awaitFatalError', async () => {
		const startRun: StartRun = () => Promise.reject(new Error('disk full'))
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })

		submission.submit('do it')

		const fatal = await submission.awaitFatalError()
		expect(fatal.message).toBe('disk full')

		expect(await submission.awaitActive()).toBeUndefined()
		expect(submission.activeRunId()).toBeUndefined()
		expect(submission.lastRunId()).toBe('run-1')
	})

	test('a non-Error rejection is normalized to an Error in awaitFatalError', async () => {
		const startRun: StartRun = () => Promise.reject('bare string rejection')
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })

		submission.submit('do it')

		const fatal = await submission.awaitFatalError()
		expect(fatal).toBeInstanceOf(Error)
		expect(fatal.message).toBe('bare string rejection')

		await submission.awaitActive()
	})

	test('a successful run never resolves awaitFatalError', async () => {
		const startRun: StartRun = async () => sampleMeta('run-1')
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })

		submission.submit('do it')
		await submission.awaitActive()

		let resolved = false
		submission.awaitFatalError().then(() => { resolved = true })
		// awaitFatalError settles only through a run rejection, and the run already completed and was awaited, so a microtask drain is the complete opportunity for a wrongful resolution to surface.
		await flushMicrotasks()
		expect(resolved).toBe(false)
	})
})

describe('createRunSubmission resume', () => {
	function sampleCheckpoint(runId: string): RunCheckpoint {
		return {
			version: 1,
			runId,
			startTime: '2026-01-01T00:00:00.000Z',
			registryCounter: 1,
			frames: [
				{
					roleId: 'main-0-1',
					roleName: 'main',
					depth: 0,
					task: 'do it',
					roleState: {
						history: [{ role: 'system', content: 'prompt' }],
						lastPromptTokens: 0,
						recentCompactionPromptTokens: [],
						recentToolCalls: [],
						toolCallCount: 0,
						generatedTokens: 0,
						contextExceededAttempts: 0,
						loopCheckToolCallWatermark: 0,
						loopCheckTokenWatermark: 0,
					},
				},
			],
		}
	}

	test('resume takes the active slot under the checkpoint run id and resolves awaitActive with the meta', async () => {
		const checkpoint = sampleCheckpoint('run-20260101-000009')
		const resumeRun: ResumeRun = async () => sampleMeta('run-20260101-000009')
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun: unusedStartRun, resumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })

		submission.resume(checkpoint)

		expect(submission.activeRunId()).toBe('run-20260101-000009')
		expect(submission.lastRunId()).toBe('run-20260101-000009')
		expect(await submission.awaitActive()).toEqual(sampleMeta('run-20260101-000009'))
		expect(submission.activeRunId()).toBeUndefined()
	})

	test('submit rejects while a resumed run is active', async () => {
		let resolveResume: (meta: RunMeta) => void = () => {}
		const resumeRun: ResumeRun = () => new Promise<RunMeta>((resolve) => {
			resolveResume = resolve
		})
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun: unusedStartRun, resumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })

		submission.resume(sampleCheckpoint('run-20260101-000009'))

		expect(submission.submit('new task')).toEqual({ ok: false, error: 'run_in_progress' })
		resolveResume(sampleMeta('run-20260101-000009'))
		await submission.awaitActive()
		expect(submission.submit('new task')).toEqual({ ok: true, runId: 'run-1' })
	})

	test('resume while a run is active throws', async () => {
		let resolveRun: (meta: RunMeta) => void = () => {}
		const startRun: StartRun = () => new Promise<RunMeta>((resolve) => {
			resolveRun = resolve
		})
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })

		submission.submit('do it')

		expect(() => submission.resume(sampleCheckpoint('run-20260101-000009'))).toThrow()
		resolveRun(sampleMeta('run-1'))
		await submission.awaitActive()
	})

	test('a resumeRun rejection clears the active slot and resolves awaitFatalError', async () => {
		const resumeRun: ResumeRun = () => Promise.reject(new Error('checkpoint unreadable'))
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun: unusedStartRun, resumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })

		submission.resume(sampleCheckpoint('run-20260101-000009'))

		const fatal = await submission.awaitFatalError()
		expect(fatal.message).toBe('checkpoint unreadable')
		expect(await submission.awaitActive()).toBeUndefined()
		expect(submission.activeRunId()).toBeUndefined()
		expect(submission.lastRunId()).toBe('run-20260101-000009')
	})

	test('resume threads the operator note through to resumeRun, and no note when none is given', async () => {
		const notes: Array<string | undefined> = []
		const resumeRun: ResumeRun = async (_checkpoint, options) => {
			notes.push(options?.resumeNote)
			return sampleMeta('run-20260101-000009')
		}
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun: unusedStartRun, resumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })

		submission.resume(sampleCheckpoint('run-20260101-000009'), { resumeNote: 'The operator resumed this run after a failure. Message from the operator: try again' })
		await submission.awaitActive()
		expect(notes).toEqual(['The operator resumed this run after a failure. Message from the operator: try again'])

		submission.resume(sampleCheckpoint('run-20260101-000009'))
		await submission.awaitActive()
		expect(notes[1]).toBeUndefined()
	})

	test('resume forwards the parked answer and the queue-tracked mark', async () => {
		const seen: Array<{ parkedAnswer?: unknown; queueTracked?: boolean }> = []
		const resumeRun: ResumeRun = async (_checkpoint, options) => {
			seen.push({
				...(options?.parkedAnswer !== undefined ? { parkedAnswer: options.parkedAnswer } : {}),
				...(options?.queueTracked !== undefined ? { queueTracked: options.queueTracked } : {}),
			})
			return sampleMeta('run-20260101-000009')
		}
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun: unusedStartRun, resumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })
		const parkedAnswer = { question: 'which database?', answer: 'postgres', toolCallId: 'ask_1' }

		submission.resume(sampleCheckpoint('run-20260101-000009'), { parkedAnswer, queueTracked: true })
		await submission.awaitActive()

		expect(seen).toEqual([{ parkedAnswer, queueTracked: true }])
	})
})

describe('createRunSubmission settlement hook', () => {
	function resumeCheckpoint(runId: string): RunCheckpoint {
		return {
			version: 1,
			runId,
			startTime: '2026-01-01T00:00:00.000Z',
			registryCounter: 1,
			frames: [
				{
					roleId: 'main-0-1',
					roleName: 'main',
					depth: 0,
					task: 'do it',
					roleState: {
						history: [{ role: 'system', content: 'prompt' }],
						lastPromptTokens: 0,
						recentCompactionPromptTokens: [],
						recentToolCalls: [],
						toolCallCount: 0,
						generatedTokens: 0,
						contextExceededAttempts: 0,
						loopCheckToolCallWatermark: 0,
						loopCheckTokenWatermark: 0,
					},
				},
			],
		}
	}

	test('onRunSettled fires exactly once when a submitted run settles, after the active slot clears', async () => {
		const settled: RunMeta[] = []
		const slotContents: Array<string | undefined> = []
		const startRun: StartRun = async (runId) => sampleMeta(runId)
		const submission = createRunSubmission({
			startRun,
			resumeRun: unusedResumeRun,
			generateRunId: () => 'run-1',
			readProjectSettings: emptySettings,
			runDirectoryExists: emptyRunsDir,
			onRunSettled: async (meta) => {
				settled.push(meta)
				slotContents.push(submission.activeRunId())
			},
		})

		submission.submit('do it')
		await submission.awaitActive()

		expect(settled).toEqual([sampleMeta('run-1')])
		// The hook runs after the active slot clears, so its tick can dispatch into the freed slot.
		expect(slotContents).toEqual([undefined])
	})

	test('onRunSettled fires exactly once when a resumed run settles', async () => {
		const settled: RunMeta[] = []
		const resumeRun: ResumeRun = async () => sampleMeta('run-20260101-000009')
		const submission = createRunSubmission({
			startRun: unusedStartRun,
			resumeRun,
			generateRunId: () => 'run-1',
			readProjectSettings: emptySettings,
			runDirectoryExists: emptyRunsDir,
			onRunSettled: async (meta) => {
				settled.push(meta)
			},
		})

		submission.resume(resumeCheckpoint('run-20260101-000009'))
		await submission.awaitActive()

		expect(settled).toEqual([sampleMeta('run-20260101-000009')])
	})

	test('onRunSettled never fires on the rejection branch — a rejected run promise is the fatal teardown path', async () => {
		const settled: RunMeta[] = []
		const startRun: StartRun = () => Promise.reject(new Error('disk full'))
		const submission = createRunSubmission({
			startRun,
			resumeRun: unusedResumeRun,
			generateRunId: () => 'run-1',
			readProjectSettings: emptySettings,
			runDirectoryExists: emptyRunsDir,
			onRunSettled: async (meta) => {
				settled.push(meta)
			},
		})

		submission.submit('do it')
		await submission.awaitFatalError()
		await flushMicrotasks()

		expect(settled).toEqual([])
	})
})

describe('createRunSubmission effort resolution', () => {
	function captureEffort(): { startRun: StartRun; captured: EffortLevel[] } {
		const captured: EffortLevel[] = []
		const startRun: StartRun = async (_runId, _task, effort) => {
			captured.push(effort)
			return sampleMeta('run-1')
		}
		return { startRun, captured }
	}

	test('a per-run override is threaded into startRun', async () => {
		const { startRun, captured } = captureEffort()
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })

		submission.submit('do it', 'thorough')
		await submission.awaitActive()
		expect(captured).toEqual(['thorough'])
	})

	test('the project default is applied when no override is given', async () => {
		const { startRun, captured } = captureEffort()
		const projectSettings: ReadProjectSettings = () => ({ effort: 'thorough' })
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: projectSettings, runDirectoryExists: emptyRunsDir })

		submission.submit('do it')
		await submission.awaitActive()
		expect(captured).toEqual(['thorough'])
	})

	test('a per-run override wins over the project default', async () => {
		const { startRun, captured } = captureEffort()
		const projectSettings: ReadProjectSettings = () => ({ effort: 'thorough' })
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: projectSettings, runDirectoryExists: emptyRunsDir })

		submission.submit('do it', 'quick')
		await submission.awaitActive()
		expect(captured).toEqual(['quick'])
	})

	test('DEFAULT_EFFORT applies when neither override nor project setting fixes the effort', async () => {
		const { startRun, captured } = captureEffort()
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })

		submission.submit('do it')
		await submission.awaitActive()
		expect(captured).toEqual([DEFAULT_EFFORT])
	})
})

describe('createRunSubmission continuation passthrough', () => {
	function captureContinuation(): { startRun: StartRun; captured: Array<RunContinuation | undefined> } {
		const captured: Array<RunContinuation | undefined> = []
		const startRun: StartRun = async (_runId, _task, _effort, _involvement, _logLevel, continuation) => {
			captured.push(continuation)
			return sampleMeta('run-1')
		}
		return { startRun, captured }
	}

	test('submit threads the continuation through to startRun', async () => {
		const { startRun, captured } = captureContinuation()
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })
		const continuation = { runId: 'run-20260101-000000', task: 'prior task', summary: 'prior summary' }

		submission.submit('do it', undefined, undefined, undefined, continuation)
		await submission.awaitActive()
		expect(captured).toEqual([continuation])
	})

	test('submit threads no continuation when none is given', async () => {
		const { startRun, captured } = captureContinuation()
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })

		submission.submit('do it')
		await submission.awaitActive()
		expect(captured).toEqual([undefined])
	})
})

describe('createRunSubmission log level resolution', () => {
	function captureLogLevel(): { startRun: StartRun; captured: LogLevel[] } {
		const captured: LogLevel[] = []
		const startRun: StartRun = async (_runId, _task, _effort, _involvement, logLevel) => {
			captured.push(logLevel)
			return sampleMeta('run-1')
		}
		return { startRun, captured }
	}

	test('a per-run override is threaded into startRun', async () => {
		const { startRun, captured } = captureLogLevel()
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })

		submission.submit('do it', undefined, undefined, 'standard')
		await submission.awaitActive()
		expect(captured).toEqual(['standard'])
	})

	test('the project default is applied when no override is given', async () => {
		const { startRun, captured } = captureLogLevel()
		const projectSettings: ReadProjectSettings = () => ({ logLevel: 'standard' })
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: projectSettings, runDirectoryExists: emptyRunsDir })

		submission.submit('do it')
		await submission.awaitActive()
		expect(captured).toEqual(['standard'])
	})

	test('a per-run override wins over the project default', async () => {
		const { startRun, captured } = captureLogLevel()
		const projectSettings: ReadProjectSettings = () => ({ logLevel: 'standard' })
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: projectSettings, runDirectoryExists: emptyRunsDir })

		submission.submit('do it', undefined, undefined, 'full')
		await submission.awaitActive()
		expect(captured).toEqual(['full'])
	})

	test('the deployment default applies when neither override nor project setting fixes the level', async () => {
		const { startRun, captured } = captureLogLevel()
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir, deploymentLogLevel: 'standard' })

		submission.submit('do it')
		await submission.awaitActive()
		expect(captured).toEqual(['standard'])
	})

	test('the project setting wins over the deployment default', async () => {
		const { startRun, captured } = captureLogLevel()
		const projectSettings: ReadProjectSettings = () => ({ logLevel: 'full' })
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: projectSettings, runDirectoryExists: emptyRunsDir, deploymentLogLevel: 'standard' })

		submission.submit('do it')
		await submission.awaitActive()
		expect(captured).toEqual(['full'])
	})

	test('a per-run override wins over the deployment default', async () => {
		const { startRun, captured } = captureLogLevel()
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir, deploymentLogLevel: 'standard' })

		submission.submit('do it', undefined, undefined, 'full')
		await submission.awaitActive()
		expect(captured).toEqual(['full'])
	})

	test('DEFAULT_LOG_LEVEL applies when nothing in the chain fixes the level', async () => {
		const { startRun, captured } = captureLogLevel()
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })

		submission.submit('do it')
		await submission.awaitActive()
		expect(captured).toEqual([DEFAULT_LOG_LEVEL])
	})
})

describe('createRunSubmission involvement resolution', () => {
	function captureInvolvement(): { startRun: StartRun; captured: InvolvementLevel[] } {
		const captured: InvolvementLevel[] = []
		const startRun: StartRun = async (_runId, _task, _effort, involvement) => {
			captured.push(involvement)
			return sampleMeta('run-1')
		}
		return { startRun, captured }
	}

	test('a per-run override is threaded into startRun', async () => {
		const { startRun, captured } = captureInvolvement()
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })

		submission.submit('do it', undefined, 'collaborative')
		await submission.awaitActive()
		expect(captured).toEqual(['collaborative'])
	})

	test('the project default is applied when no override is given', async () => {
		const { startRun, captured } = captureInvolvement()
		const projectSettings: ReadProjectSettings = () => ({ involvement: 'collaborative' })
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: projectSettings, runDirectoryExists: emptyRunsDir })

		submission.submit('do it')
		await submission.awaitActive()
		expect(captured).toEqual(['collaborative'])
	})

	test('a per-run override wins over the project default', async () => {
		const { startRun, captured } = captureInvolvement()
		const projectSettings: ReadProjectSettings = () => ({ involvement: 'collaborative' })
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: projectSettings, runDirectoryExists: emptyRunsDir })

		submission.submit('do it', undefined, 'autonomous')
		await submission.awaitActive()
		expect(captured).toEqual(['autonomous'])
	})

	test('the deployment default applies when neither override nor project setting fixes the level', async () => {
		const { startRun, captured } = captureInvolvement()
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir, deploymentInvolvement: 'collaborative' })

		submission.submit('do it')
		await submission.awaitActive()
		expect(captured).toEqual(['collaborative'])
	})

	test('the project setting wins over the deployment default', async () => {
		const { startRun, captured } = captureInvolvement()
		const projectSettings: ReadProjectSettings = () => ({ involvement: 'autonomous' })
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: projectSettings, runDirectoryExists: emptyRunsDir, deploymentInvolvement: 'collaborative' })

		submission.submit('do it')
		await submission.awaitActive()
		expect(captured).toEqual(['autonomous'])
	})

	test('a per-run override wins over the deployment default', async () => {
		const { startRun, captured } = captureInvolvement()
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir, deploymentInvolvement: 'collaborative' })

		submission.submit('do it', undefined, 'autonomous')
		await submission.awaitActive()
		expect(captured).toEqual(['autonomous'])
	})

	test('DEFAULT_INVOLVEMENT applies when nothing in the chain fixes the level', async () => {
		const { startRun, captured } = captureInvolvement()
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })

		submission.submit('do it')
		await submission.awaitActive()
		expect(captured).toEqual([DEFAULT_INVOLVEMENT])
	})
})

describe('createResumeErroredRun', () => {
	function sampleCheckpoint(runId: string): RunCheckpoint {
		return {
			version: 1,
			runId,
			startTime: '2026-01-01T00:00:00.000Z',
			registryCounter: 1,
			frames: [
				{
					roleId: 'main-0-1',
					roleName: 'main',
					depth: 0,
					task: 'do it',
					roleState: {
						history: [{ role: 'system', content: 'prompt' }],
						lastPromptTokens: 0,
						recentCompactionPromptTokens: [],
						recentToolCalls: [],
						toolCallCount: 0,
						generatedTokens: 0,
						contextExceededAttempts: 0,
						loopCheckToolCallWatermark: 0,
						loopCheckTokenWatermark: 0,
					},
				},
			],
		}
	}

	function isQueueItemShape(value: unknown): value is QueueItemView {
		if (typeof value !== 'object' || value === null) return false
		if (!('id' in value) || typeof value.id !== 'string') return false
		if (!('task' in value) || typeof value.task !== 'string') return false
		if (!('status' in value) || typeof value.status !== 'string') return false
		if (!('queuedAt' in value) || typeof value.queuedAt !== 'string') return false
		return true
	}

	function parseQueueText(text: string | null): QueueView {
		if (text === null) return { items: [] }
		const parsed: unknown = JSON.parse(text)
		if (typeof parsed !== 'object' || parsed === null) throw new Error('the fake queue store holds a malformed queue')
		if (!('items' in parsed) || !Array.isArray(parsed.items) || !parsed.items.every(isQueueItemShape)) throw new Error('the fake queue store holds a malformed queue')
		return { items: parsed.items }
	}

	// An in-memory text store standing in for the filesystem leaves.
	function createQueueStore(initial: QueueItemView[] = []): { store: { read: () => string | null; write: (contents: string) => void }; snapshot: () => QueueView } {
		let current: string | null = initial.length === 0 ? null : JSON.stringify({ items: initial })
		return {
			store: {
				read: () => current,
				write: (contents) => {
					current = contents
				},
			},
			snapshot: () => parseQueueText(current),
		}
	}

	// The real queue module over the in-memory store: the resume path only exercises its re-activation operation.
	function createQueueModule(store: ReturnType<typeof createQueueStore>, submission: RunSubmission, readers: ReturnType<typeof createReaders>): TaskQueueModule {
		return createTaskQueue({
			queueStore: store.store,
			readRunMetaById: readers.readRunMetaById,
			listRunIds: () => [],
			readRunListSummary: () => {
				throw new Error('the resume path does not assemble a briefing')
			},
			readParkedAskById: () => null,
			resumeParkedRun: () => ({ ok: false, error: 'checkpoint_missing' }),
			terminateParkedRun: () => ({ ok: false, error: 'not_found' }),
			submitRun: () => {
				throw new Error('the resume path does not dispatch')
			},
			hasActiveRun: () => submission.activeRunId() !== undefined,
			sleep: async () => {},
			now: () => '2026-01-01T00:00:00.000Z',
		})
	}

	function erroredMeta(runId: string): RunMeta {
		return { ...sampleMeta(runId), status: 'error', result: { status: 'error', summary: 'LLM unavailable: connection refused' } }
	}

	// The raw-text readers the orchestration validates against, backed by plain maps a test seeds.
	function createReaders(metas: Map<string, string>, checkpoints: Map<string, string>): { readRunMetaById: ReadRunMetaById; readCheckpointById: ReadRunCheckpointById } {
		return {
			readRunMetaById: (runId) => metas.get(runId) ?? null,
			readCheckpointById: (runId) => checkpoints.get(runId) ?? null,
		}
	}

	function erroredItem(): QueueItemView {
		return { id: 'item-1', task: 'do it', status: 'error', runId: 'run-20260101-000009', queuedAt: '2026-01-01T00:00:00.000Z', settledAt: '2026-01-01T00:05:00.000Z', error: 'LLM unavailable: connection refused' }
	}

	function createHarness(input: { metas: Map<string, string>; checkpoints: Map<string, string>; queue?: Array<QueueItemView> }): { resumeErroredRun: ReturnType<typeof createResumeErroredRun>; submission: RunSubmission; queue: ReturnType<typeof createQueueStore>; resumedNotes: () => Array<string | undefined> } {
		const queue = createQueueStore(input.queue ?? [])
		const readers = createReaders(input.metas, input.checkpoints)
		let resumeNote: string | undefined
		const resumeRun: ResumeRun = async (checkpoint, options) => {
			resumeNote = options?.resumeNote
			return sampleMeta(checkpoint.runId)
		}
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun: unusedStartRun, resumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })
		const dependencies: ResumeErroredRunDependencies = { runSubmission: submission, readRunMetaById: readers.readRunMetaById, readCheckpointById: readers.readCheckpointById, taskQueue: createQueueModule(queue, submission, readers) }
		return { resumeErroredRun: createResumeErroredRun(dependencies), submission, queue, resumedNotes: () => [resumeNote] }
	}

	test('a happy resume re-activates the settled item, threads the framed note, and reports the same run id', async () => {
		const metas = new Map([['run-20260101-000009', JSON.stringify(erroredMeta('run-20260101-000009'))]])
		const checkpoints = new Map([['run-20260101-000009', JSON.stringify(sampleCheckpoint('run-20260101-000009'))]])
		const harness = createHarness({ metas, checkpoints, queue: [erroredItem()] })

		const result = harness.resumeErroredRun('run-20260101-000009', 'the endpoint is back; carry on')

		expect(result).toEqual({ ok: true, runId: 'run-20260101-000009' })
		expect(harness.submission.activeRunId()).toBe('run-20260101-000009')
		const reactivated = harness.queue.snapshot().items.find((entry) => entry.id === 'item-1')
		expect(reactivated?.status).toBe('active')
		expect(reactivated?.runId).toBe('run-20260101-000009')
		expect(harness.resumedNotes()).toEqual(['The operator resumed this run after a failure. Message from the operator: the endpoint is back; carry on'])
		await harness.submission.awaitActive()
	})

	test('a no-note resume injects nothing and still re-activates the item', async () => {
		const metas = new Map([['run-20260101-000009', JSON.stringify(erroredMeta('run-20260101-000009'))]])
		const checkpoints = new Map([['run-20260101-000009', JSON.stringify(sampleCheckpoint('run-20260101-000009'))]])
		const harness = createHarness({ metas, checkpoints, queue: [erroredItem()] })

		expect(harness.resumeErroredRun('run-20260101-000009', undefined)).toEqual({ ok: true, runId: 'run-20260101-000009' })
		expect(harness.queue.snapshot().items.find((entry) => entry.id === 'item-1')?.status).toBe('active')
		await harness.submission.awaitActive()
		expect(harness.resumedNotes()).toEqual([undefined])
	})

	test('a run with no matching queue item still resumes — the queue record does not gate the run', async () => {
		const metas = new Map([['run-20260101-000009', JSON.stringify(erroredMeta('run-20260101-000009'))]])
		const checkpoints = new Map([['run-20260101-000009', JSON.stringify(sampleCheckpoint('run-20260101-000009'))]])
		const harness = createHarness({ metas, checkpoints })

		expect(harness.resumeErroredRun('run-20260101-000009', undefined)).toEqual({ ok: true, runId: 'run-20260101-000009' })
		await harness.submission.awaitActive()
	})

	test('rejects an unknown run id and a non-error meta without touching the queue or the slot', async () => {
		const metas = new Map([
			['run-success', JSON.stringify(sampleMeta('run-success'))],
			['run-running', JSON.stringify({ ...sampleMeta('run-running'), status: 'running' })],
		])
		const checkpoints = new Map([['run-success', JSON.stringify(sampleCheckpoint('run-success'))]])
		const harness = createHarness({ metas, checkpoints, queue: [erroredItem()] })

		expect(harness.resumeErroredRun('ghost', undefined)).toEqual({ ok: false, error: 'run_not_found' })
		expect(harness.resumeErroredRun('run-success', undefined)).toEqual({ ok: false, error: 'run_not_errored' })
		expect(harness.resumeErroredRun('run-running', undefined)).toEqual({ ok: false, error: 'run_not_errored' })
		expect(harness.queue.snapshot().items.find((entry) => entry.id === 'item-1')?.status).toBe('error')
		expect(harness.submission.activeRunId()).toBeUndefined()
	})

	test('rejects a missing or corrupt checkpoint with checkpoint_missing', async () => {
		const metas = new Map([['run-20260101-000009', JSON.stringify(erroredMeta('run-20260101-000009'))]])
		const checkpoints = new Map([['run-other', JSON.stringify(sampleCheckpoint('run-other'))]])
		const harness = createHarness({ metas, checkpoints })

		expect(harness.resumeErroredRun('run-20260101-000009', undefined)).toEqual({ ok: false, error: 'checkpoint_missing' })
		// A corrupt checkpoint document is no checkpoint, same as boot reconciliation treats one.
		const corrupt = new Map([['run-20260101-000009', '{not json']])
		const corruptHarness = createHarness({ metas, checkpoints: corrupt })
		expect(corruptHarness.resumeErroredRun('run-20260101-000009', undefined)).toEqual({ ok: false, error: 'checkpoint_missing' })
		// A checkpoint naming a different run id than its directory is treated as corrupt too.
		const misnamed = new Map([['run-20260101-000009', JSON.stringify(sampleCheckpoint('run-other'))]])
		const misnamedHarness = createHarness({ metas, checkpoints: misnamed })
		expect(misnamedHarness.resumeErroredRun('run-20260101-000009', undefined)).toEqual({ ok: false, error: 'checkpoint_missing' })
	})

	test('rejects a parked checkpoint as checkpoint_missing — the error resume never re-enters a park', () => {
		const metas = new Map([['run-20260101-000009', JSON.stringify(erroredMeta('run-20260101-000009'))]])
		const checkpoints = new Map([['run-20260101-000009', JSON.stringify(parkedCheckpointFor('run-20260101-000009'))]])
		const harness = createHarness({ metas, checkpoints })

		expect(harness.resumeErroredRun('run-20260101-000009', undefined)).toEqual({ ok: false, error: 'checkpoint_missing' })
		expect(harness.submission.activeRunId()).toBeUndefined()
	})

	test('rejects while a run is active, before any queue or checkpoint read', async () => {
		let resolveRun: (meta: RunMeta) => void = () => {}
		const startRun: StartRun = () => new Promise<RunMeta>((resolve) => {
			resolveRun = resolve
		})
		const queue = createQueueStore([erroredItem()])
		const metas = new Map([['run-20260101-000009', JSON.stringify(erroredMeta('run-20260101-000009'))]])
		const readers = createReaders(metas, new Map())
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })
		const resumeErroredRun = createResumeErroredRun({ runSubmission: submission, readRunMetaById: readers.readRunMetaById, readCheckpointById: readers.readCheckpointById, taskQueue: createQueueModule(queue, submission, readers) })

		submission.submit('first')
		expect(resumeErroredRun('run-20260101-000009', undefined)).toEqual({ ok: false, error: 'run_in_progress' })
		expect(queue.snapshot().items.find((entry) => entry.id === 'item-1')?.status).toBe('error')

		resolveRun(sampleMeta('run-1'))
		await submission.awaitActive()
	})
})

describe('createReadParkedAskById', () => {
	test('reads the parked ask from a matching checkpoint and treats every absent or corrupt shape as no ask', () => {
		const readCheckpointById: ReadRunCheckpointById = (runId) => {
			if (runId === 'run-parked') return JSON.stringify(parkedCheckpointFor('run-parked'))
			if (runId === 'run-unparked') {
				const checkpoint: RunCheckpoint = { ...parkedCheckpointFor('run-unparked') }
				delete checkpoint.parkedAsk
				return JSON.stringify(checkpoint)
			}
			if (runId === 'run-corrupt') return '{not json'
			if (runId === 'run-mismatched') return JSON.stringify(parkedCheckpointFor('run-other'))
			return null
		}
		const readParkedAskById = createReadParkedAskById(readCheckpointById)

		expect(readParkedAskById('run-parked')).toEqual({ roleId: 'main-0-1', toolCallId: 'ask_1', question: 'which database?' })
		expect(readParkedAskById('run-unparked')).toBeNull()
		expect(readParkedAskById('run-corrupt')).toBeNull()
		expect(readParkedAskById('run-mismatched')).toBeNull()
		expect(readParkedAskById('run-missing')).toBeNull()
	})
})

describe('createResumeParkedRun', () => {
	function parkedMeta(runId: string): RunMeta {
		return { ...sampleMeta(runId), status: 'needs_clarification', result: { status: 'needs_clarification', summary: 'waiting for an answer to: which database?' } }
	}

	function harness(input: { metas?: Map<string, string>, checkpoints?: Map<string, string> } = {}): { resumeParkedRun: ReturnType<typeof createResumeParkedRun>; submission: RunSubmission; resumeCalls: Array<{ parkedAnswer: unknown, queueTracked: boolean | undefined }> } {
		const metas = input.metas ?? new Map()
		const checkpoints = input.checkpoints ?? new Map()
		const resumeCalls: Array<{ parkedAnswer: unknown, queueTracked: boolean | undefined }> = []
		const resumeRun: ResumeRun = async (checkpoint, options) => {
			resumeCalls.push({ parkedAnswer: options?.parkedAnswer, queueTracked: options?.queueTracked })
			return parkedMeta(checkpoint.runId)
		}
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun: unusedStartRun, resumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })
		const resumeParkedRun = createResumeParkedRun({
			runSubmission: submission,
			readRunMetaById: (runId) => metas.get(runId) ?? null,
			readCheckpointById: (runId) => checkpoints.get(runId) ?? null,
		})
		return { resumeParkedRun, submission, resumeCalls }
	}

	const answer = { question: 'which database?', answer: 'postgres', toolCallId: 'ask_1' }

	test('rejects while a run is active', async () => {
		let resolveRun: (meta: RunMeta) => void = () => {}
		const resumeRun: ResumeRun = () => new Promise<RunMeta>((resolve) => {
			resolveRun = resolve
		})
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun: unusedStartRun, resumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })
		const resumeParkedRun = createResumeParkedRun({ runSubmission: submission, readRunMetaById: () => null, readCheckpointById: () => null })

		submission.resume(parkedCheckpointFor('run-active'))
		expect(resumeParkedRun('run-active', answer)).toEqual({ ok: false, error: 'run_in_progress' })
		resolveRun(sampleMeta('run-active'))
		await submission.awaitActive()
	})

	test('rejects a missing or unparseable meta with checkpoint_missing', () => {
		const missing = harness()
		expect(missing.resumeParkedRun('run-1', answer)).toEqual({ ok: false, error: 'checkpoint_missing' })
		const corrupt = harness({ metas: new Map([['run-1', '{not json']]) })
		expect(corrupt.resumeParkedRun('run-1', answer)).toEqual({ ok: false, error: 'checkpoint_missing' })
	})

	test('rejects a non-needs_clarification meta with not_parked', () => {
		const testHarness = harness({ metas: new Map([['run-1', JSON.stringify(sampleMeta('run-1'))]]) })
		expect(testHarness.resumeParkedRun('run-1', answer)).toEqual({ ok: false, error: 'not_parked' })
	})

	test('rejects a missing, corrupt, or mismatched checkpoint with checkpoint_missing', () => {
		const metas = new Map([['run-1', JSON.stringify(parkedMeta('run-1'))]])
		const missing = harness({ metas })
		expect(missing.resumeParkedRun('run-1', answer)).toEqual({ ok: false, error: 'checkpoint_missing' })
		const corrupt = harness({ metas, checkpoints: new Map([['run-1', '{not json']]) })
		expect(corrupt.resumeParkedRun('run-1', answer)).toEqual({ ok: false, error: 'checkpoint_missing' })
		const mismatched = harness({ metas, checkpoints: new Map([['run-1', JSON.stringify(parkedCheckpointFor('run-other'))]]) })
		expect(mismatched.resumeParkedRun('run-1', answer)).toEqual({ ok: false, error: 'checkpoint_missing' })
	})

	test('rejects an unparked checkpoint or a mismatched question with not_parked', () => {
		const metas = new Map([['run-1', JSON.stringify(parkedMeta('run-1'))]])
		const unparkedCheckpoint = { ...parkedCheckpointFor('run-1') }
		delete unparkedCheckpoint.parkedAsk
		const unparked = harness({ metas, checkpoints: new Map([['run-1', JSON.stringify(unparkedCheckpoint)]]) })
		expect(unparked.resumeParkedRun('run-1', answer)).toEqual({ ok: false, error: 'not_parked' })
		const mismatched = harness({ metas, checkpoints: new Map([['run-1', JSON.stringify(parkedCheckpointFor('run-1'))]]) })
		expect(mismatched.resumeParkedRun('run-1', { ...answer, question: 'something else?' })).toEqual({ ok: false, error: 'not_parked' })
		const staleCall = harness({ metas, checkpoints: new Map([['run-1', JSON.stringify(parkedCheckpointFor('run-1'))]]) })
		expect(staleCall.resumeParkedRun('run-1', { ...answer, toolCallId: 'ask_old' })).toEqual({ ok: false, error: 'not_parked' })
	})

	test('resumes the same run with the answer and the restored queue-tracked mark', async () => {
		const metas = new Map([['run-1', JSON.stringify(parkedMeta('run-1'))]])
		const checkpoints = new Map([['run-1', JSON.stringify(parkedCheckpointFor('run-1'))]])
		const testHarness = harness({ metas, checkpoints })

		expect(testHarness.resumeParkedRun('run-1', answer)).toEqual({ ok: true, runId: 'run-1' })
		expect(testHarness.submission.activeRunId()).toBe('run-1')
		expect(testHarness.resumeCalls).toEqual([{ parkedAnswer: answer, queueTracked: true }])
		await testHarness.submission.awaitActive()
	})
})

describe('createTerminateParkedRun', () => {
	function harness(input: { metas?: Map<string, string> } = {}): {
		terminateParkedRun: ReturnType<typeof createTerminateParkedRun>
		metas: Map<string, string>
		deleted: string[]
		logs: Array<{ runId: string; event: LogEvent }>
	} {
		const metas = new Map(input.metas ?? [])
		const deleted: string[] = []
		const logs: Array<{ runId: string; event: LogEvent }> = []
		const terminateParkedRun = createTerminateParkedRun({
			readRunMetaById: (runId) => metas.get(runId) ?? null,
			writeMetaFor: (runId) => (meta) => {
				metas.set(runId, JSON.stringify(meta))
			},
			deleteCheckpointFor: (runId) => () => {
				deleted.push(runId)
			},
			appendLogFor: (runId) => (event) => {
				logs.push({ runId, event })
			},
		})
		return { terminateParkedRun, metas, deleted, logs }
	}

	function parkedMeta(runId: string): RunMeta {
		return {
			runId,
			guildPath: 'guild',
			benchmarkPath: 'bench',
			task: 'do it',
			effort: 'thorough',
			involvement: 'collaborative',
			logLevel: 'standard',
			continuesFrom: 'run-20251231-000000',
			status: 'needs_clarification',
			startTime: '2026-01-01T00:00:00.000Z',
			endTime: '2026-01-01T00:01:00.000Z',
			result: { status: 'needs_clarification', summary: 'waiting for an answer to: which database?' },
		}
	}

	test('marks a parked run interrupted, preserves its identity, deletes the checkpoint, and logs the operator action', () => {
		const runId = 'run-20260101-000000'
		const testHarness = harness({ metas: new Map([[runId, JSON.stringify(parkedMeta(runId))]]) })

		expect(testHarness.terminateParkedRun(runId)).toEqual({ ok: true, runId })
		expect(testHarness.deleted).toEqual([runId])
		expect(testHarness.logs.length).toBe(1)
		const log = testHarness.logs[0]
		if (log === undefined) throw new Error('expected a termination log event')
		expect(log.runId).toBe(runId)
		expect(log.event.type).toBe('run_terminated')
		expect(log.event.payload).toEqual({ reason: 'operator', message: 'Terminated by the operator while waiting for an answer.' })

		const metaText = testHarness.metas.get(runId)
		if (metaText === undefined) throw new Error('expected the terminated meta')
		const parsed: unknown = JSON.parse(metaText)
		if (!isRunMeta(parsed)) throw new Error('expected a valid run meta')
		expect(parsed.status).toBe('interrupted')
		expect(parsed.runId).toBe(runId)
		expect(parsed.guildPath).toBe('guild')
		expect(parsed.benchmarkPath).toBe('bench')
		expect(parsed.task).toBe('do it')
		expect(parsed.effort).toBe('thorough')
		expect(parsed.involvement).toBe('collaborative')
		expect(parsed.logLevel).toBe('standard')
		expect(parsed.continuesFrom).toBe('run-20251231-000000')
		expect(parsed.startTime).toBe('2026-01-01T00:00:00.000Z')
		// Termination preserves the parked end time; the log event carries when the operator acted.
		expect(parsed.endTime).toBe('2026-01-01T00:01:00.000Z')
		expect(log.event.timestamp).not.toBe(parsed.endTime)
		expect(parsed.result).toBeUndefined()
		expect(parsed.error).toEqual({ kind: 'interrupted', message: 'The operator terminated this run while it was waiting for an answer.' })
	})

	test('an already-interrupted meta deletes the checkpoint and appends the audit event idempotently, reporting not_parked', () => {
		const runId = 'run-20260101-000000'
		const interrupted = { ...parkedMeta(runId), status: 'interrupted' as const, error: { kind: 'interrupted' as const, message: 'already terminated' } }
		const testHarness = harness({ metas: new Map([[runId, JSON.stringify(interrupted)]]) })

		expect(testHarness.terminateParkedRun(runId)).toEqual({ ok: false, error: 'not_parked' })
		expect(testHarness.deleted).toEqual([runId])
		const log = testHarness.logs[0]
		if (log === undefined) throw new Error('expected a termination log event')
		expect(log.runId).toBe(runId)
		expect(log.event.type).toBe('run_terminated')
		expect(log.event.payload).toEqual({ reason: 'operator', message: 'Terminated by the operator while waiting for an answer.' })
		expect(testHarness.metas.get(runId)).toBe(JSON.stringify(interrupted))
	})

	test('rejects a missing or unparseable meta as not_found without touching anything', () => {
		const missing = harness()
		expect(missing.terminateParkedRun('run-1')).toEqual({ ok: false, error: 'not_found' })

		const corrupt = harness({ metas: new Map([['run-1', '{not json']]) })
		expect(corrupt.terminateParkedRun('run-1')).toEqual({ ok: false, error: 'not_found' })
		expect(corrupt.deleted).toEqual([])
		expect(corrupt.logs).toEqual([])
	})

	test('rejects success and error metas as not_parked without deleting their checkpoints', () => {
		for (const status of ['success', 'error'] as const) {
			const original = JSON.stringify({ ...sampleMeta('run-1'), status })
			const testHarness = harness({ metas: new Map([['run-1', original]]) })
			expect(testHarness.terminateParkedRun('run-1')).toEqual({ ok: false, error: 'not_parked' })
			expect(testHarness.metas.get('run-1')).toBe(original)
			expect(testHarness.deleted).toEqual([])
			expect(testHarness.logs).toEqual([])
		}
	})
})
