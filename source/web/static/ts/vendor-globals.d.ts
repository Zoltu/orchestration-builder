// Ambient Window augmentation for the vendored script globals the converted client modules read (window.showdown, window.hljs): the checker's DOM lib knows neither library, so the minimal surface the readers touch is declared here. The declarations only satisfy the type checker: every read stays behind its runtime guard (demo.html loads neither script, so both globals are genuinely absent there) — types never validate.

interface Window {
	// showdown's UMD bundle sets this on load; the reader falls back to plain text when absent.
	showdown?: { Converter: new (options: { tables?: boolean; strikethrough?: boolean; noHeaderId?: boolean }) => { makeHtml(text: string): unknown } }
	// highlight.js sets this on load; `getLanguage` is checked with typeof at the read site, so it stays optional here too.
	hljs?: {
		highlight(code: string, options: { language: string }): { value: string }
		highlightAuto(code: string): { value: string }
		getLanguage?(language: string): unknown
	}
}
