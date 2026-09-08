import { describe, expect, test } from 'bun:test'
import type { RunCheckpoint } from './checkpoint.ts'
import { DEFAULT_LOG_LEVEL } from './log-level.ts'
import type { EffortLevel, LogLevel, RunContinuation, RunMeta } from './types.js'
import type { ReadProjectSettings } from './persistence.ts'
import { DEFAULT_EFFORT } from './effort.ts'
import { createRunSubmission, type ResumeRun, type RunSubmission, type StartRun } from './run-submission.ts'
import { defined } from './test-fixtures.ts'

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
		const submission = createRunSubmission({ startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings })

		const result = submission.submit('do it')
		expect(result).toEqual({ ok: true, runId: 'run-1' })
		expect(startedRunId).toBe('run-1')
		expect(submission.activeRunId()).toBe('run-1')

		await submission.awaitActive()
	})

	test('submit rejects a second task while a run is active', async () => {
		let resolveFirst: (meta: RunMeta) => void = () => {}
		const startRun: StartRun = () => new Promise<RunMeta>((resolve) => {
			resolveFirst = resolve
		})
		const ids = ['run-1', 'run-2']
		let next = 0
		const submission = createRunSubmission({ startRun, resumeRun: unusedResumeRun, generateRunId: () => defined(ids[next++], 'run id'), readProjectSettings: emptySettings })

		const first = submission.submit('first')
		expect(first).toEqual({ ok: true, runId: 'run-1' })

		const second = submission.submit('second')
		expect(second).toEqual({ ok: false, error: 'run_in_progress' })
		expect(submission.activeRunId()).toBe('run-1')

		resolveFirst(sampleMeta('run-1'))
		await submission.awaitActive()
	})

	test('activeRunId clears when the run completes, allowing a new submit', async () => {
		let resolveRun: (meta: RunMeta) => void = () => {}
		const startRun: StartRun = () => new Promise<RunMeta>((resolve) => {
			resolveRun = resolve
		})
		const ids = ['run-1', 'run-2']
		let next = 0
		const submission = createRunSubmission({ startRun, resumeRun: unusedResumeRun, generateRunId: () => defined(ids[next++], 'run id'), readProjectSettings: emptySettings })

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
		const submission = createRunSubmission({ startRun, resumeRun: unusedResumeRun, generateRunId: () => defined(ids[next++], 'run id'), readProjectSettings: emptySettings })

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
		const submission = createRunSubmission({ startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings })

		submission.submit('do it')
		expect(await submission.awaitActive()).toEqual(meta)
	})

	test('awaitActive resolves with undefined when no run has been started', async () => {
		const startRun: StartRun = async () => sampleMeta('run-1')
		const submission = createRunSubmission({ startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings })

		expect(await submission.awaitActive()).toBeUndefined()
	})

	test('awaitActive still returns the completed run meta after it has already been awaited', async () => {
		const meta = sampleMeta('run-1')
		const startRun: StartRun = async () => meta
		const submission = createRunSubmission({ startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings })

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
		const submission = createRunSubmission({ startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings })

		submission.submit('do it')

		const fatal = await submission.awaitFatalError()
		expect(fatal.message).toBe('disk full')

		expect(await submission.awaitActive()).toBeUndefined()
		expect(submission.activeRunId()).toBeUndefined()
		expect(submission.lastRunId()).toBe('run-1')
	})

	test('a non-Error rejection is normalized to an Error in awaitFatalError', async () => {
		const startRun: StartRun = () => Promise.reject('bare string rejection')
		const submission = createRunSubmission({ startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings })

		submission.submit('do it')

		const fatal = await submission.awaitFatalError()
		expect(fatal).toBeInstanceOf(Error)
		expect(fatal.message).toBe('bare string rejection')

		await submission.awaitActive()
	})

	test('a successful run never resolves awaitFatalError', async () => {
		const startRun: StartRun = async () => sampleMeta('run-1')
		const submission = createRunSubmission({ startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings })

		submission.submit('do it')
		await submission.awaitActive()

		let resolved = false
		submission.awaitFatalError().then(() => { resolved = true })
		await new Promise((resolve) => setTimeout(resolve, 10))
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
		const submission = createRunSubmission({ startRun: unusedStartRun, resumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings })

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
		const submission = createRunSubmission({ startRun: unusedStartRun, resumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings })

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
		const submission = createRunSubmission({ startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings })

		submission.submit('do it')

		expect(() => submission.resume(sampleCheckpoint('run-9'))).toThrow()
		resolveRun(sampleMeta('run-1'))
		await submission.awaitActive()
	})

	test('a resumeRun rejection clears the active slot and resolves awaitFatalError', async () => {
		const resumeRun: ResumeRun = () => Promise.reject(new Error('checkpoint unreadable'))
		const submission = createRunSubmission({ startRun: unusedStartRun, resumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings })

		submission.resume(sampleCheckpoint('run-9'))

		const fatal = await submission.awaitFatalError()
		expect(fatal.message).toBe('checkpoint unreadable')
		expect(await submission.awaitActive()).toBeUndefined()
		expect(submission.activeRunId()).toBeUndefined()
		expect(submission.lastRunId()).toBe('run-9')
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
		const submission = createRunSubmission({ startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings })

		submission.submit('do it', 'thorough')
		await submission.awaitActive()
		expect(captured).toEqual(['thorough'])
	})

	test('the project default is applied when no override is given', async () => {
		const { startRun, captured } = captureEffort()
		const projectSettings: ReadProjectSettings = () => ({ effort: 'thorough' })
		const submission = createRunSubmission({ startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: projectSettings })

		submission.submit('do it')
		await submission.awaitActive()
		expect(captured).toEqual(['thorough'])
	})

	test('a per-run override wins over the project default', async () => {
		const { startRun, captured } = captureEffort()
		const projectSettings: ReadProjectSettings = () => ({ effort: 'thorough' })
		const submission = createRunSubmission({ startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: projectSettings })

		submission.submit('do it', 'quick')
		await submission.awaitActive()
		expect(captured).toEqual(['quick'])
	})

	test('DEFAULT_EFFORT applies when neither override nor project setting fixes the effort', async () => {
		const { startRun, captured } = captureEffort()
		const submission = createRunSubmission({ startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings })

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
		const submission = createRunSubmission({ startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings })
		const continuation = { runId: 'run-20260101-000000', task: 'prior task', summary: 'prior summary' }

		submission.submit('do it', undefined, undefined, continuation)
		await submission.awaitActive()
		expect(captured).toEqual([continuation])
	})

	test('submit threads no continuation when none is given', async () => {
		const { startRun, captured } = captureContinuation()
		const submission = createRunSubmission({ startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings })

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
		const submission = createRunSubmission({ startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings })

		submission.submit('do it', undefined, 'standard')
		await submission.awaitActive()
		expect(captured).toEqual(['standard'])
	})

	test('the project default is applied when no override is given', async () => {
		const { startRun, captured } = captureLogLevel()
		const projectSettings: ReadProjectSettings = () => ({ logLevel: 'standard' })
		const submission = createRunSubmission({ startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: projectSettings })

		submission.submit('do it')
		await submission.awaitActive()
		expect(captured).toEqual(['standard'])
	})

	test('a per-run override wins over the project default', async () => {
		const { startRun, captured } = captureLogLevel()
		const projectSettings: ReadProjectSettings = () => ({ logLevel: 'standard' })
		const submission = createRunSubmission({ startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: projectSettings })

		submission.submit('do it', undefined, 'full')
		await submission.awaitActive()
		expect(captured).toEqual(['full'])
	})

	test('the deployment default applies when neither override nor project setting fixes the level', async () => {
		const { startRun, captured } = captureLogLevel()
		const submission = createRunSubmission({ startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, deploymentLogLevel: 'standard' })

		submission.submit('do it')
		await submission.awaitActive()
		expect(captured).toEqual(['standard'])
	})

	test('the project setting wins over the deployment default', async () => {
		const { startRun, captured } = captureLogLevel()
		const projectSettings: ReadProjectSettings = () => ({ logLevel: 'full' })
		const submission = createRunSubmission({ startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: projectSettings, deploymentLogLevel: 'standard' })

		submission.submit('do it')
		await submission.awaitActive()
		expect(captured).toEqual(['full'])
	})

	test('a per-run override wins over the deployment default', async () => {
		const { startRun, captured } = captureLogLevel()
		const submission = createRunSubmission({ startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings, deploymentLogLevel: 'standard' })

		submission.submit('do it', undefined, 'full')
		await submission.awaitActive()
		expect(captured).toEqual(['full'])
	})

	test('DEFAULT_LOG_LEVEL applies when nothing in the chain fixes the level', async () => {
		const { startRun, captured } = captureLogLevel()
		const submission = createRunSubmission({ startRun, resumeRun: unusedResumeRun, generateRunId: () => 'run-1', readProjectSettings: emptySettings })

		submission.submit('do it')
		await submission.awaitActive()
		expect(captured).toEqual([DEFAULT_LOG_LEVEL])
	})
})
