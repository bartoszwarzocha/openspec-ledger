# Changelog

All notable changes to OpenSpec Ledger are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The version numbers follow the phasing set out in the change proposal: each release ends in
something demonstrable rather than in a half-finished layer.

## [0.2.1] - 2026-09-09

### Changed

- **The archive tally chip reads `with tasks open` instead of `left unfinished`.** The old wording
  said something was unfinished but not what, and the extension's own author read it as meaning a
  change had been *partially* archived. There is no such thing — archiving moves a whole change
  directory — so the label was inviting a conclusion the feature cannot support. The new wording
  cannot be read that way and matches the row caption directly beneath it, which already says
  `archived, 3 tasks open`.

  Renamed everywhere the phrase appeared, not only on the chip: the chip sets the filter, and a
  filter whose name in the view title disagreed with the chip that selected it would be a worse
  confusion than the one being fixed.

  The tally tooltip now uses a colon — `Show only: with tasks open`. Its template joined the label
  into a sentence, which worked while every label was a single adjective and broke on a phrase.

## [0.2.0] - 2026-09-07

### Added

- **The archive, as a scope of its own.** `openspec/changes/archive/` was invisible until now.
  Two buttons — **Current** and **Archive** — sit at the top of the Overview and in the view title
  of the tree, and switch which list every surface is showing.

  It is a scope rather than a seventh filter, and the difference is the whole design: a filter is a
  lens on a list, so `All changes` has to go on meaning "everything in this list". Folding
  archiving into the filter would have put finished, moved-away work back into every count, badge
  and ranking the moment the filter was cleared. So archived changes stay out of the aggregates,
  the ready-to-archive badge, the stalled ranking, the progress history and the movement report,
  in both scopes.

  Details that follow from that:
  - An archived change is **never reported as stale**, whatever the threshold. It has not advanced
    since the day it was archived and never will, so the warning would be permanent and therefore
    worthless. The three remaining states then say the one useful thing about it: whether it was
    finished when it was put away.
  - Captions are rewritten for the archive — `archived 2026-03-03`,
    `archived 2026-05-11, 3 tasks open`, `archived, not decomposed` — because "ready to archive"
    on something already archived, and "last advanced" on something that never will again, both
    describe a state the change has left.
  - The **Archive** action is withheld from anything already in the archive, in the row button, the
    bulk button and the context menu alike.
  - Each scope remembers its own filter, and the tally's chips rename themselves where the word
    would mislead: *complete* reads *finished*, *in progress* reads *with tasks open*.
  - The ready-to-archive badge goes on counting the current scope while you are in the archive.
    Work waiting for a decision does not stop waiting because you changed view.
- **The archive date, from git.** Each archived change now carries the day it reached the archive:
  `archived 2026-03-03` in the Overview, and beside the figures in the tree.

  It is read from the commit that put the files at their archive path — one `git log` per root, not
  one per change — because the two cheap answers on disk are both wrong often enough to be worse
  than silence. A directory's mtime is reset by a fresh clone, and the date in a change's own id is
  the day it was *created*, which is exactly the figure a reader would misread as the archive date
  if it were the only one on the row. Where the history cannot answer — a shallow clone, a project
  not under version control — the caption says `archived` and stops there.

  Rename detection is switched off for that query on purpose: archiving is a pure rename, git
  reports it as `R100`, and `--diff-filter=A` would therefore miss the one commit being asked
  about.

  Because the row now carries the archive date, the creation date in the change id steps back to
  the tooltip. Two bare dates on one line, neither labelled, read as a range or as a mistake.

  The read happens **after** the archive is on screen and republishes when it lands, so a slow
  repository delays a date and never the list. A root is not asked again until its archive gains or
  loses a change.
- The archive is read from disk **only while it is on screen**, so a project with three hundred
  archived changes costs nothing on the path that draws the active list.
- The demo workspace generator now archives three changes — one finished, one shelved with work
  still in it, one never decomposed — as real commits that move the directory, so the archive in a
  screenshot is an archive a repository could actually have.
- `scripts/tree-preview.ts` takes `--archive`, printing the tree the archive scope renders.

### Changed

- **Something to look at while a pass runs.** Pressing Archive could mean reading a directory
  bigger than the active list, and until now that looked like nothing happening. The editor's own
  progress bar now appears on both views for the length of any pass the reader set off — the first
  load, Refresh, and a scope switch — the Overview draws a slim indeterminate bar and dims the rows
  it is about to replace, and the tree says *Reading the archive…* above them.

  Neither surface is rebuilt while it waits. Handing them the new scope over a model that has not
  read it yet made the archive flash *Nothing has been archived yet* and then fill in, which looked
  like the extension losing the answer and finding it again. A watcher-driven pass — an agent
  writing `tasks.md` — still draws nothing at all: a progress bar that flickers all afternoon is one
  the reader learns to stop seeing.

### Fixed

- **Clicking a change opened nothing for several seconds.** With `gitEvidence.enabled` on, a
  click produced four to five seconds of no feedback at all before the detail panel appeared —
  long enough that there was no way to tell a slow read from a click that had not registered.

  Two ordering mistakes, not a performance problem. The panel was created *after* both evidence
  layers had been awaited — the git layer runs a search per completed task, the Claude layer
  reads a transcript corpus — so the one surface that answers the click was the last thing to
  appear. And a click in the Overview ran a tree collapse and up to three reveals *before* even
  that.

  Now the panel opens immediately from what is already in memory — the change, its history, its
  stall — and each evidence layer is written into it as it answers. The two publish separately,
  so the faster one is not held behind the slower. Until a layer answers, its section carries a
  progress bar and a sentence saying what is being read, which is the difference between waiting
  and wondering. The tree navigation now runs behind the panel rather than in front of it.

  A late answer never reopens a panel the reader has closed and never steals focus back from
  wherever they moved on to. Opening the same change again supersedes and cancels the read in
  flight; opening a *different* change does not, because panels are one per change and the first
  one's answer is still wanted.

## [0.1.1] - 2026-09-04

### Added

- A screenshot in the README, and a note at the top naming the two agents the handoff and the
  provenance layer work with: Claude Code and GitHub Copilot. Everything else works with no agent
  at all, which the note says as plainly as it says the rest.

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

[0.1.1]: https://github.com/bartoszwarzocha/openspec-ledger/releases/tag/v0.1.1
[0.1.0]: https://github.com/bartoszwarzocha/openspec-ledger/releases/tag/v0.1.0
