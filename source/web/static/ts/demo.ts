// Demo harness for the InteractionModel scenarios.
// Renders the current frame two ways: the flow view SVG (the product surface) and a debug text view (the model's raw projection) that stays behind a toggle so the SVG can be cross-checked against the model's helpers during development.
// Each frame is the output of the real `deriveInteractionModel` adapter run server-side over the first `N` events of a fixture event stream (see `GET /api/demo/flow/:scenario/:frame`), fetched here over HTTP. The harness therefore exercises the identical `LogEvent → InteractionModel` path the product polls against a live run, so a behavior the demo shows is the behavior the product renders — the harness is a faithful poll simulator, not a hand-curated showcase. `scenarios.js` stays as the in-memory renderer test bed (its model-frame fixtures are consumed by `run-stage/flow-view.test.ts` / `run-stage/sequence-diagram.test.ts`); this harness consumes adapter output instead, so the adapter is exercised in the browser too.
// The harness imports only its sibling static modules; it touches nothing in the product client (app.js).
import { activeOperation, activeParticipant, activeStack, callChainOf, fateOf, isPaused, isTerminalStatus, observesOf, stacksOf } from './interaction-model.js'
import { createLabelResolver, isLabelTier, isRoleOrder } from './labels.js'
import { createRunStage, SEQUENCE_BODY_CLASS, SEQUENCE_HEADER_CLASS, sequenceActiveRowScrollTop } from './run-stage/index.js'
import { createMarkdownRenderer } from './markdown-render.js'
import { createTooltipDismiss, deriveTooltipDescriptor, isInFlightAskHuman, resolveTooltipTarget } from './inspector.js'
import { deriveActiveQuestionControls } from './question-affordance.js'
import { createOperationDetails } from './operation-details.js'
import { LoadingIndicator } from './loading-indicator.js'
import { isObject, isOperationMetricsRecord } from './guards.js'
import { operationIdsForTooltipDetails, Tooltip, tooltipStyle } from './tooltip.js'
import { copyRawToClipboard } from './clipboard.js'
import { ResultModal } from './result-modal.js'
import { QuestionModal } from './question-modal.js'
import type { InteractionModel, Operation, Participant, RunStatus } from './interaction-model.js'
import type { LabelResolver, LabelTier } from './labels.js'
import type { RunStage } from './run-stage/index.js'
import type { TooltipTarget } from './inspector.js'
import type { OperationDetailsState } from './operation-details.js'
import type { TerminalResult } from './result-modal.js'
import type { Vnode, VnodeChild, VnodeChildInput } from '../vendor/hyperapp.js'

const PLAY_INTERVAL_MS = 1000
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml'

// One scenario manifest from the /api/demo/scenarios list: each entry carries the id, label, frame count, and the full participant set (the sequence view's static column source). The rows come from the first-party adapter endpoint and are re-guarded downstream where individual fields are read.
interface DemoScenarioManifest {
	id: string
	label: string
	frameCount: number
	participants: Participant[]
}

// The demo endpoints are first-party, but types never validate what arrives over the wire: these guards check the fields the harness itself reads (id/role/kind on participants; the lifecycle fields on operations) so a malformed body fails fast with a readable message instead of surfacing as undefined reads deep in a render. Fields only the checked view modules read stay to those modules' contract. The metrics record check (isOperationMetricsRecord) is the shared guard in guards.js, so both wire ingress points validate the same counter set.
function isParticipantRecord(value: unknown): value is Participant {
	return isObject(value) && typeof value['id'] === 'string' && typeof value['role'] === 'string' && typeof value['kind'] === 'string'
}

function isOperationRecord(value: unknown): value is Operation {
	if (!isObject(value)) return false
	if (typeof value['id'] !== 'string' || typeof value['kind'] !== 'string' || typeof value['lifecycle'] !== 'string') return false
	if (typeof value['stack'] !== 'string' || typeof value['startedAt'] !== 'string') return false
	if (value['settledAt'] !== null && typeof value['settledAt'] !== 'string') return false
	if (value['metrics'] !== null && !isOperationMetricsRecord(value['metrics'])) return false
	return value['outcome'] === null || typeof value['outcome'] === 'string'
}

function isInteractionModelPayload(value: unknown): value is InteractionModel {
	if (!isObject(value)) return false
	if (typeof value['status'] !== 'string') return false
	if (!Array.isArray(value['participants']) || !value['participants'].every(isParticipantRecord)) return false
	return Array.isArray(value['operations']) && value['operations'].every(isOperationRecord)
}

function isScenarioManifest(value: unknown): value is DemoScenarioManifest {
	if (!isObject(value)) return false
	if (typeof value['id'] !== 'string' || value['id'] === '') return false
	if (typeof value['label'] !== 'string') return false
	if (typeof value['frameCount'] !== 'number' || !Number.isInteger(value['frameCount']) || value['frameCount'] < 0) return false
	return Array.isArray(value['participants']) && value['participants'].every(isParticipantRecord)
}

function isScenarioManifestList(value: unknown): value is DemoScenarioManifest[] {
	return Array.isArray(value) && value.every(isScenarioManifest)
}

