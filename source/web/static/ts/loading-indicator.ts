// The shared loading affordance: a CSS spinner beside a short status label. A text-only loading line is easy to miss and reads like a stale surface, so every data-loading placeholder uses this component; `role="status"` exposes the label to assistive technology while the spinner is decorative.
//
// `h` is passed in rather than imported so the component stays free of hyperapp coupling and is usable from both hosts and the tests with a fake `h`.

import type { LooseH, Vnode } from '../vendor/hyperapp.js'

export function LoadingIndicator(h: LooseH, label: string, className?: string): Vnode {
	const classes = className === undefined || className === '' ? 'loading-indicator' : `loading-indicator ${className}`
	return h('span', { class: classes, role: 'status' }, [
		h('span', { class: 'loading-spinner', 'aria-hidden': 'true' }),
		h('span', { class: 'loading-indicator-label' }, [label]),
	])
}
