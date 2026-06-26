# Security

## Threat model

The executor runs a language model against a Guild that exposes tools such as file system access and shell command execution. The model is a **trusted component**: it carries out the operator's intent and is not assumed to emit attacks. The untrusted input is the **workspace** — it may contain malicious scripts, binaries, package manifests, or prompt-injection payloads (a file or task description that tries to override the system prompt, ignore safety rules, or exfiltrate data). The goal is to prevent the workspace from causing the model to do bad things, and to contain any damage to the mounted workspace.

The defense is primarily **upstream**: isolate the workspace, canonicalize file paths, restrict network egress, and design Guild prompts that resist injection. Where model output is displayed in the web UI, a light defense-in-depth backstop exists for the case where a prompt-injection attempt from the workspace succeeds in *coercing* the model's output — not because the model is an adversary. The model is not over-defended: it is not sandboxed, its output is not quarantined, and its prose is rendered as the Markdown it is intended to be.

## Attack surface

- **Model-generated shell commands.** `run_shell` runs arbitrary commands. A confused model can run destructive commands by mistake (misinterpreting the task, not acting maliciously). This is the same risk as any local coding agent that runs generated code.
- **Prompt injection.** A task description or a file in the workspace can attempt to override system prompts, instruct the model to ignore safety rules, or exfiltrate data. This is the primary path by which untrusted workspace content reaches the trusted model. The executor cannot prevent all prompt injection, so workspace isolation and egress restriction are the defense.
- **Network egress.** A model whose instructions have been subverted by prompt injection — or one that makes a mistake with a network-capable command — could read workspace files and send them to a remote host. Egress should be restricted in production.
- **File traversal.** File read/write tools must not escape the workspace.
- **Supply-chain inputs.** A workspace may contain scripts, binaries, or package manifests. The executor treats these as untrusted inputs.
- **Vendored web client dependencies.** The web client (`source/web/static/app.js`) vendors three single self-contained files under `source/web/static/vendor/` (no runtime `import` of anything outside the file, no `node_modules` in the deployed image): `hyperapp@2.0.0` (the UI renderer), `showdown@2.1.0` (Markdown → HTML), and `highlight.js@11.11.1` (syntax highlighting inside fenced code), plus the `highlight.js` GitHub theme CSS. These are an approved, one-time exception to the no-dependencies policy; they are small, widely-audited, and have no transitive runtime dependencies. They are not listed in `package.json` runtime or dev dependencies — the web client is a static bundle served verbatim, not a Node program — and they are added to the image only as vendored static assets. The unminified browser builds are vendored (not minified bundles) so the operator can read the source; `showdown` is a fully-wrapped single file (no minification, no data blobs larger than a few hundred chars per line) and `highlight.js` is the unminified `cdn-release` build. Version pins: `showdown@2.1.0` (MIT), `highlight.js@11.11.1` (BSD-3-Clause), `hyperapp@2.0.0` (MIT). Their licenses are vendored alongside them (`vendor/*.LICENSE`).

## Web client rendering pipeline

The agent's prose fields — task, result summary, `ask_human` question text and context, and the surfaced run error message — are Markdown the UI renders as formatted text (headings, lists, code blocks) with syntax-highlighted fenced code, instead of the literal punctuation a `textContent`-only render would show. The model is a trusted component and its prose is not assumed to be an attack; rendering it as Markdown is the intended UX.

The residual concern is not a malicious model but **prompt injection**: a malicious file in the workspace could coerce the model into emitting markup that would be dangerous if inserted into the DOM as raw HTML. The primary defense is upstream (preventing injection from the workspace); the rendering pipeline below is a light defense-in-depth backstop for the case where an injection attempt succeeds in coercing the model's output. It never inserts HTML via `innerHTML`. It is, in order:

1. `showdown` (`window.showdown`, a classic deferred `<script>` global) parses the Markdown to an HTML string via a `Converter` configured for GFM tables and strikethrough (header-id generation disabled). Fenced code blocks are then highlighted by replacing each `<pre><code>` block with `highlight.js` (`window.hljs`) output, emitting `<pre><code class="hljs language-X">…</code></pre>`.
2. `DOMParser` parses that HTML string with `text/html` into a neutral node tree. `text/html` parsing never executes scripts, so a `<script>` in the Markdown becomes an inert element node.
3. The sanitizer (`source/web/static/markdown.js`, imported by `app.js`) walks the tree and keeps only what an allowlist permits. This is the single source of truth for what may render and is unit-tested in-memory by `source/web/markdown.test.ts`.
4. The surviving tree is turned back into hyperapp vnodes — text becomes text-node children, elements become `h(tag, attributes, children)`. hyperapp places content into text nodes and DOM properties/attributes, never into markup, so the rendered tree cannot break out of the DOM.

