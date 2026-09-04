# Design — implement-openspec-ledger

## Context

OpenSpec stores a change as a directory under `openspec/changes/<name>/` containing
`.openspec.yaml` (schema and creation date), `proposal.md`, usually `design.md`, usually
`tasks.md`, and a `specs/<capability>/spec.md` tree. Progress is expressed as GitHub-style
checkboxes in `tasks.md`, grouped under `## N. Section` headings and numbered `N.M`.

Seven Marketplace extensions read this. Their common shape: find `openspec/` at the
workspace root, walk `changes/`, count completed against pending checkboxes, render a tree.
The most installed one (Codder13, ~8.5k) adds a CodeLens that pushes a task into the Copilot
chat. The most complete tree (e1roy, ~201 installs, updated 2026-08-31) adds nesting,
`[n/m]` badges and grouping by workspace folder.

Three things follow from measuring the reference environment rather than assuming a
single-repo layout:

1. **Root discovery at the workspace root is wrong.** `D:\work\projects` holds 14
   `openspec/` roots; nine of them are in sibling repositories under `team/platform/`,
   which is the folder actually opened in the editor. Every existing extension finds zero
   changes here.

2. **A percentage without a date is misleading.** `route-reads-through-data-service`
   reads 61/63. So does a change that has not been touched since July. Ten changes are at
   100% and still in `changes/` rather than archived. The tree needs a time axis.

3. **The checkbox is unverified.** In agent-driven work the agent writes both the code and
   the tick. Two independent records exist on disk that can corroborate it: the git history,
   and the Claude Code transcripts — ~2,950 references to `openspec/changes/<name>` across
   30 transcript files in the reference environment.

The extension is therefore structured as a parsing core with three read-only evidence layers
stacked on top, plus one narrow write path (checkbox toggle) and one outbound path (handing a
task to the agent).

## Goals

- **Find every `openspec/` root** under the open workspace folders regardless of nesting depth,
  without blocking activation.
- **Model a change faithfully**, including the four changes in the reference environment that
  have no `tasks.md` and must not be reported as 0%.
- **Show movement, not just state** — how much a change advanced since the last snapshot, and
  how long it has been still — with the history backfilled from git so the feature is useful on
  first launch.
- **Corroborate completed tasks against the git history** and present the result as a signal
  with its provenance, never as a verdict.
- **Attribute changes to Claude Code sessions** with cost, timing and edited files, from data
  already on disk.
- **Hand a specific task to a running agent** without the user retyping the context.
- **Degrade cleanly**: no git, no transcripts, no `tasks.md`, no workspace — each has a defined,
  explained empty state.

## Non-Goals

- **Authoring.** The extension never writes `proposal.md`, `design.md` or a spec file. The one
  write it performs is toggling a checkbox line in `tasks.md`.
- **Replacing the OpenSpec CLI.** No `init`, no `validate`, no `archive`. The CLI is not invoked
  at all, so no version coupling exists.
- **A second agent integration.** Copilot, Cursor and Continue are out of scope. The evidence
  layer is specific to what Claude Code writes to disk.
- **Stores (beta) as a first-class layout.** Discovery must not break on it, but modelling a
  cross-repo planning store is a later change.
- **Scoring.** No composite "health" number. Three evidence sources are shown side by side and
  the reader draws the conclusion.
- **Editing `tasks.md` structurally.** No adding, renumbering or reordering tasks.

## Decisions

### D1. Module boundaries

```
src/
  discovery/      locating openspec roots, config.yaml parsing, watching
  model/          Change, TaskSection, Task, Progress; the parser for tasks.md
  history/        snapshot store, git-log backfill, movement + stall derivation
  evidence/
    git.ts        reference extraction, commit matching
    claude.ts     transcript discovery, change binding, cost attribution
  view/           TreeDataProvider, tree items, sorting, commands
  handoff/        prompt construction, terminal delivery
  extension.ts    activation, wiring, watchers, settings
```

The dependency direction is one-way: `view` and `handoff` depend on `model`; `history` and
`evidence` depend on `model`; `model` depends on `discovery`; nothing depends on `view`.
Each evidence layer is optional at runtime and its absence produces an empty state, not an
error — this is what makes phases 4-6 independently shippable.

### D2. Discovery uses `workspace.findFiles`, not a manual walk

`vscode.workspace.findFiles('**/openspec/config.yaml', <exclude>)` runs against the editor's
own file index, honours `files.exclude` and `search.exclude`, is cancellable, and does not
block the extension host.

Rejected: `fs.readdir` recursion. It re-walks `node_modules`, `target/`, `dist/` and `.git` on
every refresh, needs its own exclusion list and cancellation, and in the reference environment
would traverse nine Rust and Angular repositories on each pass.

Rejected: requiring the user to list roots in settings. Fourteen roots is exactly the case where
manual configuration rots.

Consequence and limit: `findFiles` searches only inside opened workspace folders. An `openspec/`
root outside them is invisible by design. A setting supplies extra absolute paths for that case.

