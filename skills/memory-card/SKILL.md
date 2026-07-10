---
name: memory-card
description: >
  Create a new investigation card in the memory corpus via the memory_card tool. Use this skill
  when starting work on an ADO work item, QA bug, or production issue, or when the user says
  "new memory card", "start a card for ADO 12345", "create investigation card", "I'm starting
  work on [ticket]", "open a card", or "backlog this for later". Load memory (router) first if
  unfamiliar with the two-layer corpus.
---

# Memory Card

Create a new investigation card under `.opencode/memory/issues/active/` (or `issues/backlog/` for
planned-but-not-started work) by calling the `memory_card` tool.

## Tool call

```
memory_card({ cardId, symptom?, source?, backlog? })
```

- **`cardId`** (required) — free-form id. This org tracks work in Azure DevOps, so use the ADO
  work item convention, e.g. `ADO-12345`. `sanitizeCardId` canonicalizes it automatically —
  `ADO-12345` becomes `CARD-ADO-12345` on disk. You don't need to add the `CARD-` prefix yourself,
  and passing it twice won't double it up.
- **`symptom`** — one-line description of the problem. **Required unless `backlog: true`.**
- **`source`** — one of `"ado" | "qa" | "prod" | "other"`. Pick the one that matches where the
  work came from; defaults to `"other"` if omitted.
- **`backlog`** — set `true` to park a not-yet-started idea instead of opening an active
  investigation. Backlog cards get `context.md` only (no `trace.md`/`benchmarks.md`/`artifacts/`
  until activated by moving the card into `issues/active/`).

## No separate init step

The first call to `memory_card` auto-scaffolds the entire `.opencode/memory/` tree if it isn't
there yet — directories, `.gitignore`, `README.md`, `BENCHMARKS.md`. There is nothing to run
beforehand.

## Refusal behavior

`memory_card` refuses if a card with that (sanitized) id already exists in **any** lifecycle
state — backlog, active, done, or archive. If that happens, the card already exists: use
`memory-context` to check what's already recorded, or `memory-trace` to keep logging against it,
rather than trying to recreate it.

## After creating

- Fill in the rest of `context.md` by hand (reproduction steps, relevant repos/files, schema
  tables, related issues) — the tool only stamps the header and symptom line.
- Start logging findings with `memory-trace` as soon as you begin investigating — don't wait.
