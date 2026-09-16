// Demo harness for the InteractionModel scenarios.
// Renders the current frame two ways: the flow view SVG (the product surface) and a debug text view (the model's raw projection) that stays behind a toggle so the SVG can be cross-checked against the model's helpers during development.
// Each frame is the output of the real `deriveInteractionModel` adapter run server-side over the first `N` events of a fixture event stream (see `GET /api/demo/flow/:scenario/:frame`), fetched here over HTTP. The harness therefore exercises the identical `LogEvent → InteractionModel` path the product polls against a live run, so a behavior the demo shows is the behavior the product renders — the harness is a faithful poll simulator, not a hand-curated showcase. `scenarios.js` stays as the in-memory renderer test bed (its model-frame fixtures are consumed by `flow-view.test.ts` / `sequence-diagram.test.ts`); this harness consumes adapter output instead, so the adapter is exercised in the browser too.
// The harness imports only its sibling static modules; it touches nothing in the product client (app.js).
import { activeOperation, activeParticipant, activeStack, callChainOf, fateOf, isPaused, isTerminalStatus, observesOf, stacksOf } from './interaction-model.js'
import { createLabelResolver, isLabelTier } from './labels.js'
import { deriveLifecycle, renderFlowView, deriveNowCaption, deriveCostStrip, createColumnTracker } from './flow-view.js'
import { renderSequenceView, HEADER_HEIGHT, ROW_HEIGHT, BOTTOM_MARGIN } from './sequence-diagram.js'
import { createMarkdownRenderer } from './markdown-render.js'
import { createTooltipDismiss, deriveTooltipDescriptor, isInFlightAskHuman, resolveTooltipTarget } from './inspector.js'
import { operationIdsForTooltipDetails } from './tooltip.js'
import { copyRawToClipboard } from './clipboard.js'
import { Tooltip, tooltipStyle } from './tooltip.js'
import { ResultModal } from './result-modal.js'
import { QuestionModal } from './question-modal.js'
import { activeAskHumanCall } from './flow-view.js'

const PLAY_INTERVAL_MS = 1000
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'

// The demo harness loads its labels from the same /api/config the product client loads, so a swapped guild re-flavors the harness the same way it re-flavors the run view. The harness is served by the same web server (see server.ts serveStaticPath), so the endpoint is reachable at the page origin.
let labels = null
let tier = 'detailed'

// The scenario manifest fetched once from /api/demo/scenarios: each entry carries the id, label, frame count, and the full participant set (the sequence view's static column source).
// Frames themselves are not held locally — each is the adapter's output for an event-prefix, fetched on demand from /api/demo/flow/:scenario/:frame so the harness always renders adapter-derived models.
let scenarios = []
// The adapter-derived InteractionModel for the current scenario+frame, or null before the first frame loads (or while a fetch is in flight).
// Every renderer reads this adapter-derived frame.
let currentFrame = null
// The frame rendered before `currentFrame`, kept so `deriveLifecycle` can diff entering/departing participants across consecutive frames — the same role the product client's `previousFlowModel` plays.
// Reset to null on a scenario switch (the first frame of a scenario animates nothing).
let previousFrame = null
// The caller-held column high-water mark for the flow view (see createColumnTracker): one per page load, so the stage width stays stable as scenarios deepen and unwind.
const flowColumnTracker = createColumnTracker()

function requireElement(id, constructorFunction) {
	const element = document.getElementById(id)
	if (element === null) throw new Error(`demo harness chrome is missing element "${id}"`)
	if (!(element instanceof constructorFunction)) throw new Error(`element "${id}" is not a ${constructorFunction.name}`)
	return element
}

const scenarioSelect = requireElement('demo-scenario-select', HTMLSelectElement)
const frameScrubber = requireElement('demo-frame-scrubber', HTMLInputElement)
const frameMeta = requireElement('demo-frame-meta', HTMLSpanElement)
const playButton = requireElement('demo-play-button', HTMLButtonElement)
const previousButton = requireElement('demo-prev-button', HTMLButtonElement)
const nextButton = requireElement('demo-next-button', HTMLButtonElement)
const themeButton = requireElement('demo-theme-button', HTMLButtonElement)
const tierSelect = requireElement('demo-tier-select', HTMLSelectElement)
const textView = requireElement('demo-text-view', HTMLPreElement)

// The flow view SVG renders above the debug text view; the text view stays available behind a toggle so the SVG structure can be cross-checked against the model's raw projection during development. The container also carries the `pb-flow` class so it is the positioning context for the result-modal overlay (an HTML sibling of the SVG), mirroring the product client's run-view scoping.
const flowContainer = document.createElement('div')
flowContainer.id = 'demo-flow-view'
flowContainer.className = 'pb-flow'
flowContainer.style.marginTop = '1rem'
textView.parentElement?.insertBefore(flowContainer, textView)

// The sequence view renders inside a scroll container rather than the page itself so a long timeline scrolls vertically (wheel reaches the container) without zooming; the SVG keeps its natural full-content viewBox and the container scrolls it. The flow view mounts directly in the flow container because it never overflows.
const sequenceScrollContainer = document.createElement('div')
sequenceScrollContainer.className = 'pb-sequence-scroll'
sequenceScrollContainer.style.overflow = 'auto'
sequenceScrollContainer.style.maxHeight = '70vh'

// The "now" caption updates per frame alongside the SVG.
const nowCaption = document.createElement('p')
nowCaption.className = 'pb-now-caption'
flowContainer.append(nowCaption)

