// Substitutes the operator-configured browser tab title into the served index.html at response time, so the configured title is present in the initial HTML and never flashes the default. Only the `<title>` element's text is rewritten; every other byte of the document passes through unchanged, and a document with no `<title>` element is returned as-is — the substitution is an upgrade applied to the app shell, never a corruption of some other HTML body.

export function renderIndexHtmlWithPageTitle(html: string, title: string): string {
	// Attributes on the opening tag are tolerated (a document may carry `<title lang="en">`), the match is case-insensitive per HTML's parsing, and only the first title element is rewritten.
	const titleElement = /<title(?:\s[^>]*)?>[\s\S]*?<\/title>/i
	if (!titleElement.test(html)) return html
	const escapedTitle = escapeTitleText(title)
	// The replacement is built through a replacer function because a title containing `$` sequences (`$&`, `$$`) would otherwise be expanded by String.replace as replacement patterns instead of appearing literally.
	return html.replace(titleElement, () => `<title>${escapedTitle}</title>`)
}

// The title element's contents parse as text, so only the three characters that could start or close markup inside it need escaping; `&` goes first so the replacements' own ampersands are not double-escaped.
function escapeTitleText(title: string): string {
	return title.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
