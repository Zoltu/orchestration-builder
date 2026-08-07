import type { ToolHandler } from './tool-dispatch.js'
import { createFetchUrl, type Fetcher } from './tools/fetch-url.js'
import { createGlobFiles } from './tools/glob-files.js'
import { createKagiClient } from './tools/kagi.js'
import { createListDirectory } from './tools/list-directory.js'
import { createReadFile } from './tools/read-file.js'
import { createReadFilePartial } from './tools/read-file-partial.js'
import { createRepoMap } from './tools/repo-map.js'
import { createRunShell } from './tools/run-shell.js'
import { createSearchText } from './tools/search-text.js'
import { createTest } from './tools/test.js'
import { createBunSubprocessRunner } from './tools/subprocess-tool.js'
import { createTypecheck } from './tools/typecheck.js'
import { createWebSearch } from './tools/web-search.js'
import { createWriteFile } from './tools/write-file.js'

export interface NativeToolsConfig {
	workspaceRoot: string
	defaultToolTimeoutSeconds: number
	fetcher?: Fetcher
	kagiApiKey?: string
}

export function createToolHandlers(config: NativeToolsConfig): Record<string, ToolHandler> {
	const list = createListDirectory(config.workspaceRoot)
	const glob = createGlobFiles(config.workspaceRoot)
	const read = createReadFile(config.workspaceRoot)
	const readPartial = createReadFilePartial(config.workspaceRoot)
	const search = createSearchText(config.workspaceRoot)
	const write = createWriteFile(config.workspaceRoot)
	const repoMap = createRepoMap(config.workspaceRoot)
	const timeoutMs = config.defaultToolTimeoutSeconds * 1000
	// The Guild declares web_search and the kagi fetch backend unconditionally (the tool set is
	// static); without a key the handlers stay registered and report themselves unavailable.
	const kagiClient = config.kagiApiKey === undefined ? undefined : createKagiClient(config.kagiApiKey)
	const fetch = createFetchUrl(timeoutMs, { fetcher: config.fetcher, kagiExtract: kagiClient?.extract })
	const webSearch = createWebSearch({ search: kagiClient?.search, timeoutMs })
	const subprocessRunner = createBunSubprocessRunner()
	const runShell = createRunShell(config.workspaceRoot, config.defaultToolTimeoutSeconds, subprocessRunner)
	const test = createTest(config.workspaceRoot, config.defaultToolTimeoutSeconds, subprocessRunner)
	const typecheck = createTypecheck(config.workspaceRoot, config.defaultToolTimeoutSeconds, subprocessRunner)
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
	}
}