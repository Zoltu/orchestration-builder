import { describe, expect, test } from 'bun:test'
import { QuestionModal } from './static/ts/question-modal.js'
import { defined } from './test-fixtures.js'

// The question-modal component is browser-pure JS, so its exports arrive with inferred JS types. The interfaces and fake `h`/`renderMarkdown` below carry the shape the tests assert against, mirroring flow-view.test.ts.

interface Vnode {
	tag: string
	props: Record<string, unknown>
	children: VnodeChild[]
}
type VnodeChild = Vnode | string
type VnodeChildInput = VnodeChild | VnodeChildInput[] | null | undefined | boolean

function fakeH(tag: string, props: Record<string, unknown>, children: VnodeChildInput): Vnode {
	return { tag, props, children: normalizeChildren(children) }
}

// hyperapp flattens nested arrays and drops null/boolean children; the fake mirrors that so the component can pass loose children (a string heading, the renderMarkdown array, a null conditional) the same way it does against the real renderer.
function normalizeChildren(children: VnodeChildInput): VnodeChild[] {
	const out: VnodeChild[] = []
	pushChildren(out, children)
	return out
}

function pushChildren(out: VnodeChild[], children: VnodeChildInput): void {
	if (children === null || children === undefined || typeof children === 'boolean') return
	if (Array.isArray(children)) {
		for (const child of children) pushChildren(out, child)
		return
	}
	out.push(children)
}

function isVnode(value: VnodeChild): value is Vnode {
	return typeof value !== 'string'
}

function byTag(vnode: Vnode, tag: string): Vnode[] {
	return vnode.children.filter((child): child is Vnode => isVnode(child) && child.tag === tag)
}

// Walks a vnode tree and collects every descendant matching a tag, so the modal's nested structure (heading/question/form inside the card) is reachable.
function allByTag(vnode: Vnode, tag: string): Vnode[] {
	const found: Vnode[] = []
	for (const child of vnode.children) {
		if (!isVnode(child)) continue
		if (child.tag === tag) found.push(child)
		for (const grand of allByTag(child, tag)) found.push(grand)
	}
	return found
}

// A fake Markdown renderer that records its argument and returns a marker vnode carrying the text, so the tests assert both that the prose flowed through the renderer and that its output reached the modal.
function fakeRenderMarkdown(text: string): Vnode {
	return { tag: 'span', props: { class: 'md-marker', 'data-text': text }, children: [text] }
}