Because strings only ever become text nodes or allowlisted attributes (never `innerHTML`), and because the sanitizer strips anything not on the allowlist before the vnode step, markup coerced into the model's output is defanged before it reaches the DOM even if an upstream injection defense fails. Machine fields (tool names, log payloads, raw-payload detail, timestamps, role names, run ids, the one-line current-activity summary, the operator's question answer, artifact paths) stay `textContent`.

### Sanitizer allowlist

- **Allowed tags:** `p`, `br`, `hr`, `h1`–`h6`, `ul`, `ol`, `li`, `pre`, `code`, `blockquote`, `em`, `strong`, `del`, `s`, `a`, `span`, `table`, `thead`, `tbody`, `tr`, `th`, `td`. `span` is allowed because `highlight.js` wraps syntax tokens in `<span class="hljs-…">`. `img`, `script`, `iframe`, `object`, `embed`, `svg`, `form`, `input`, `link`, `meta`, and every other tag are not allowed.
- **Disallowed tags** are either dropped wholesale (a denylist of non-prose/dangerous elements: `script`, `style`, `iframe`, `object`, `embed`, `svg`, `form`, `input`, `link`, `meta`, `audio`, `video`, etc. — their content is removed, not unwrapped, so a `<script>` body never becomes visible text) or unwrapped (every other disallowed tag: the tag is removed but its sanitized children are kept, so agent-authored `<div>text</div>` still yields the inner `text`).
- **Allowed attributes:** `a` may carry `href` and `title` only; `code`, `pre`, and `span` may carry `class` only (for `highlight.js` token classes and `showdown`'s `language-…` code classes; class values are CSS-only and not executable); every other tag carries no attributes. Every `on*` event handler, `style`, `src`, `srcset`, and any other attribute is stripped by omission.
- **Allowed URL schemes:** `http`, `https`, `mailto`. `javascript:`, `data:`, `vbscript:`, and any other absolute scheme are rejected; relative, anchor, and protocol-relative URLs pass. The scheme is read after stripping leading and embedded control characters (tab, newline, NUL — the bytes browsers ignore before resolving a scheme), so `java\tscript:` cannot smuggle past.

If `showdown` or `highlight.js` fails to load or throws, a prose field falls back to its raw text rendered as a single text node, so the UI stays readable instead of blank.


## Mitigations

- **Prompt-injection resistance (primary).** Because the workspace is untrusted and the model is trusted, the main defense is preventing workspace content from coercing the model: workspace isolation, egress restriction, and Guild prompts designed to resist injection (ignoring embedded instructions to override safety rules, treating file contents as data rather than commands). The display-layer sanitizer in the web client is a secondary backstop, not the primary line.
- **Workspace isolation.** The executor modifies the mounted project at `/workspace` in place. File tools canonicalize paths and reject any that resolve outside the workspace. Runs are sequential (one at a time), so there is no concurrent-run isolation concern.
- **Path canonicalization.** File tools resolve paths relative to the workspace, canonicalize them, and reject any that escape.
- **Tool exposure is a Guild decision.** The executor only exposes tools to a role if the role explicitly lists them. A Guild author can remove `run_shell` if it is not needed.
- **`run_shell` containment.** `run_shell` ships only after per-run environment isolation lands. Containment comes from the isolation environment, not from an in-tool command allowlist. An in-tool allowlist is a deferred enhancement, not the v1 path.
- **Secrets.** API keys are passed through environment variables, not stored in the Guild or workspace.

## What the design does not prevent

- A deliberately destructive task given by a legitimate user. The executor does not second-guess the user; it only contains execution to the workspace.
- A model that destructively modifies files inside the workspace. This is expected behavior for coding tasks; isolation prevents damage elsewhere.
- The model itself acting maliciously. The model is a trusted component and is not treated as an adversary; if it were compromised that would be a trusted-component failure outside this threat model. The design defends against the workspace coercing the model, not against the model.
- Resource exhaustion within budget limits. The executor enforces timeouts and budgets, but a malicious workspace input could still trigger expensive computations within those limits.

## Foundry implications

The Foundry may propose Guild changes that expose new tools or broaden existing ones. A branch that weakens workspace isolation or prompt-injection resistance should fail validation before reaching the baseline. Review of Foundry reports should include checking which tools were added or removed, and whether prompt changes make the model more susceptible to coercion by workspace content.
