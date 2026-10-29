// Shared question-affordance behavior for the SVG flow button and the HTML sequence/fallback bars.
//
// Every activation path must isolate itself from the host's delegated inspector handlers, and every keydown must return a valid state so hyperapp never receives `undefined` as the next state. The demo's gate lives here too: only a frame whose active operation is an in-flight ask_human exposes the question control.
//
// The module is browser-pure and imports only the shared interaction model and inspector predicate.

import { activeOperation } from './interaction-model.js'
import { isInFlightAskHuman } from './inspector.js'
import type { InteractionModel } from './interaction-model.js'

export type QuestionActivationHandler = (state: never, event: Event) => unknown

export interface QuestionActivationHandlers<State> {
	onclick: (state: State, event: Event) => unknown
	onkeydown: (state: State, event: Event) => unknown
}

export interface ActiveQuestionControls {
	onclick: QuestionActivationHandler
}

const ACTIVATION_KEYS: ReadonlySet<string> = new Set(['Enter', ' '])

function activationKeyOf(event: Event): string | null {
	if (!('key' in event)) return null
	const key = event['key']
	return typeof key === 'string' ? key : null
}

// Returns both handlers so an affordance cannot accidentally ship one without the other. Non-activation keys return the incoming state unchanged, matching a no-op hyperapp action instead of dispatching `undefined`.
export function createQuestionActivationHandlers<State = never>(onclick: (state: State, event: Event) => unknown): QuestionActivationHandlers<State> {
	const activate = (state: State, event: Event): unknown => {
		event.stopPropagation()
		return onclick(state, event)
	}
	const onkeydown = (state: State, event: Event): unknown => {
		const key = activationKeyOf(event)
		if (key === null || !ACTIVATION_KEYS.has(key)) return state
		event.preventDefault()
		return activate(state, event)
	}
	return { onclick: activate, onkeydown }
}

// The demo's question control exists only on a frame whose active operation is an in-flight ask_human. Returning undefined keeps every other frame free of a dead question bar.
export function deriveActiveQuestionControls(model: InteractionModel, onclick: QuestionActivationHandler): ActiveQuestionControls | undefined {
	const operation = activeOperation(model)
	if (operation === null) return undefined
	if (!isInFlightAskHuman(model, operation.id)) return undefined
	return { onclick }
}
