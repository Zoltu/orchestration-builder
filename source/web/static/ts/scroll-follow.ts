// Follow-with-free-scroll for the run view's sequence container.
//
// Content growth inside a scroll container does not fire scroll events, so "keep the newest operations in sight" cannot be re-derived per render: the at-bottom state must be remembered across content updates. The follower records at-bottom on every scroll event, and a `follow()` call after a content update scrolls to the bottom only while the user is still pinned there — scrolling up browses freely, and scrolling back to the bottom re-locks the follow. Browser-pure TypeScript sibling of the view modules; imports nothing.
//
// The pure math helpers (`isAtBottom`, `pinnedScrollTop`) ship exported even though the follower consumes them internally — pure helpers are exported so the tests exercise the same implementations the module uses rather than a parallel copy.

// The minimal scroll-container surface the follower reads and drives. A real HTMLElement satisfies this structurally; tests pass a fake with the same shape.
export interface ScrollElement {
	addEventListener(type: string, listener: () => void): void
	removeEventListener(type: string, listener: () => void): void
	scrollTop: number
	clientHeight: number
	scrollHeight: number
}

export interface ScrollFollower {
	// The attached container, so a host can detect that the rendered container was replaced.
	element: ScrollElement
	// Scrolls to the bottom iff the user is pinned there; call after content updates.
	follow(): void
	// Detaches the scroll listener.
	destroy(): void
}

// True when a scroll container's viewport sits within `tolerancePx` of its bottom edge. A container with no overflow (scrollHeight <= clientHeight) is always at the bottom, as is a zero-height one. The default tolerance of 1px absorbs the fractional scroll heights zoomed or subpixel layout produces.
export function isAtBottom(scrollTop: number, clientHeight: number, scrollHeight: number, tolerancePx = 1): boolean {
	return scrollTop + clientHeight >= scrollHeight - tolerancePx
}

// The scrollTop that pins a scroll container to its bottom edge; 0 when the content does not overflow.
export function pinnedScrollTop(scrollHeight: number, clientHeight: number): number {
	return Math.max(0, scrollHeight - clientHeight)
}

// Attaches to a scroll container and tracks whether the user is pinned to its bottom. A fresh follower starts pinned ("follow the action"), so opening a run locks the follow before the user has expressed any scroll intent; the first scroll event re-derives the state from the real position.
export function createScrollFollower(element: ScrollElement, tolerancePx = 1): ScrollFollower {
	let pinned = true
	const onScroll = () => {
		pinned = isAtBottom(element.scrollTop, element.clientHeight, element.scrollHeight, tolerancePx)
	}
	element.addEventListener('scroll', onScroll)
	return {
		element,
		follow() {
			if (!pinned) return
			element.scrollTop = pinnedScrollTop(element.scrollHeight, element.clientHeight)
		},
		destroy() {
			element.removeEventListener('scroll', onScroll)
		},
	}
}
