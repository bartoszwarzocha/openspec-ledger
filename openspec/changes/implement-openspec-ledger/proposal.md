## Why

OpenSpec records intent as a checklist. When an agent does the work, the agent ticks its own
boxes, and nothing downstream checks the tick. A `- [x]` is a character in a markdown file.

Seven extensions already render that file. Measured on the reference environment
(`D:\work\projects`, 2026-09-04), what they render is not enough to run a project:

- **33 active changes across 14 `openspec/` roots**, nine of them in sibling repositories
  under a single opened folder. No existing extension discovers those — spek activates on
  `openspec/config.yaml` at the workspace root, Task Viewer groups by opened workspace
  folder. Both find nothing here.
- **10 changes are at 100% and still sitting in `changes/`.** Complete, never archived,
  indistinguishable at a glance from work in progress.
- **8 changes are one task short of done**, one at 61/63. A percentage cannot tell "finished
  yesterday" from "abandoned in July", because no extension remembers yesterday.
- **4 changes have no `tasks.md`.** Every progress display reads them as 0%, which is wrong:
  they are proposals that were never decomposed, not work that stalled.
- **~2,950 references to `openspec/changes/<name>` sit in 30 Claude Code transcripts** —
  an unread record of which agent session touched which change, for how long, at what cost.

The gap is not rendering. It is that nobody asks whether the checklist is telling the truth,
and nobody asks whether it is moving.

## What Changes

- **Discover `openspec/` roots recursively** under every open workspace folder, not only at
  its root, with the exclusion set and result cache needed to keep it off the activation path
- **Parse the change model** — `.openspec.yaml`, `proposal.md`, `design.md`, and `tasks.md`
  into sections and indent-nested tasks, with a first-class representation for a change that
  has no `tasks.md` rather than folding it into 0%
- **Render a Ledger tree** in the Activity Bar: root → change → section → task, with progress
  at every level, sort modes including *stalled longest* and *ready to archive*, jump-to-line,
  and checkbox toggling written back to `tasks.md`
- **Record progress history** — a snapshot per change per day in extension storage, backfilled
  on first run by replaying `git log` over each `tasks.md`, so the tree is useful immediately
  instead of after a fortnight of collecting
- **Derive a git evidence signal** — for each completed task, extract the file paths and code
  symbols it names and look for a commit after the tick that touched them; surface *no trace
  found* as a reviewable signal with the exact command behind it
- **Derive Claude Code provenance** — bind transcripts to changes by the change path appearing
  in prompts and tool calls, and report per change which sessions worked on it, when, at what
  token and dollar cost, and which source files they edited
- **Hand a task to the agent** — send a prompt naming the change, the task and its file to a
  Claude Code terminal, with a clipboard fallback

## Capabilities

### New Capabilities

- `workspace-discovery`: Recursive location of `openspec/` roots across workspace folders,
  configuration parsing, exclusion handling, invalidation and caching.
- `change-model`: The in-memory model of a change — metadata, documents, task sections,
  nested tasks, progress arithmetic, and the no-`tasks.md` case.
- `ledger-tree-view`: The Activity Bar tree, its labels, badges, sort and filter modes,
  navigation commands and checkbox write-back.
- `progress-history`: Dated progress snapshots, `git log` backfill, movement and stall
  derivation, and the storage contract.
- `git-evidence`: Extraction of file and symbol references from task text, commit matching
  after the completion date, and the presentation of a heuristic signal.
- `claude-code-evidence`: Transcript discovery and parsing, change binding, per-change
  session/cost/file attribution, and the checked-without-touching-code signal.
- `agent-handoff`: Prompt construction and delivery to a Claude Code terminal, with fallback.

### Modified Capabilities

_(None — this is the first change in a new project.)_

## Impact

- **New repository.** No existing code is modified. The extension is standalone and depends
  on no other extension being installed.
- **Performance.** Discovery must not block activation; the extension activates on
  `onStartupFinished` and populates the tree asynchronously. Transcript parsing (~100 MB of
  JSONL in the reference environment) is lazy, on demand per change, and cached by
  mtime+size. Budgets are stated per operation in `design.md` and asserted in tasks.
- **Writes to user repositories.** Exactly one: toggling a checkbox rewrites the single line
  in `tasks.md`. Nothing else in the repository is touched, and history is stored outside it.
- **Privacy.** Transcripts contain prompt text. The extension reads them locally, displays
  only derived aggregates plus file paths, never transmits anything, and the entire
  Claude Code evidence layer is off unless enabled.
- **External tools.** `git` must be on `PATH` for history backfill and the evidence signal.
  Absence degrades those two features to an explanatory empty state; the rest works.
- **Upstream risk.** OpenSpec's answer to multi-repo is Stores (beta) — a separate planning
  repository. If adopted, recursive discovery becomes unnecessary, but the evidence layers
  are unaffected because they bind to change names, not paths. Discovery is designed so that
  a Stores layout degrades to a single root rather than to an error.
- **Out of scope for this change**: authoring or editing proposals, specs and designs;
  invoking the OpenSpec CLI; archiving changes; Copilot or any non-Claude agent; the
  Stores (beta) layout as a first-class source.