describe('QuestionModal', () => {
	const question = { id: 'q1', question: 'Which CI provider should I target?', context: '.github/workflows/', askedAt: 't1' }

	test('renders a backdrop and a centered card over the run view', () => {
		const modal: Vnode = QuestionModal(fakeH, { question, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onSubmit: () => undefined })
		expect(modal.tag).toBe('div')
		expect(modal.props.class).toBe('question-modal-overlay')
		expect(byTag(modal, 'div').some((d) => d.props.class === 'question-modal-backdrop')).toBe(true)
		const card = byTag(modal, 'div').find((d) => d.props.class === 'question-modal-card')
		expect(card).toBeDefined()
		expect(defined(card, 'card').props.id).toBe('question-modal-card')
	})

	test('renders the question text through the sanitized Markdown pipeline', () => {
		const modal: Vnode = QuestionModal(fakeH, { question, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onSubmit: () => undefined })
		const questionDiv = defined(allByTag(modal, 'div').find((d) => d.props.class === 'question-modal-question markdown'), 'questionDiv')
		expect(questionDiv).toBeDefined()
		const marker = defined(byTag(questionDiv, 'span')[0], 'marker')
		expect(marker).toBeDefined()
		expect(marker.props['data-text']).toBe(question.question)
	})

	test('renders the context through the Markdown pipeline when present', () => {
		const modal: Vnode = QuestionModal(fakeH, { question, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onSubmit: () => undefined })
		const contextDiv = defined(allByTag(modal, 'div').find((d) => d.props.class === 'question-modal-context question-context markdown'), 'contextDiv')
		expect(contextDiv).toBeDefined()
		expect(defined(byTag(contextDiv, 'span')[0], 'marker').props['data-text']).toBe(question.context)
	})

	test('omits the context block when the question has no context', () => {
		const noContext = { id: 'q1', question: 'which CI?', askedAt: 't1' }
		const modal: Vnode = QuestionModal(fakeH, { question: noContext, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onSubmit: () => undefined })
		const contextDiv = allByTag(modal, 'div').find((d) => d.props.class === 'question-modal-context question-context markdown')
		expect(contextDiv).toBeUndefined()
	})

	test('the heading names which run is asking', () => {
		const modal: Vnode = QuestionModal(fakeH, { question, runLabel: 'run-2026-1', renderMarkdown: fakeRenderMarkdown, onSubmit: () => undefined })
		const heading = defined(allByTag(modal, 'p').find((p) => p.props.class === 'question-modal-heading'), 'heading')
		expect(heading).toBeDefined()
		expect(heading.children.join('')).toBe('Question from run-2026-1')
	})

	test('the heading falls back to "Question" when no run label is supplied', () => {
		const modal: Vnode = QuestionModal(fakeH, { question, runLabel: null, renderMarkdown: fakeRenderMarkdown, onSubmit: () => undefined })
		const heading = defined(allByTag(modal, 'p').find((p) => p.props.class === 'question-modal-heading'), 'heading')
		expect(heading).toBeDefined()
		expect(heading.children.join('')).toBe('Question')
	})

	test('the answer textarea is multi-line and autofocus, and the form wires the supplied submit handler', () => {
		const onSubmit = () => undefined
		const modal: Vnode = QuestionModal(fakeH, { question, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onSubmit, answerPending: false })
		const form = defined(allByTag(modal, 'form').find((f) => f.props.class === 'question-modal-form'), 'form')
		expect(form).toBeDefined()
		expect(form.props.onsubmit).toBe(onSubmit)
		const textarea = defined(byTag(form, 'textarea')[0], 'textarea')
		expect(textarea).toBeDefined()
		expect(textarea.props.rows).toBe('4')
		expect(textarea.props.autofocus).toBe(true)
		expect(textarea.props.disabled).toBe(false)
		expect(defined(byTag(form, 'button')[0], 'button').props.disabled).toBe(false)
	})

	test('answerPending disables the textarea and the submit button', () => {
		const modal: Vnode = QuestionModal(fakeH, { question, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onSubmit: () => undefined, answerPending: true })
		const form = defined(allByTag(modal, 'form').find((f) => f.props.class === 'question-modal-form'), 'form')
		const textarea = byTag(form, 'textarea')[0]
		const button = byTag(form, 'button')[0]
		expect(defined(textarea, 'textarea').props.disabled).toBe(true)
		expect(defined(button, 'button').props.disabled).toBe(true)
	})

	test('the fixed prop adds the viewport-covering overlay modifier', () => {
		const fixed: Vnode = QuestionModal(fakeH, { question, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onSubmit: () => undefined, fixed: true })
		expect(fixed.props.class).toBe('question-modal-overlay question-modal-overlay--fixed')
		const scoped: Vnode = QuestionModal(fakeH, { question, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onSubmit: () => undefined })
		expect(scoped.props.class).toBe('question-modal-overlay')
	})

	test('renders no terminate button unless the caller supplies one', () => {
		const modal: Vnode = QuestionModal(fakeH, { question, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onSubmit: () => undefined })
		const form = defined(allByTag(modal, 'form').find((f) => f.props.class === 'question-modal-form'), 'form')
		expect(byTag(form, 'button').some((button) => button.props.class === 'question-modal-terminate')).toBe(false)
	})

	test('renders a secondary terminate button that fires the supplied action', () => {
		let terminations = 0
		const onTerminate = () => {
			terminations++
		}
		const modal: Vnode = QuestionModal(fakeH, { question, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onSubmit: () => undefined, onTerminate })
		const form = defined(allByTag(modal, 'form').find((f) => f.props.class === 'question-modal-form'), 'form')
		const terminate = defined(byTag(form, 'button').find((button) => button.props.class === 'question-modal-terminate'), 'terminate')
		expect(terminate.props.type).toBe('button')
		expect(terminate.props.disabled).toBe(false)
		expect(terminate.children.join('')).toBe('Terminate task')
		const onclick = terminate.props.onclick
		if (typeof onclick !== 'function') throw new Error('expected a terminate click handler')
		onclick()
		expect(terminations).toBe(1)
	})

	test('answerPending disables the terminate button too', () => {
		const modal: Vnode = QuestionModal(fakeH, { question, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onSubmit: () => undefined, onTerminate: () => undefined, answerPending: true })
		const form = defined(allByTag(modal, 'form').find((f) => f.props.class === 'question-modal-form'), 'form')
		const terminate = defined(byTag(form, 'button').find((button) => button.props.class === 'question-modal-terminate'), 'terminate')
		expect(terminate.props.disabled).toBe(true)
	})

	test('terminatePending disables the terminate button while the request is in flight', () => {
		const modal: Vnode = QuestionModal(fakeH, { question, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onSubmit: () => undefined, onTerminate: () => undefined, terminatePending: true })
		const form = defined(allByTag(modal, 'form').find((f) => f.props.class === 'question-modal-form'), 'form')
		const terminate = defined(byTag(form, 'button').find((button) => button.props.class === 'question-modal-terminate'), 'terminate')
		expect(terminate.props.disabled).toBe(true)
	})
})

