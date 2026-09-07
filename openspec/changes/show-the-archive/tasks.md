# Tasks — show-the-archive

## 1. Model

- [x] 1.1 Add `LedgerScope` and `LEDGER_SCOPES` to `model/types.ts`, with the reasoning for it not being a `FilterMode`
- [x] 1.2 Add optional `Change.archived` and `RootModel.archived`, both optional so no existing caller or fixture changes meaning
- [x] 1.3 Add optional `TreeOptions.scope` and `Overview.scope`, absent meaning `current`
- [x] 1.4 Export `ARCHIVE_DIR` and add `listArchivedChangeIds`, treating an absent directory as an empty list
- [x] 1.5 Give `readChange` an `archived` option that reads from `changes/archive/<id>` and sets the flag
- [x] 1.6 Give `ModelBuilder.build` a `BuildOptions.includeArchived`, off by default, and keep the archive out of the root aggregate
- [x] 1.7 Extend `applyExclusions` to filter the archive on the same list, so Hide does not expire on archiving
- [x] 1.8 Add the one clause to `statusOf` that keeps an archived change out of the stale state

## 2. Surfaces

- [x] 2.1 Add `scopeOf` and `changesIn` to `view/nodes.ts` as the single place that knows which array a scope means
- [x] 2.2 Build the tree from the scope's list, including the root badge and the two empty-list messages
- [x] 2.3 Give an archived change the `change-archived` context value, keeping the `change` prefix
- [x] 2.4 Rename the filter labels, nouns and nothing-matched messages that would mislead in the archive
- [x] 2.5 Note the archive in the change tooltip and in the detail panel header
- [x] 2.6 Rewrite the row captions in `noteFor` for the archive, including the singular of "1 task open"
- [x] 2.7 Build the overview from the scope's list and record the scope on the result
- [x] 2.8 Render the Current/Archive switch in the webview, sticky with the tally and outside the empty-state branch
- [x] 2.9 Withhold the row archive button and the Archive-all button in the archive
- [x] 2.10 Rename the tally chips where the word changes meaning, and let the stale chip disappear on its own

## 3. Wiring

- [x] 3.1 Store the scope per workspace and the filter per scope, validating both against their known sets
- [x] 3.2 Set the `openspecLedger.scope` context key on construction and on every change
- [x] 3.3 Rebuild rather than redraw on a scope change, so the archive is never shown empty and then filled in
- [x] 3.4 Look a change up in both lists, so a detail panel opened from the archive keeps working after a switch
- [x] 3.5 Say both facts in the view title: which scope, and which filter within it
- [x] 3.6 Contribute Show Archive and Show Current Changes, and hide Archive Completed Changes in the archive

## 4. Evidence that it works

- [x] 4.1 Tests for `listArchivedChangeIds`, for reading from the archive, and for the same id existing in both places
- [x] 4.2 Tests that an ordinary build opens no file under `archive/`, asserted through the file cache rather than by inspection
- [x] 4.3 Tests that the archive stays out of the root aggregate and out of the ready-to-archive badge
- [x] 4.4 Tests that an archived change is never stale at any threshold
- [x] 4.5 Tests for the three archive captions, the archive filters, and the scope recorded on the overview
- [x] 4.6 Tests for the tree in the archive scope: which changes, which context value, which icon, both empty messages
- [x] 4.7 Test that hiding a change hides it in the archive too
- [x] 4.8 Teach the demo workspace generator to archive, as a committed move, with one finished, one shelved and one undecomposed change
- [x] 4.9 Add `--archive` to `scripts/tree-preview.ts` and check the archive scope against the generated workspace
- [ ] 4.10 Open the Extension Development Host and look at both scopes by hand: the switch, the empty archive, the withheld menus
  - The same reason 10.5 of the first change is still open: a screen is the one thing a test cannot judge.

## 6. Archive dates and the wait

- [x] 6.1 Read the archive date from the commit that moved the change, one `git log` per root, with `--no-renames` so the rename is seen as an add
- [x] 6.2 Take the earliest add per change, so a file added to a shelved change later does not move its date
- [x] 6.3 Report nothing where the history cannot answer, rather than falling back to an mtime or to the id's creation date
- [x] 6.4 Carry the dates on `TreeOptions.archivedAt`, keyed like the stalls, and cache per root against the archived count
- [x] 6.5 Read them after the list is published, and republish once, so no date delays the list
- [x] 6.6 Put the date in the caption, in the tree badge and in the tooltip; drop the id's creation date from the archived row
- [x] 6.7 Show the editor's progress bar on both views for a pass the reader set off, and for no other
- [x] 6.8 Draw a busy bar over dimmed rows and a tree message, without rebuilding either surface against a model that cannot answer yet
- [x] 6.9 Tests: the parser against every shape of `git log` output, and the flags against a real repository with a real rename
- [x] 6.10 Tests: the date reaches the caption, the badge and the tooltip, and is ignored for a change that is not archived

## 5. Release

- [x] 5.1 README section on Current and Archive, and the command table entry
- [x] 5.2 CHANGELOG entry for 0.2.0 stating why it is a scope rather than a filter
- [x] 5.3 Bump the version to 0.2.0
- [x] 5.4 Package the VSIX and install it locally (`openspec-ledger-0.2.0.vsix`, 308.09 KB)
