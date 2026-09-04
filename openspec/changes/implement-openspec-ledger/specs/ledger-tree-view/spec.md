# Spec: ledger-tree-view

Traces to: D3 (native tree, webview for detail), D5 (undecomposed state), D11 (checkbox write-back)

---

## ADDED Requirements

### Requirement: Tree structure

The system SHALL contribute a view container to the Activity Bar containing a tree with four
levels: root, change, section, task. Tasks with children SHALL nest below their parent task.

When exactly one root is discovered, the root level SHALL be omitted and changes SHALL appear at
the top level.

A root SHALL be labelled by its path relative to the containing workspace folder, or by its
directory name when it is an additional root outside the workspace.

#### Scenario: Multiple roots
- **WHEN** fourteen roots are discovered
- **THEN** the tree SHALL show fourteen collapsible root nodes
- **AND** each SHALL be labelled by its path relative to its workspace folder

#### Scenario: Single root
- **WHEN** exactly one root is discovered
- **THEN** changes SHALL appear at the top level with no root node above them

#### Scenario: Task nesting
- **WHEN** a task has two child tasks
- **THEN** the parent SHALL be collapsible and SHALL contain both children

---

### Requirement: Progress display

A change node SHALL display its progress as a count pair and a percentage. A section node SHALL
display the count pair for its own tasks.

A change in the undecomposed state SHALL display the text `not decomposed` in place of progress.

A change at 100 percent SHALL be visually distinguished from a change below 100 percent.

#### Scenario: Change badge
- **WHEN** a change has 61 of 63 leaf tasks complete
- **THEN** its node SHALL show `61/63` and `97%`

#### Scenario: Undecomposed change badge
- **WHEN** a change has no `tasks.md`
- **THEN** its node SHALL show `not decomposed`
- **AND** SHALL NOT show a percentage

#### Scenario: Completed change is distinguished
- **WHEN** a change has every leaf task complete
- **THEN** its node SHALL carry a distinct icon from changes below 100 percent

---

### Requirement: Task state icons

A task node SHALL carry an icon reflecting its state: complete, in progress, or pending. The
complete icon SHALL be rendered in the theme's success colour.

#### Scenario: Complete task
- **WHEN** a task is complete
- **THEN** its node SHALL show a check icon in the success colour

#### Scenario: Pending task
- **WHEN** a task is pending
- **THEN** its node SHALL show an empty-circle icon in the default foreground colour

---

### Requirement: Sort modes

The system SHALL offer the following orderings of changes within a root, selectable from the view
title and persisted across sessions:

- `name` — alphabetical by change identifier
- `progress` — descending by completion percentage
- `nearest-done` — ascending by the number of incomplete leaf tasks remaining
- `stalled` — descending by days since the change last advanced
- `created` — descending by creation date

Undecomposed changes SHALL sort last in every mode except `name`.

#### Scenario: Nearest done ordering
- **WHEN** the sort mode is `nearest-done`
- **AND** the root holds changes with 2, 1 and 14 tasks remaining
- **THEN** they SHALL appear in the order 1, 2, 14

#### Scenario: Sort mode persists
- **WHEN** the user selects the `stalled` sort mode and reloads the window
- **THEN** the `stalled` mode SHALL still be in effect

#### Scenario: Undecomposed changes sort last
- **WHEN** the sort mode is `progress`
- **THEN** undecomposed changes SHALL appear after every change that has a progress figure

---

### Requirement: Ready-to-archive grouping

The system SHALL provide a filter that shows only changes at 100 percent, labelled as ready to
archive, and SHALL display the count of such changes in the view title badge.

#### Scenario: Ten completed changes
- **WHEN** ten of 33 changes across all roots are at 100 percent
- **THEN** the view title badge SHALL show 10
- **AND** enabling the filter SHALL show exactly those ten changes

---

### Requirement: Navigation

Selecting a task node SHALL open its `tasks.md` and reveal the recorded line. Selecting a change
node SHALL open its `proposal.md`, or its `design.md` when no proposal exists, or reveal the
change directory when neither exists.

A command SHALL open the change detail panel for the selected change.

#### Scenario: Task opens at its line
- **WHEN** a task recorded at line 47 is selected
- **THEN** `tasks.md` SHALL open with the cursor on line 47
- **AND** line 47 SHALL be scrolled into view

#### Scenario: Change with no proposal
- **WHEN** a change node with no `proposal.md` and no `design.md` is selected
- **THEN** the change directory SHALL be revealed in the Explorer

---

### Requirement: Checkbox write-back

A task node SHALL expose a checkbox. Toggling it SHALL rewrite the marker characters on the
recorded line of `tasks.md` through a workspace edit, so the change is undoable and applies to an
open dirty editor.

Before applying the edit the system SHALL re-read the recorded line and compare it to the text
captured at parse time. On mismatch the edit SHALL be abandoned, the model SHALL be refreshed,
and the user SHALL be told that the file changed on disk.

Toggling SHALL update the tree within 100 ms and SHALL NOT trigger a full model rebuild.

#### Scenario: Toggle a pending task
- **WHEN** the user checks the box on a pending task recorded at line 47
- **THEN** line 47 of `tasks.md` SHALL have its marker replaced with the complete marker
- **AND** no other line SHALL be modified

#### Scenario: Undo
- **WHEN** the user toggles a checkbox and then invokes undo
- **THEN** `tasks.md` SHALL return to its previous content

#### Scenario: File changed underneath
- **WHEN** the recorded line no longer matches the text captured at parse time
- **THEN** no edit SHALL be applied
- **AND** the model SHALL be refreshed
- **AND** a warning naming the file SHALL be shown

---

### Requirement: File watching

The system SHALL watch every discovered root for changes to `tasks.md`, `proposal.md`,
`design.md` and `.openspec.yaml`, and for the creation and deletion of change directories.

Events SHALL be debounced into a single model pass, and two passes SHALL NOT run concurrently.

#### Scenario: External edit refreshes the tree
- **WHEN** an agent ticks three boxes in `tasks.md` outside the editor
- **THEN** the tree SHALL reflect the new progress without user action

#### Scenario: Burst of writes produces one pass
- **WHEN** `tasks.md` is written twenty times within one second
- **THEN** at most one model pass SHALL run after the burst settles

#### Scenario: New change directory appears
- **WHEN** a new directory is created under `changes/`
- **THEN** it SHALL appear in the tree without a window reload

---

### Requirement: Empty states

The system SHALL render an explanatory message, not an empty list, in each of these cases: no
workspace folder open, no OpenSpec root discovered, and a root containing no active changes.

The no-root message SHALL mention that roots are discovered at any depth and SHALL offer the
`openspecLedger.additionalRoots` setting.

#### Scenario: No roots found
- **WHEN** discovery completes and returns no roots
- **THEN** the view SHALL show a message explaining that no `openspec` directory was found
- **AND** SHALL offer a command to open the additional-roots setting

#### Scenario: Root with no changes
- **WHEN** a root's `changes/` directory is empty
- **THEN** the root node SHALL show a child stating that it holds no active changes
