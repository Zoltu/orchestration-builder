import type { RunBaseTracker } from '../base-state.js'
import type { ToolHandler } from './tool-dispatch.js'
import { ensureOrchestrationGitExcluded, nodeGitExcludeFilesystem } from '../git-exclude.js'
import { createFetchUrl, type Fetcher } from './fetch-url.js'
import { createGitTools } from './git.js'
import { createGlobFiles, nodeGlobFilesystem } from './glob-files.js'
import { createKagiClient } from './kagi.js'
import { createListDirectory } from './list-directory.js'
import { createReadFile } from './read-file.js'
import { createReadFilePartial } from './read-file-partial.js'
import { createRepoMap } from './repo-map.js'
import { createRunShell } from './run-shell.js'
import { createSearchText } from './search-text.js'
import { createTest } from './test.js'
import type { SubprocessRunner } from '../subprocess.js'
import { createTypecheck } from './typecheck.js'
import { createWebSearch } from './web-search.js'
import { createWriteFile } from './write-file.js'

export interface NativeToolsConfig {
	workspaceRoot: string
	defaultToolTimeoutSeconds: number
	fetcher?: Fetcher
	kagiApiKey?: string
	subprocessRunner: SubprocessRunner
	// The run-scoped base commit state, shared with the executor so the git diff tools and git_set_base see the same base.
	baseTracker: RunBaseTracker
}

export function createNativeToolHandlers(config: NativeToolsConfig): Record<string, ToolHandler> {
	const list = createListDirectory(config.workspaceRoot)
	const glob = createGlobFiles(config.workspaceRoot, nodeGlobFilesystem)
	const read = createReadFile(config.workspaceRoot)
	const readPartial = createReadFilePartial(config.workspaceRoot)
	const search = createSearchText(config.workspaceRoot)
	const write = createWriteFile(config.workspaceRoot)
	const repoMap = createRepoMap(config.workspaceRoot)
	const timeoutMs = config.defaultToolTimeoutSeconds * 1000
	// The Guild declares web_search and the kagi fetch backend unconditionally (the tool set is static); without a key the handlers stay registered and report themselves unavailable.
	const kagiClient = config.kagiApiKey === undefined ? undefined : createKagiClient(config.kagiApiKey)
	const fetch = createFetchUrl(timeoutMs, { fetcher: config.fetcher, kagiExtract: kagiClient?.extract })
	const webSearch = createWebSearch({ search: kagiClient?.search, timeoutMs })
	const subprocessRunner = config.subprocessRunner
	const runShell = createRunShell(config.workspaceRoot, config.defaultToolTimeoutSeconds, subprocessRunner)
	const test = createTest(config.workspaceRoot, config.defaultToolTimeoutSeconds, subprocessRunner)
	const typecheck = createTypecheck(config.workspaceRoot, config.defaultToolTimeoutSeconds, subprocessRunner)
	// The tool factory has no run-scoped logger, so a failed best-effort re-ensure is reported to the console the same way startup's excludeOrchestrationFromGit reports it.
	const ensureOrchestrationExcluded = () => {
		const result = ensureOrchestrationGitExcluded(config.workspaceRoot, nodeGitExcludeFilesystem)
		if (!result.ok) console.log(`Could not exclude .orchestration from the workspace's git repository: ${result.reason}`)
	}
	const git = createGitTools({ workspaceRoot: config.workspaceRoot, defaultToolTimeoutSeconds: config.defaultToolTimeoutSeconds, runner: subprocessRunner, ensureOrchestrationExcluded, baseTracker: config.baseTracker })
	return {
		list_directory: list,
		glob_files: glob,
		read_file: read,
		read_file_partial: readPartial,
		search_text: search,
		write_file: write,
		repo_map: repoMap,
		fetch_url: fetch,
		web_search: webSearch,
		run_shell: runShell,
		test,
		typecheck,
		...git,
	}
}
