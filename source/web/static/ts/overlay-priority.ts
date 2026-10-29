// The Escape-key target when several app-level overlays are open. The visual stacking order is the priority: the task-history drawer sits above the question prompt, which sits above the inspector modal.

export type AppOverlay = 'task-history' | 'question-prompt' | 'inspector'

export interface OpenOverlays {
	taskHistory: boolean
	questionPrompt: boolean
	inspector: boolean
}

export function topmostAppOverlay(open: OpenOverlays): AppOverlay | null {
	if (open.taskHistory) return 'task-history'
	if (open.questionPrompt) return 'question-prompt'
	if (open.inspector) return 'inspector'
	return null
}
