---
name: memory-context
description: >
  Load prior knowledge via the memory_context tool — a card's context.md/trace.md/benchmarks.md
  plus relevant system/ knowledge, or system/ knowledge alone when there is no card. MANDATORY at
  the start of every session, task, or investigation. Use when resuming a session, starting a new
  analysis, or asking "what do we know about CARD-XXXXX" / "get me up to speed". cardId is
  optional: omit it outside work context (no ticket). Load memory (router) first if unfamiliar
  with the two-layer corpus.
---

# Memory Context

Load prior context by calling the `memory_context` tool, before repeating work someone (possibly
you, in a previous session) already did. This is **mandatory** — not a nice-to-have.

## Tool call

```
memory_context({ cardId?, mode?, sections? })
```

- **`cardId`** (optional) — the card's id. Pass it when a real ticket/card exists. **Omit it** in
  no-card (system) mode: the tool returns `system/` knowledge only. Never invent an id.
- **`mode`** — `"compact"` (default) or `"full"`.
  - `compact` — `context.md` and `benchmarks.md` in full; `trace.md` limited to the last 10
    entries; `system/` sections shown as headings only. Use for a quick resume.
  - `full` — everything in full, including the complete trace and full `system/` file contents.
    Use for a deep dive when compact isn't enough.
- **`sections`** — optional array to scope which `system/` subfolders to pull in (e.g.
  `["known-behaviors", "schemas"]`). Omit to auto-include every `system/` subfolder that has at
  least one `.md` file.

## When to use

Call this **at the start of every session or task**, before doing any analysis, to check whether
prior findings already answer the question. Skipping this step is how the same dead end gets
re-investigated by a later session that never saw the earlier `ruled-out` entry.

- Ticket/card id known → `memory_context({ cardId })`.
- No ticket (general question, system-level work) → `memory_context({})`.

## Auto-injected preamble and ack gate

Every harness task prompt already begins with a `<memory-context>` block (card context if the plan
has a `card_id`, else `system/` knowledge). Read it first; call the tool yourself when you need more
depth (`mode: "full"`, specific `sections`).

The planner's `plan_task` and the orchestrator's `submit_plan` / `submit_workflow` are rejected
until that session has called `memory_context`. A call with no `cardId` satisfies the gate.

Allowed for every agent except `builder-junior` (which relies on the injected preamble).

## Output

A single markdown document assembled from the card's `context.md`, `trace.md`, `benchmarks.md`
(when a card is given) and the selected `system/` knowledge. Generated fresh on every call, not
cached.

## After loading

With a card: keep going with `memory-trace` as new findings surface, and `memory-promote` for
anything durable beyond the card. Without a card: use `memory-promote` (no `cardId`) for durable
findings.
