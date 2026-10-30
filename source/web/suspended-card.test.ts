import { describe, expect, test } from 'bun:test'
import { deriveSuspendedCard, resumeFailureCopy, SuspendedCard, suspendedTerminateTarget, terminateFailureCopy } from './static/ts/suspended-card.js'
import type { SuspensionRecord } from './static/ts/interaction-model.js'

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

function allByTag(vnode: Vnode, tag: string): Vnode[] {
	const found: Vnode[] = []
	for (const child of vnode.children) {
		if (!isVnode(child)) continue
		if (child.tag === tag) found.push(child)
		for (const grand of allByTag(child, tag)) found.push(grand)
	}
	return found
}

function allText(vnode: Vnode): string {
	const parts: string[] = []
	for (const child of vnode.children) {
		if (typeof child === 'string') parts.push(child)
		else parts.push(allText(child))
	}
	return parts.join(' ')
}

const suspension: SuspensionRecord = {
	category: 'billing',
	resumePolicy: 'operator',
	message: 'Provider said the account is out of credit.',
	suspendedAt: '2026-01-01T00:02:00.000Z',
}

describe('deriveSuspendedCard', () => {
	test('builds a pause descriptor for a suspended view with fixed category copy', () => {
		const descriptor = deriveSuspendedCard({ status: 'suspended', suspension, resumable: true })
		if (descriptor === undefined) throw new Error('expected a suspended descriptor')
		expect(descriptor.status).toBe('suspended')
		expect(descriptor.category).toBe('billing')
		expect(descriptor.suspendedAt).toBe('2026-01-01T00:02:00.000Z')
		expect(descriptor.resumable).toBe(true)
		expect(descriptor.cause).toContain('needs credit')
		expect(descriptor.cause).not.toContain('Provider said')
	})

	test('never builds a descriptor for terminal, running, malformed, or suspension-less bodies', () => {
		for (const status of ['success', 'error', 'needs_clarification', 'interrupted', 'running', 'unknown']) {
			expect(deriveSuspendedCard({ status, suspension, resumable: true })).toBeUndefined()
		}
		expect(deriveSuspendedCard({ status: 'suspended' })).toBeUndefined()
		expect(deriveSuspendedCard(null)).toBeUndefined()
		expect(deriveSuspendedCard('suspended')).toBeUndefined()
	})

	test('builds operator copy from the pause record, never provider copy or the raw message', () => {
		const pause = { message: 'Raw platform message', pausedAt: '2026-01-01T00:02:00.000Z' }
		const descriptor = deriveSuspendedCard({ status: 'suspended', pause, resumable: true })
		if (descriptor === undefined) throw new Error('expected an operator pause descriptor')
		expect(descriptor.kind).toBe('operator')
		expect(descriptor.category).toBeNull()
		expect(descriptor.suspendedAt).toBe('2026-01-01T00:02:00.000Z')
		expect(descriptor.cause).toContain('paused by the operator')
		expect(descriptor.cause).toContain('model is idle')
		expect(descriptor.cause).not.toContain('Raw platform message')
		for (const forbidden of ['provider', 'credit', 'credential', 'health']) {
			expect(descriptor.cause.toLowerCase()).not.toContain(forbidden)
		}
	})

	test('a summary without the run-view checkpoint probe leaves Resume enabled; an explicit false disables it', () => {
		const summary = deriveSuspendedCard({ status: 'suspended', suspension })
		if (summary === undefined) throw new Error('expected a suspended descriptor')
		expect(summary.resumable).toBe(true)
		const view = deriveSuspendedCard({ status: 'suspended', suspension, resumable: false })
		if (view === undefined) throw new Error('expected a suspended descriptor')
		expect(view.resumable).toBe(false)
	})
})

