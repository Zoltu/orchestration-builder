import { describe, expect, test } from 'bun:test'
import { QuestionModal, derivePendingQuestion } from './static/question-modal.js'

// The question-modal component is browser-pure JS, so its exports arrive with inferred JS types. The interfaces and fake `h`/`renderMarkdown` below carry the shape the tests assert against, mirroring flow-view.test.ts.

interface Vnode {
	tag: string
	props: Record<string, unknown>
	children: VnodeChild[]
}
type VnodeChild = Vnode | string

function fakeH(tag: string, props: Record<string, unknown>, children: unknown): Vnode {
	return { tag, props, children: normalizeChildren(children) }
}

// hyperapp flattens nested arrays and drops null/boolean children; the fake mirrors that so the component can pass loose children (a string heading, the renderMarkdown array, a null conditional) the same way it does against the real renderer.
function normalizeChildren(children: unknown): VnodeChild[] {
	const out: VnodeChild[] = []
	pushChildren(out, children)
	return out
}

function pushChildren(out: VnodeChild[], children: unknown): void {
	if (children === null || children === undefined || typeof children === 'boolean') return
	if (Array.isArray(children)) {
		for (const child of children) pushChildren(out, child)
		return
	}
	out.push(children as VnodeChild)
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

describe('derivePendingQuestion', () => {
	test('returns the first question history entry without an answer', () => {
		const runView = {
			questionHistory: [
				{ id: 'q1', question: 'which CI?', askedAt: 't1', answer: 'GitHub Actions', answeredAt: 't2' },
				{ id: 'q2', question: 'which runtime?', context: 'node 20', askedAt: 't3' },
			],
		}
		const pending = derivePendingQuestion(runView)
		expect(pending).toBeDefined()
		expect(pending!.id).toBe('q2')
		expect(pending!.question).toBe('which runtime?')
		expect(pending!.context).toBe('node 20')
	})

	test('returns undefined when every question has been answered', () => {
		const runView = {
			questionHistory: [
				{ id: 'q1', question: 'which CI?', askedAt: 't1', answer: 'GitHub Actions', answeredAt: 't2' },
			],
		}
		expect(derivePendingQuestion(runView)).toBeUndefined()
	})

	test('returns undefined when there is no question history', () => {
		expect(derivePendingQuestion({ questionHistory: [] })).toBeUndefined()
		expect(derivePendingQuestion({})).toBeUndefined()
		expect(derivePendingQuestion(null)).toBeUndefined()
		expect(derivePendingQuestion(undefined)).toBeUndefined()
	})
})

describe('QuestionModal', () => {
	const question = { id: 'q1', question: 'Which CI provider should I target?', context: '.github/workflows/', askedAt: 't1' }

	test('renders a backdrop and a centered card over the run view', () => {
		const modal: Vnode = QuestionModal(fakeH, { question, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onSubmit: () => undefined })
		expect(modal.tag).toBe('div')
		expect(modal.props.class).toBe('question-modal-overlay')
		expect(byTag(modal, 'div').some((d) => d.props.class === 'question-modal-backdrop')).toBe(true)
		const card = byTag(modal, 'div').find((d) => d.props.class === 'question-modal-card')
		expect(card).toBeDefined()
		expect(card!.props.id).toBe('question-modal-card')
	})

	test('renders the question text through the sanitized Markdown pipeline', () => {
		const modal: Vnode = QuestionModal(fakeH, { question, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onSubmit: () => undefined })
		const questionDiv = allByTag(modal, 'div').find((d) => (d.props.class as string) === 'question-modal-question markdown')
		expect(questionDiv).toBeDefined()
		const marker = byTag(questionDiv!, 'span')[0]
		expect(marker).toBeDefined()
		expect(marker!.props['data-text']).toBe(question.question)
	})

	test('renders the context through the Markdown pipeline when present', () => {
		const modal: Vnode = QuestionModal(fakeH, { question, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onSubmit: () => undefined })
		const contextDiv = allByTag(modal, 'div').find((d) => (d.props.class as string) === 'question-modal-context question-context markdown')
		expect(contextDiv).toBeDefined()
		const marker = byTag(contextDiv!, 'span')[0]
		expect(marker!.props['data-text']).toBe(question.context)
	})

	test('omits the context block when the question has no context', () => {
		const noContext = { id: 'q1', question: 'which CI?', askedAt: 't1' }
		const modal: Vnode = QuestionModal(fakeH, { question: noContext, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onSubmit: () => undefined })
		const contextDiv = allByTag(modal, 'div').find((d) => (d.props.class as string) === 'question-modal-context question-context markdown')
		expect(contextDiv).toBeUndefined()
	})

	test('the heading names which run is asking', () => {
		const modal: Vnode = QuestionModal(fakeH, { question, runLabel: 'run-2026-1', renderMarkdown: fakeRenderMarkdown, onSubmit: () => undefined })
		const heading = allByTag(modal, 'p').find((p) => (p.props.class as string) === 'question-modal-heading')
		expect(heading).toBeDefined()
		expect(heading!.children.join('')).toBe('Question from run-2026-1')
	})

	test('the heading falls back to "Question" when no run label is supplied', () => {
		const modal: Vnode = QuestionModal(fakeH, { question, runLabel: null, renderMarkdown: fakeRenderMarkdown, onSubmit: () => undefined })
		const heading = allByTag(modal, 'p').find((p) => (p.props.class as string) === 'question-modal-heading')
		expect(heading).toBeDefined()
		expect(heading!.children.join('')).toBe('Question')
	})

	test('the answer input is autofocus and the form wires the supplied submit handler', () => {
		const onSubmit = () => undefined
		const modal: Vnode = QuestionModal(fakeH, { question, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onSubmit, answerPending: false })
		const form = allByTag(modal, 'form').find((f) => (f.props.class as string) === 'question-modal-form')
		expect(form).toBeDefined()
		expect(form!.props.onsubmit).toBe(onSubmit)
		const input = byTag(form!, 'input')[0]
		expect(input).toBeDefined()
		expect(input!.props.autofocus).toBe(true)
		expect(input!.props.disabled).toBe(false)
		const button = byTag(form!, 'button')[0]
		expect(button!.props.disabled).toBe(false)
	})

	test('answerPending disables the input and the submit button', () => {
		const modal: Vnode = QuestionModal(fakeH, { question, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onSubmit: () => undefined, answerPending: true })
		const form = allByTag(modal, 'form').find((f) => (f.props.class as string) === 'question-modal-form')!
		const input = byTag(form, 'input')[0]
		const button = byTag(form, 'button')[0]
		expect(input!.props.disabled).toBe(true)
		expect(button!.props.disabled).toBe(true)
	})
})
