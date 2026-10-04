import { describe, expect, test } from 'bun:test'
import type { RunCheckpoint } from './checkpoint.ts'
import { DEFAULT_LOG_LEVEL } from './log-level.ts'
import type { EffortLevel, LogLevel, RunContinuation, RunMeta } from './types.js'
import type { ReadProjectSettings, RunDirectoryExists } from './persistence.ts'
import { DEFAULT_EFFORT } from './effort.ts'
import { createRunSubmission, type ResumeRun, type RunSubmission, type StartRun } from './run-submission.ts'
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
		const startRun: StartRun = async (_runId, _task, _effort, _logLevel, _continuation, queueTracked) => {
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
		const checkpoint = sampleCheckpoint('run-9')
		const resumeRun: ResumeRun = async () => sampleMeta('run-9')
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun: unusedStartRun, resumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })

		submission.resume(checkpoint)

		expect(submission.activeRunId()).toBe('run-9')
		expect(submission.lastRunId()).toBe('run-9')
		expect(await submission.awaitActive()).toEqual(sampleMeta('run-9'))
		expect(submission.activeRunId()).toBeUndefined()
	})

	test('submit rejects while a resumed run is active', async () => {
		let resolveResume: (meta: RunMeta) => void = () => {}
		const resumeRun: ResumeRun = () => new Promise<RunMeta>((resolve) => {
			resolveResume = resolve
		})
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun: unusedStartRun, resumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })

		submission.resume(sampleCheckpoint('run-9'))

		expect(submission.submit('new task')).toEqual({ ok: false, error: 'run_in_progress' })
		resolveResume(sampleMeta('run-9'))
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

		expect(() => submission.resume(sampleCheckpoint('run-9'))).toThrow()
		resolveRun(sampleMeta('run-1'))
		await submission.awaitActive()
	})

	test('a resumeRun rejection clears the active slot and resolves awaitFatalError', async () => {
		const resumeRun: ResumeRun = () => Promise.reject(new Error('checkpoint unreadable'))
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun: unusedStartRun, resumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })

		submission.resume(sampleCheckpoint('run-9'))

		const fatal = await submission.awaitFatalError()
		expect(fatal.message).toBe('checkpoint unreadable')
		expect(await submission.awaitActive()).toBeUndefined()
		expect(submission.activeRunId()).toBeUndefined()
		expect(submission.lastRunId()).toBe('run-9')
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
		const resumeRun: ResumeRun = async () => sampleMeta('run-9')
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

		submission.resume(resumeCheckpoint('run-9'))
		await submission.awaitActive()

		expect(settled).toEqual([sampleMeta('run-9')])
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
		const startRun: StartRun = async (_runId, _task, _effort, _logLevel, continuation) => {
			captured.push(continuation)
			return sampleMeta('run-1')
		}
		return { startRun, captured }
	}

	test('submit threads the continuation through to startRun', async () => {
		const { startRun, captured } = captureContinuation()
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })
		const continuation = { runId: 'run-20260101-000000', task: 'prior task', summary: 'prior summary' }

		submission.submit('do it', undefined, undefined, continuation)
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
		const startRun: StartRun = async (_runId, _task, _effort, logLevel) => {
			captured.push(logLevel)
			return sampleMeta('run-1')
		}
		return { startRun, captured }
	}

	test('a per-run override is threaded into startRun', async () => {
		const { startRun, captured } = captureLogLevel()
		const submission = createRunSubmission({ onRunSettled: settleNothing, startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, runDirectoryExists: emptyRunsDir })

		submission.submit('do it', undefined, 'standard')
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

		submission.submit('do it', undefined, 'full')
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

		submission.submit('do it', undefined, 'full')
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