describe('SuspendedCard', () => {
	test('renders the pause card with cause, suspendedAt, Resume now, and Terminate run', () => {
		const descriptor = deriveSuspendedCard({ status: 'suspended', suspension, resumable: true })
		if (descriptor === undefined) throw new Error('expected a suspended descriptor')
		const onResume = () => undefined
		const onTerminate = () => undefined
		const modal: Vnode = SuspendedCard(fakeH, { descriptor, runLabel: 'run-1', runId: 'run-1', onResume, onTerminate, onClose: () => undefined })
		expect(modal.props.class).toBe('suspended-card-overlay')
		const text = allText(modal)
		expect(text).toContain('Run suspended')
		expect(text).toContain('Suspended since 2026-01-01T00:02:00.000Z')
		expect(text).toContain('needs credit')
		const resume = allByTag(modal, 'button').find((button) => button.props.class === 'suspended-card-resume')
		const terminate = allByTag(modal, 'button').find((button) => button.props.class === 'suspended-card-terminate')
		if (resume === undefined || terminate === undefined) throw new Error('expected both recovery buttons')
		expect(resume.children.join('')).toBe('Resume now')
		expect(terminate.children.join('')).toBe('Terminate run')
		expect(resume.props['data-run-id']).toBe('run-1')
		expect(terminate.props['data-run-id']).toBe('run-1')
		expect(resume.props.onclick).toBe(onResume)
		expect(terminate.props.onclick).toBe(onTerminate)
	})

	test('renders the operator pause card with paused copy and the same resume/terminate actions', () => {
		const pause = { message: 'The operator paused this run.', pausedAt: '2026-01-01T00:02:00.000Z' }
		const descriptor = deriveSuspendedCard({ status: 'suspended', pause, resumable: true })
		if (descriptor === undefined) throw new Error('expected an operator pause descriptor')
		const modal: Vnode = SuspendedCard(fakeH, { descriptor, runLabel: 'run-1', runId: 'run-1', onResume: () => undefined, onTerminate: () => undefined, onClose: () => undefined })
		const text = allText(modal)
		expect(text).toContain('Run paused')
		expect(text).toContain('Paused since 2026-01-01T00:02:00.000Z')
		expect(text).toContain('model is idle')
		for (const forbidden of ['provider', 'credit', 'credential', 'health']) {
			expect(text.toLowerCase()).not.toContain(forbidden)
		}
		expect(allByTag(modal, 'button').some((button) => button.props.class === 'suspended-card-resume')).toBe(true)
		expect(allByTag(modal, 'button').some((button) => button.props.class === 'suspended-card-terminate')).toBe(true)
	})

	test('disables Resume when the checkpoint is gone and never renders result/error surfaces', () => {
		const descriptor = deriveSuspendedCard({ status: 'suspended', suspension, resumable: false })
		if (descriptor === undefined) throw new Error('expected a suspended descriptor')
		const modal: Vnode = SuspendedCard(fakeH, { descriptor, runLabel: 'run-1', onResume: () => undefined, onTerminate: () => undefined, onClose: () => undefined })
		const resume = allByTag(modal, 'button').find((button) => button.props.class === 'suspended-card-resume')
		if (resume === undefined) throw new Error('expected a resume button')
		expect(resume.props.disabled).toBe(true)
		const classes = allByTag(modal, 'div').map((node) => String(node.props.class ?? ''))
		expect(classes.some((name) => name.includes('result-modal'))).toBe(false)
		const text = allText(modal)
		expect(text).not.toContain('Copy raw')
		expect(text).not.toContain('Technical details')
		expect(text).not.toContain('Something went wrong')
	})

	test('shows a typed refusal notice inside the card without inventing provider detail', () => {
		const descriptor = deriveSuspendedCard({ status: 'suspended', suspension, resumable: true })
		if (descriptor === undefined) throw new Error('expected a suspended descriptor')
		const modal: Vnode = SuspendedCard(fakeH, { descriptor, notice: 'This run has no saved checkpoint to resume from.', onClose: () => undefined })
		const notice = allByTag(modal, 'p').find((node) => node.props.class === 'suspended-card-notice')
		if (notice === undefined) throw new Error('expected a notice')
		expect(notice.children.join('')).toBe('This run has no saved checkpoint to resume from.')
	})
})

describe('typed suspended action failures', () => {
	test('resume failures map every endpoint rejection to accurate copy', () => {
		expect(resumeFailureCopy({ error: 'run_suspended' }, 409)).toContain('Another run is suspended')
		expect(resumeFailureCopy({ error: 'run_paused' }, 409)).toContain('Another run is paused by the operator')
		expect(resumeFailureCopy({ error: 'run_not_suspended' }, 409)).toContain('nothing to resume')
		expect(resumeFailureCopy({ error: 'run_not_resumable' }, 409)).toContain('no longer in a state that can be resumed')
		expect(resumeFailureCopy({ error: 'checkpoint_missing' }, 409)).toContain('no saved checkpoint')
		expect(resumeFailureCopy({ error: 'checkpoint_missing' }, 409)).toContain('terminated')
		expect(resumeFailureCopy({ error: 'provider_unavailable' }, 409)).toContain('model provider is unavailable')
		expect(resumeFailureCopy({ error: 'run_in_progress' }, 409)).toContain('Another run is in progress')
		expect(resumeFailureCopy({}, 409)).toContain('no longer waiting to be resumed')
		expect(resumeFailureCopy({}, 500)).toBe('The resume was rejected.')
		expect(resumeFailureCopy({ error: 'pause_intent_clear_failed' }, 500)).toContain('pause request could not be cleared')
		expect(resumeFailureCopy({ error: 'pause_intent_clear_failed', message: 'The pause request could not be cleared, so the run was not resumed.' }, 500)).toBe('The pause request could not be cleared, so the run was not resumed.')
		expect(resumeFailureCopy({}, 404)).toContain('could not be found')
	})

	test('terminate failures distinguish a missing item, an active run, and a status conflict', () => {
		expect(terminateFailureCopy({}, 404)).toContain('could not be found')
		expect(terminateFailureCopy({ error: 'status_forbidden' }, 409)).toContain('no longer suspended')
		expect(terminateFailureCopy({ error: 'run_not_suspended' }, 409)).toContain('no longer suspended')
		expect(terminateFailureCopy({ error: 'run_in_progress' }, 409)).toContain('already in progress')
		expect(terminateFailureCopy({}, 500)).toBe('The run could not be terminated.')
	})

	test('the pause card and history prefer the run-level endpoint; a queue row keeps its item path', () => {
		expect(suspendedTerminateTarget('run-20260101-000500', null)).toEqual({
			url: 'api/runs/run-20260101-000500/terminate',
			pendingId: 'run-20260101-000500',
		})
		expect(suspendedTerminateTarget('run-20260101-000500', 'item-1')).toEqual({
			url: 'api/queue/item-1/terminate',
			pendingId: 'item-1',
		})
	})
})
