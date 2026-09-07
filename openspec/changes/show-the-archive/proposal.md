## Why

`openspec archive <name>` moves a finished change into `openspec/changes/archive/` and folds its
spec deltas into `openspec/specs/`. Until now the extension pretended that directory did not
exist: `listChangeIds` filtered it out and nothing else ever looked.

That was right for the active list and wrong as a whole. On the reference environment the archive
holds more changes than `changes/` does, and it is the only record of how the project got here.
Three questions have no answer today:

- **What did we actually ship, and when?** The movement report covers what is in flight. Finished
  work leaves the report the moment it is archived, so the one list that says "this is done" is
  invisible.
- **What did we shelve rather than finish?** `openspec archive` does not require 100 %. A change
  put away with four tasks still open is a decision somebody made, and nothing surfaces it.
- **Where did this requirement come from?** Reading an archived proposal means finding the
  directory in the explorer, because no view in the extension will show it.

The obvious implementation is a seventh `FilterMode`, and it is the wrong one. A filter is a lens
on a list: `All changes` has to go on meaning *everything in this list*. Adding `archived` to the
filter set would put finished, moved-away work back into every count, badge and ranking the moment
the reader cleared the filter — and the whole value of the ready-to-archive badge and the *stalled
longest* ranking is that they describe work that can still be acted on.

## What Changes

- **A scope, orthogonal to the filter.** `LedgerScope` is `current` or `archive`. The scope says
  which list; the filter says which part of that list. Both surfaces read it, and each scope keeps
  its own filter.
- **Two buttons, stated in words.** `Current` and `Archive` at the top of the Overview, sticky, so
  a reader a hundred rows into the archive can still get out; the same pair in the view title of
  the tree, driven by an `openspecLedger.scope` context key.
- **A separate list in the model.** `RootModel.archived` rather than a flag on `RootModel.changes`,
  so the history store, the backfill, the badge, the aggregate and the movement report — every one
  of which iterates `changes` — go on meaning the active ones without being changed at all.
- **Read only when it is on screen.** `ModelBuilder.build` takes `includeArchived`, off by default.
  A project with three hundred archived changes costs nothing on the path that draws the active
  list.
- **An archived change is never stale.** It has not advanced since the day it was archived and
  never will. The three remaining states then say the one thing worth knowing about it: whether it
  was finished when it was put away.
- **The Archive action is withheld from the archive** — row button, bulk button and context menu —
  through a `change-archived` context value that still begins with `change`, so the open and reveal
  menus keep working.
- **Captions and chips rewritten** where the active vocabulary would mislead: `archived`,
  `archived with 3 tasks open`, `archived, not decomposed`; *complete* reads *finished* and
  *in progress* reads *left unfinished*.

## Impact

- Affected specs: **archive-scope** (added), `ledger-tree-view` and `change-model` (extended by the
  requirements below rather than rewritten).
- Affected code: `model/types.ts`, `model/changes.ts`, `model/build.ts`, `model/status.ts`,
  `model/exclude.ts`, `view/nodes.ts`, `view/overview.ts`, `view/overviewPanel.ts`,
  `view/detail.ts`, `controller.ts`, `package.json`.
- No change to the history store's format, to the backfill, or to either evidence layer.
