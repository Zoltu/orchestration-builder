# Guild Configuration

## What the Guild is

The Guild is the entire behavior of the orchestrator described as JSON. When the executor runs, it loads the Guild and does only what the Guild instructs.

The Guild contains:

- How to connect to the target model.
- Runtime budgets and safety limits.
- Context policy.
- Role definitions (agents).
- Tool manifests.
- The name of the entry role.

There is no workflow graph, no hard-coded planner, no hard-coded recovery flow, and no hard-coded compaction logic. Every workflow emerges from roles calling tools, including the built-in `agent` tool that invokes other roles.

## Files

A Guild is stored under a folder (conventionally `guild/`):

```
guild/
├── guild.json           # top-level configuration
├── prompts/
│   ├── orchestrator.md
│   ├── planner.md
│   ├── coder.md
│   ├── critic.md
│   └── context_manager.md
└── tools/
    ├── read_file.json
    ├── write_file.json
    ├── run_shell.json
    ├── agent.json
    ├── finish.json
    ├── context_info.json
    ├── edit_context.json
    └── ask_human.json
```

System prompts and tool manifests are plain files so that the Foundry can rewrite them independently without touching the rest of the configuration.

## Top-level schema

```json
{
  "schemaVersion": 1,
  "model": { ... },
  "executor": { ... },
  "contextPolicy": { ... },
  "entryRole": "orchestrator",
  "roles": { ... },
  "tools": [ ... ]
}
```

### `schemaVersion`

An integer that identifies the Guild format version. The executor uses this to decide how to parse the file. When the format changes, older Guilds can be migrated or rejected with a clear error.

### Guild validation

A `guild.schema.json` file accompanies the executor. A `guild validate <path>` command checks that `guild.json` matches the schema, that all referenced prompt files and tool manifests exist, and that every role’s `tools` array references declared tool names. This catches malformed Guilds before a run starts.

### `model`

```json
{
  "name": "qwen2.5-coder:32b",
  "apiBase": "http://localhost:11434/v1",
  "apiKey": "",
  "contextWindow": 32768,
  "reasoningField": "reasoning",
  "generation": {
    "temperature": 0.2,
    "maxTokens": 4096
  }
}
```

- `name`: arbitrary label for logs and reports.
- `apiBase`: OpenAI-compatible chat/completions endpoint.
- `apiKey`: optional API key.
- `contextWindow`: context window size in tokens.
- `reasoningField`: name of the field in the API response that contains reasoning content, if any. Common values are `reasoning` and `reasoning_content`. If the endpoint does not expose reasoning separately, this field is omitted and reasoning is treated as empty.
- `generation`: default sampling parameters. Roles may override `temperature` and `maxTokens`.

### `executor`

```json
{
  "executor": {
    "maxAgentDepth": 8,
    "maxToolCallsPerRole": 50,
    "maxTokensPerRole": 60000,
    "maxRunTimeSeconds": 300,
    "defaultToolTimeoutSeconds": 30,
    "maxRepeatedToolCalls": 3,
    "maxCompactionAttempts": 5
  }
}
```

These budgets are enforced by the executor regardless of what a role tries to do.

### `contextPolicy`

```json
{
  "contextPolicy": {
    "maxToolOutputChars": 4000
  }
}
```

- `maxToolOutputChars`: tool results longer than this are truncated inline, with a pointer to the full artifact stored on disk under `data/runs/<run_id>/workspace/`.

There is no automatic compaction threshold. Roles use the `context_info` and `edit_context` tools to manage context.

### `entryRole`

A string naming the role that receives the user’s goal. Conventionally this is a high-level orchestrator role, but it can be any defined role.

### `roles`

Each role is a map from role name to a role definition:

```json
{
  "orchestrator": {
    "systemPrompt": "guild/prompts/orchestrator.md",
    "tools": ["agent", "finish", "ask_human"],
    "generation": {
      "temperature": 0.3,
      "maxTokens": 2048
    },
    "budget": {
      "maxToolCalls": 30
    }
  },
  "planner": {
    "systemPrompt": "guild/prompts/planner.md",
    "tools": ["agent", "finish"]
  },
  "coder": {
    "systemPrompt": "guild/prompts/coder.md",
    "tools": ["read_file", "write_file", "run_shell", "agent", "finish"]
  },
  "critic": {
    "systemPrompt": "guild/prompts/critic.md",
    "tools": ["read_file", "finish"]
  },
  "context_manager": {
    "systemPrompt": "guild/prompts/context_manager.md",
    "tools": ["context_info", "edit_context", "finish"],
    "generation": {
      "temperature": 0.1,
      "maxTokens": 2048
    }
  },
  "recovery": {
    "systemPrompt": "guild/prompts/recovery.md",
    "tools": ["agent", "finish", "ask_human"],
    "generation": { "temperature": 0.2, "maxTokens": 2048 }
  }
}
```

The seed Guild should include a `context_manager` role because the executor performs no automatic compaction. It should also include a `recovery` role so the orchestrator can delegate when a child role fails.

Role fields:

- `systemPrompt` (string, required): path to a Markdown file containing the system prompt.
- `tools` (array of strings, required): names of tools this role may call.
- `generation` (object, optional): overrides `model.generation`.
- `includeReasoning` (boolean, optional): if `true`, reasoning blocks from previous assistant turns in this role are included in the prompt. Default `false`.
- `budget` (object, optional): per-role overrides for `maxToolCalls` and `maxTokens`.

