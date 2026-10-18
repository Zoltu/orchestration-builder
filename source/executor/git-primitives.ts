// The hash of git's canonical empty tree, the comparison base for a repository whose HEAD is unborn: diffing against it shows every staged/committed path as added without requiring a commit to exist.
export const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

// The fixed prefix silences the pager and repository hooks (including the fsmonitor hook) and pins identity/signing via `-c`, but it cannot stop a workspace repo's configured clean filter from running during `git add`, so staging a filtered path may still execute a workspace-chosen program.
export function gitPrefix(): readonly string[] {
	return ['git', '--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'user.name=Adaptive Orchestrator', '-c', 'user.email=orchestrator@localhost', '-c', 'commit.gpgsign=false']
}