// The ambient cost strip lives in the harness chrome (not the flow area) so it stays visible as a quiet border read while the centerpiece changes. It carries elapsed and tokens aggregated off OperationMetrics, formatted as textContent. Effort is not carried by InteractionModel (it is a run-level setting, not per-operation data), so the strip reads elapsed and tokens only.
const costStrip = document.createElement('div')
costStrip.className = 'pb-cost-strip'
const costElapsed = document.createElement('span')
costElapsed.className = 'pb-cost-item'
const costSep = document.createElement('span')
costSep.className = 'pb-cost-sep'
costSep.textContent = '·'
const costTokens = document.createElement('span')
costTokens.className = 'pb-cost-item'
costStrip.append(costElapsed, costSep, costTokens)
const demoBar = document.querySelector('.demo-bar')
if (demoBar !== null) {
	demoBar.insertAdjacentElement('afterend', costStrip)
} else {
	flowContainer.parentElement?.insertBefore(costStrip, flowContainer)
}

const showTextToggle = document.createElement('input')
showTextToggle.type = 'checkbox'
showTextToggle.id = 'demo-show-text'
const showTextLabel = document.createElement('label')
showTextLabel.style.display = 'inline-flex'
showTextLabel.style.gap = '0.25rem'
showTextLabel.style.alignItems = 'center'
showTextLabel.style.fontSize = '0.8rem'
showTextLabel.style.textTransform = 'uppercase'
showTextLabel.style.letterSpacing = '0.04em'
showTextLabel.append('Debug text', showTextToggle)
const spacer = document.querySelector('.demo-bar .demo-spacer')
if (spacer !== null) {
	spacer.insertAdjacentElement('afterend', showTextLabel)
} else {
	scenarioSelect.parentElement?.append(showTextLabel)
}
textView.style.display = 'none'

// A Flow/Sequence segmented toggle swaps the run-view centerpiece between the product surface (Flow) and the temporal debug surface (Sequence). Both read the same InteractionModel frame, so the toggle is pure view state and a switch re-renders with no model mutation.
const viewToggle = document.createElement('div')
viewToggle.className = 'pb-view-toggle'
viewToggle.setAttribute('role', 'group')
viewToggle.setAttribute('aria-label', 'run view')
const flowButton = document.createElement('button')
flowButton.type = 'button'
flowButton.textContent = 'Flow'
flowButton.className = 'is-active'
const sequenceButton = document.createElement('button')
sequenceButton.type = 'button'
sequenceButton.textContent = 'Sequence'
viewToggle.append(flowButton, sequenceButton)
const viewToggleSpacer = document.querySelector('.demo-bar .demo-spacer')
if (viewToggleSpacer !== null) {
	viewToggleSpacer.insertAdjacentElement('afterend', viewToggle)
} else {
	scenarioSelect.parentElement?.append(viewToggle)
}

function applyViewToggle() {
	flowButton.classList.toggle('is-active', viewMode === 'flow')
	sequenceButton.classList.toggle('is-active', viewMode === 'sequence')
	// The jump-to-active affordance is meaningful only on the sequence view (the flow view has no scrollable time axis), so it shows and hides with the sequence segment.
	jumpToActiveButton.style.display = viewMode === 'sequence' ? '' : 'none'
}

// The jump-to-active button is shown for the sequence view (which has a scrollable time axis); the flow view has no scrollable axis.
const jumpToActiveButton = document.createElement('button')
jumpToActiveButton.type = 'button'
jumpToActiveButton.textContent = 'Jump to active'
jumpToActiveButton.style.display = 'none'
const jumpSpacer = document.querySelector('.demo-bar .demo-spacer')
if (jumpSpacer !== null) {
	jumpSpacer.insertAdjacentElement('afterend', jumpToActiveButton)
} else {
	scenarioSelect.parentElement?.append(jumpToActiveButton)
}
jumpToActiveButton.addEventListener('click', () => {
	if (activeSequenceContainer === null) return
	jumpSequenceViewToActive(activeSequenceContainer)
})

flowButton.addEventListener('click', () => {
	viewMode = 'flow'
	applyViewToggle()
	render()
})

sequenceButton.addEventListener('click', () => {
	viewMode = 'sequence'
	applyViewToggle()
	render()
})

function applyShowTextToggle() {
	textView.style.display = showTextToggle.checked ? 'block' : 'none'
}
showTextToggle.addEventListener('change', applyShowTextToggle)

// A DOM-producing `h` so the flow view's vnode tree mounts as a real SVG without a separate render step. The flow view passes only string-valued attributes (class, transform, data-*, geometry, text-anchor) plus the departing overlay's `style` object (CSS custom properties the depart keyframe reads as var(--from-*)/var(--to-*)); string-valued props become SVG attributes, the `style` object is applied via CSSStyleDeclaration so the custom properties land on the element rather than being stringified to "[object Object]", and `on*` props are wired as event listeners so the terminal CTA's onclick toggles its modal state. String children become text nodes and vnode children are appended in order.
function isEventListener(value) {
	return typeof value === 'function'
}

function isStyleObject(value) {
	if (typeof value !== 'object' || value === null) return false
	if (Array.isArray(value)) return false
	return true
}

