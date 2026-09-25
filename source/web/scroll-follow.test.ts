import { describe, expect, test } from 'bun:test'
import { createScrollFollower, isAtBottom, pinnedScrollTop } from './static/scroll-follow.js'

// Fake scroll container: plain fields plus a recorded scroll listener, no real DOM. follow() drives scrollTop through the same property a browser would clamp, so the fake needs no scrollTo.
class FakeScrollElement {
	scrollTop = 0
	clientHeight = 0
	scrollHeight = 0
	scrollListener: (() => void) | null = null
	addEventListener(type: string, listener: () => void): void {
		if (type === 'scroll') this.scrollListener = listener
	}
	removeEventListener(type: string, listener: () => void): void {
		if (type === 'scroll' && this.scrollListener === listener) this.scrollListener = null
	}
}

function layout(element: FakeScrollElement, scrollHeight: number, clientHeight: number, scrollTop = 0): void {
	element.scrollHeight = scrollHeight
	element.clientHeight = clientHeight
	element.scrollTop = scrollTop
}

// Fail fast instead of a non-null assertion when no listener is attached (e.g. after destroy).
function fireScroll(element: FakeScrollElement): void {
	if (element.scrollListener === null) throw new Error('no scroll listener attached')
	element.scrollListener()
}

describe('isAtBottom', () => {
	test('true when exactly at the bottom', () => {
		expect(isAtBottom(100, 100, 200)).toBe(true)
	})

	test('false when above the bottom', () => {
		expect(isAtBottom(50, 100, 200)).toBe(false)
	})

	test('true within the default 1px tolerance (fractional scroll heights)', () => {
		expect(isAtBottom(99.5, 100, 200)).toBe(true)
	})

	test('default tolerance rejects positions further than 1px from the bottom', () => {
		expect(isAtBottom(98, 100, 200)).toBe(false)
	})

	test('an explicit tolerance of 0 demands the exact bottom', () => {
		expect(isAtBottom(100, 100, 200, 0)).toBe(true)
		expect(isAtBottom(99.5, 100, 200, 0)).toBe(false)
	})

	test('true for a zero-height container', () => {
		expect(isAtBottom(0, 0, 0)).toBe(true)
	})

	test('true when the content does not overflow', () => {
		expect(isAtBottom(0, 100, 80)).toBe(true)
	})
})

describe('pinnedScrollTop', () => {
	test('offsets by the overflow amount', () => {
		expect(pinnedScrollTop(300, 100)).toBe(200)
	})

	test('zero when the content fits', () => {
		expect(pinnedScrollTop(80, 100)).toBe(0)
	})

	test('zero for a zero-height container', () => {
		expect(pinnedScrollTop(0, 0)).toBe(0)
	})
})

describe('createScrollFollower', () => {
	test('attaches a scroll listener and exposes its element', () => {
		const element = new FakeScrollElement()
		const follower = createScrollFollower(element)
		expect(follower.element).toBe(element)
		expect(element.scrollListener).not.toBeNull()
		follower.destroy()
	})

	test('a fresh follower starts pinned: the first follow pins an overflowing container to the bottom', () => {
		const element = new FakeScrollElement()
		layout(element, 500, 200)
		const follower = createScrollFollower(element)
		follower.follow()
		expect(element.scrollTop).toBe(300)
		follower.destroy()
	})

	test('follow is a no-op while the content fits', () => {
		const element = new FakeScrollElement()
		layout(element, 100, 200)
		const follower = createScrollFollower(element)
		follower.follow()
		expect(element.scrollTop).toBe(0)
		follower.destroy()
	})

	test('follow tracks content growth while pinned', () => {
		const element = new FakeScrollElement()
		layout(element, 500, 200)
		const follower = createScrollFollower(element)
		follower.follow()
		element.scrollHeight = 700
		follower.follow()
		expect(element.scrollTop).toBe(500)
		follower.destroy()
	})

	test('a programmatic follow keeps the follower pinned (the scroll event it fires re-derives at-bottom)', () => {
		const element = new FakeScrollElement()
		layout(element, 500, 200)
		const follower = createScrollFollower(element)
		follower.follow()
		element.scrollTop = 300
		fireScroll(element)
		element.scrollHeight = 700
		follower.follow()
		expect(element.scrollTop).toBe(500)
		follower.destroy()
	})

	test('scrolling away unpins: follow no longer moves the view', () => {
		const element = new FakeScrollElement()
		layout(element, 500, 200, 500)
		const follower = createScrollFollower(element)
		element.scrollTop = 120
		fireScroll(element)
		element.scrollHeight = 700
		follower.follow()
		expect(element.scrollTop).toBe(120)
		follower.destroy()
	})

	test('scrolling back to the bottom re-locks the follow', () => {
		const element = new FakeScrollElement()
		layout(element, 500, 200, 500)
		const follower = createScrollFollower(element)
		element.scrollTop = 120
		fireScroll(element)
		element.scrollTop = 300
		fireScroll(element)
		element.scrollHeight = 700
		follower.follow()
		expect(element.scrollTop).toBe(500)
		follower.destroy()
	})

	test('destroy detaches the scroll listener', () => {
		const element = new FakeScrollElement()
		const follower = createScrollFollower(element)
		follower.destroy()
		expect(element.scrollListener).toBeNull()
	})
})
