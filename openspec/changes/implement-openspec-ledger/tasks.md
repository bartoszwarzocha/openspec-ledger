# Tasks — implement-openspec-ledger

Phases 1-4 ship as 0.1.0 (parity plus recursive discovery). Phase 5-6 ship as 0.2.0 (movement).
Phase 7 ships as 0.3.0 (git evidence). Phases 8-9 ship as 0.4.0 (Claude Code evidence and
handoff). Each phase ends in something demonstrable.

## 1. Project Scaffolding

- [x] 1.1 Initialise the repository: `package.json` with the `openspecLedger` publisher and name, engines for VS Code, `activationEvents: ["onStartupFinished"]`, and an `openspec-ledger` view container contribution
- [x] 1.2 Configure TypeScript strict mode, `tsconfig.json` targeting the extension host, and `npm run check-types` as `tsc --noEmit`
- [x] 1.3 Configure esbuild to bundle `src/extension.ts` to `dist/extension.js` with `vscode` external, plus `watch` and `package` scripts run in parallel by `npm-run-all`
- [x] 1.4 Configure eslint over `src` and wire `npm run compile` to check-types, lint and build
- [x] 1.5 Add the extension icon, README, LICENSE, `.vscodeignore` and `.gitignore`
- [x] 1.6 Create the output channel and a `log()` helper used by every module for diagnostics
- [x] 1.7 Declare all settings in `package.json` with defaults: `additionalRoots`, `sortMode`, `gitEvidence.enabled`, `claudeEvidence.enabled`, `handoff.command`, `handoff.template`
- [x] 1.8 Verify the extension activates in the Extension Development Host and contributes an empty view

## 2. Workspace Discovery

- [x] 2.1 Implement `findRoots()` using `workspace.findFiles` over `**/openspec/config.yaml` with the exclusion set, returning absolute root paths
- [x] 2.2 Extend discovery to accept a root that has `openspec/changes/` but no `config.yaml`, via a second `findFiles` pass
- [x] 2.3 Parse `config.yaml` for the `schema` key, attaching a configuration error to the root instead of dropping it on failure
- [x] 2.4 Implement additional roots from `openspecLedger.additionalRoots`, including existence checking and one-time reporting of missing paths
- [x] 2.5 Implement root labelling: path relative to the containing workspace folder, or directory name for an additional root
- [x] 2.6 Implement the discovery cache and its invalidation on workspace folder change, setting change and explicit refresh
- [x] 2.7 Make discovery cancellable and move it off the activation path, so the view registers first
- [x] 2.8 Write tests: nine nested roots found, root at the workspace root found, root without `config.yaml` accepted, `node_modules` excluded, empty workspace returns empty
- [x] 2.9 Write tests: additional root outside the workspace included, missing configured path logged and skipped, malformed `config.yaml` retains the root
- [x] 2.10 Measure discovery against the reference environment and assert it completes within one second

## 3. Change Model and Task Parser

- [x] 3.1 Define the model types: `OpenSpecRoot`, `Change`, `TaskSection`, `Task`, `Progress`, with an explicit undecomposed state distinct from an empty task list
- [x] 3.2 Implement change enumeration over `changes/`, excluding `archive`, recording which of the four documents are present
- [x] 3.3 Implement `.openspec.yaml` parsing for `schema` and `created`, with the inferred-date fallback to the earliest document mtime
- [x] 3.4 Implement the task line matcher for the four markers, capturing indent, marker, text, line number and verbatim line
- [x] 3.5 Implement section detection from markdown headings, including the implicit unnamed section for tasks preceding the first heading
- [x] 3.6 Implement indent-based nesting with tab-width normalisation, attaching each task to the nearest shallower parent
- [x] 3.7 Implement task number extraction and its removal from the label
- [x] 3.8 Implement leaf-only progress arithmetic and percentage rounding that reserves 100 for genuinely complete changes
- [x] 3.9 Implement the file cache keyed by modification time and size, and the model rebuild that consults it
- [x] 3.10 Write tests for the parser against a flat numbered list, a nested list, all four markers, prose and fenced code between tasks, and content before the first heading
- [x] 3.11 Write tests for progress: all complete, one short, parents not double-counted, in-progress counted in the total only
- [x] 3.12 Write tests for the undecomposed state: absent `tasks.md` versus empty `tasks.md`, and exclusion from aggregates
- [x] 3.13 Write tests for metadata: declared `created`, missing `created` falling back to mtime and marked inferred
- [x] 3.14 Benchmark the parser against the 145-task file and assert under 10 ms; benchmark a full rebuild of 33 changes and assert under 250 ms

## 4. Ledger Tree View