function domH(tag, props, children = []) {
	const element = document.createElementNS(SVG_NAMESPACE, tag)
	for (const [key, value] of Object.entries(props)) {
		// Boolean HTML/SVG attributes are present=true/absent=false, so a `false` value must skip the attribute rather than stringify it: setAttribute('disabled', 'false') still disables the element because the attribute exists. Skipping the false value leaves the attribute absent, which is the false state; a true value still stringifies to 'true', whose presence is the true state.
		if (value === undefined || value === null || value === false) continue
		if (key.startsWith('on') && isEventListener(value)) {
			element.addEventListener(key.slice(2), value)
			continue
		}
		if (key === 'style' && isStyleObject(value)) {
			for (const [prop, propValue] of Object.entries(value)) {
				if (propValue === undefined || propValue === null) continue
				element.style.setProperty(prop, String(propValue))
			}
			continue
		}
		element.setAttribute(key, String(value))
	}
	for (const child of children) {
		if (child === null || child === undefined) continue
		if (typeof child === 'string') {
			element.appendChild(document.createTextNode(child))
		} else if (child instanceof Node) {
			element.appendChild(child)
		}
	}
	return element
}

// An HTML-producing `h` for the inspector card and the sanitized-Markdown vnodes it renders. The sequence view SVG cannot host HTML (the tooltip card is a positioned `<div>` carrying `<p>`/`<ul>`/`<pre>` from the markdown pipeline), so the inspector reuses tooltip.js with an HTML `h` rather than the SVG `domH` the views use. `on*` props wire event listeners and the `style` object is applied via CSSStyleDeclaration so positioning lands as real CSS rather than a stringified object, mirroring domH's handling.
function htmlH(tag, props, children = []) {
	const element = document.createElement(tag)
	for (const [key, value] of Object.entries(props)) {
		// Boolean HTML attributes are present=true/absent=false, so a `false` value must skip the attribute rather than stringify it: setAttribute('disabled', 'false') still disables the element because the attribute exists. Skipping the false value leaves the attribute absent (the false state); a true value still stringifies to 'true' (its presence is the true state).
		if (value === undefined || value === null || value === false) continue
		if (key.startsWith('on') && isEventListener(value)) {
			element.addEventListener(key.slice(2), value)
			continue
		}
		if (key === 'style' && isStyleObject(value)) {
			for (const [prop, propValue] of Object.entries(value)) {
				if (propValue === undefined || propValue === null) continue
				element.style.setProperty(prop, String(propValue))
			}
			continue
		}
		element.setAttribute(key, String(value))
	}
	for (const child of children) {
		if (child === null || child === undefined) continue
		if (typeof child === 'string') {
			element.appendChild(document.createTextNode(child))
		} else if (child instanceof Node) {
			element.appendChild(child)
		}
	}
	return element
}

const renderMarkdown = createMarkdownRenderer(htmlH)

// The inspector overlay: one positioned card mounted inside the run-view container (`flowContainer`), rebuilt per hover and anchored flush against the hovered node's rect.
// The card is `pointer-events: auto` and `user-select: text` (styles.css) so the operator can move the pointer from the node into the card to select and copy its contents; a short grace period on leaving the node (or the card) keeps the card open while the pointer travels between them, and the card dismisses once the pointer is over neither.
// The dedup key is `${kind}:${id}` so the card is reused (not flickered) as the pointer moves within the same operation (a sequence message → its terminal node) or the same participant (a node's box → its cost figures).
let currentTooltipNode = null
let currentTooltipKey = null
// The grace-period dismiss timer, shared with the product client via inspector.js; expiry tears the card down directly (the harness has no dispatch loop).
const tooltipDismiss = createTooltipDismiss()

// The operation-details session cache, mirroring the product client's: the frame models ship no
// detail bodies, so opening a card fetches the ids its derivation may show from the demo frame
// endpoint's ?operation= variant, once per scenario+operation per session. Operation ids are stable
// across a scenario's frames (events only append), so an entry never goes stale.
const operationDetailsCache = new Map()

// The target the open card was built from, so a late details response can rebuild it in place.
let currentTooltipTarget = null

function detailsCacheKey(operationId) {
	const manifest = scenarios[scenarioIndex]
	return `${manifest !== undefined ? manifest.id : ''}|${operationId}`
}

function operationDetailsLookup() {
	return (operationId) => {
		const entry = operationDetailsCache.get(detailsCacheKey(operationId))
		return entry === undefined ? { status: 'failed' } : entry
	}
}

// Marks each uncached id 'loading' and fetches it from the demo frame endpoint. Every landing —
// response or failure — goes through operationDetailsLanded, so both surfaces waiting on the id
// (the open inspector card and the question modal) fill in from one path. A 404 (an id the frame
// no longer resolves) and a network failure both record 'failed', which renders section-less.
function fetchOperationDetails(target) {
	const manifest = scenarios[scenarioIndex]
	if (manifest === undefined || currentFrame === null) return
	for (const operationId of operationIdsForTooltipDetails(currentFrame, target)) {
		const key = detailsCacheKey(operationId)
		if (operationDetailsCache.has(key)) continue
		operationDetailsCache.set(key, 'loading')
		fetch(`api/demo/flow/${encodeURIComponent(manifest.id)}/${frameIndex}?operation=${encodeURIComponent(operationId)}`).then(
			(response) => {
				const ok = response.ok
				response.json().then(
					(body) => {
						operationDetailsCache.set(key, detailsStateFrom(ok, body))
						operationDetailsLanded(operationId)
					},
					() => {
						operationDetailsCache.set(key, 'failed')
						operationDetailsLanded(operationId)
					},
				)
			},
			() => {
				operationDetailsCache.set(key, 'failed')
				operationDetailsLanded(operationId)
			},
		)
	}
}

function detailsStateFrom(ok, body) {
	if (ok && body !== null && typeof body === 'object' && typeof body.details === 'string') return { details: body.details }
	if (ok && body !== null && typeof body === 'object' && body.details === null) return { details: null }
	return 'failed'
}

