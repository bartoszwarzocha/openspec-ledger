## Context

The decisions in `implement-openspec-ledger/design.md` are numbered D1–D14 and are referenced from
the source by that number. This change continues the series rather than starting a new one, so a
`design.md D15` in a comment resolves without the reader having to know which change introduced it.

## Decisions

### D15. The archive is a scope, not a filter, and is read only when it is on screen

`FilterMode` already has six members and the machinery to add a seventh is trivial. It is still
wrong. The filter set is a lens over one list, which is why `all` is a member of it: clearing the
filter has to return the reader to *everything there is*. If `archived` were a filter, then either
`all` includes the archive — and the ready-to-archive badge, the aggregate percentage and the
*stalled longest* ranking are all quietly wrong, because they now describe work nobody can act on —
or `all` excludes it, and `all` no longer means all.

So `LedgerScope` is a second, orthogonal setting: the scope chooses the list, the filter narrows it.

The same argument decides the shape in the model. `RootModel.archived` is a **separate array**, not
a flag on the elements of `RootModel.changes`. Six modules iterate `changes` — the history store,
the backfill, the badge, the root aggregate, the movement report, `archiveCompleted` — and every
one of them means the active list. A flag would have put the burden of remembering that on all six,
where forgetting it is silent and the symptom appears somewhere else entirely. A second array makes
the mistake unavailable: code that has not been changed cannot see the archive.

Reading is lazy for the same reason it is separate. `ModelBuilder.build` takes `includeArchived`,
defaulting to false, and the controller passes `scope === 'archive'`. The archive can be larger
than the active list and is by definition static, so paying to parse it on every pass — including
every debounced pass triggered by an agent writing `tasks.md` — would be spent for nothing.

The cost is one rebuild when the scope changes. That is accepted rather than worked around: caching
the archive across scope switches would mean deciding when to invalidate it, and the `FileCache`
already makes the second build of an unchanged archive nearly free.

### D16. An archived change is never stale, and its captions say what it was

`statusOf` gains one clause: staleness is not considered for an archived change. This is a stronger
version of the existing rule that a complete change is never stale. A complete change is waiting
for a decision; an archived one is not waiting for anything. It has not advanced since the day it
was put away and never will, so a stall figure computed from it grows without bound, and every
archive would render as a wall of warnings about work that is over.

What the remaining three states then encode is the useful question: `complete` means it was
finished when it was archived, `active` means it was shelved with work still open, `undecomposed`
means it was never broken down. That is why the archive does **not** get a status of its own — a
fifth `ChangeStatus` would have collapsed exactly the distinction worth keeping.

The captions follow. "Ready to archive" describes a decision waiting to be taken and in the archive
it has been; "last advanced" describes something that might advance again. Both are replaced, and
only the vocabulary that would mislead is restated — `all`, `undecomposed` and `stale` carry over
unchanged, and `stale` needs no archive wording because it can no longer occur there.

Menus are handled by context value rather than by a `when` clause on the scope: `change-archived`
still begins with `change`, so the open and reveal menus continue to match, while
`viewItem == change-complete` — which is what Archive binds to — no longer does. A finished change
that is already archived must not be offered the chance to be archived again, and the binding, not
the caller, is the right place to say so.
