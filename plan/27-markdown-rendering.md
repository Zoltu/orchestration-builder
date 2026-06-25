# Step 27 — Markdown rendering with syntax highlighting

## Goal

Render the agent's free-form text — tasks, `ask_human` questions and context, result summaries, and the surfaced run error message — as formatted Markdown with code-block syntax highlighting, instead of the plain `textContent` blobs the UI shows today. The agent produces Markdown (code fences, lists, emphasis); the UI should display it as the agent intended so a non-developer can read results without parsing raw punctuation.

## Context

Read [`14-multi-run-ui.md`](14-multi-run-ui.md) (the `textContent`-only security invariant this step revises), [`17-per-run-view-readability.md`](17-per-run-view-readability.md) (where the result/summary/error/artifact text is rendered today), `source/web/static/app.js` (the `renderRunSummary` / `renderQuestions` / `renderError` / `renderCurrentActivity` functions this step rewrites), and `source/web/static/index.html` + `styles.css`.

The current UI injects every untrusted string via `element.textContent`, which is safe but flattens Markdown to literal punctuation. The target user is a non-developer who cannot read `# heading` or `` ```ts `` as formatting. This step introduces two carefully-chosen, vendored, dependency-free rendering libraries — `marked` (Markdown → sanitized HTML) and `highlight.js` (syntax highlighting inside code blocks) — and routes the agent-authored text fields through them.

## Deliverables

1. **Vendored dependencies.** Add `marked` and `highlight.js` as the only permitted runtime dependencies beyond Bun built-ins (this is a deliberate exception to the no-dependencies policy, approved by the operator; both are small, widely-audited, and have no transitive runtime deps). Vendor them as static assets under `source/web/static/vendor/` (no `node_modules` in the deployed image) and `<script>`-include them from `index.html` ahead of `app.js`. Do **not** add them to `package.json`'s runtime deps — the web client is a static bundle, not a Node program. Record the version pins and the rationale in `docs/security.md` ("Dependency surface") and this step's closeout.
2. `source/web/static/app.js` — add a `renderMarkdown(text)` helper that turns a string into sanitized DOM nodes, and replace the `textContent` assignment for the Markdown-carrying fields:
   - `renderRunSummary`: the **Task** and **Result** `<dd>` values.
   - `renderQuestions`: the question text and the `context`.
   - `renderError`: the error `message` (the `kind` stays a plain label).
   - `renderCurrentActivity`: leave as `textContent` — the current-activity line is a one-line machine summary, not agent Markdown.
   - The log row summaries and raw-payload detail stay `textContent` (they are structured, not prose).
3. **Sanitization invariant.** `marked`'s output is HTML; untrusted agent text must not reach the DOM as executable markup. Configure `marked` with `highlight.js` for fenced code, and sanitize the rendered HTML before insertion. Because a `textContent`-only policy is no longer sufficient once Markdown is rendered, add a sanitization pass that strips `<script>`, inline event handlers (`on*`), `javascript:` URLs, and any tag/attribute not on an allowlist (headings, lists, code, pre, em/strong, links with `href` only, blockquote, etc.). Prefer a small, audited sanitizer (vendored) over hand-rolling regex. The allowlist and the sanitizer choice are recorded in `docs/security.md`.
4. `source/web/static/styles.css` — style the rendered Markdown (headings, code blocks with the highlight.js theme, lists, blockquotes) so the agent's output reads as a document, not a raw dump.
5. `docs/security.md` — document the new rendering pipeline, the vendoring decision, the sanitizer allowlist, and why the `textContent`-only invariant was relaxed (Markdown is the agent's intended output format) without opening an XSS surface.
6. `source/web/render.test.ts` (or a new `source/web/markdown.test.ts`) — if any sanitization logic is pure (the allowlist check, the tag stripper), unit-test it in-memory. The DOM-attachment glue is a leaf and is not unit-tested.

## Module boundaries

- All rendering stays in `app.js` (a thin DOM leaf) plus the vendored libraries; no executor or `render.ts` changes. `render.ts` continues to ship plain strings; the client decides how to render them.
- The Markdown fields are exactly: task, result summary, question text, question context, error message. Tool names, log payloads, timestamps, role names, and run ids stay `textContent`.
- No new endpoints. No executor changes.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] Task, result, question, context, and error-message fields render as formatted Markdown (headings, lists, code blocks) with syntax-highlighted fenced code.
- [ ] A malicious agent payload (e.g. `<script>` or an `onerror` handler, or a `javascript:` link) is stripped before reaching the DOM; untrusted content never executes.
- [ ] The vendored libraries and their versions are recorded in `docs/security.md`.
- [ ] Log rows, role names, timestamps, run ids, and the current-activity line remain `textContent` (no Markdown rendering there).

## End-of-step evaluation

Re-read `app.js` for every untrusted-content insertion point and confirm the Markdown path is used only for the allowlisted prose fields and the sanitizer runs on every one of them. Confirm a code fence containing `<script>alert(1)</script>` renders as highlighted, non-executing text. Confirm the vendored bundle adds no `node_modules` to the deployed image and no entry to `package.json` runtime deps. Confirm `docs/security.md`'s allowlist matches what the sanitizer actually enforces.

## Estimated effort

Medium — the libraries are small, but the sanitization review is security-sensitive and the Markdown-field allowlist must be exact.

## Operator handoff

Run the service against a benchmark whose result summary contains Markdown (headings, a code fence, a list) and confirm it renders as a document. Then submit a task whose agent output includes a `<script>` tag in a result summary and confirm it does not execute. Report any field that renders as raw punctuation where Markdown was expected.