// Re-opens the current card when a late details response lands for an id it derives from, so the
// card fills in; the dedup in openTooltip is bypassed by closing first, and a card the pointer has
// since left stays closed.
function refillTooltip(operationId) {
	if (currentTooltipNode === null || currentTooltipTarget === null || currentFrame === null) return
	if (!operationIdsForTooltipDetails(currentFrame, currentTooltipTarget).includes(operationId)) return
	const target = currentTooltipTarget
	closeTooltip()
	openTooltip(target)
}

// The shared landing for a details response or failure: refill the open inspector card, and fill
// the question modal when it is waiting on this operation's details. Routing both surfaces through
// one path is what closes the hover-then-open-modal race — a modal opened while a hover fetch is
// still in flight would otherwise never see the response.
function operationDetailsLanded(operationId) {
	refillTooltip(operationId)
	if (questionModalOperationId !== operationId) return
	const state = operationDetailsCache.get(detailsCacheKey(operationId))
	if (state !== undefined && state.status === 'ready') applyQuestionModalDetails(state.details)
}

function closeTooltip() {
	tooltipDismiss.cancel()
	if (currentTooltipNode === null) return
	currentTooltipNode.remove()
	currentTooltipNode = null
	currentTooltipKey = null
	currentTooltipTarget = null
}

// Builds the inspector card from the live InteractionModel via the shared descriptor dispatch in `inspector.js` (the same one the product client uses), so the dev harness and the live view consume one inspector derivation.
// The card is anchored to the target's snapshot rect (flush against it) and appended to the run-view container so a `mouseleave` on the container covers both the SVG and the card — moving from a node into the card keeps the card open. The target's details are fetched on demand if not cached; the first render shows the loading placeholder and the refill fills it in.
function openTooltip(target) {
	if (labels === null || currentFrame === null) return
	const descriptor = deriveTooltipDescriptor(currentFrame, labels, tier, target, operationDetailsLookup())
	if (descriptor.title === '') return
	// Reuse the open card when the pointer moves within the same target (a message path → its terminal node, or a node box → its cost figures) so the card does not flicker on every mouseover. The rect is unchanged for the same target, so the card stays put.
	const key = `${target.kind}:${target.id}`
	if (currentTooltipKey === key && currentTooltipNode !== null) {
		return
	}
	closeTooltip()
	fetchOperationDetails(target)
	const card = Tooltip(htmlH, { title: descriptor.title, sections: descriptor.sections, renderMarkdown, style: tooltipStyle(target.rect) })
	flowContainer.appendChild(card)
	currentTooltipNode = card
	currentTooltipKey = key
	currentTooltipTarget = target
}

// Sequence-view scroll state. The SVG renders at its natural full-content viewBox and lives inside a scroll container, so a long timeline scrolls vertically (the page wheel) rather than zooming; the container is the single piece of state the jump-to-active affordance needs.
let activeSequenceContainer = null

// The SVG scales to the container width, so the row's fractional position in the natural viewBox maps to a pixel offset inside the container's scroll range.
function jumpSequenceViewToActive(container) {
	if (currentFrame === null) return
	const frame = currentFrame
	if (frame.operations.length === 0) return
	const svg = container.firstElementChild
	if (!(svg instanceof SVGSVGElement)) return
	const rect = svg.getBoundingClientRect()
	if (rect.height === 0) return
	const lastIndex = frame.operations.length - 1
	const naturalHeight = HEADER_HEIGHT + frame.operations.length * ROW_HEIGHT + BOTTOM_MARGIN
	const rowY = HEADER_HEIGHT + lastIndex * ROW_HEIGHT + ROW_HEIGHT / 2
	const target = (rowY / naturalHeight) * rect.height
	container.scrollTop = Math.max(0, target - container.clientHeight / 2)
}

// Wires the inspector (hover/click) to the run-view container once.
// The container (`flowContainer`) holds the flow SVG, the sequence scroll container, the modals, and the inspector card, so a single set of `mouseover`/`mouseleave`/`click` listeners covers both views and the card itself:
//  - `mouseover` over the card: keep it open (cancel any pending dismiss) — the pointer entered the card to select/copy.
//  - `mouseover` over a node/edge: open/switch the card to it (anchored to its rect), canceling any pending dismiss.
//  - `mouseover` over empty run-view area: schedule a grace-period dismiss — if the pointer reaches the card (or a new node) before it fires, the dismiss is canceled; otherwise the card dismisses once the pointer is over neither.
//  - `mouseleave` on the container: schedule a grace-period dismiss (the pointer left the run view).
//  - `click` on an in-flight `ask_human` row: re-open the question modal (the sequence view's re-entry affordance); every other click falls through to the hover path.
function wireRunViewInteractions() {
	const openAt = (event) => {
		if (event.target instanceof Element && event.target.closest('.tooltip-card') !== null) {
			tooltipDismiss.cancel()
			return
		}
		const target = resolveTooltipTarget(event)
		if (target === null) {
			if (currentTooltipNode !== null) tooltipDismiss.schedule(closeTooltip)
			return
		}
		tooltipDismiss.cancel()
		openTooltip(target)
	}
	flowContainer.addEventListener('mouseover', openAt)
	flowContainer.addEventListener('click', (event) => {
		if (event.target instanceof Element && event.target.closest('.tooltip-card') !== null) {
			return
		}
		const target = resolveTooltipTarget(event)
		if (target !== null && target.kind === 'operation' && currentFrame !== null && isInFlightAskHuman(currentFrame, target.id)) {
			openQuestionModal()
			return
		}
		openAt(event)
	})
	flowContainer.addEventListener('mouseleave', () => {
		if (currentTooltipNode !== null) tooltipDismiss.schedule(closeTooltip)
	})
}

