// Coalesces many requests for the next animation frame into one scheduled callback.
// The pending flag clears before the callback runs, so a request made from inside it schedules the following frame instead of being swallowed.

export interface AnimationFrameCoalescer {
	request(): void
}

export function createAnimationFrameCoalescer(schedule: (callback: () => void) => void, callback: () => void): AnimationFrameCoalescer {
	let pending = false
	return {
		request(): void {
			if (pending) return
			pending = true
			schedule(() => {
				pending = false
				callback()
			})
		},
	}
}