Falling back: a root is also accepted when `openspec/changes/` exists but `config.yaml` does not,
because a Stores-style or hand-made layout may omit it.

### D3. Native `TreeDataProvider`, with a webview only for the change detail

The main surface is a tree of roots, changes, sections and tasks. `TreeDataProvider` gives
native theming, keyboard navigation, the built-in filter box, checkbox support
(`TreeItemCheckboxState`), `description`/`tooltip` slots for progress and dates, and virtualised
rendering of the ~1,100 task nodes the reference environment produces.

A webview would reimplement all of that, and would have to re-render on every file change.

The one webview is the **change detail panel**: the progress sparkline, the session list with
costs, and the evidence table. That content is tabular and graphical and has no natural tree
representation. It is opened on demand and is not part of the activation path.

### D4. What the task parser accepts

A line is a task when it matches `^(\s*)[-*] \[([ xX~-])\]\s+(.*)$`.

- Pending, complete and in-progress markers are all recognised. The in-progress marker is
  emitted by the incumbent extension; accepting it costs nothing and avoids misreporting
  in-progress work as pending.
- Nesting is by leading whitespace, tabs counted as the configured tab width. A deeper task is a
  child of the nearest shallower one.
- `## N. Title` opens a section. `#` and `###` also open sections at their own depth. Text
  outside any heading lands in an implicit unnamed section.
- The leading `N.M` in the task text is captured as its number when present and stripped from the
  label, because a numbered node reads better than a repeated prefix.

Anything unmatched is ignored, never fatal. The format is a convention, not a schema; a change
that cannot be parsed is shown with its raw file, not dropped from the tree.

Progress counts **leaf tasks only**. A parent whose children are all complete contributes one
completed leaf if it has no children, zero if it does — otherwise a nested list double-counts.

### D5. A change without `tasks.md` is a distinct state, not 0%

Four of the 33 changes in the reference environment have only `.openspec.yaml` and sometimes a
`proposal.md`. Zero percent implies work that has not started; the truth is a proposal that was
never decomposed. The model distinguishes an absent task list from an empty one, the tree renders
*not decomposed* rather than a progress badge, and such changes are excluded from progress
aggregates and from the stalled ranking.

### D6. History lives in extension storage, not in the repository

Snapshots go to `globalStorageUri/history/<hash of root path>.json`, one file per `openspec/`
root, holding one record per change per day: date, completed, total, and the source (`observed`
or `backfilled`).

Rejected: a file inside `openspec/`. Fourteen roots means fourteen new tracked files, each
churning daily, in repositories whose diffs are reviewed. The benefit — shared history across a
team — is real but does not outweigh polluting every repository, and can be added later behind a
setting.

The decisive argument is D7: because the entire history is reconstructible from `git log`, the
store is a cache. Losing it costs one backfill, not the record. That also survives a machine
rebuild, which the reference environment has already needed once.

### D7. Backfill replays `git log` over `tasks.md`

On first sight of a change, for each `tasks.md`: list the commits that touched the file with
`git log --format=%H%x09%aI --follow -- <path>`, then read the file at each of those commits
with `git show <sha>:<repo-relative path>`.

Each revision is parsed with the same D4 parser and yields one snapshot dated by the commit's
author date. This reconstructs the full progress curve, including the dates a task was ticked —
which is precisely what D8 needs.

Cost is bounded by the number of commits touching one file, typically tens. Results are cached by
commit SHA, which is immutable, so a revision is parsed once ever. Backfill runs in the background
after the tree is already populated, and is skipped when the root is not a git repository.

`--follow` handles a change directory that was renamed. Missing blobs (shallow clone) are skipped
rather than treated as errors.

### D8. Git evidence is a reference match, reported as a missing-trace signal

Extraction, from the task's own text: inline-code spans, bare path-like tokens containing a slash
and an extension, and identifiers in PascalCase or with a trailing call parenthesis. The reference
environment's tasks are dense with these — task 1.1 of `add-lookup-provider` alone names a
module path, a trait, three methods and a function — so the extraction has real material to work
with.

Matching, for a task completed at time `T` (from D7):

1. Commits after `T - 7d` in the root's repository.
2. A path reference matches when a commit's changed-file list contains it as a suffix.
3. A symbol reference matches via a pickaxe search restricted to the same window.

Presentation. Three states only: **corroborated** (at least one reference matched),
**no references to check** (extraction found nothing — common and not suspicious), and
**no trace found** (references existed and none matched). Only the third is surfaced, in a
dedicated list, with the exact commands and the references that were searched, so the user can
disagree in one click.

This is a heuristic and is documented as one in the UI text. Refactors rename things; a task can
legitimately touch files it does not name; squashed history loses the window. The seven-day
backdating absorbs the common case of ticking a box some days after the work. A signal that is
distrusted is worse than no signal, so nothing here is ever phrased as an accusation, and a
per-change dismissal is persisted.

### D9. Claude Code binding is by change path in the transcript