// Records the active sequence scroll container so the jump-to-active affordance can center the latest message row.
// The hover listeners live on `flowContainer` (wired once by `wireRunViewInteractions`), so this only updates the scroll-state reference.
function wireSequenceInteractions(container) {
	activeSequenceContainer = container
}

let scenarioIndex = 0
let frameIndex = 0
let viewMode = 'flow'
let playTimer = null
// The result-modal mount, or null when no modal is open. The modal is a view concern layered on a terminal frame (the run's status, not model state): opening it mounts an HTML overlay sibling to the SVG without rebuilding the SVG, so the enter animation and marching-ants do not replay on a modal toggle.
let resultModalNode = null
// Set by the See Result click so the next flow-area repaint materializes the terminal return as settled (the working-phase equivalent), departing the returner and its response line. The flag is view-side state, not model state: the scenario's terminal frame is unchanged, so navigating away and back restores the lingering leg. The See Result click stands in for the operation You would emit to settle the terminal return, since You is the run's root and never emits a real operation.
let resultAcknowledged = false
// The question-modal mount, or null when no modal is open. The modal is a view concern layered on an ask_human transit frame (a pending question, not model state): opening it mounts an HTML overlay sibling to the SVG without rebuilding the SVG, so the enter animation and marching-ants do not replay on a modal toggle.
let questionModalNode = null
// The ask_human call operation the open modal's question text derives from, or null when no modal is open. The shared details-landing path checks it so a response for an in-flight fetch fills the modal even when the fetch was started by a hover rather than the modal itself.
let questionModalOperationId = null
// Set by loadScenario/render so the next render knows the scenario (not just the frame) changed and the sequence scroll position resets to the top rather than preserving a scrollTop that mapped onto a different scenario's content.
let scenarioChanged = true
// Set to 'forward' by Next and Play so the next render auto-scrolls the sequence view to the latest row; every other navigation (Previous, arbitrary scrub, tier swap, view toggle) leaves it 'preserve' so the user's scroll position is kept rather than yanked to the bottom on a non-advancing step.
let pendingScrollIntent = 'preserve'

function roleLabelOf(participantId) {
	if (currentFrame === null) return participantId
	const found = currentFrame.participants.find((participant) => participant.id === participantId)
	if (found === undefined) return participantId
	// The resolver collapses participants that share a role (instance-per-invocation retries), so the instance id is appended to keep the debug view able to tell coder-1 from coder-2 apart.
	return `${labels.resolveParticipantLabel(found, tier)} (${found.id})`
}

function formatOperation(operation, participants) {
	const outcome = operation.outcome === null ? '' : ` → ${operation.outcome}`
	const label = labels.resolveOperationLabel(operation, participants, tier, labels.hashString(operation.id))
	return `${label} [${operation.lifecycle}${outcome}]`
}

function renderTextView() {
	const manifest = scenarios[scenarioIndex]
	if (manifest === undefined || currentFrame === null) return ''
	const frame = currentFrame
	const stack = activeStack(frame)
	const participant = activeParticipant(frame)
	const openStacks = stacksOf(frame)
	const observes = observesOf(frame)
	const lines = []
	lines.push(`scenario: ${manifest.label} (${manifest.id})`)
	lines.push(`frame:    ${frameIndex + 1} / ${manifest.frameCount}`)
	lines.push(`status:   ${frame.status}`)
	lines.push(``)
	lines.push(`active stack:       ${stack ?? '—'}`)
	lines.push(`active participant: ${participant === null ? '—' : roleLabelOf(participant)}`)
	lines.push(``)
	lines.push(`open call chains:`)
	if (openStacks.length === 0) {
		lines.push(`  (none)`)
	} else {
		for (const stackId of openStacks) {
			const chain = callChainOf(frame, stackId)
			const paused = isPaused(frame, stackId)
			const fate = fateOf(frame, stackId)
			const tag = paused ? ` (paused, fate: ${fate})` : ` (active, fate: ${fate})`
			lines.push(`  ${stackId}${tag}`)
			for (const call of chain) {
				lines.push(`    ${formatOperation(call, frame.participants)}`)
			}
		}
	}
	lines.push(``)
	lines.push(`observes:`)
	if (observes.length === 0) {
		lines.push(`  (none)`)
	} else {
		for (const observe of observes) {
			lines.push(`  ${formatOperation(observe, frame.participants)}  [stack: ${observe.stack}]`)
		}
	}
	return lines.join('\n')
}

// The See Result click stands in for the operation You would emit to settle the terminal return. Settling the active in_flight return departs the returner (the lingering leg renders only while in_flight), so the next render shows the returner and its response line leaving for the top bar — the working-phase equivalent reached by user acknowledgment rather than a modeled operation. Only the active in_flight return is touched; every earlier operation keeps the lifecycle the frame already carries.
function acknowledgeFrame(frame) {
	const active = activeOperation(frame)
	if (active === null || active.kind !== 'return' || active.lifecycle !== 'in_flight') return frame
	const operations = frame.operations.map((operation) => {
		if (operation === active) {
			return { ...operation, lifecycle: 'settled', settledAt: operation.settledAt ?? operation.startedAt }
		}
		return operation
	})
	return { ...frame, operations }
}

function resolveActiveFrame() {
	if (currentFrame === null) return undefined
	return resultAcknowledged ? acknowledgeFrame(currentFrame) : currentFrame
}

