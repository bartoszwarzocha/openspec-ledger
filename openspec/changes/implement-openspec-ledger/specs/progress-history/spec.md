# Spec: progress-history

Traces to: D6 (storage outside the repository), D7 (git-log backfill), D13 (budgets)

---

## ADDED Requirements

### Requirement: Snapshot record

The system SHALL record, for each change, at most one progress snapshot per calendar day,
containing the date, the number of complete leaf tasks, the total number of leaf tasks, and
whether the snapshot was observed live or reconstructed from git.

When a change's progress changes more than once on the same day, the snapshot for that day SHALL
hold the latest observation.

#### Scenario: First observation of the day
- **WHEN** a change is observed at 09:00 with 61 of 63 complete and no snapshot exists for today
- **THEN** a snapshot dated today SHALL be written with 61 and 63 and the source `observed`

#### Scenario: Second observation of the day
- **WHEN** the same change is observed at 15:00 with 62 of 63 complete
- **THEN** today's snapshot SHALL be updated to 62 of 63
- **AND** no second snapshot for today SHALL exist

---

### Requirement: Storage location

Snapshots SHALL be stored under the extension's global storage directory, one JSON file per
OpenSpec root, named by a hash of the root's absolute path.

The system SHALL NOT write history into any user repository.

A corrupt or unreadable history file SHALL be discarded and rebuilt by backfill rather than
raising an error.

#### Scenario: History is not written to the repository
- **WHEN** the extension has been running against a root for a week
- **THEN** `git status` in that repository SHALL report no files added by the extension

#### Scenario: Corrupt history file
- **WHEN** a history file contains text that is not valid JSON
- **THEN** the file SHALL be discarded
- **AND** backfill SHALL run for that root
- **AND** no error SHALL be surfaced to the user

---

### Requirement: Backfill from git history

On first encountering a change, the system SHALL reconstruct its progress history by listing the
commits that touched its `tasks.md`, reading the file's content at each commit, parsing each
revision with the task parser, and writing one snapshot per commit dated by the commit's author
date and marked `backfilled`.

Backfill SHALL follow renames of the file.

A commit whose blob cannot be read SHALL be skipped without failing the backfill.

Parsed revisions SHALL be cached by commit hash and SHALL NOT be re-parsed.

Backfill SHALL run in the background after the tree has rendered, and SHALL be skipped when the
root is not inside a git repository.

#### Scenario: History is available on first run
- **WHEN** the extension is installed against a repository whose `tasks.md` has 40 commits
- **THEN** after backfill the change SHALL have snapshots covering those 40 commit dates
- **AND** each SHALL be marked `backfilled`

#### Scenario: Renamed change directory
- **WHEN** a change directory was renamed in the repository's history
- **THEN** backfill SHALL include the revisions from before the rename

#### Scenario: Not a git repository
- **WHEN** a root is not inside a git repository
- **THEN** backfill SHALL be skipped
- **AND** the change SHALL still collect observed snapshots from the current day forward

#### Scenario: Backfill does not block the tree
- **WHEN** backfill is running for fourteen roots
- **THEN** the tree SHALL remain interactive
- **AND** progress figures SHALL already be displayed

#### Scenario: Backfill of one change is bounded
- **WHEN** a change's `tasks.md` has been touched by 40 commits
- **THEN** its backfill SHALL complete within 2 seconds

---

### Requirement: Movement derivation

The system SHALL derive, for each change, the number of leaf tasks completed since a given date,
and the date on which its completed count last increased.

A change whose completed count has never increased across its recorded history SHALL report no
last-advanced date.

#### Scenario: Movement since a date
- **WHEN** a change had 55 complete on 2026-08-28 and has 61 complete today
- **AND** movement is requested since 2026-08-28
- **THEN** the system SHALL report 6 tasks completed

#### Scenario: Last advanced
- **WHEN** a change reached 61 complete on 2026-07-14 and has not changed since
- **THEN** its last-advanced date SHALL be 2026-07-14

#### Scenario: Never advanced
- **WHEN** a change has been at 0 complete throughout its recorded history
- **THEN** it SHALL report no last-advanced date

---

### Requirement: Stall derivation

The system SHALL compute days stalled as the number of whole days between a change's
last-advanced date and today.

A change with no last-advanced date SHALL use its creation date instead, and SHALL mark the
figure as measured from creation.

A change at 100 percent SHALL NOT be reported as stalled.

#### Scenario: Stalled change
- **WHEN** a change with 61 of 63 complete last advanced 52 days ago
- **THEN** it SHALL report 52 days stalled

#### Scenario: Recently advanced change
- **WHEN** a change with 61 of 63 complete last advanced yesterday
- **THEN** it SHALL report 1 day stalled

#### Scenario: Completed change is never stalled
- **WHEN** a change is at 100 percent and last advanced 90 days ago
- **THEN** it SHALL NOT be reported as stalled

---

### Requirement: Movement report

The system SHALL provide a command that produces a movement report across every discovered root
for a chosen period, listing per change the progress at the start of the period, the progress
now, the number of tasks completed in between, and the days stalled.

The report SHALL be rendered as a markdown document in an untitled editor.

The period SHALL default to seven days and SHALL be selectable.

#### Scenario: Weekly report
- **WHEN** the user runs the movement report with the default period
- **THEN** a markdown document SHALL open listing every change that moved in the last seven days
- **AND** a separate section SHALL list every change that did not move

#### Scenario: Change created within the period
- **WHEN** a change was created three days ago
- **THEN** the report SHALL show its starting progress as zero
- **AND** SHALL mark it as new in the period