// The demo harness loads its labels from the same /api/config the product client loads, so a swapped guild re-flavors the harness the same way it re-flavors the run view. The harness is served by the same web server (see server.ts serveStaticPath), so the endpoint is reachable at the page origin.
let labels: LabelResolver | null = null
let tier: LabelTier = 'detailed'

// The demo's run stage is built once the scenario manifest list and config land, over the union of every manifest's participants — the demo's full guild inventory, the analog of the app's /api/config role list — so a role's accent is stable across scenarios and frames. Until then it renders the neutral stage.
let runStage: RunStage = createRunStage({ roleNames: [], roleOrder: [] })

// Frames themselves are not held locally — each is the adapter's output for an event-prefix, fetched on demand from /api/demo/flow/:scenario/:frame so the harness always renders adapter-derived models.
let scenarios: DemoScenarioManifest[] = []
// The adapter-derived InteractionModel for the current scenario+frame, or null before the first frame loads (or while a fetch is in flight).
// Every renderer reads this adapter-derived frame.
let currentFrame: InteractionModel | null = null
// The frame rendered before `currentFrame`, kept so the stage can diff entering/departing participants across consecutive frames — the same role the product client's `previousFlowModel` plays.
// Reset to null on a scenario switch (the first frame of a scenario animates nothing).
let previousFrame: InteractionModel | null = null

