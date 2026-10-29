import { isRunIdShape } from '../executor/run-id.js'
import type { TaskLineage, TaskLineageTruncatedReason } from './model.js'
import type { RunThreadFacts } from './derive.js'

export interface TaskLineageWalk {
	runs: RunThreadFacts[]
	lineage: TaskLineage
}

function parentOf(facts: RunThreadFacts): string | null {
	const declaredParent = facts.meta !== null ? facts.meta.continuesFrom : undefined
	if (declaredParent !== undefined) return declaredParent
	return facts.queuedContinuesFrom
}

export function deriveTaskLineage(current: RunThreadFacts, lookupRun: (runId: string) => RunThreadFacts | null, maxRuns: number): TaskLineageWalk {
	if (!Number.isInteger(maxRuns) || maxRuns < 1) throw new Error(`deriveTaskLineage: maxRuns must be a positive integer, received ${maxRuns}`)
	const chain: RunThreadFacts[] = [current]
	const visited = new Set<string>([current.runId])
	const immediateParentRunId = parentOf(current)
	let parentRunId = immediateParentRunId
	let missingParentRunId: string | null = null
	let truncatedReason: TaskLineageTruncatedReason | null = null

	while (parentRunId !== null) {
		if (!isRunIdShape(parentRunId)) {
			truncatedReason = 'malformed_parent'
			missingParentRunId = parentRunId
			break
		}
		if (visited.has(parentRunId)) {
			truncatedReason = 'cycle'
			break
		}
		if (chain.length >= maxRuns) {
			truncatedReason = 'depth'
			break
		}
		const parent = lookupRun(parentRunId)
		if (parent === null || parent.runId !== parentRunId) {
			truncatedReason = 'missing_parent'
			missingParentRunId = parentRunId
			break
		}
		chain.push(parent)
		visited.add(parent.runId)
		parentRunId = parentOf(parent)
	}

	const runs = [...chain].reverse()
	const root = runs[0]
	if (root === undefined) throw new Error(`deriveTaskLineage: chain for ${current.runId} is empty`)
	let resumeCount = 0
	let resumeCountComplete = true
	for (const run of runs) {
		resumeCount += run.resumeCount
		if (!run.resumeCountComplete) resumeCountComplete = false
	}
	const continuationCount = runs.length - 1
	if (truncatedReason !== null) resumeCountComplete = false
	return {
		runs,
		lineage: {
			rootRunId: root.runId,
			parentRunId: immediateParentRunId,
			continuationCount,
			resumeCount,
			resumeCountComplete,
			depth: continuationCount,
			complete: truncatedReason === null,
			missingParentRunId,
			truncatedReason,
		},
	}
}
