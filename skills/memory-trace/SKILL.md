---
name: memory-trace
description: >
  Append a structured, timestamped entry to an active memory card's trace.md via the memory_trace
  tool. Use this skill whenever logging a finding, a ruled-out hypothesis, a new hypothesis, or a
  next step during an investigation. Triggers include "log finding", "found that", "ruled out X",
  "I think it might be", "next step is", "add to trace", or "update the investigation log for
  CARD-XXXXX". Load memory (router) first if unfamiliar with the two-layer corpus.
---

# Memory Trace

Append one entry to an active card's `trace.md` by calling the `memory_trace` tool.

## Tool call

```
memory_trace({ cardId, type, body, session? })
```

- **`cardId`** (required) — the card's id (raw or already-sanitized; `sanitizeCardId` normalizes
  it either way).
- **`type`** (required) — one of `"finding" | "ruled-out" | "hypothesis" | "next-step"`.
  - `finding` — confirmed through analysis.
  - `ruled-out` — a hypothesis investigated and disproven.
  - `hypothesis` — a theory not yet confirmed.
  - `next-step` — what to do next.
- **`body`** (required) — the entry content. Must not be empty/whitespace-only.
- **`session`** — optional label (defaults to `"opencode"`).

## Log as you go — not retrospectively

Call `memory_trace` **the moment you learn something**, inline during the investigation. Do not
batch findings up to write at the end of a session — a dropped session, a crash, or context
compaction loses everything that wasn't already appended. One call per finding; if several things
surface at once, call it multiple times rather than merging them into one entry.

## Write with asymmetric economy

An entry earns its tokens by what a **cold future session can recover from it**, not by prose:

- **Cut hard** — framing sentences, restated context, narrative connective tissue, hedging.
  Fragments are fine.
- **Keep verbatim** — file paths, line numbers, exact identifiers/constants, commands run, and
  error text. Never paraphrase or truncate these; they're the load-bearing content.
- Keep framing prose to roughly 2–3 sentences; let evidence run as long as it needs to.

## Active cards only

`memory_trace` only writes to cards in `issues/active/`. If the card is in `backlog/`, `done/`, or
`archive/`, the call throws naming the actual state it found — e.g. it will tell you the card is
in `issues/done/`, not active, and that you need to activate it (move it into `issues/active/`)
first. If the card doesn't exist at all, create it first with `memory-card`.

## Append-only

Every call appends a new block; nothing already in `trace.md` is ever read back, rewritten, or
reordered. Don't try to "fix" an old entry — log a new one that supersedes it instead.