// Looks up the demo chrome by id and checks its element kind; a missing or mismatched element is a broken page, so it throws with the id rather than handing undefined into the wiring.
function requireElement<C>(id: string, constructorFunction: new () => C): C {
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

// The sequence view renders inside a scroll container rather than the page itself so a long timeline scrolls vertically (wheel reaches the container) without zooming; the surface holds a pinned header SVG and a body SVG whose viewBox starts at the header height, and the container scrolls the body. The flow view mounts directly in the flow container because it never overflows.
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

function applyViewToggle(): void {
	flowButton.classList.toggle('is-active', viewMode === 'flow')
	sequenceButton.classList.toggle('is-active', viewMode === 'sequence')
	// The jump-to-active affordance is meaningful only on the sequence view (the flow view has no scrollable time axis), so it shows and hides with the sequence segment. The roles-only filter is likewise a sequence-view lens, so its toggle follows the same rule.
	jumpToActiveButton.style.display = viewMode === 'sequence' ? '' : 'none'
	rolesOnlyLabel.style.display = viewMode === 'sequence' ? '' : 'none'
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

// The roles-only sequence filter toggle (see interaction-model.js rolesOnlyModel): the same shared filter helper the product client's view controls consume — the harness inherits the behavior by import (per the demo contract), owning only the playback chrome around it. Hidden with the sequence segment like the jump-to-active button.
const rolesOnlyToggle = document.createElement('input')
rolesOnlyToggle.type = 'checkbox'
rolesOnlyToggle.id = 'demo-roles-only'
// The app's sequence view opens with the roles-only filter on (app.ts sequenceRolesOnly), so the harness matches that default.
rolesOnlyToggle.checked = true
const rolesOnlyLabel = document.createElement('label')
rolesOnlyLabel.style.display = 'none'
rolesOnlyLabel.style.gap = '0.25rem'
rolesOnlyLabel.style.alignItems = 'center'
rolesOnlyLabel.style.fontSize = '0.8rem'
rolesOnlyLabel.style.textTransform = 'uppercase'
rolesOnlyLabel.style.letterSpacing = '0.04em'
rolesOnlyLabel.title = 'Hide tool and interrupt columns — show only the agent roles and the human'
rolesOnlyLabel.append('Roles only', rolesOnlyToggle)
const rolesOnlySpacer = document.querySelector('.demo-bar .demo-spacer')
if (rolesOnlySpacer !== null) {
	rolesOnlySpacer.insertAdjacentElement('afterend', rolesOnlyLabel)
} else {
	scenarioSelect.parentElement?.append(rolesOnlyLabel)
}
rolesOnlyToggle.addEventListener('change', () => {
	render()
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

function applyShowTextToggle(): void {
	textView.style.display = showTextToggle.checked ? 'block' : 'none'
}
showTextToggle.addEventListener('change', applyShowTextToggle)

// A DOM-producing `h` so the flow view's vnode tree mounts as a real SVG without a separate render step. The flow view passes only string-valued attributes (class, transform, data-*, geometry, text-anchor) plus the departing overlay's `style` object (CSS custom properties the depart keyframe reads as var(--from-*)/var(--to-*)); string-valued props become SVG attributes, the `style` object is applied via CSSStyleDeclaration so the custom properties land on the element rather than being stringified to "[object Object]", and `on*` props are wired as event listeners so the terminal CTA's onclick toggles its modal state. String children become text nodes and vnode children are appended in order.
function isEventListener(value: unknown): value is () => unknown {
	return typeof value === 'function'
}

// The vnode product this host's `h` implementations build: the exchange shape's fields for the view layer (which never reads them) plus the live element the host mounts. The fields really exist on the object, so the wrapper satisfies the declared `Vnode` contract without a cast.
interface HostVnode extends Vnode {
	element: Element
}

// Narrows a rendered product back to the host's wrapper so it can be mounted. The shared views type their products as the exchange shape; in this host every product comes from domH/htmlH, so a product without the wrapper's fields is a broken render and throws.
function isHostVnode(value: VnodeChildInput): value is HostVnode {
	if (typeof value !== 'object' || value === null) return false
	return 'tag' in value && 'props' in value && 'children' in value && 'element' in value
}

function hostElementOf(vnode: Vnode, what: string): Element {
	if (!isHostVnode(vnode)) throw new Error(`${what} rendered a product without a host element`)
	return vnode.element
}

function applyHostProperties(element: HTMLElement | SVGElement, props: Record<string, unknown>): void {
	for (const [key, value] of Object.entries(props)) {
		// `key` is a vnode identity marker, not a DOM attribute.
		if (key === 'key') continue
		// Boolean HTML/SVG attributes are present=true/absent=false, so a `false` value must skip the attribute rather than stringify it: setAttribute('disabled', 'false') still disables the element because the attribute exists. Skipping the false value leaves the attribute absent, which is the false state; a true value still stringifies to 'true', whose presence is the true state.
		if (value === undefined || value === null || value === false) continue
		if (key.startsWith('on') && isEventListener(value)) {
			element.addEventListener(key.slice(2), value)
			continue
		}
		if (key === 'style' && isObject(value)) {
			for (const [prop, propValue] of Object.entries(value)) {
				if (propValue === undefined || propValue === null) continue
				element.style.setProperty(prop, String(propValue))
			}
			continue
		}
		element.setAttribute(key, String(value))
	}
}

function createHostElement(tag: string, namespace: string): HTMLElement | SVGElement {
	if (namespace === SVG_NAMESPACE) return document.createElementNS(SVG_NAMESPACE, tag)
	if (namespace === HTML_NAMESPACE) return document.createElement(tag)
	throw new Error(`domH cannot create "${tag}" in namespace "${namespace}"`)
}

function materializeHostElement(vnode: HostVnode, namespace: string): Element {
	const childNamespace = vnode.tag === 'svg' ? SVG_NAMESPACE : namespace
	const element = createHostElement(vnode.tag, childNamespace)
	applyHostProperties(element, vnode.props)
	for (const child of vnode.children) {
		if (typeof child === 'string') {
			element.appendChild(document.createTextNode(child))
			continue
		}
		if (!isHostVnode(child)) throw new Error(`domH child "${child.tag}" is not a host vnode`)
		element.appendChild(materializeHostElement(child, childNamespace))
	}
	return element
}

function rootNamespaceForTag(tag: string): string {
	if (tag === 'svg') return SVG_NAMESPACE
	if (tag === 'div') return HTML_NAMESPACE
	throw new Error(`domH cannot mount a root <${tag}>: expected <svg> or <div>`)
}

// The stage's sequence surface is an HTML div containing SVG children. Because `h` receives children already built, domH defers element creation to the root access and threads the namespace down: the HTML root starts in HTML, an `svg` tag switches its subtree to SVG, and descendants inherit it. An unknown root tag fails fast instead of silently producing the wrong namespace.
function domH(tag: string, props: Record<string, unknown>, children: VnodeChild[] = []): HostVnode {
	const collected: VnodeChild[] = []
	for (const child of children) {
		if (typeof child === 'string' || isHostVnode(child)) collected.push(child)
	}
	let element: Element | null = null
	const vnode: HostVnode = {
		tag,
		props,
		children: collected,
		get element(): Element {
			if (element === null) element = materializeHostElement(vnode, rootNamespaceForTag(tag))
			return element
		},
	}
	return vnode
}

// An HTML-producing `h` for the inspector card and the sanitized-Markdown vnodes it renders. The sequence view SVG cannot host HTML (the tooltip card is a positioned `<div>` carrying `<p>`/`<ul>`/`<pre>` from the markdown pipeline), so the inspector reuses tooltip.js with an HTML `h` rather than the SVG `domH` the views use. `on*` props wire event listeners and the `style` object is applied via CSSStyleDeclaration so positioning lands as real CSS rather than a stringified object, mirroring domH's handling. Children arrive in the LooseH convention — an array, a bare string, or absent — so a bare string iterates character-wise (each character becomes its own text node, this host's original DOM shape), and anything else that is not an array renders nothing.
function htmlH(tag: string, props: Record<string, unknown>, children: VnodeChildInput = []): HostVnode {
	const element = document.createElement(tag)
	applyHostProperties(element, props)
	const collected: VnodeChild[] = []
	const childList: Iterable<VnodeChildInput> = typeof children === 'string' ? children : Array.isArray(children) ? children : []
	for (const child of childList) {
		if (child === null || child === undefined || typeof child === 'boolean') continue
		if (typeof child === 'string') {
			element.appendChild(document.createTextNode(child))
			collected.push(child)
			continue
		}
		if (isHostVnode(child)) {
			element.appendChild(child.element)
			collected.push(child)
		}
	}
	return { tag, props, children: collected, element }
}

const renderMarkdown = createMarkdownRenderer(htmlH, { maxEntries: 256, maxCharacters: 16_000_000 })

// The inspector overlay: one positioned card mounted inside the run-view container (`flowContainer`), rebuilt per hover and anchored flush against the hovered node's rect.
// The card is `pointer-events: auto` and `user-select: text` (stylesheets/styles.css) so the operator can move the pointer from the node into the card to select and copy its contents; a short grace period on leaving the node (or the card) keeps the card open while the pointer travels between them, and the card dismisses once the pointer is over neither.
// The dedup key is `${kind}:${id}` so the card is reused (not flickered) as the pointer moves within the same operation (a sequence message → its terminal node) or the same participant (a node's box → its cost figures).
let currentTooltipNode: Element | null = null
let currentTooltipKey: string | null = null
// The grace-period dismiss timer, shared with the product client via inspector.js; expiry tears the card down directly (the harness has no dispatch loop).
const tooltipDismiss = createTooltipDismiss()

// The operation-details controller, shared with the product client via operation-details.js: the
// frame models ship no detail bodies, so opening a card fetches the ids its derivation may show
// from the demo frame endpoint's ?operation= variant. Operation ids are stable across a scenario's
// frames (events only append), so a cached entry never goes stale; the scenario id in the key keeps
// one scenario's entries from answering for another's same-numbered operation. The cache is a
// bounded LRU, so an evicted id is fetched again the next time a surface asks. This host drives the
// controller through the promise-based `ensure` (the product client, whose fetches are hyperapp
// effects, drives `begin` + `record*` instead), and the landing fan-out is the onLanded callback below.
const operationDetails = createOperationDetails({ fetchDetail: fetchDemoOperationDetail, onLanded: operationDetailsLanded }, { maxEntries: 512, maxCharacters: 32_000_000 })

// The details fetch for one operation, resolved to the landing shape the controller records (`{ ok,
// body }` with the body already parsed): a network failure or an unparseable body rejects, which the
// controller records as 'failed'. The URL reads the current frame index at fetch time — the cache
// key carries only the scenario id because operation ids are stable across a scenario's frames.
async function fetchDemoOperationDetail(context: string, operationId: string): Promise<{ ok: boolean; body: unknown }> {
	const response = await fetch(`api/demo/flow/${encodeURIComponent(context)}/${frameIndex}?operation=${encodeURIComponent(operationId)}`)
	return { ok: response.ok, body: await response.json() }
}

// The target the open card was built from, so a late details response can rebuild it in place.
let currentTooltipTarget: TooltipTarget | null = null

function currentScenarioId(): string {
	const manifest = scenarios[scenarioIndex]
	return manifest !== undefined ? manifest.id : ''
}

function operationDetailsLookup(): (operationId: string) => OperationDetailsState {
	return (operationId) => operationDetails.lookup(currentScenarioId(), operationId)
}

// Marks each uncached id 'loading' and fetches it from the demo frame endpoint. Every landing —
// response or failure — goes through operationDetailsLanded (the controller's onLanded), so both
// surfaces waiting on the id (the open inspector card and the question modal) fill in from one
// path. A 404 (an id the frame no longer resolves) and a network failure both record 'failed',
// which renders section-less.
function fetchOperationDetails(target: TooltipTarget): void {
	const manifest = scenarios[scenarioIndex]
	if (manifest === undefined || currentFrame === null) return
	operationDetails.ensure(manifest.id, operationIdsForTooltipDetails(currentFrame, target))
}

// Re-opens the current card when a late details response lands for an id it derives from, so the
// card fills in; the dedup in openTooltip is bypassed by closing first, and a card the pointer has
// since left stays closed.
function refillTooltip(operationId: string): void {
	if (currentTooltipNode === null || currentTooltipTarget === null || currentFrame === null) return
	if (!operationIdsForTooltipDetails(currentFrame, currentTooltipTarget).includes(operationId)) return
	const target = currentTooltipTarget
	closeTooltip()
	openTooltip(target)
}

// The shared landing for a details response or failure: refill the open inspector card, and fill
// the question modal when it is waiting on this operation's details. Routing both surfaces through
// one path is what closes the hover-then-open-modal race — a modal opened while a hover fetch is
// still in flight would otherwise never see the response. The context is the scenario id the fetch
// started under, which is also the key half the cache answered from.
function operationDetailsLanded(context: string, operationId: string): void {
	refillTooltip(operationId)
	if (questionModalOperationId !== operationId) return
	const state = operationDetails.lookup(context, operationId)
	if (state.status === 'ready') applyQuestionModalDetails(state.details)
	else if (state.status === 'failed') showQuestionModalMessage(QUESTION_MODAL_FALLBACK)
}

function closeTooltip(): void {
	tooltipDismiss.cancel()
	if (currentTooltipNode === null) return
	currentTooltipNode.remove()
	currentTooltipNode = null
	currentTooltipKey = null
	currentTooltipTarget = null
}

// Builds the inspector card from the live InteractionModel via the shared descriptor dispatch in `inspector.js` (the same one the product client uses), so the dev harness and the live view consume one inspector derivation.
// The card is anchored to the target's snapshot rect (flush against it) and appended to the run-view container so a `mouseleave` on the container covers both the SVG and the card — moving from a node into the card keeps the card open. The target's details are fetched on demand if not cached; the first render shows the loading placeholder and the refill fills it in.
function openTooltip(target: TooltipTarget): void {
	if (labels === null || currentFrame === null) return
	// Reuse the open card when the pointer moves within the same target (a message path → its terminal node, or a node box → its cost figures) so the card does not flicker on every mouseover. The rect is unchanged for the same target, so the card stays put.
	const key = `${target.kind}:${target.id}`
	if (currentTooltipKey === key && currentTooltipNode !== null) {
		return
	}
	closeTooltip()
	// Begin the fetch before deriving the card, so a cold open reads its loading state just like the product host rather than deriving a failed lookup first.
	fetchOperationDetails(target)
	const descriptor = deriveTooltipDescriptor(currentFrame, labels, tier, target, operationDetailsLookup())
	if (descriptor.title === '') return
	const card = Tooltip(htmlH, { title: descriptor.title, sections: descriptor.sections, renderMarkdown, style: tooltipStyle(target.rect, { width: window.innerWidth, height: window.innerHeight }) })
	const cardElement = hostElementOf(card, 'the tooltip card')
	flowContainer.appendChild(cardElement)
	currentTooltipNode = cardElement
	currentTooltipKey = key
	currentTooltipTarget = target
}

// Sequence-view scroll state. The surface holds a pinned header SVG and a body SVG whose viewBox starts at the header height; the body lives inside a scroll container, so a long timeline scrolls vertically (the page wheel) rather than zooming. The container is the single piece of state the jump-to-active affordance needs.
let activeSequenceContainer: HTMLElement | null = null

// Centers the latest message row using the layout math owned by the run-stage module (`sequenceActiveRowScrollTop`), so the harness consumes the production calculation rather than re-deriving it from the view's private constants. The surface owns the header and body pairing; the body's rendered height excludes the header, whose rendered height is passed separately so the offset accounts for the band above it.
function jumpSequenceViewToActive(container: HTMLElement): void {
	if (currentFrame === null) return
	const header = container.querySelector(`.${SEQUENCE_HEADER_CLASS}`)
	const body = container.querySelector(`.${SEQUENCE_BODY_CLASS}`)
	if (!(body instanceof SVGSVGElement)) return
	const bodyRect = body.getBoundingClientRect()
	if (bodyRect.height === 0) return
	const headerHeight = header instanceof SVGSVGElement ? header.getBoundingClientRect().height : 0
	container.scrollTop = sequenceActiveRowScrollTop(currentFrame.operations.length, bodyRect.height, container.clientHeight, headerHeight)
}

// Wires the inspector (hover/click) to the run-view container once.
// The container (`flowContainer`) holds the flow SVG, the sequence scroll container, the modals, and the inspector card, so a single set of `mouseover`/`mouseleave`/`click` listeners covers both views and the card itself:
//  - `mouseover` over the card: keep it open (cancel any pending dismiss) — the pointer entered the card to select/copy.
//  - `mouseover` over a node/edge: open/switch the card to it (anchored to its rect), canceling any pending dismiss.
//  - `mouseover` over empty run-view area: schedule a grace-period dismiss — if the pointer reaches the card (or a new node) before it fires, the dismiss is canceled; otherwise the card dismisses once the pointer is over neither.
//  - `mouseleave` on the container: schedule a grace-period dismiss (the pointer left the run view).
//  - `click` on an in-flight `ask_human` row: re-open the question modal as a secondary shortcut alongside the stage Question button; every other click falls through to the hover path.
// The product client's click also drills into the LLM-turn inspector modal (app.js ClickRunView via resolveInspectorScope); that modal is app-only — the harness has no run-log window to feed it, and building a fixture-log transport plus a second inspector controller would reimplement shell behavior the demo contract forbids — so a click here stays a tooltip affordance.
function wireRunViewInteractions(): void {
	const openAt = (event: Event): void => {
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
function wireSequenceInteractions(container: HTMLElement): void {
	activeSequenceContainer = container
}

let scenarioIndex = 0
let frameIndex = 0
let viewMode: 'flow' | 'sequence' = 'flow'
let playTimer: ReturnType<typeof setInterval> | null = null
// The result-modal mount, or null when no modal is open. The modal is a view concern layered on a terminal frame (the run's status, not model state): opening it mounts an HTML overlay sibling to the SVG without rebuilding the SVG, so the enter animation and marching-ants do not replay on a modal toggle.
let resultModalNode: Element | null = null
// Set by the See Result click so the next flow-area repaint materializes the terminal return as settled (the working-phase equivalent), departing the returner and its response line. The flag is view-side state, not model state: the scenario's terminal frame is unchanged, so navigating away and back restores the lingering leg. The See Result click stands in for the operation You would emit to settle the terminal return, since You is the run's root and never emits a real operation.
let resultAcknowledged = false
// The question-modal mount, or null when no modal is open. The modal is a view concern layered on an ask_human transit frame (a pending question, not model state): opening it mounts an HTML overlay sibling to the SVG without rebuilding the SVG, so the enter animation and marching-ants do not replay on a modal toggle.
let questionModalNode: HTMLElement | null = null
// The ask_human call operation the open modal's question text derives from, or null when no modal is open. The shared details-landing path checks it so a response for an in-flight fetch fills the modal even when the fetch was started by a hover rather than the modal itself.
let questionModalOperationId: string | null = null
// Set by loadScenario/render so the next render knows the scenario (not just the frame) changed and the sequence scroll position resets to the top rather than preserving a scrollTop that mapped onto a different scenario's content.
let scenarioChanged = true
// Set to 'forward' by Next and Play so the next render auto-scrolls the sequence view to the latest row; every other navigation (Previous, arbitrary scrub, tier swap, view toggle) leaves it 'preserve' so the user's scroll position is kept rather than yanked to the bottom on a non-advancing step.
let pendingScrollIntent: 'preserve' | 'forward' = 'preserve'

function roleLabelOf(labels: LabelResolver, participantId: string): string {
	if (currentFrame === null) return participantId
	const found = currentFrame.participants.find((participant) => participant.id === participantId)
	if (found === undefined) return participantId
	// The resolver collapses participants that share a role (instance-per-invocation retries), so the instance id is appended to keep the debug view able to tell coder-1 from coder-2 apart.
	return `${labels.resolveParticipantLabel(found, tier)} (${found.id})`
}

function formatOperation(labels: LabelResolver, operation: Operation, participantsById: ReadonlyMap<string, Participant>): string {
	const outcome = operation.outcome === null ? '' : ` → ${operation.outcome}`
	const label = labels.resolveOperationLabel(operation, participantsById, tier, labels.hashString(operation.id))
	return `${label} [${operation.lifecycle}${outcome}]`
}

function renderTextView(): string {
	if (labels === null) return ''
	const manifest = scenarios[scenarioIndex]
	if (manifest === undefined || currentFrame === null) return ''
	const frame = currentFrame
	const participantsById = new Map<string, Participant>()
	for (const participant of frame.participants) participantsById.set(participant.id, participant)
	const stack = activeStack(frame)
	const participant = activeParticipant(frame)
	const openStacks = stacksOf(frame)
	const observes = observesOf(frame)
	const lines: string[] = []
	lines.push(`scenario: ${manifest.label} (${manifest.id})`)
	lines.push(`frame:    ${frameIndex + 1} / ${manifest.frameCount}`)
	lines.push(`status:   ${frame.status}`)
	lines.push(``)
	lines.push(`active stack:       ${stack ?? '—'}`)
	lines.push(`active participant: ${participant === null ? '—' : roleLabelOf(labels, participant)}`)
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
				lines.push(`    ${formatOperation(labels, call, participantsById)}`)
			}
		}
	}
	lines.push(``)
	lines.push(`observes:`)
	if (observes.length === 0) {
		lines.push(`  (none)`)
	} else {
		for (const observe of observes) {
			lines.push(`  ${formatOperation(labels, observe, participantsById)}  [stack: ${observe.stack}]`)
		}
	}
	return lines.join('\n')
}

// The See Result click stands in for the operation You would emit to settle the terminal return. Settling the active in_flight return departs the returner (the lingering leg renders only while in_flight), so the next render shows the returner and its response line leaving for the top bar — the working-phase equivalent reached by user acknowledgment rather than a modeled operation. Only the active in_flight return is touched; every earlier operation keeps the lifecycle the frame already carries.
function acknowledgeFrame(frame: InteractionModel): InteractionModel {
	const active = activeOperation(frame)
	if (active === null || active.kind !== 'return' || active.lifecycle !== 'in_flight') return frame
	const operations: Operation[] = frame.operations.map((operation) => {
		if (operation === active) {
			return { ...operation, lifecycle: 'settled', settledAt: operation.settledAt ?? operation.startedAt }
		}
		return operation
	})
	return { ...frame, operations }
}

function resolveActiveFrame(): InteractionModel | undefined {
	if (currentFrame === null) return undefined
	return resultAcknowledged ? acknowledgeFrame(currentFrame) : currentFrame
}

function renderFlowViewSvg(): Vnode | null {
	if (labels === null || currentFrame === null) return null
	const baseFrame = currentFrame
	const frame = resultAcknowledged ? acknowledgeFrame(baseFrame) : baseFrame
	// On acknowledge, diff against the un-acknowledged frame so the returner's departure animates rather than the whole graph re-entering; otherwise diff against the last rendered frame so enter/depart animates across consecutive fetched frames.
	const diffBase = resultAcknowledged ? baseFrame : previousFrame
	const manifest = scenarios[scenarioIndex]
	const cta = { onclick: openResultModal }
	const question = deriveActiveQuestionControls(frame, openQuestionModal)
	return runStage.render(domH, {
		model: frame,
		previousModel: diffBase,
		labels,
		tier,
		viewMode: 'flow',
		rolesOnly: false,
		guildParticipants: manifest === undefined ? [] : manifest.participants,
		cta,
		question,
	})
}

function renderSequenceSurface(): Vnode | null {
	if (labels === null || currentFrame === null) return null
	const manifest = scenarios[scenarioIndex]
	if (manifest === undefined) return null
	// The sequence view lays out a column per guild role plus the special human/tools columns from the first frame; the manifest carries the scenario's full participant set (every participant the run ever produces) so columns appear from frame 0 without peeking at a future frame. The stage applies the roles-only lens to both the frame and the static set, so the tools column collapses with the tool rows.
	return runStage.render(domH, {
		model: currentFrame,
		previousModel: previousFrame,
		labels,
		tier,
		viewMode: 'sequence',
		rolesOnly: rolesOnlyToggle.checked,
		guildParticipants: manifest.participants,
		question: deriveActiveQuestionControls(currentFrame, openQuestionModal),
	})
}

// Derives the terminal-result descriptor the modal renders. The demo frames carry no result/error text (the InteractionModel has no result field), so the summary is a fixed honest line keyed off the current frame's terminal status and the error block surfaces only on an error status — enough for the modal to read as a real result affordance without inventing scenario-specific prose. The current frame is terminal whenever the modal opens (openResultModal gates on isTerminalStatus), so its status is the run's terminal status.
function deriveDemoResultDescriptor(status: RunStatus): TerminalResult {
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

function openResultModal(): void {
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
	const modalElement = hostElementOf(modal, 'the result modal')
	flowContainer.appendChild(modalElement)
	resultModalNode = modalElement
	// Repaint the flow area so the returner departs immediately; the modal (appended after the now caption) survives the repaint, which only swaps the SVG that sits before the now caption.
	paintFlowArea()
}

// Rebuilds the flow SVG (and the caption/cost surfaces derived from the same frame) without touching the result modal or the acknowledge flag. The acknowledge path calls this so the returner departs while the modal stays mounted; the navigation path uses render() instead, which additionally closes the modal and resets the flag.
function paintFlowArea(): void {
	const frame = resolveActiveFrame()
	if (frame === undefined) return
	while (flowContainer.firstChild !== null) {
		if (flowContainer.firstChild === nowCaption) break
		flowContainer.removeChild(flowContainer.firstChild)
	}
	const svg = renderFlowViewSvg()
	if (svg !== null) {
		flowContainer.insertBefore(hostElementOf(svg, 'the flow view'), nowCaption)
	}
	if (labels !== null) nowCaption.textContent = runStage.nowCaption(frame, labels, tier)
	const cost = runStage.cost(frame)
	costElapsed.textContent = `elapsed ${cost.elapsedSeconds}s`
	costTokens.textContent = `${cost.tokens.toLocaleString()} tokens`
}

function closeResultModal(): void {
	if (resultModalNode === null) return
	resultModalNode.remove()
	resultModalNode = null
}

// The question modal opens on an ask_human transit frame and stays open until the user answers or dismisses it. Like the result modal it is an HTML overlay sibling to the SVG, mounted without rebuilding the SVG so the marching-ants and enter animations do not replay. The Question affordance stays on the answerer node while the modal is dismissed, so the operator can re-open it by clicking the button again.
// The question text is the ask call's details; the models carry no question text, so the modal opens with the waiting fallback and the details fetch fills the question block in when it lands (a failure restores the fallback — graceful, like the inspector card).
const QUESTION_MODAL_FALLBACK = 'The run is waiting for your input.'
const QUESTION_MODAL_NO_DETAILS = 'No question details were logged for this operation.'

function openQuestionModal(): void {
	if (questionModalNode !== null) return
	const manifest = scenarios[scenarioIndex]
	if (manifest === undefined) return
	const frame = resolveActiveFrame()
	if (frame === undefined) return
	const operation = activeOperation(frame)
	if (operation === null || !isInFlightAskHuman(frame, operation.id)) return
	const modal = QuestionModal(htmlH, {
		question: { question: QUESTION_MODAL_FALLBACK },
		runLabel: manifest.label,
		renderMarkdown,
		onSubmit: submitQuestion,
		onClose: closeQuestionModal,
	})
	const modalElement = hostElementOf(modal, 'the question modal')
	if (!(modalElement instanceof HTMLElement)) throw new Error('the question modal did not render an HTML element')
	flowContainer.appendChild(modalElement)
	questionModalNode = modalElement
	questionModalOperationId = operation.id
	fillQuestionModalWithDetails(manifest, operation.id)
}

// Fills the modal's question block from the ask call's details cache, fetching on a miss. A
// 'loading' entry needs no work here: the in-flight fetch's landing (operationDetailsLanded) sees
// the modal's registered operation id and applies the details when it resolves. A failure restores
// the waiting fallback, and a ready-but-empty answer shows a fixed no-details line, so the spinner
// never outlives the fetch. The fetch goes through the controller's ensure, whose dedup keeps a
// loading entry from being fetched twice; an evicted later miss fetches again, like the tooltip path's.
function fillQuestionModalWithDetails(manifest: DemoScenarioManifest, operationId: string): void {
	const cached = operationDetails.lookup(manifest.id, operationId)
	if (cached.status === 'ready') {
		applyQuestionModalDetails(cached.details)
		return
	}
	operationDetails.ensure(manifest.id, [operationId])
	// A miss becomes loading synchronously inside ensure; a previously cached failure stays failed and keeps the waiting fallback rather than spinning forever.
	if (operationDetails.lookup(manifest.id, operationId).status === 'loading') showQuestionModalLoading()
}

// The question modal's details-loading state: a spinner in the question block so the open modal visibly fills in instead of showing only the waiting fallback.
function showQuestionModalLoading(): void {
	if (questionModalNode === null) return
	const block = questionModalNode.querySelector('.question-modal-question')
	if (block === null) return
	while (block.firstChild !== null) block.removeChild(block.firstChild)
	block.appendChild(hostElementOf(LoadingIndicator(htmlH, 'Loading question details\u2026'), 'question details loading indicator'))
}

function showQuestionModalMessage(message: string): void {
	if (questionModalNode === null) return
	const block = questionModalNode.querySelector('.question-modal-question')
	if (block === null) return
	while (block.firstChild !== null) block.removeChild(block.firstChild)
	block.appendChild(document.createTextNode(message))
}

// Swaps the open modal's question text for the fetched details markdown; a ready-but-empty answer restores a fixed no-details line rather than leaving the loading spinner.
function applyQuestionModalDetails(details: unknown): void {
	if (questionModalNode === null) return
	if (typeof details !== 'string' || details === '') {
		showQuestionModalMessage(QUESTION_MODAL_NO_DETAILS)
		return
	}
	const block = questionModalNode.querySelector('.question-modal-question')
	if (block === null) return
	while (block.firstChild !== null) block.removeChild(block.firstChild)
	for (const child of renderMarkdown(details)) {
		block.appendChild(typeof child === 'string' ? document.createTextNode(child) : child.element)
	}
}

function closeQuestionModal(): void {
	if (questionModalNode === null) return
	questionModalNode.remove()
	questionModalNode = null
	questionModalOperationId = null
}

// Submitting the answer advances to the next frame (the human_answer return), which turns the answerer green and closes the call. The answer text is not stored in the demo (the InteractionModel carries no answer field), so advancing the frame is the whole of the response; the product client would POST the answer and the backend would emit the return.
function submitQuestion(event: Event): void {
	event.preventDefault()
	closeQuestionModal()
	const manifest = scenarios[scenarioIndex]
	if (manifest !== undefined && frameIndex < manifest.frameCount - 1) {
		pendingScrollIntent = 'forward'
		frameIndex += 1
	}
	loadFrame()
}

function render(): void {
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
		nowCaption.textContent = runStage.nowCaption(frame, labels, tier)
	} else {
		nowCaption.textContent = ''
	}
	const cost = runStage.cost(frame)
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
			flowContainer.insertBefore(hostElementOf(svg, 'the flow view'), nowCaption)
		}
		// Auto-open the question modal when landing on an ask_human transit frame so the operator can answer immediately; dismissing it leaves the Question affordance on the answerer node for re-entry.
		openQuestionModal()
		scenarioChanged = false
		pendingScrollIntent = 'preserve'
		return
	}
	const surface = renderSequenceSurface()
	if (surface === null) {
		scenarioChanged = false
		pendingScrollIntent = 'preserve'
		return
	}
	sequenceScrollContainer.replaceChildren(hostElementOf(surface, 'the sequence view'))
	flowContainer.insertBefore(sequenceScrollContainer, nowCaption)
	wireSequenceInteractions(sequenceScrollContainer)
	// Auto-open the question modal in the sequence view too, so a pending ask_human prompts the operator regardless of which view is active; after dismissal the stage Question button or an ask_human message-row click re-opens it (the row click is wired in wireSequenceInteractions).
	openQuestionModal()
	// scenarioChanged must be cleared before applySequenceScroll so a scenario switch still resets to top (scenarioChanged catches it first), but a normal frame advance does not hit the reset-to-top branch.
	scenarioChanged = false
	applySequenceScroll(preservedScrollTop, isForwardAdvance)
	pendingScrollIntent = 'preserve'
}

// On a forward frame advance (Next or Play), scroll the sequence container so the latest (active) message row lands in view — the same affordance the "Jump to active" button offers, but automatic, so an in-progress run's current operation never drifts off-screen as Play or Next advances. On a backward step, an arbitrary scrub, a tier swap, or a view toggle, restore the pixel scrollTop captured before the rebuild so the user's scroll position is preserved rather than yanked. A scenario switch resets to the top because the preserved scrollTop mapped onto a different scenario's content.
function applySequenceScroll(preservedScrollTop: number, isForwardAdvance: boolean): void {
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

function loadScenario(newScenarioIndex: number): void {
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
async function loadFrame(): Promise<void> {
	const manifest = scenarios[scenarioIndex]
	if (manifest === undefined) return
	const generation = ++loadGeneration
	const response = await fetch(`api/demo/flow/${encodeURIComponent(manifest.id)}/${frameIndex}`)
	if (generation !== loadGeneration) return
	if (!response.ok) {
		if (currentFrame === null) render()
		return
	}
	const frame: unknown = await response.json()
	if (generation !== loadGeneration) return
	if (!isInteractionModelPayload(frame)) throw new Error(`demo frame payload for scenario "${manifest.id}" at frame ${frameIndex} is not a valid interaction model`)
	previousFrame = currentFrame
	currentFrame = frame
	render()
}

function stopPlaying(): void {
	if (playTimer === null) return
	clearInterval(playTimer)
	playTimer = null
	playButton.textContent = 'Play'
}

function togglePlaying(): void {
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

function applyTheme(theme: string): void {
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
		if (!isScenarioManifestList(manifestList)) throw new Error('demo scenario list is not an array of valid scenario manifests')
		labels = createLabelResolver(config)
		const visualization = isObject(config) ? config['visualization'] : undefined
		const roleOrder = isObject(visualization) ? visualization['roleOrder'] : undefined
		scenarios = manifestList
		const guildParticipants = manifestList.flatMap((manifest) => manifest.participants)
		const roleNames = guildParticipants.filter((participant) => participant.kind === 'role').map((participant) => participant.role)
		runStage = createRunStage({ roleNames, roleOrder: isRoleOrder(roleOrder) ? roleOrder : [] })
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