function renderFlowViewSvg() {
	if (labels === null || currentFrame === null) return null
	const baseFrame = currentFrame
	const frame = resultAcknowledged ? acknowledgeFrame(baseFrame) : baseFrame
	// On acknowledge, diff against the un-acknowledged frame so the returner's departure animates rather than the whole graph re-entering; otherwise diff against the last rendered frame so enter/depart animates across consecutive fetched frames.
	const diffBase = resultAcknowledged ? baseFrame : previousFrame
	const lifecycle = diffBase !== null ? deriveLifecycle(diffBase, frame) : undefined
	const cta = { onclick: openResultModal }
	const question = { onclick: openQuestionModal }
	return renderFlowView(domH, frame, labels, tier, lifecycle, cta, question, flowColumnTracker)
}

function renderSequenceViewSvg() {
	if (labels === null || currentFrame === null) return null
	const manifest = scenarios[scenarioIndex]
	if (manifest === undefined) return null
	// The sequence view lays out a column per guild role plus the special human/tools columns from the first frame; the manifest carries the scenario's full participant set (every participant the run ever produces) so columns appear from frame 0 without peeking at a future frame.
	return renderSequenceView(domH, currentFrame, labels, tier, manifest.participants)
}

// Derives the terminal-result descriptor the modal renders. The demo frames carry no result/error text (the InteractionModel has no result field), so the summary is a fixed honest line keyed off the current frame's terminal status and the error block surfaces only on an error status — enough for the modal to read as a real result affordance without inventing scenario-specific prose. The current frame is terminal whenever the modal opens (openResultModal gates on isTerminalStatus), so its status is the run's terminal status.
function deriveDemoResultDescriptor(status) {
	if (status === 'error') {
		return { status, summary: null, artifacts: [], error: { message: 'The run stopped with an error.', raw: null } }
	}
	if (status === 'interrupted') {
		return { status, summary: null, artifacts: [], error: { message: 'The run was interrupted before it could be resumed.', raw: null } }
	}
	if (status === 'needs_clarification') {
		return { status, summary: 'The run is waiting for your input.', artifacts: [], error: null }
	}
	return { status, summary: 'The run completed.', artifacts: [], error: null }
}

function openResultModal() {
	if (resultModalNode !== null) return
	if (currentFrame === null) return
	if (!isTerminalStatus(currentFrame.status)) return
	const manifest = scenarios[scenarioIndex]
	const runLabel = manifest !== undefined ? manifest.label : ''
	// The click is You's acknowledgment: it settles the terminal return (departing the returner) and opens the result modal. The depart is a view-side flag the render path reads, not model state — the fetched frame is unchanged, so navigating away and back restores the lingering leg.
	resultAcknowledged = true
	const descriptor = deriveDemoResultDescriptor(currentFrame.status)
	const modal = ResultModal(htmlH, {
		descriptor,
		runLabel,
		renderMarkdown,
		onCopyRaw: copyRawToClipboard,
		onClose: closeResultModal,
	})
	flowContainer.appendChild(modal)
	resultModalNode = modal
	// Repaint the flow area so the returner departs immediately; the modal (appended after the now caption) survives the repaint, which only swaps the SVG that sits before the now caption.
	paintFlowArea()
}

// Rebuilds the flow SVG (and the caption/cost surfaces derived from the same frame) without touching the result modal or the acknowledge flag. The acknowledge path calls this so the returner departs while the modal stays mounted; the navigation path uses render() instead, which additionally closes the modal and resets the flag.
function paintFlowArea() {
	const frame = resolveActiveFrame()
	if (frame === undefined) return
	while (flowContainer.firstChild !== null) {
		if (flowContainer.firstChild === nowCaption) break
		flowContainer.removeChild(flowContainer.firstChild)
	}
	const svg = renderFlowViewSvg()
	if (svg !== null) {
		flowContainer.insertBefore(svg, nowCaption)
	}
	if (labels !== null) nowCaption.textContent = deriveNowCaption(frame, labels, tier)
	const cost = deriveCostStrip(frame)
	costElapsed.textContent = `elapsed ${cost.elapsedSeconds}s`
	costTokens.textContent = `${cost.tokens.toLocaleString()} tokens`
}

function closeResultModal() {
	if (resultModalNode === null) return
	resultModalNode.remove()
	resultModalNode = null
}

// The question modal opens on an ask_human transit frame and stays open until the user answers or dismisses it. Like the result modal it is an HTML overlay sibling to the SVG, mounted without rebuilding the SVG so the marching-ants and enter animations do not replay. The Question affordance stays on the answerer node while the modal is dismissed, so the operator can re-open it by clicking the button again.
// The question text is the ask call's details; the models carry no question text, so the modal opens with the waiting fallback and the details fetch fills the question block in when it lands (a failure leaves the fallback — graceful, like the inspector card).
function openQuestionModal() {
	if (questionModalNode !== null) return
	const manifest = scenarios[scenarioIndex]
	if (manifest === undefined) return
	const frame = resolveActiveFrame()
	if (frame === undefined) return
	const askHumanCall = activeAskHumanCall(frame)
	if (askHumanCall === undefined) return
	const modal = QuestionModal(htmlH, {
		question: { question: 'The run is waiting for your input.' },
		runLabel: manifest.label,
		renderMarkdown,
		onSubmit: submitQuestion,
		onClose: closeQuestionModal,
	})
	flowContainer.appendChild(modal)
	questionModalNode = modal
	questionModalOperationId = askHumanCall.id
	fillQuestionModalWithDetails(manifest, askHumanCall.id)
}