- [x] 4.1 Implement `TreeDataProvider` with the four node kinds and the collapse of the root level when exactly one root exists
- [x] 4.2 Implement change node rendering: label, count pair and percentage in the description, distinct icon at 100 percent
- [x] 4.3 Implement the undecomposed change node showing `not decomposed` and no percentage
- [x] 4.4 Implement section and task node rendering, with state icons and the success colour for complete tasks
- [x] 4.5 Implement the five sort modes, persisted in workspace state, with undecomposed changes sorted last outside `name`
- [x] 4.6 Implement the ready-to-archive filter and the view title badge counting changes at 100 percent
- [x] 4.7 Implement the refresh command and wire it to discovery invalidation
- [x] 4.8 Implement empty states for no workspace, no roots discovered, and a root with no active changes, including the command that opens the additional-roots setting
- [x] 4.9 Write tests against a fixture tree: multiple roots, single root collapse, nesting, badges, undecomposed rendering
- [x] 4.10 Write tests for each sort mode, including the ordering by tasks remaining and the persistence of the selection
- [x] 4.11 Verify manually against the reference environment that all fourteen roots and 33 changes render

## 5. Navigation and Checkbox Write-Back

- [x] 5.1 Implement the open-task command that reveals `tasks.md` at the recorded line
- [x] 5.2 Implement the open-change command with the proposal, design and reveal-directory fallback chain
- [x] 5.3 Implement checkbox contribution on task nodes using the tree checkbox state
- [x] 5.4 Implement the toggle as a `WorkspaceEdit` replacing only the marker characters on the recorded line
- [x] 5.5 Implement the pre-write verification that re-reads the line and abandons the edit with a warning on mismatch
- [x] 5.6 Implement the targeted tree refresh after a toggle, avoiding a full model rebuild
- [x] 5.7 Implement file watching over `tasks.md`, `proposal.md`, `design.md` and `.openspec.yaml`, plus change directory creation and deletion
- [x] 5.8 Implement debouncing of watcher events into a single pass and the guard preventing concurrent passes
- [x] 5.9 Write tests: toggle rewrites one line only, undo restores the file, mismatch abandons the edit and warns
- [x] 5.10 Write tests: a burst of twenty writes produces one pass, a new change directory appears without reload
- [x] 5.11 Measure toggle-to-tree-update latency and assert under 100 ms

## 6. Progress History and Backfill

- [x] 6.1 Define the snapshot record and the per-root history file format under global storage, named by a hash of the root path
- [x] 6.2 Implement the history store: load, save, discard-and-rebuild on corruption, and the one-snapshot-per-day upsert
- [x] 6.3 Implement the live observation hook that writes a snapshot after each model rebuild
- [x] 6.4 Implement a thin `git` runner over `child_process` with cancellation, a timeout, and detection of git being absent from `PATH`
- [x] 6.5 Implement commit listing for a `tasks.md` with rename following, returning hashes and author dates
- [x] 6.6 Implement reading a file's content at a commit, skipping unreadable blobs without failing the run
- [x] 6.7 Implement backfill: parse each revision with the task parser, write one snapshot per commit, cache parsed revisions by commit hash
- [x] 6.8 Schedule backfill in the background after the first tree render, skipping roots outside a git repository
- [x] 6.9 Implement movement derivation: tasks completed since a date, and the last-advanced date
- [x] 6.10 Implement stall derivation, including the fallback to the creation date and the exclusion of changes at 100 percent
- [x] 6.11 Surface days stalled in the change tooltip and enable the `stalled` sort mode against it
- [x] 6.12 Write tests for the store: one snapshot per day, second observation updates it, corrupt file discarded silently
- [x] 6.13 Write tests for backfill against a fixture repository: forty commits reconstructed, rename followed, missing blob skipped, non-git root skipped
- [x] 6.14 Write tests for movement and stall derivation, including a change that never advanced and one at 100 percent
- [x] 6.15 Measure backfill of a forty-commit change and assert under two seconds

## 7. Movement Report

- [x] 7.1 Implement the report generator producing, per change, the starting progress, current progress, tasks completed and days stalled for a chosen period
- [x] 7.2 Implement the markdown rendering with a moved section, a did-not-move section, and a new-in-period marker
- [x] 7.3 Implement the command with a period picker defaulting to seven days, opening the result in an untitled editor
- [x] 7.4 Write tests for the generator: change that moved, change that did not, change created within the period, undecomposed change excluded
- [x] 7.5 Generate the report against the reference environment and check it by hand against the known state of the 33 changes

## 8. Git Evidence

