# Spec: git-evidence

Traces to: D8 (reference match as a signal), D14 (Stores disables this layer)

---

## ADDED Requirements

### Requirement: Reference extraction from task text

The system SHALL extract candidate references from a task's label, of two kinds:

- **path references** — tokens containing a forward or backward slash and a file extension,
  whether or not they appear inside an inline-code span
- **symbol references** — tokens inside an inline-code span that are not path references, and
  bare tokens that are PascalCase or end in a call parenthesis

Extraction SHALL discard tokens shorter than three characters and tokens consisting only of
digits and punctuation.

Extraction SHALL be purely textual and SHALL NOT read any source file.

#### Scenario: Task naming a module and a trait
- **WHEN** a task label reads
  "Create `src/provider/mod.rs` with `LookupProvider` async trait and `resolve_provider()`"
- **THEN** extraction SHALL yield the path reference `src/provider/mod.rs`
- **AND** the symbol references `LookupProvider` and `resolve_provider`

#### Scenario: Prose-only task
- **WHEN** a task label reads "Write unit tests for the happy path"
- **THEN** extraction SHALL yield no references

#### Scenario: Short and numeric tokens discarded
- **WHEN** a task label contains the inline-code spans `ok`, `5` and `1.1`
- **THEN** none of them SHALL be yielded as references

---

### Requirement: Completion date resolution

The system SHALL determine the date a completed task was ticked by finding the earliest snapshot
in which that task's line was recorded as complete, using the backfilled history.

When history does not cover the task, the system SHALL report the completion date as unknown and
SHALL NOT evaluate git evidence for it.

#### Scenario: Date from backfilled history
- **WHEN** a task appears pending in the revision of 2026-08-20 and complete in the revision of
  2026-08-21
- **THEN** its completion date SHALL be 2026-08-21

#### Scenario: No history coverage
- **WHEN** a change has no backfilled history because its root is not a git repository
- **THEN** every completed task SHALL report an unknown completion date
- **AND** the change SHALL report that git evidence is unavailable

---

### Requirement: Commit matching

For a completed task with a known completion date `T` and at least one reference, the system
SHALL search the containing repository for corroborating commits authored on or after `T` minus
seven days.

A path reference SHALL match when a commit in the window changed a file whose repository-relative
path ends with the reference.

A symbol reference SHALL match when a pickaxe search over the window returns at least one commit.

Commits that touch only files under `openspec/` SHALL be ignored for matching purposes.

#### Scenario: Path reference corroborated
- **WHEN** a task naming `src/provider/mod.rs` was completed on 2026-08-21
- **AND** a commit on 2026-08-20 changed `src/provider/mod.rs`
- **THEN** the task SHALL be reported as corroborated

#### Scenario: Symbol reference corroborated
- **WHEN** a task naming `LookupProvider` was completed on 2026-08-21
- **AND** a commit in the window added a line containing `LookupProvider`
- **THEN** the task SHALL be reported as corroborated

#### Scenario: Only the spec was committed
- **WHEN** the only commits in the window changed files under `openspec/`
- **THEN** those commits SHALL NOT corroborate the task

#### Scenario: Nothing matched
- **WHEN** a task has two references and neither matches any commit in the window
- **THEN** the task SHALL be reported as having no trace found

---

### Requirement: Three-state result and presentation

Every completed task SHALL be assigned exactly one of three states: `corroborated`,
`no-references` when extraction yielded nothing, and `no-trace` when references existed and none
matched.

Only `no-trace` results SHALL be surfaced in the user interface. They SHALL be presented as a
signal to review, never as an assertion that the task was not done.

Each surfaced result SHALL show the references that were searched, the time window, and the git
commands that produced the result.

#### Scenario: Corroborated tasks are not surfaced
- **WHEN** a change has 60 completed tasks of which 58 are corroborated and 2 have no references
- **THEN** no evidence signal SHALL be shown for that change

#### Scenario: No-trace result is explained
- **WHEN** a task is reported as no-trace
- **THEN** the panel SHALL list the references searched, the date window, and the commands run
- **AND** the wording SHALL describe a missing trace, not a false claim

---

### Requirement: Dismissal

The user SHALL be able to dismiss a `no-trace` result for a specific task. A dismissed result
SHALL NOT be surfaced again unless the task's line text changes.

Dismissals SHALL be persisted in extension storage alongside history.

#### Scenario: Dismissed result stays dismissed
- **WHEN** the user dismisses a no-trace result and reloads the window
- **THEN** that result SHALL NOT be surfaced again

#### Scenario: Task text changed after dismissal
- **WHEN** a dismissed task's line text is edited
- **THEN** the dismissal SHALL lapse and the task SHALL be evaluated again

---

### Requirement: Disabled by default and unavailable states

Git evidence SHALL be disabled unless `openspecLedger.gitEvidence.enabled` is set. When disabled,
no git command SHALL be run for evidence purposes.

The system SHALL report git evidence as unavailable, with the reason shown, when git is not on
`PATH`, when the root is not inside a git repository, or when the repository containing the
change holds no tracked files outside `openspec/`.

#### Scenario: Feature is off by default
- **WHEN** the extension is installed with default settings
- **THEN** no evidence-related git command SHALL be executed

#### Scenario: Planning-only repository
- **WHEN** a root's repository contains no tracked files outside `openspec/`
- **THEN** git evidence SHALL be reported unavailable for that root
- **AND** the reason SHALL state that the code lives in another repository

#### Scenario: Git missing
- **WHEN** `git` is not on `PATH`
- **THEN** git evidence SHALL be reported unavailable
- **AND** the rest of the extension SHALL function normally