// Fills the modal's question block from the ask call's details cache, fetching on a miss. A
// 'loading' entry needs no work here: the in-flight fetch's landing (operationDetailsLanded) sees
// the modal's registered operation id and applies the details when it resolves. A failure lands the
// same way and applies nothing, so the waiting fallback stays — graceful, like the inspector card.
function fillQuestionModalWithDetails(manifest, operationId) {
	const key = detailsCacheKey(operationId)
	const cached = operationDetailsCache.get(key)
	if (cached !== undefined && cached.status === 'ready') {
		applyQuestionModalDetails(cached.details)
		return
	}
	if (cached !== undefined) return
	operationDetailsCache.set(key, 'loading')
	fetch(`api/demo/flow/${encodeURIComponent(manifest.id)}/${frameIndex}?operation=${encodeURIComponent(operationId)}`).then(
		(response) => {
			const ok = response.ok
			response.json().then(
				(body) => {
					operationDetailsCache.set(key, detailsStateFrom(ok, body))
					operationDetailsLanded(operationId)
				},
				() => {
					operationDetailsCache.set(key, 'failed')
					operationDetailsLanded(operationId)
				},
			)
		},
		() => {
			operationDetailsCache.set(key, 'failed')
			operationDetailsLanded(operationId)
		},
	)
}

// Swaps the open modal's question text for the fetched details markdown; nothing to do when the
// operation carried no details or the modal has since closed.
function applyQuestionModalDetails(details) {
	if (questionModalNode === null) return
	if (typeof details !== 'string' || details === '') return
	const block = questionModalNode.querySelector('.question-modal-question')
	if (block === null) return
	while (block.firstChild !== null) block.removeChild(block.firstChild)
	for (const child of renderMarkdown(details)) {
		block.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
	}
}

function closeQuestionModal() {
	if (questionModalNode === null) return
	questionModalNode.remove()
	questionModalNode = null
	questionModalOperationId = null
}

// Submitting the answer advances to the next frame (the human_answer return), which turns the answerer green and closes the call. The answer text is not stored in the demo (the InteractionModel carries no answer field), so advancing the frame is the whole of the response; the product client would POST the answer and the backend would emit the return.
function submitQuestion(event) {
	event.preventDefault()
	closeQuestionModal()
	const manifest = scenarios[scenarioIndex]
	if (manifest !== undefined && frameIndex < manifest.frameCount - 1) {
		pendingScrollIntent = 'forward'
		frameIndex += 1
	}
	loadFrame()
}

function render() {
	const manifest = scenarios[scenarioIndex]
	if (manifest === undefined) return
	if (currentFrame === null) return
	const frame = currentFrame
	const totalFrames = manifest.frameCount
	frameScrubber.max = String(Math.max(0, totalFrames - 1))
	frameScrubber.value = String(frameIndex)
	frameMeta.textContent = `${frameIndex + 1} / ${totalFrames}`
	textView.textContent = renderTextView()
	if (labels !== null) {
		nowCaption.textContent = deriveNowCaption(frame, labels, tier)
	} else {
		nowCaption.textContent = ''
	}
	const cost = deriveCostStrip(frame)
	costElapsed.textContent = `elapsed ${cost.elapsedSeconds}s`
	costTokens.textContent = `${cost.tokens.toLocaleString()} tokens`
	// A tooltip opened on a previous frame's operation is stale once the frame advances, so it is dismissed with the rest of the stale DOM. The result modal and the acknowledge flag are frame/view-scoped too: a frame/view/tier change unmounts the modal and restores the lingering terminal leg, so reopening is a fresh click on the new frame's CTA. The acknowledge path (paintFlowArea) bypasses this so the modal survives the depart repaint.
	closeTooltip()
	resultAcknowledged = false
	closeResultModal()
	closeQuestionModal()
	// Capture the sequence scroll position before the DOM rebuild so a backward step, an arbitrary scrub, a tier swap, or a view toggle can restore it; replaceChildren resets scrollTop to 0, so without this every frame change would yank the view to the top.
	const preservedScrollTop = sequenceScrollContainer.scrollTop
	const isForwardAdvance = pendingScrollIntent === 'forward'
	while (flowContainer.firstChild !== null) {
		if (flowContainer.firstChild === nowCaption) break
		flowContainer.removeChild(flowContainer.firstChild)
	}
	if (viewMode === 'flow') {
		const svg = renderFlowViewSvg()
		if (svg !== null) {
			flowContainer.insertBefore(svg, nowCaption)
		}
		// Auto-open the question modal when landing on an ask_human transit frame so the operator can answer immediately; dismissing it leaves the Question affordance on the answerer node for re-entry.
		openQuestionModal()
		scenarioChanged = false
		pendingScrollIntent = 'preserve'
		return
	}
	const svg = renderSequenceViewSvg()
	if (svg === null) {
		scenarioChanged = false
		pendingScrollIntent = 'preserve'
		return
	}
	sequenceScrollContainer.replaceChildren(svg)
	flowContainer.insertBefore(sequenceScrollContainer, nowCaption)
	wireSequenceInteractions(sequenceScrollContainer)
	// Auto-open the question modal in the sequence view too, so a pending ask_human prompts the operator regardless of which view is active; re-opening after dismissal is via clicking the ask_human message row (wired in wireSequenceInteractions).
	openQuestionModal()
	// scenarioChanged must be cleared before applySequenceScroll so a scenario switch still resets to top (scenarioChanged catches it first), but a normal frame advance does not hit the reset-to-top branch.
	scenarioChanged = false
	applySequenceScroll(preservedScrollTop, isForwardAdvance)
	pendingScrollIntent = 'preserve'
}

