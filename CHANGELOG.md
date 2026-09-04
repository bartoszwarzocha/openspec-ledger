# Changelog

All notable changes to OpenSpec Ledger are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The version numbers follow the phasing set out in the change proposal: each release ends in
something demonstrable rather than in a half-finished layer.

## [0.1.0] - 2026-09-04

First release: parity with the existing OpenSpec extensions, plus the two things none of them
does — finding roots at any depth, and remembering yesterday. Requires VS Code 1.104 or later.
`git` on `PATH` is optional; without it, history backfill and git evidence degrade to an explained
empty state and everything else works.

### Added

- **Recursive discovery.** `openspec/` roots are found at any depth beneath the open folders, not
  only at a folder's root. A root is accepted with `openspec/config.yaml` or with
  `openspec/changes/`, so a hand-made or Stores-style layout is not rejected. Paths outside the
  workspace can be added through `openspecLedger.additionalRoots`.
- **Change model.** `.openspec.yaml`, `proposal.md`, `design.md` and `tasks.md` are parsed into
  sections and indent-nested tasks. A change with no `tasks.md` is reported as *not decomposed*
  rather than as 0 %, and is excluded from aggregates and from the stalled ranking.
- **Ledger tree.** Root → change → section → task in the Activity Bar, with progress at every
  level, five sort modes including *stalled longest* and *nearest done*, a ready-to-archive
  filter and title badge, jump-to-line, and checkbox toggling written back to `tasks.md` through
  a workspace edit that can be undone.
- **Progress history.** One snapshot per change per day in extension storage, backfilled on first
  run by replaying `git log` over each `tasks.md`, so movement and stall figures are available
  immediately instead of after a fortnight of collecting.
- **Movement report.** A markdown report over any period listing what moved, what did not, and
  how long each change has been still.
- **Git evidence** (off by default). For each completed task, whether a commit after the tick
  touched the files and symbols the task names. Reported as *no trace found*, with the references
  searched, the window and the exact commands — never as an accusation.
- **Claude Code provenance** (off by default). Which sessions worked on a change, when, at what
  estimated cost, and which source files they edited, read from the transcripts Claude Code
  already writes to disk. Nothing leaves the machine and no prompt text is displayed.
- **Agent handoff.** Send a task or a whole section to a Claude Code terminal, with a clipboard
  fallback. The text is written without a trailing newline, so nothing is submitted until you
  press Enter.

**Both evidence layers ship disabled.** `openspecLedger.gitEvidence.enabled` and
`openspecLedger.claudeEvidence.enabled` both default to `false`, and until one is turned on it does
nothing at all: no git command is run for evidence purposes, and no transcript file is opened.

The git layer is off because it was measured before it was trusted. Over **553 completed tasks** it
returned *no trace found* for **15.2 %** of them, and reading all 84 of those by hand showed a list
dominated by references that were never going to appear in a commit as written: CSS selectors,
JSON-schema and OpenAPI keys, and ordinary English words that happened to sit in an inline-code
span. Genuine signals were among them, but mixed with enough noise that a reader would learn to
skip the list — and a signal that has lost trust is worse than none. A narrower symbol grammar is
the obvious improvement; until that is measured, the honest default is off.

The Claude Code layer is off for a different reason: it reads files that contain your prompts.
Nothing leaves the machine and no prompt text is ever displayed, but reading them at all should be
your decision rather than a default.

[0.1.0]: https://github.com/bartoszwarzocha/openspec-ledger/releases/tag/v0.1.0
