// The persistent provider-health banner the product shell renders above the active screen. The run-list feed already polls once per second, so the banner rides that frame instead of opening a second health poll. Its input is the coarse HealthView only: no endpoint, credential, model, header, request, or provider body can reach the DOM from here.

import { isHealthView } from './run-list-feed/index.js'
import type { HealthView } from './run-list-feed/index.js'
import type { LooseH, Vnode } from '../vendor/hyperapp.js'

export type HealthBannerTone = 'info' | 'warning'

export interface HealthBannerDescriptor {
	tone: HealthBannerTone
	message: string
}

const BILLING_SUSPENDED_MESSAGE = 'Model provider needs credit \u2014 top up, then resume the suspended run.'
const BILLING_MESSAGE = 'Model provider needs credit \u2014 top up to restore the provider.'
const AUTH_SUSPENDED_MESSAGE = 'Model provider rejected the credentials \u2014 fix the deployment and restart, then resume.'
const AUTH_MESSAGE = 'Model provider rejected the credentials \u2014 fix the deployment and restart.'
const REQUEST_REJECTED_SUSPENDED_MESSAGE = 'The model endpoint rejected the request \u2014 resume after fixing the deployment.'
const REQUEST_REJECTED_MESSAGE = 'The model endpoint rejected the request \u2014 fix the deployment.'
const TRANSIENT_AUTO_MESSAGE = 'Model provider unavailable \u2014 retrying automatically.'
const TRANSIENT_OPERATOR_SUSPENDED_MESSAGE = 'Model provider unavailable \u2014 resume the suspended run when it is healthy.'
const UNKNOWN_MESSAGE = 'Provider status is being checked \u2014 health is not known yet.'
const SUSPENDED_AUTO_MESSAGE = 'Run suspended \u2014 retrying automatically.'
const SUSPENDED_OPERATOR_MESSAGE = 'Run suspended \u2014 resume when ready.'
const DISPATCH_PAUSED_MESSAGE = 'Dispatch paused until the provider is healthy.'

// Maps the coarse health snapshot to one fixed message. The category wins when it names a provider problem, so a billing or auth pause always says what the operator must do. The suspended-run policy, not the category alone, decides whether a transient pause retries automatically: the attempt cap downgrades it to an operator decision while keeping the transient category. Copy mentions a suspended run only when the view names one. An unknown or absent view renders no banner.
export function deriveHealthBanner(value: unknown): HealthBannerDescriptor | null {
	if (!isHealthView(value)) return null
	const health: HealthView = value
	const provider = health.provider
	const suspendedRunId = health.suspendedRunId
	const hasSuspendedRun = typeof suspendedRunId === 'string' && suspendedRunId !== ''
	const autoResume = health.resumePolicy === 'auto'

	if (provider.category === 'billing') return { tone: 'warning', message: hasSuspendedRun ? BILLING_SUSPENDED_MESSAGE : BILLING_MESSAGE }
	if (provider.category === 'auth') return { tone: 'warning', message: hasSuspendedRun ? AUTH_SUSPENDED_MESSAGE : AUTH_MESSAGE }
	if (provider.category === 'request_rejected') return { tone: 'warning', message: hasSuspendedRun ? REQUEST_REJECTED_SUSPENDED_MESSAGE : REQUEST_REJECTED_MESSAGE }
	if (provider.category === 'transient') {
		if (autoResume) return { tone: 'info', message: TRANSIENT_AUTO_MESSAGE }
		return hasSuspendedRun ? { tone: 'info', message: TRANSIENT_OPERATOR_SUSPENDED_MESSAGE } : { tone: 'warning', message: DISPATCH_PAUSED_MESSAGE }
	}
	if (provider.category === 'unknown') return { tone: 'info', message: UNKNOWN_MESSAGE }

	if (provider.state === 'unknown') return { tone: 'info', message: UNKNOWN_MESSAGE }
	if (provider.state === 'degraded') return { tone: 'info', message: autoResume ? TRANSIENT_AUTO_MESSAGE : hasSuspendedRun ? TRANSIENT_OPERATOR_SUSPENDED_MESSAGE : DISPATCH_PAUSED_MESSAGE }
	if (provider.state === 'unavailable') {
		if (hasSuspendedRun) return { tone: 'info', message: autoResume ? SUSPENDED_AUTO_MESSAGE : SUSPENDED_OPERATOR_MESSAGE }
		return { tone: 'warning', message: DISPATCH_PAUSED_MESSAGE }
	}
	if (hasSuspendedRun) return { tone: 'info', message: autoResume ? SUSPENDED_AUTO_MESSAGE : SUSPENDED_OPERATOR_MESSAGE }
	return null
}

export interface HealthBannerProps {
	descriptor: HealthBannerDescriptor
}

// The banner is fixed trusted text only; the run id is deliberately not rendered, so the DOM carries no machine identifier beyond what the screen already shows.
export function HealthBanner(h: LooseH, props: HealthBannerProps): Vnode {
	return h('div', { class: `health-banner health-banner--${props.descriptor.tone}`, role: 'status' }, [props.descriptor.message])
}