Transcripts live under `~/.claude/projects/<encoded cwd>/<sessionId>.jsonl`
(`CLAUDE_CONFIG_DIR` overrides the root), one JSON object per line. A session is bound to a
change when `openspec/changes/<name>` appears anywhere in its user prompts or tool inputs. In the
reference environment this fires ~2,950 times across 30 files, so the binding is dense enough to
be useful.

Per bound session the panel reports first and last activity, model, token totals, cost, and the
set of source files edited outside `openspec/`. From this comes the second signal:
**a task ticked by a session that edited no source file**, which is a stronger indicator than D8
because it does not depend on matching text.

Reading is lazy — nothing is parsed until a change's detail panel is opened or the evidence
column is enabled — and cached by mtime and size, the approach already proven on ~101 MB in
~615 ms in the sibling `claude-statusbar` project. Files untouched for over 30 days are skipped
without opening.

Absent transcripts (an API-key, Bedrock or Vertex sign-in, or a fresh machine) produce an
explained empty state, not an error.

### D10. Pricing is vendored, not shared

Cost needs per-model prices. `claude-statusbar` has a verified table with the details that matter:
per-model-id prefixes matched longest-first, the 1-hour cache write multiplier of 2x that Claude
Code almost exclusively emits, the Sonnet 5 introductory window, fast-mode repricing.

The table is copied into `src/evidence/pricing.ts` with a comment naming the source file and the
verification date. Rejected: a shared npm package — two extensions do not justify publishing and
versioning one, and the coupling would slow both. The duplication is a table of numbers with a
dated provenance comment; when it drifts, it drifts visibly.

Cost is labelled an estimate in the UI, because it is computed locally rather than billed.

### D11. Checkbox write-back rewrites one line

Toggling replaces the marker characters on the recorded line, via `WorkspaceEdit` so it
participates in undo and works on an open dirty editor.

Before writing, the line is re-read and its text compared to what was parsed. On mismatch the
write is refused and the tree refreshes — the file changed underneath, very possibly because an
agent is editing it right now, which in this environment is the normal case rather than an edge
case.

### D12. Handoff writes to a terminal, and falls back to the clipboard

A prompt naming the root, change, task number, task text and the `tasks.md` path is sent to a
Claude Code terminal with `Terminal.sendText(text, false)` — no trailing newline, so the user
reviews and presses Enter. The terminal is chosen by matching an existing terminal whose name or
shell-integration working directory corresponds to the root, otherwise a new one is created
running `claude`.

Rejected: an editor chat API. VS Code's chat API addresses Copilot; Claude Code runs as a
terminal process and in its own extension. A terminal write is the integration point that works
for both entrypoints without depending on anything undocumented.

Clipboard fallback covers the case where no terminal can be established, and is also the mode
offered when the user has Claude Code open elsewhere.

### D13. Performance budgets

| Operation | Budget | Enforced by |
|---|---|---|
| Activation to first tree render | < 300 ms | discovery off the activation path (D2) |
| Discovery across 14 roots | < 1 s | `findFiles`, cancellable |
| Parsing one `tasks.md` (145 tasks) | < 10 ms | single pass, no regex backtracking |
| Full model rebuild, 33 changes | < 250 ms | per-file cache on mtime and size |
| Backfill of one change | < 2 s | per-SHA cache, background |
| Transcript scan, ~100 MB | < 1 s | mtime and size cache, 30-day skip, lazy |
| Checkbox toggle to tree update | < 100 ms | targeted refresh, not full rebuild |

File watching is debounced into a single pass, and two passes never run concurrently — the
failure mode learned in `claude-statusbar`, where one agent reply rewrites a transcript many
times per second.

### D14. Stores (beta) must not break discovery

OpenSpec's cross-repo direction is Stores: a separate planning repository. Under that layout the
code repositories hold no `openspec/`, and one planning repository holds all changes.

Discovery already handles this — it is simply a workspace with one root — provided two things
hold: a root is accepted without `config.yaml` (D2), and nothing assumes a change's `tasks.md`
lives in the same git repository as the code it describes. The second matters for D7 and D8:
history backfill uses the repository containing `tasks.md`, while git evidence must search the
code repositories. Until Stores is modelled properly, git evidence is disabled for a root whose
own repository contains no source files outside `openspec/`, with that reason shown, rather than
silently reporting *no trace found* for everything.

## Risks

- **The evidence heuristic loses trust on false positives.** Mitigated by surfacing only the
  strongest state, showing the commands, and persisting dismissals. If it still misfires in real
  use, D8 ships disabled by default and D9 — which does not guess — carries the feature.
- **The `tasks.md` convention is not a schema and can drift.** Mitigated by parsing defensively
  and never dropping a change that fails to parse.
- **Transcript format is internal to Claude Code.** Mitigated by depending only on the fields the
  sibling project already relies on across versions, and by treating the whole layer as optional.
- **The niche is small.** ~8.5k installs for the category leader. Accepted deliberately: the
  reference environment alone justifies the build.
