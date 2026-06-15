# Overview

## Purpose

The orchestrator is a system that enables a small, locally-hosted language model to perform complex multi-step tasks that would normally require a much larger model. It does this by breaking work into roles, invoking those roles in a recursive call graph, using tools, verifying results, and recovering from errors.

The key insight is that the small model does not need to be inherently capable of "thinking big." Instead, it must be capable of following narrow instructions, calling tools, and returning structured results. A larger model (the Foundry) is used offline to discover exactly which instructions, roles, tools, and workflows make the small model successful.

## Goals

- **Make consumer hardware sufficient.** The final product targets a single model running on a consumer GPU or CPU, such as a ~27B parameter model quantized to Q4. The executor is strictly sequential and keeps the full context window available to that one model.
- **Automate prompt and workflow optimization.** The Foundry iteratively improves the Guild configuration by running experiments, measuring outcomes, and merging the improvements.
- **Be model-agnostic at the executor layer.** The executor only requires an OpenAI-compatible chat/completions endpoint. The Foundry discovers what works for a specific model.
- **Everything in the Guild is a role or a tool.** No hard-coded workflows, no hard-coded agents, no special recovery logic. The Foundry can add, remove, or rewrite roles and tools as needed.
- **Human reviewability.** All runs, all experiments, and all Guild versions are persisted on disk in plain-text formats. A human can inspect the system without running anything.

## Core concepts

- **Executor.** The runtime that runs the small model. It loads the Guild, starts the configured entry role, dispatches tool calls, enforces safety budgets, and persists results. It never contains large-model logic.
- **Guild.** A JSON configuration plus referenced prompt and tool-manifest files. It describes the model endpoint, the roles, the available tools, context policy, and runtime budgets. The Guild is the artifact being optimized.
- **Foundry.** An offline process driven by a large model. It reads completed run traces, proposes hypotheses for improving the Guild, runs experiments against a benchmark suite, and merges successful changes back into the Guild.

## Intended use cases

- **Agentic coding on consumer hardware.** A user gives a high-level task ("add user authentication to this NestJS app"), and the orchestrator plans, writes code, runs tests, reviews security, and integrates the result.
- **General multi-step problem solving.** The same executor and Guild can be applied to writing, analysis, planning, or research tasks, because the planner/router role is part of the Guild and can be optimized by the Foundry.
- **Prompt/workflow distillation.** A developer or organization uses the Foundry to produce a polished Guild that can be distributed so end-users can run complex agent workflows on cheap, local models.
- **Continuous improvement.** As new local models are released, the Foundry can rebuild the Guild to take advantage of changed capabilities without rewriting the executor.

## Non-goals

- The executor is not a general-purpose programming framework and does not replace LangChain, CrewAI, or similar libraries.
- The Foundry is not designed to optimize arbitrary codebases; it optimizes the Guild configuration for the executor.
- The first release does not support multiple concurrent LLM requests inside the executor. Parallelism is reserved for the Foundry.
