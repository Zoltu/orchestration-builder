import { describe, expect, test } from 'bun:test'
import { renderIndexHtmlWithPageTitle } from './page-title.js'

const INDEX_HTML = [
	'<!DOCTYPE html>',
	'<html lang="en">',
	'\t<head>',
	'\t\t<title>Adaptive Orchestrator</title>',
	'\t</head>',
	'\t<body><div id="app"></div></body>',
	'</html>',
].join('\n')

describe('renderIndexHtmlWithPageTitle', () => {
	test('replaces exactly the title element text and leaves every other byte unchanged', () => {
		const result = renderIndexHtmlWithPageTitle(INDEX_HTML, 'Mission Control')
		expect(result).toBe(INDEX_HTML.replace('<title>Adaptive Orchestrator</title>', '<title>Mission Control</title>'))
	})

	test('escapes the three markup-significant characters in the title', () => {
		const result = renderIndexHtmlWithPageTitle(INDEX_HTML, 'a & b < c > d')
		expect(result).toContain('<title>a &amp; b &lt; c &gt; d</title>')
	})

	test('a markup-shaped title cannot break out of the title element', () => {
		const result = renderIndexHtmlWithPageTitle(INDEX_HTML, '</title><script>alert(1)</script>')
		expect(result).toContain('<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>')
		expect(result).not.toContain('<script>alert(1)</script>')
	})

	test('inserts a title containing replacement-pattern sequences literally', () => {
		const result = renderIndexHtmlWithPageTitle(INDEX_HTML, '$& and $$')
		expect(result).toContain('<title>$&amp; and $$</title>')
	})

	test('returns the document unchanged when it has no title element', () => {
		const html = '<!DOCTYPE html><html><body><h1>not the app shell</h1></body></html>'
		expect(renderIndexHtmlWithPageTitle(html, 'Mission Control')).toBe(html)
	})

	test('replaces only the first title element and tolerates attributes on the opening tag', () => {
		const html = '<html><head><TITLE lang="en">first</TITLE><title>second</title></head></html>'
		expect(renderIndexHtmlWithPageTitle(html, 'Mission Control')).toBe('<html><head><title>Mission Control</title><title>second</title></head></html>')
	})
})
