# Spec: archive-scope

Traces to: D15 (scope, not filter; lazy read), D16 (never stale; captions and menus)

---

## ADDED Requirements

### Requirement: Two scopes, chosen by the reader

The system SHALL offer two scopes — *current* and *archive* — and SHALL show the changes of exactly
one of them at a time on every surface. The current scope SHALL be the changes under
`openspec/changes/`; the archive scope SHALL be the changes under `openspec/changes/archive/`.

The scope SHALL be selectable from the Overview header and from the view title of the tree, SHALL be
remembered per workspace, and SHALL default to *current*.

The scope SHALL be independent of the filter: each scope SHALL remember its own filter, and choosing
a scope SHALL NOT change which filters exist.

#### Scenario: Switching to the archive
- **WHEN** the reader presses Archive
- **THEN** every surface SHALL list only changes under `openspec/changes/archive/`
- **AND** the tree and the Overview SHALL agree about which changes those are

#### Scenario: Returning to the current scope
- **WHEN** the reader presses Current
- **THEN** the list SHALL hold exactly the changes it held before the archive was opened
- **AND** the filter that was in force in the current scope SHALL be restored

#### Scenario: A filter chosen in one scope does not follow the reader
- **GIVEN** the filter in the current scope is *Stale*
- **WHEN** the reader switches to the archive
- **THEN** the archive SHALL be shown under its own filter, not under *Stale*

### Requirement: The archive is excluded from every figure computed over the work in flight

Archived changes SHALL NOT contribute to a root's aggregate progress, to the ready-to-archive badge,
to the stalled ranking, to the progress history, to the git backfill, or to the movement report — in
either scope.

The ready-to-archive badge SHALL go on counting the current scope while the archive is displayed.

#### Scenario: Aggregate excludes the archive
- **GIVEN** a root with one change at 1 of 4 and three archived changes at 8 of 8
- **WHEN** the root's progress is computed
- **THEN** it SHALL be 1 of 4

#### Scenario: The badge does not follow the view
- **GIVEN** two changes at 100 percent in the current scope
- **WHEN** the reader is looking at the archive
- **THEN** the badge SHALL still read 2

#### Scenario: No history is recorded for the archive
- **WHEN** a pass runs with the archive on screen
- **THEN** no snapshot SHALL be written for an archived change

### Requirement: The archive is read only when it is displayed

The system SHALL NOT read `openspec/changes/archive/` while the current scope is displayed. No file
under that directory SHALL be opened, and `RootModel.archived` SHALL be absent.

A root with no `archive` directory SHALL yield an empty archive rather than a problem.

#### Scenario: An ordinary pass opens nothing in the archive
- **GIVEN** a root with an archived change
- **WHEN** the model is built for the current scope
- **THEN** no file beneath `changes/archive/` SHALL have been read

#### Scenario: A young project has no archive
- **GIVEN** a root with no `changes/archive/` directory
- **WHEN** the model is built for the archive scope
- **THEN** the archive SHALL be empty and the root SHALL report no problem

### Requirement: An archived change is never stale

The system SHALL NOT report an archived change as stale, whatever its stall figure and whatever the
configured threshold. An archived change SHALL be reported as *complete*, *active* or *undecomposed*
according to the state of its task list when it was archived.

#### Scenario: A long-archived change carries no warning
- **GIVEN** an archived change at 61 of 63 that last advanced 400 days ago
- **WHEN** its status is computed with a 30-day threshold
- **THEN** it SHALL be *active*, and SHALL carry no warning icon

### Requirement: Captions describe what an archived change was

Row captions in the archive SHALL state the change's condition at the time it was archived, and
SHALL NOT use a caption that describes a pending decision or a possible future advance.

A change archived while complete SHALL read `archived`. A change archived with open tasks SHALL name
how many are open. A change archived without a task list SHALL say so.

#### Scenario: The three captions
- **WHEN** the archive holds a change at 3 of 3, one at 1 of 4, and one with no `tasks.md`
- **THEN** their captions SHALL be `archived`, `archived with 3 tasks open`, and
  `archived, not decomposed`

### Requirement: Nothing in the archive can be archived again

The Archive command SHALL NOT be offered for a change that is already archived, from the row action,
from the bulk action, or from the context menu. The commands that open and reveal a change SHALL go
on working for it.

#### Scenario: A finished change in the archive
- **GIVEN** an archived change at 100 percent
- **WHEN** its context menu is opened
- **THEN** Archive SHALL be absent
- **AND** Open proposal.md and Reveal Change Folder SHALL be present

#### Scenario: The bulk action in the archive
- **WHEN** the archive is displayed
- **THEN** the Archive-all action SHALL NOT be shown

### Requirement: An empty archive is an answer

When the archive holds nothing, the system SHALL say so, SHALL distinguish that from a workspace in
which no root was found, and SHALL leave the scope switch reachable so the reader can return to the
current scope.

#### Scenario: Nothing archived yet
- **GIVEN** roots with changes but nothing under `changes/archive/`
- **WHEN** the archive is displayed
- **THEN** the view SHALL state that nothing has been archived yet
- **AND** the Current button SHALL remain on screen

#### Scenario: A filter that empties the archive
- **GIVEN** an archive whose changes are all finished
- **WHEN** the filter is *Left unfinished*
- **THEN** the message SHALL name the archive rather than the active list
