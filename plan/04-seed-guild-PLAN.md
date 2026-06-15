# Phase 4 — Seed Guild

## Goal

Create a hand-written Guild that can perform end-to-end coding tasks for non-developers. The Guild must be runnable by the executor built in Phases 1–3 and should demonstrate planning, delegation, recovery, and context management.

## Deliverables

1. `guild/guild.json` — top-level configuration:
   - Model endpoint defaults (OpenAI-compatible).
   - Executor budgets suitable for long-horizon runs (depth 8, tool calls 50 per role, multi-hour runtime allowed).
   - `contextPolicy.maxToolOutputChars` set to a reasonable default.
   - Entry role: `orchestrator`.
   - Roles: `orchestrator`, `planner`, `coder`, `critic`, `context_manager`, `recovery`.
   - Tool manifest paths for all v1 tools.

2. `guild/prompts/orchestrator.md` — system prompt:
   - Greet the user, ask at most 1–2 clarifying questions only when a reasonable guess cannot be made.
   - Delegate to `planner` for large or ambiguous tasks.
   - Delegate to `coder` for implementation.
   - Delegate to `critic` for review.
   - Use `recovery` when a child role returns an error.
   - Finish with a plain-language summary and list of artifacts.

3. `guild/prompts/planner.md` — system prompt:
   - Break the user goal into numbered steps.
   - Identify which files need to be read or created.
   - Propose a verification step before finishing.

4. `guild/prompts/coder.md` — system prompt:
   - Read relevant files before editing.
   - Write complete, syntactically valid files.
   - Prefer small, testable changes.
   - Call `finish` with artifacts and a short summary.

5. `guild/prompts/critic.md` — system prompt:
   - Review a plan or code against the original task.
   - Report concrete issues and suggestions.
   - Call `finish` with `status: "success"` if acceptable, otherwise explain why.

6. `guild/prompts/context_manager.md` — system prompt:
   - Use `context_info` and `edit_context` to reduce token usage.
   - Preserve system prompt, user task, and most recent reasoning.
   - Call `finish` when done.

7. `guild/prompts/recovery.md` — system prompt:
   - Receive an error result card and decide: retry, re-delegate, ask human, or escalate.
   - Return a new `agent` call or `finish` with `status: "error"`.

8. `guild/tools/*.json` — tool manifests for all v1 tools:
   - `agent.json`, `finish.json`, `context_info.json`, `edit_context.json`, `ask_human.json`
   - `list_directory.json`, `glob_files.json`, `read_file.json`, `read_file_partial.json`, `search_text.json`, `fetch_url.json`

## Non-developer design notes

- Avoid assuming the user knows technical terms. Prompts can instruct the agent to explain them when used.
- Encourage the orchestrator to make reasonable defaults and tell the user what it is doing.
- Error recovery should not dump stack traces to the user; it should summarize in plain language.

## Module boundaries

- The Guild is data, not code. It lives under `guild/`.
- No TypeScript source files are added in this phase except perhaps a validation script to check that `guild.json` loads cleanly.

## Acceptance criteria

- [ ] `guild/guild.json` passes the loader and schema validation from Phase 1.
- [ ] All referenced prompt files and tool manifests exist.
- [ ] Every role’s `tools` array contains only tools declared in the Guild.
- [ ] The orchestrator prompt contains explicit guidance on when to ask clarifying questions.
- [ ] The recovery role prompt lists the available error kinds and how to handle them.

## Estimated effort

Small to medium — mostly writing and iterating on prompts.
