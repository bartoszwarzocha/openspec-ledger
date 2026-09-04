# Spec: change-model

Traces to: D4 (task parser grammar), D5 (change without tasks.md), D13 (parse budget)

---

## ADDED Requirements

### Requirement: Change enumeration

The system SHALL enumerate every immediate subdirectory of `<root>/openspec/changes/` as a
change, excluding a directory named `archive`.

Each change SHALL carry its directory name as its identifier, its absolute path, and the
presence of `proposal.md`, `design.md`, `tasks.md` and a `specs/` subtree.

A change directory SHALL be enumerated even when it contains only `.openspec.yaml`.

#### Scenario: Change with the full document set
- **WHEN** `changes/add-lookup-provider/` contains `.openspec.yaml`, `proposal.md`,
  `design.md`, `tasks.md` and `specs/`
- **THEN** the change SHALL be reported with all four documents present

#### Scenario: Change with only metadata
- **WHEN** `changes/spec-consistency-fixes/` contains only `.openspec.yaml`
- **THEN** the change SHALL still be enumerated
- **AND** it SHALL report no proposal, no design and no task list

#### Scenario: Archive is excluded
- **WHEN** `changes/archive/` exists and contains change directories
- **THEN** none of them SHALL be enumerated as active changes

---

### Requirement: Change metadata

The system SHALL read `.openspec.yaml` in each change directory and SHALL extract `schema` and
`created` when present.

When `created` is absent or unparseable, the change SHALL fall back to the earliest filesystem
modification time among its documents, and SHALL mark the date as inferred.

#### Scenario: Declared creation date
- **WHEN** `.openspec.yaml` contains `created: 2026-02-13`
- **THEN** the change SHALL report a creation date of 2026-02-13 that is not inferred

#### Scenario: Missing creation date
- **WHEN** `.openspec.yaml` contains no `created` key
- **THEN** the change SHALL report the earliest document modification time
- **AND** SHALL mark the creation date as inferred

---

### Requirement: Task file parsing

The system SHALL parse `tasks.md` into an ordered list of sections, each containing an ordered
tree of tasks.

A line matching `^(\s*)[-*] \[([ xX~-])\]\s+(.*)$` SHALL be recognised as a task. The marker
` ` SHALL mean pending, `x` or `X` SHALL mean complete, and `-` or `~` SHALL mean in progress.

A markdown heading SHALL open a section at the heading's depth. Tasks appearing before any
heading SHALL belong to an implicit unnamed section.

Nesting SHALL be determined by leading whitespace, with a tab counted as the configured tab
width. A task indented more deeply than the preceding task SHALL be its child.

A leading task number of the form `N.M` or `N.M.K` SHALL be captured as the task's number and
removed from its label.

Every task SHALL record the one-based line number on which it was found and the verbatim text of
that line.

Lines matching no rule SHALL be ignored.

#### Scenario: Flat numbered task list
- **WHEN** `tasks.md` contains a `## 1. Provider Module` heading followed by four
  `- [x] 1.1 ...` through `- [x] 1.4 ...` lines
- **THEN** the parser SHALL produce one section titled `1. Provider Module`
- **AND** that section SHALL contain four complete tasks numbered 1.1 to 1.4
- **AND** each task label SHALL exclude its number prefix

#### Scenario: Nested tasks
- **WHEN** a task line is followed by a task line indented by two further spaces
- **THEN** the second task SHALL be a child of the first

#### Scenario: In-progress marker
- **WHEN** a line reads `- [-] 3.2 Wire the registry`
- **THEN** the task SHALL be reported as in progress, neither pending nor complete

#### Scenario: Content before any heading
- **WHEN** `tasks.md` begins with task lines before its first heading
- **THEN** those tasks SHALL belong to an implicit unnamed section that sorts first

#### Scenario: Unrecognised lines are ignored
- **WHEN** `tasks.md` contains prose paragraphs, tables and fenced code blocks between tasks
- **THEN** the parser SHALL ignore them
- **AND** SHALL NOT report a parse failure

#### Scenario: Line numbers are recorded
- **WHEN** a task is found on line 47 of `tasks.md`
- **THEN** the task SHALL report line 47

---

### Requirement: Progress arithmetic

The system SHALL compute progress for a change as the number of complete leaf tasks over the
total number of leaf tasks.

A task with children SHALL NOT be counted; only tasks with no children SHALL contribute.

An in-progress task SHALL count towards the total but not towards the completed count.

Progress SHALL be reported as both the pair of counts and a percentage rounded to the nearest
integer, where a percentage of 100 SHALL be produced only when every leaf task is complete.

#### Scenario: All tasks complete
- **WHEN** a change has 32 leaf tasks and all are complete
- **THEN** progress SHALL be 32 of 32 and 100 percent

#### Scenario: One task short
- **WHEN** a change has 110 leaf tasks and 109 are complete
- **THEN** progress SHALL be 109 of 110
- **AND** the percentage SHALL be 99, not 100

#### Scenario: Parents are not double-counted
- **WHEN** a section contains one complete parent task with three complete children
- **THEN** the total SHALL be 3, not 4

---

### Requirement: Change without a task list

The system SHALL distinguish a change whose `tasks.md` is absent from a change whose `tasks.md`
contains no tasks.

A change with no `tasks.md` SHALL report an undecomposed state and SHALL NOT report a progress
percentage.

An undecomposed change SHALL be excluded from any aggregate progress figure and from any ranking
based on progress or staleness.

#### Scenario: Absent task file
- **WHEN** a change directory contains no `tasks.md`
- **THEN** the change SHALL report the undecomposed state
- **AND** SHALL NOT report progress of 0 percent

#### Scenario: Empty task file
- **WHEN** `tasks.md` exists but contains no task lines
- **THEN** the change SHALL report progress of 0 of 0
- **AND** SHALL NOT report the undecomposed state

#### Scenario: Undecomposed changes are excluded from aggregates
- **WHEN** a root holds eight changes of which two are undecomposed
- **THEN** the root's aggregate progress SHALL be computed over the remaining six

---

### Requirement: Model caching and rebuild

The system SHALL cache each parsed file by its modification time and size, and SHALL re-parse a
file only when either has changed.

A full model rebuild across 33 changes SHALL complete within 250 ms when no file has changed.

Parsing a single `tasks.md` of 145 tasks SHALL complete within 10 ms.

#### Scenario: Unchanged files are not re-parsed
- **WHEN** a model rebuild runs and no file has changed since the previous rebuild
- **THEN** no `tasks.md` SHALL be read from disk

#### Scenario: Changed file is re-parsed
- **WHEN** a single `tasks.md` is modified
- **THEN** only that file SHALL be re-read and re-parsed