- [x] 8.1 Implement reference extraction: inline-code spans, path-like tokens, PascalCase and call-parenthesis identifiers, with the short and numeric filters
- [x] 8.2 Implement completion-date resolution from backfilled history, reporting unknown when history does not cover the task
- [x] 8.3 Implement path-reference matching against the changed-file lists of commits in the window, ignoring commits touching only `openspec/`
- [x] 8.4 Implement symbol-reference matching via a pickaxe search restricted to the window
- [x] 8.5 Implement the three-state classification and restrict surfacing to the no-trace state
- [x] 8.6 Implement the planning-only repository check that marks git evidence unavailable when no tracked files exist outside `openspec/`
- [x] 8.7 Implement the unavailable states for missing git and for a root outside a git repository, each with its reason
- [x] 8.8 Implement dismissal persistence keyed by task line text, lapsing when the text changes
- [x] 8.9 Build the evidence section of the change detail panel: the no-trace list with references searched, the window, and the commands run
- [x] 8.10 Write the wording of every evidence message and have it reviewed against the rule that it describes a missing trace, never a false claim
- [x] 8.11 Write tests for extraction: module-and-trait task, prose-only task, short and numeric tokens discarded
- [x] 8.12 Write tests for matching against a fixture repository: path corroborated, symbol corroborated, spec-only commits ignored, nothing matched
- [x] 8.13 Write tests for unavailability: git missing, non-git root, planning-only repository
- [x] 8.14 Run the layer against the reference environment, count the no-trace results by hand, and decide from the false-positive rate whether the default stays off

## 9. Claude Code Evidence and Handoff

- [x] 9.1 Implement transcript discovery honouring `CLAUDE_CONFIG_DIR` with the home-directory default, and the unavailable state when no data directory exists
- [x] 9.2 Implement the transcript line reader with per-line JSON tolerance, so a malformed line does not abort a file
- [x] 9.3 Implement change binding by scanning for `openspec/changes/<id>` in both separator forms, case-insensitively on Windows
- [x] 9.4 Implement usage extraction with deduplication by message and request identifier, keeping the first occurrence
- [x] 9.5 Vendor the price table into `src/evidence/pricing.ts` with a comment naming the source file and the verification date, and implement longest-prefix model matching
- [x] 9.6 Implement cost estimation across input, output, both cache write durations and cache reads, with unpriced models contributing zero and being listed
- [x] 9.7 Implement edited-file collection from file-writing tool calls, excluding paths under `openspec/`
- [x] 9.8 Implement the per-session summary and the change-level rollup, distinguishing no activity from measured zero
- [x] 9.9 Implement the checked-without-code signal from completion dates falling inside a session span with no source edits
- [x] 9.10 Implement lazy reading, the mtime-and-size cache, and the thirty-day skip with a full-rescan override
- [x] 9.11 Build the sessions section of the change detail panel: session list, costs marked as estimates, edited files, and the signal
- [x] 9.12 Implement the privacy guarantees: no transmission, no prompt text displayed, layer disabled by default
- [x] 9.13 Implement handoff prompt construction from the template, covering numbered and unnumbered tasks and the proposal reference
- [x] 9.14 Implement section handoff listing only incomplete tasks, and hide the command for a fully complete section
- [x] 9.15 Implement terminal selection by working directory then by name, with creation of a new terminal running the configured command
- [x] 9.16 Implement delivery without a trailing newline, terminal revelation, and the clipboard fallback with its explicit command
- [x] 9.17 Restrict handoff availability to pending and in-progress tasks and hide it for undecomposed changes
- [x] 9.18 Write tests for binding, deduplication, longest-prefix pricing, unpriced models, and edited-file exclusion
- [x] 9.19 Write tests for laziness: activation opens no transcript, a warm second scan reads nothing, old transcripts skipped
- [x] 9.20 Write tests for handoff: numbered and unnumbered prompts, custom template, section prompt omits complete tasks, no newline sent
- [x] 9.21 Measure a warm scan of the roughly 100 MB reference corpus and assert under one second

## 10. Packaging and Release

- [x] 10.1 Write the README: the differentiator stated first, the three evidence sources, the settings table, and the recursive-discovery note
- [x] 10.2 Write the CHANGELOG covering the phased releases
- [x] 10.3 Verify every performance budget in the design against the reference environment and record the measurements in the README
- [x] 10.4 Package with `npx @vscode/vsce package` and install the resulting file into a clean VS Code profile
- [ ] 10.5 Run through every empty state by hand: no workspace, no roots, no git, no transcripts, undecomposed change
  - The only task left open: every other item here is settled by a test or a measurement, whereas an empty state is a screen, and the only way to know it reads well is for a person to open the Extension Development Host and look at it.
- [x] 10.6 Decide the default for each evidence layer based on the phase 8 and 9 measurements, and record the reasoning in the README
