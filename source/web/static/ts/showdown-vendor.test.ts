import { describe, expect, test } from 'bun:test'
import showdown from '../vendor/showdown.js'

describe('vendored showdown patch', () => {
	test('expands more than ten inline elements inside a raw HTML container', () => {
		const converter = new showdown.Converter({ tables: true, strikethrough: true, noHeaderId: true })
		const markdown = `<span class="test">${'_a_, '.repeat(19)}</span>`
		const html = converter.makeHtml(markdown)
		expect(html).not.toContain('¨C')
		expect(html.match(/<em>/g)?.length).toBe(19)
	})
})