### `tools`

A list of tool-manifest file paths. Each manifest declares:

```json
{
  "name": "read_file",
  "description": "Read a file and return its contents.",
  "parameters": {
    "type": "object",
    "required": ["path"],
    "properties": {
      "path": { "type": "string" },
      "max_lines": { "type": "number", "default": 100 }
    }
  }
}
```

The executor uses these manifests both to validate calls and to expose the tools to the model in the chat/completions request.

## Built-in tools

Built-in tools are listed in the Guild like any other tool, but their behavior is implemented inside the executor.

### `agent`

Invokes another role. The full role name is supplied as the `role` parameter. The child role receives the `task` as its initial user message and runs to completion. The child’s `finish` result is returned as the result of this tool call.

This makes the system recursive: roles are invoked through the same tool-calling mechanism as file reads and shell commands.

### `finish`

Ends the current role and returns a result card to its parent. The entry role’s `finish` ends the whole run.

### `context_info`

Returns metadata about the current role’s conversation, including token usage per message and reasoning presence.

### `edit_context`

Mutates the current role’s conversation. Available only to roles whose tool list includes it.

### `ask_human`

Asks a human for clarification. The role provides a `question` and optional `context`.

The tool schema is the same in every environment. Only the backend changes:

- During **Foundry optimization**, the Foundry's large model answers as a simulated persona.
- In the **final product**, the question is surfaced in the web UI and the run waits until the user answers.

The Guild must include `ask_human` in a role's tool list for that role to ask questions. The tool set visible to the small model must be the same during optimization and deployment; only the answer backend is selected at runtime.

## Native tools

Native tools are implemented in the executor. A typical seed Guild includes at least:

- `read_file`
- `write_file`
- `list_directory`
- `run_shell`

Each tool manifest describes parameters. The executor executes them against the run workspace.

## Tool availability and fine-tuning consistency

The set of tools a role is allowed to call is part of the Guild. The same Guild is used during Foundry optimization and during final-product execution, so the small model always sees the same tool names and schemas. The executor does not hide tools conditionally.

This is especially important for `ask_human`:

- If `ask_human` is present in the optimized Guild, it must also be available in the deployed product.
- If it is absent during optimization, it must remain absent in the product.

The runtime only changes the *backend* that answers the question, not the tool itself.

## Workflows are not declared

There is no separate graph or playbook file. A workflow is just a role calling `agent` multiple times and combining the results before calling `finish`.

For example, an adversarial review workflow can be implemented entirely inside the `orchestrator` role:

1. Call `agent:planner` with the goal.
2. Call `agent:critic` with the plan.
3. Call `agent:judge` or synthesize the result locally.
4. Call `agent:coder` if the plan survives critique.
5. Call `finish`.

If the Foundry decides it wants a different workflow, it rewrites the orchestrator prompt or adds/removes roles.

## Example `guild.json`

```json
{
  "schemaVersion": 1,

  "model": {
    "name": "qwen2.5-coder:32b",
    "apiBase": "http://localhost:11434/v1",
    "apiKey": "",
    "contextWindow": 32768,
    "reasoningField": "reasoning",
    "generation": {
      "temperature": 0.2,
      "maxTokens": 4096
    }
  },

  "executor": {
    "maxAgentDepth": 8,
    "maxToolCallsPerRole": 50,
    "maxTokensPerRole": 60000,
    "maxRunTimeSeconds": 300,
    "defaultToolTimeoutSeconds": 30,
    "maxRepeatedToolCalls": 3,
    "maxCompactionAttempts": 5
  },

  "contextPolicy": {
    "maxToolOutputChars": 4000
  },

  "entryRole": "orchestrator",

  "roles": {
    "orchestrator": {
      "systemPrompt": "guild/prompts/orchestrator.md",
      "tools": ["agent", "finish", "ask_human"],
      "generation": { "temperature": 0.3, "maxTokens": 2048 }
    },
    "planner": {
      "systemPrompt": "guild/prompts/planner.md",
      "tools": ["agent", "finish"]
    },
    "coder": {
      "systemPrompt": "guild/prompts/coder.md",
      "tools": ["read_file", "write_file", "run_shell", "agent", "finish"]
    },
    "critic": {
      "systemPrompt": "guild/prompts/critic.md",
      "tools": ["read_file", "finish"]
    },
    "context_manager": {
      "systemPrompt": "guild/prompts/context_manager.md",
      "tools": ["context_info", "edit_context", "finish"],
      "generation": { "temperature": 0.1, "maxTokens": 2048 }
    },
    "recovery": {
      "systemPrompt": "guild/prompts/recovery.md",
      "tools": ["agent", "finish", "ask_human"],
      "generation": { "temperature": 0.2, "maxTokens": 2048 }
    }
  },

  "tools": [
    "guild/tools/agent.json",
    "guild/tools/finish.json",
    "guild/tools/context_info.json",
    "guild/tools/edit_context.json",
    "guild/tools/ask_human.json",
    "guild/tools/read_file.json",
    "guild/tools/write_file.json",
    "guild/tools/run_shell.json",
    "guild/tools/list_directory.json"
  ]
}
```
