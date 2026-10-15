---
name: memory
description: >
  Router for the two-layer investigation memory system — system/ (durable, committed knowledge)
  and issues/ (per-investigation cards) under .opencode/memory/. Memory use is mandatory; card
  ids are optional (no-card/system mode when there is no ticket). Use this skill for ANY
  interaction with the memory_card, memory_trace, memory_context, or memory_promote tools,
  including starting or resuming an investigation, logging a finding, checking prior context,
  or promoting something durable. Routes to memory-card, memory-trace, memory-context, or
  memory-promote based on where you are in the workflow. Triggers include any mention of
  "memory card", "investigation card", "trace log", "log a finding", "promote finding",
  "system knowledge", "resume investigation", or "what do we know about".
---

# Memory — Router

Master skill for the investigation memory corpus at `.opencode/memory/`. Read this first, then
load the matching sub-skill for the actual operation.

**No CLI.** Every operation happens through a tool call — `memory_card`, `memory_trace`,
`memory_context`, `memory_promote` — registered by the harness plugin. There is no
`rag-new-card`/`rag-trace`-style script to shell out to. This is the one deliberate difference
from the `rag` plugin this design is derived from.

## Two-layer model

```
.opencode/memory/
├── system/                        ← durable, committed knowledge
│   ├── architecture/               repo maps, integration topology, deployment layout
│   ├── schemas/                    DDL summaries, table relationships, schema quirks
│   ├── services/                   per-service behavior, config edge cases, controller quirks
│   └── known-behaviors/            promoted findings — confirmed system behaviors
└── issues/                        ← per-investigation cards
    ├── backlog/CARD-XXXXX/         planned, not yet active — context.md only
    ├── active/CARD-XXXXX/          under investigation — context.md, trace.md, benchmarks.md, artifacts/
    ├── done/CARD-XXXXX/            finished locally, per-dev, never committed
    └── archive/CARD-XXXXX/         finished, durable, committed (trace.md excluded)
```

Each card directory holds:
- `context.md` — issue ID, source, symptom, repos, related issues
- `trace.md` — append-only investigation log (local working state only)
- `benchmarks.md` — benchmark-moment tracking for this card
- `artifacts/` — code snippets, DDL excerpts, log samples

First call to `memory_card` auto-scaffolds the whole tree (README/BENCHMARKS/`.gitignore`/etc.) if
it doesn't exist yet — there is no separate init tool.

## Memory is mandatory; card id is optional

Using memory is **required**, not optional. A card id is **not**: it exists only when real work has
a ticket (ADO number, bug id, prod issue). Outside work context there is no card — use **no-card
(system) mode**: call `memory_context` and `memory_promote` without `cardId`, and they read/write
`system/` knowledge only. Never invent a card id, and never ask the user for one just to satisfy
memory.

### Auto-injected preamble

Every harness task prompt is auto-prefixed with a `<memory-context>` block — the card's context if
the plan has a `card_id`, else `system/` knowledge. Read it first. Respect its `ruled-out` entries.

### Tool gating

| Tool | Agents allowed | `cardId` |
|---|---|---|
| `memory_context` | all agents except `builder-junior` | optional |
| `memory_card` | orchestrator, debugger | required |
| `memory_trace` | orchestrator, builder, debugger, consultant | required |
| `memory_promote` | orchestrator, debugger, consultant | optional |

`builder-junior` has no memory tools; it only reads the injected preamble.

### Ack gate

The planner's `plan_task` and the orchestrator's `submit_plan` / `submit_workflow` are rejected
until that session has called `memory_context`. Calling it with **no** `cardId` counts. Planner
passes `card_id` on every `plan_task` when a card exists; `save_plan` persists it, and task
completion/failure is then auto-traced to the card.

## Decision guidance

| Situation | Sub-skill |
|---|---|
| Starting work on a real ticket/bug/prod issue that has no card yet | `memory-card` |
| Start of any session or task (card or no card) | `memory-context` — **mandatory first step** |
| Actively investigating a card — found something, ruled something out, have a hypothesis, know the next step | `memory-trace` — **log as you find it, not at the end** (card required) |
| Confirmed finding that matters beyond this one card — or any durable finding in no-card mode | `memory-promote` |

The most common mistake is treating `memory-trace` as an end-of-session summary step. It isn't —
call it inline, every time you learn something, so a dropped session never loses the finding.

## Commit boundary

The corpus ships its own nested `.opencode/memory/.gitignore`, written by `scaffoldCorpus()`:

- **Ignored** (local working state): `issues/backlog/`, `issues/active/`, `issues/done/`, and
  **every** `trace.md` anywhere — including inside `issues/archive/`.
- **Committed**: `system/**` and `issues/archive/**` minus `trace.md` (i.e. `context.md`,
  `benchmarks.md`, `artifacts/`).

That nested `.gitignore` only controls what's committed *within* `.opencode/memory/`. It cannot
help if something upstream already ignores `.opencode/` wholesale.

### This harness repo specifically

This repo's own root `.gitignore` ignores `.opencode/` outright (by design — it holds generated
plan artifacts too, see `AGENTS.md`). That rule is untouched by this skill and should stay that
way for this repo.

### Consumer projects adopting this harness

If a **different** project installs this harness and wants its memory corpus to actually reach
Git, a root `.opencode/` ignore rule (common for tools like this) will swallow
`.opencode/memory/` along with everything else. Fix it with a negation snippet in that project's
own root `.gitignore`:

```gitignore
.opencode/*
!.opencode/memory/
```

This ignores everything else under `.opencode/` but lets the memory corpus through. The corpus's
own nested `.gitignore` (above) then still excludes the local-only card state — so the net effect
is exactly the intended boundary: `system/` and `issues/archive/` (sans `trace.md`) committed,
everything else local.
