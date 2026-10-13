// The run-scoped base commit hash that defines the change set reviewers inspect: it defaults to HEAD at task start (or the git empty tree when HEAD is unborn) and the orchestrator may move it during the run with git_set_base. It rides the checkpoint like writeCapableStarted so a restart does not lose the base the run is diffing against.
export interface RunBaseTracker {
	baseHash?: string
}

export function createRunBaseTracker(baseHash?: string): RunBaseTracker {
	return {
		...(baseHash !== undefined ? { baseHash } : {}),
	}
}
