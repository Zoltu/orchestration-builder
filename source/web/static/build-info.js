// Top-bar build identifier for the web client.
//
// `GET /api/config` carries the serving image's build identifier (`build.builtAt` always, `build.sha` when the build passed one — see the Dockerfile's BUILD_SHA step). A process without a baked build-info.json (a source checkout) serves `build: null`, and the top bar then renders nothing. Plain-JS sibling of the view modules (JSDoc typedefs carry the shapes the TS tests assert against, mirroring the labels.js convention); imports nothing.

/**
 * @typedef {Object} BuildInfo
 * @property {string} [sha] the commit the image was built from, absent when the build passed none
 * @property {string} builtAt UTC timestamp baked at image build time
 */

/**
 * Reads the `build` field off a /api/config body, tolerating absent and malformed payloads: anything without a non-empty `builtAt` yields null, an empty or non-string `sha` reads as "the build had none", and unknown sibling fields are dropped rather than passed into state.
 *
 * @param {unknown} config the parsed /api/config body
 * @returns {BuildInfo | null}
 */
export function buildInfoFromConfig(config) {
	if (config === null || typeof config !== 'object') return null
	const build = config.build
	if (build === null || typeof build !== 'object') return null
	if (typeof build.builtAt !== 'string' || build.builtAt === '') return null
	const label = { builtAt: build.builtAt }
	if (typeof build.sha === 'string' && build.sha !== '') label.sha = build.sha
	return label
}

/**
 * The built date shown in the version label: the UTC calendar day the build timestamp denotes, or the raw string when it does not parse as an instant — the label stays honest to whatever the build baked rather than showing nothing.
 *
 * @param {string} builtAt
 * @returns {string}
 */
function formatBuildDate(builtAt) {
	const parsed = Date.parse(builtAt)
	if (Number.isNaN(parsed)) return builtAt
	return new Date(parsed).toISOString().slice(0, 10)
}

/**
 * Formats the top-bar version label: the sha's 7-character short form plus the built date (e.g. `9f3a2b7 · 2026-09-25`), or the built date alone when the build carried no sha. A null or malformed build yields the empty string so the caller skips rendering the label.
 *
 * @param {BuildInfo | null} build
 * @returns {string}
 */
export function formatBuildLabel(build) {
	if (build === null || typeof build !== 'object') return ''
	if (typeof build.builtAt !== 'string' || build.builtAt === '') return ''
	const sha = typeof build.sha === 'string' && build.sha !== '' ? `${build.sha.slice(0, 7)} · ` : ''
	return `${sha}${formatBuildDate(build.builtAt)}`
}