// On a forward frame advance (Next or Play), scroll the sequence container so the latest (active) message row lands in view — the same affordance the "Jump to active" button offers, but automatic, so an in-progress run's current operation never drifts off-screen as Play or Next advances. On a backward step, an arbitrary scrub, a tier swap, or a view toggle, restore the pixel scrollTop captured before the rebuild so the user's scroll position is preserved rather than yanked. A scenario switch resets to the top because the preserved scrollTop mapped onto a different scenario's content.
function applySequenceScroll(preservedScrollTop, isForwardAdvance) {
	if (scenarioChanged) {
		sequenceScrollContainer.scrollTop = 0
		return
	}
	if (isForwardAdvance) {
		jumpSequenceViewToActive(sequenceScrollContainer)
		return
	}
	sequenceScrollContainer.scrollTop = preservedScrollTop
}

function loadScenario(newScenarioIndex) {
	scenarioIndex = newScenarioIndex
	frameIndex = 0
	scenarioChanged = true
	previousFrame = null
	loadFrame()
}

// The frame is the adapter's output for the scenario's first `frameIndex + 1` events — the model a product poll would see the moment that event landed.
// `previousFrame` carries the previously-rendered frame so the flow view's enter/depart lifecycle animates across consecutive frames.
// A fetch failure leaves the harness showing the last good frame (or empty before the first load) rather than crashing.
// A generation guard drops stale responses so rapid scrubbing cannot land an older frame after a newer one (the last fetch requested always wins).
let loadGeneration = 0
async function loadFrame() {
	const manifest = scenarios[scenarioIndex]
	if (manifest === undefined) return
	const generation = ++loadGeneration
	const response = await fetch(`api/demo/flow/${encodeURIComponent(manifest.id)}/${frameIndex}`)
	if (generation !== loadGeneration) return
	if (!response.ok) {
		if (currentFrame === null) render()
		return
	}
	const frame = await response.json()
	if (generation !== loadGeneration) return
	previousFrame = currentFrame
	currentFrame = frame
	render()
}

function stopPlaying() {
	if (playTimer === null) return
	clearInterval(playTimer)
	playTimer = null
	playButton.textContent = 'Play'
}

function togglePlaying() {
	if (playTimer !== null) {
		stopPlaying()
		return
	}
	playButton.textContent = 'Pause'
	playTimer = setInterval(() => {
		const manifest = scenarios[scenarioIndex]
		if (manifest === undefined) return
		if (frameIndex + 1 >= manifest.frameCount) {
			stopPlaying()
			return
		}
		frameIndex = (frameIndex + 1) % manifest.frameCount
		pendingScrollIntent = 'forward'
		loadFrame()
	}, PLAY_INTERVAL_MS)
}

function applyTheme(theme) {
	document.documentElement.setAttribute('data-theme', theme)
	themeButton.textContent = theme === 'dark' ? 'Light' : 'Dark'
}

scenarioSelect.addEventListener('change', () => {
	stopPlaying()
	loadScenario(Number(scenarioSelect.value))
})

frameScrubber.addEventListener('input', () => {
	stopPlaying()
	frameIndex = Number(frameScrubber.value)
	loadFrame()
})

playButton.addEventListener('click', togglePlaying)

previousButton.addEventListener('click', () => {
	stopPlaying()
	const manifest = scenarios[scenarioIndex]
	if (manifest === undefined) return
	frameIndex = (frameIndex - 1 + manifest.frameCount) % manifest.frameCount
	loadFrame()
})

nextButton.addEventListener('click', () => {
	stopPlaying()
	const manifest = scenarios[scenarioIndex]
	if (manifest === undefined) return
	frameIndex = (frameIndex + 1) % manifest.frameCount
	pendingScrollIntent = 'forward'
	loadFrame()
})

themeButton.addEventListener('click', () => {
	const current = document.documentElement.getAttribute('data-theme') ?? 'light'
	applyTheme(current === 'dark' ? 'light' : 'dark')
})

tierSelect.addEventListener('change', () => {
	const value = tierSelect.value
	if (isLabelTier(value)) {
		tier = value
		render()
	}
})

// The initial theme follows the browser's color-scheme preference so a user who runs dark sees dark on first load rather than a flash of light; the toggle still flips it manually afterward.
const prefersDarkColorScheme = window.matchMedia('(prefers-color-scheme: dark)').matches
applyTheme(prefersDarkColorScheme ? 'dark' : 'light')
applyViewToggle()

// Wire the run-view inspector once: the listeners live on `flowContainer`, which persists across SVG swaps, so they cover both the flow and sequence views (and the inspector card itself) without re-attaching per render.
wireRunViewInteractions()

// Load the guild config (for the label resolver) and the demo scenario manifest in parallel, then populate the scenario dropdown and load the first frame.
// The harness renders nothing until both arrive so the views never reach for a resolver or a frame that does not exist; a failure of either leaves the harness in its pre-load state with no rendering, surfacing the missing-config state rather than crashing on a null resolver or an empty scenario list.
Promise.all([
	fetch('api/config').then((response) => response.json()),
	fetch('api/demo/scenarios').then((response) => response.json()),
])
	.then(([config, manifestList]) => {
		labels = createLabelResolver(config)
		scenarios = manifestList
		for (const [index, manifest] of scenarios.entries()) {
			const option = document.createElement('option')
			option.value = String(index)
			option.textContent = manifest.label
			scenarioSelect.appendChild(option)
		}
		loadScenario(0)
	})
	.catch((error) => {
		console.error('failed to load the demo harness config or scenarios', error)
	})
