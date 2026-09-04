# OpenSpec Ledger

A VS Code extension that audits OpenSpec changes instead of merely displaying them.

## The problem

OpenSpec gives a change a `tasks.md` with a checklist. When a coding agent does the work,
the same agent ticks the boxes. Nothing verifies the tick, and nothing records when it
happened. Over a few weeks a repository accumulates changes that look finished, changes
that look nearly finished but have not moved in a month, and changes that were completed
and never archived — and none of that is visible from the checklist alone.

## What already exists

Seven extensions on the Marketplace render OpenSpec content. The two that matter:

| Extension | Installs | What it does |
|---|---|---|
| OpenSpec (Codder13) | ~8,537 | CodeLens "Start task" over `tasks.md`, injects context into the AI chat |
| OpenSpec Task Viewer (e1roy) | ~201 | Sidebar tree, `[n/m]` progress, nested checkboxes, jump to line |

Between them they cover browsing and starting a task. All seven show the present tense
only, all seven trust the checkbox, and all seven target GitHub Copilot.

## What this project adds

1. **Movement.** Daily progress snapshots, backfilled from `git log` on first run, so a
   change can be sorted by *how long it has been stuck* rather than by percent complete.
2. **Corroboration.** For each completed task, whether any commit after the tick touched
   the files and symbols the task names. Reported as a missing-trace signal, never as an
   accusation.
3. **Provenance.** Which Claude Code sessions worked on a change, when, at what token and
   dollar cost, and which files they actually modified — read from the transcripts Claude
   Code already writes to disk.

Item 3 is not reproducible by the incumbents: they integrate with Copilot, which leaves no
comparable on-disk record.

## Scope boundaries

The extension reads OpenSpec content and writes exactly two things: a checkbox toggle in
`tasks.md` when the user clicks one, and its own history file in extension storage. It does
not author proposals, does not run the OpenSpec CLI, and does not replace the agent.

## Reference environment

Developed against `D:\work\projects` — 14 `openspec/` roots, 33 active changes, nine
of them in sibling repositories under a single opened folder, and 30 Claude Code
transcripts referencing change paths. Any design that only works for a single `openspec/`
at the workspace root is wrong for this environment.