describe('QuestionModal accessibility', () => {
	const question = { id: 'q1', question: 'Which CI provider should I target?', context: '.github/workflows/', askedAt: 't1' }

	test('the card is a labelled modal dialog', () => {
		const modal: Vnode = QuestionModal(fakeH, { question, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onSubmit: () => undefined })
		const card = defined(allByTag(modal, 'div').find((d) => d.props.class === 'question-modal-card'), 'card')
		const heading = defined(allByTag(modal, 'p').find((p) => p.props.class === 'question-modal-heading'), 'heading')
		expect(card.props['role']).toBe('dialog')
		expect(card.props['aria-modal']).toBe('true')
		expect(typeof heading.props['id']).toBe('string')
		expect(card.props['aria-labelledby']).toBe(heading.props['id'])
	})

	test('an explicit Close button invokes the supplied close action and keeps its type as button', () => {
		let closes = 0
		const onClose = () => {
			closes++
		}
		const modal: Vnode = QuestionModal(fakeH, { question, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onSubmit: () => undefined, onClose })
		const form = defined(allByTag(modal, 'form').find((f) => f.props.class === 'question-modal-form'), 'form')
		const close = defined(byTag(form, 'button').find((button) => button.props.class === 'question-modal-close'), 'close')
		expect(close.props['type']).toBe('button')
		expect(close.children.join('')).toBe('Close')
		const onclick = close.props['onclick']
		if (typeof onclick !== 'function') throw new Error('expected a close click handler')
		onclick()
		expect(closes).toBe(1)
	})

	test('Escape returns the close action, while ordinary keys return the incoming state untouched', () => {
		const onClose = () => undefined
		const modal: Vnode = QuestionModal(fakeH, { question, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onSubmit: () => undefined, onClose })
		const card = defined(allByTag(modal, 'div').find((d) => d.props.class === 'question-modal-card'), 'card')
		const onkeydown = card.props['onkeydown']
		if (typeof onkeydown !== 'function') throw new Error('expected a dialog keydown handler')
		let preventDefaults = 0
		let stoppedPropagations = 0
		const event = (key: string) => ({
			key,
			preventDefault: () => {
				preventDefaults++
			},
			stopPropagation: () => {
				stoppedPropagations++
			},
		})
		const incomingState = { marker: 'unchanged' }
		expect(onkeydown(incomingState, event('a'))).toBe(incomingState)
		expect(preventDefaults).toBe(0)
		expect(stoppedPropagations).toBe(0)
		expect(onkeydown(incomingState, event('Escape'))).toBe(onClose)
		expect(preventDefaults).toBe(1)
		expect(stoppedPropagations).toBe(1)
	})
})
