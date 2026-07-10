---
name: memory-promote
description: >
  Promote a confirmed, durable finding from a memory card into system/ knowledge via the
  memory_promote tool. Use this skill when the user says "promote this finding", "this is a
  benchmark moment", "add to system knowledge", "this belongs in known-behaviors", or otherwise
  indicates a confirmed finding reveals something durable about the system's architecture,
  schema, or service behavior. Load memory (router) first if unfamiliar with the two-layer corpus.
---

# Memory Promote

Write a confirmed, durable finding from an investigation card into `system/` by calling the
`memory_promote` tool.

## Tool call

```
memory_promote({ cardId, finding, impact?, targetPath, title?, sectionTitle? })
```

- **`cardId`** (required) — the card the finding came from. Must not be a `backlog/` card.
- **`finding`** (required) — the durable insight, written to stand on its own outside this card's
  context. Must not be empty.
- **`impact`** — what this affects going forward. Optional but strongly recommended — a finding
  without stated impact is harder for a future reader to act on.
- **`targetPath`** (required) — path **relative to `system/`**, e.g. `known-behaviors/foo.md`.
  Must stay under `system/` (no `..`, no absolute paths). If the file already exists, the finding
  is appended as a new section; if not, a new file is created with frontmatter.
- **`title`** — the document's H1 title. Used only when creating a new file; ignored (existing
  title kept) when appending to one that already exists.
- **`sectionTitle`** — heading for this specific finding's section within the target file. Falls
  back to `title`, then `"Finding"`, if omitted.

## Promote sparingly

Not every trace entry deserves promotion. Promote only findings that will matter **beyond this one
investigation** — a real architecture fact, a schema quirk, a service behavior that would recur
across future issues. If a finding only explains why *this specific* card behaved the way it did,
leave it in `trace.md` and don't call this tool.

Good candidates: a hard-coded constant that causes a class of failures, an undocumented schema
relationship, a service interaction pattern that silently misbehaves in a known edge case.

Bad candidates: "the bug in this PR was a typo on line 42" — true, but doesn't generalize.

## What this does NOT touch

`memory_promote` never touches `trace.md`. It writes/appends to the `system/` target file and
appends a `promoted` entry to the card's `benchmarks.md`. If a `pending` benchmark entry already
exists for this finding, this call is what turns it into `promoted` — but the tool itself doesn't
read `benchmarks.md` for pending entries, so track that manually if the corpus is using that
convention.

## Before closing a card

When wrapping up an investigation, sweep `trace.md` for findings that turned out to be durable but
were never promoted — don't let good findings get stranded in a card that's about to move to
`done/` (local, effectively lost) or `archive/` (committed, but no longer actively read).
