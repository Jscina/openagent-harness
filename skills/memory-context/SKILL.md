---
name: memory-context
description: >
  Assemble a focused context payload for a memory card via the memory_context tool, pulling from
  the card's context.md/trace.md/benchmarks.md and relevant system/ knowledge. Use this skill when
  resuming a session, starting a new AI analysis session on an existing card, or asking "what do
  we know about CARD-XXXXX" / "get me up to speed on [card/issue]". Load memory (router) first if
  unfamiliar with the two-layer corpus.
---

# Memory Context

Assemble prior context for a card by calling the `memory_context` tool, before repeating work
someone (possibly you, in a previous session) already did.

## Tool call

```
memory_context({ cardId, mode?, sections? })
```

- **`cardId`** (required) — the card's id.
- **`mode`** — `"compact"` (default) or `"full"`.
  - `compact` — `context.md` and `benchmarks.md` in full; `trace.md` limited to the last 10
    entries; `system/` sections shown as headings only. Use for a quick resume.
  - `full` — everything in full, including the complete trace and full `system/` file contents.
    Use for a deep dive when compact isn't enough.
- **`sections`** — optional array to scope which `system/` subfolders to pull in (e.g.
  `["known-behaviors", "schemas"]`). Omit to auto-include every `system/` subfolder that has at
  least one `.md` file.

## When to use

Call this **at the start of a session or investigation**, before doing any analysis, to check
whether prior findings already answer the question. Skipping this step is how the same dead end
gets re-investigated by a later session that never saw the earlier `ruled-out` entry.

## Output

A single markdown document assembled from the card's `context.md`, `trace.md`, `benchmarks.md`,
and the selected `system/` knowledge — ready to read directly or paste as the opening context of a
new analysis session. It is generated fresh on every call, not cached.

## After loading

Keep going with `memory-trace` as new findings surface, and `memory-promote` for anything that
turns out to be durable beyond this card.
