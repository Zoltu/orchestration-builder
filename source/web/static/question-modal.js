// Per-run-view modal for a pending `ask_human` question.
//
// The modal is an overlay scoped to the run view (not `document.body`-wide) so a future multi-run world lets the user switch away and back: it covers the active run's flow area only. It renders the question text and its optional context as sanitized Markdown (via the `renderMarkdown` closure passed in, the same pipeline the product client uses) and the answer input is trusted operator input sent verbatim — never rendered back as Markdown from an untrusted source. See docs/security.md "Web client rendering pipeline".
//
// `h` and `renderMarkdown` are passed in rather than imported so the component stays free of hyperapp and showdown coupling and is exercisable in tests with fakes (mirroring flow-view.js and markdown.js). The submit handler is supplied by the caller: in the demo harness it advances the frame (the scenario's next frame models the answered state); in the product client it will POST to `/api/answer`.

// The modal overlay: a backdrop over the run view plus a centered card carrying the question, its context, and the answer form. The card names which run is asking (`runLabel`) as preparation for a multi-run world where more than one run could be waiting. The answer input carries `autofocus` so the operator can type immediately without hunting for focus; `answerPending` disables the form while a submit is in flight (the product client's POST path; the harness answers instantly). `onClose` is wired to the backdrop click so the operator can dismiss a pending question without answering it — the Question affordance stays on the answerer node so the modal is re-openable, mirroring the result modal's dismiss path.
export function QuestionModal(h, props) {
	const question = props.question
	const runLabel = props.runLabel
	const renderMarkdown = props.renderMarkdown
	const onSubmit = props.onSubmit
	const onClose = props.onClose
	const answerPending = props.answerPending === true

	const context = question.context !== undefined && typeof question.context === 'string' && question.context !== ''
		? question.context
		: null

	return h('div', { class: 'question-modal-overlay' }, [
		h('div', { class: 'question-modal-backdrop', onclick: onClose }),
		h('div', { class: 'question-modal-card', id: 'question-modal-card' }, [
			h('p', { class: 'question-modal-heading' }, runLabel !== null && runLabel !== undefined && runLabel !== ''
				? `Question from ${runLabel}`
				: 'Question'),
			h('div', { class: 'question-modal-question markdown' }, renderMarkdown(question.question)),
			context !== null
				? h('div', { class: 'question-modal-context question-context markdown' }, renderMarkdown(context))
				: null,
			h('form', { class: 'question-modal-form', onsubmit: onSubmit }, [
				h('input', { type: 'text', placeholder: 'your answer', autofocus: true, disabled: answerPending }),
				h('button', { type: 'submit', disabled: answerPending }, 'Answer'),
			]),
		]),
	])
}
