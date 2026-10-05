// Top-bar build identifier for the web client.
//
// `GET /api/config` carries the serving image's build identifier (`build.builtAt` always, `build.sha` when the build passed one — see the Dockerfile's BUILD_SHA step). A process without a baked build-info.json (a source checkout) serves `build: null`, and the top bar then renders nothing. Browser-side twin of source/web/build-info.ts: the same shape, read off the /api/config body instead of the baked file; imports nothing but the shared record guard.

import { isObject } from './guards.js'

export interface BuildInfo {
	// Present only when the build passed a non-empty sha; the Dockerfile bakes an empty string when it did not.
	sha?: string
	builtAt: string
}

// Reads the `build` field off a /api/config body, tolerating absent and malformed payloads: anything without a non-empty `builtAt` yields null, an empty or non-string `sha` reads as "the build had none", and unknown sibling fields are dropped rather than passed into state.
export function buildInfoFromConfig(config: unknown): BuildInfo | null {
	if (!isObject(config)) return null
	const build = config.build
	if (!isObject(build)) return null
	if (typeof build.builtAt !== 'string' || build.builtAt === '') return null
	const label: BuildInfo = { builtAt: build.builtAt }
	if (typeof build.sha === 'string' && build.sha !== '') label.sha = build.sha
	return label
}

// The built date shown in the version label: the UTC calendar day the build timestamp denotes, or the raw string when it does not parse as an instant — the label stays honest to whatever the build baked rather than showing nothing.
function formatBuildDate(builtAt: string): string {
	const parsed = Date.parse(builtAt)
	if (Number.isNaN(parsed)) return builtAt
	return new Date(parsed).toISOString().slice(0, 10)
}

// Formats the top-bar version label: the sha's 7-character short form plus the built date (e.g. `9f3a2b7 · 2026-09-25`), or the built date alone when the build carried no sha. A null or malformed build yields the empty string so the caller skips rendering the label. The field checks stay runtime guards rather than trusting the types: the payload arrives over `/api/config`, and a type annotation never rejects a malformed response at that boundary.
export function formatBuildLabel(build: BuildInfo | null): string {
	if (build === null || typeof build.builtAt !== 'string' || build.builtAt === '') return ''
	const sha = typeof build.sha === 'string' && build.sha !== '' ? `${build.sha.slice(0, 7)} · ` : ''
	return `${sha}${formatBuildDate(build.builtAt)}`
}
