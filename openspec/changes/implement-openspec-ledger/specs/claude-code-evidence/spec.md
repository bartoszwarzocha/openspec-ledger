# Spec: claude-code-evidence

Traces to: D9 (binding by change path), D10 (vendored pricing), D13 (transcript budget)

---

## ADDED Requirements

### Requirement: Transcript discovery

The system SHALL locate Claude Code transcripts under the per-user data directory, honouring the
`CLAUDE_CONFIG_DIR` environment variable and defaulting to `.claude` in the user's home
directory.

Every `.jsonl` file beneath the `projects` subdirectory SHALL be considered a transcript,
regardless of which project directory it sits in.

A missing data directory SHALL be reported as an explained unavailable state, not an error.

#### Scenario: Default location
- **WHEN** `CLAUDE_CONFIG_DIR` is unset
- **THEN** transcripts SHALL be sought beneath the `.claude/projects` directory in the user's home

#### Scenario: Overridden location
- **WHEN** `CLAUDE_CONFIG_DIR` names an existing directory
- **THEN** transcripts SHALL be sought beneath its `projects` subdirectory

#### Scenario: No data directory
- **WHEN** no Claude Code data directory exists
- **THEN** the evidence layer SHALL report itself unavailable
- **AND** the message SHALL explain that no Claude Code history was found on this machine

---

### Requirement: Change binding

A transcript SHALL be bound to a change when the text `openspec/changes/<change identifier>`
appears anywhere in that transcript, in either path separator form.

Binding SHALL be case-insensitive on Windows.

A transcript MAY be bound to several changes, and a change MAY be bound to several transcripts.

#### Scenario: Session bound by a tool call
- **WHEN** a transcript contains a tool input referencing
  `openspec/changes/route-reads-through-data-service/tasks.md`
- **THEN** that session SHALL be bound to the change `route-reads-through-data-service`

#### Scenario: Backslash separators
- **WHEN** a transcript contains `openspec\changes\theme-tokens`
- **THEN** the session SHALL be bound to the change `theme-tokens`

#### Scenario: Unbound transcript
- **WHEN** a transcript mentions no change path
- **THEN** it SHALL NOT appear under any change

---

### Requirement: Per-session attribution

For each session bound to a change, the system SHALL report the session identifier, its working
directory, the timestamps of its first and last activity, the models used, the total input and
output tokens, an estimated cost, and the set of files it edited outside `openspec/`.

Files edited SHALL be collected from file-writing tool calls recorded in the transcript.

Messages SHALL be deduplicated by their message and request identifiers, keeping the first
occurrence, because streaming writes repeat entries.

#### Scenario: Session summary
- **WHEN** a session with 40 assistant messages is bound to a change
- **THEN** the panel SHALL show its first and last activity times, model, token totals and cost

#### Scenario: Duplicate entries are counted once
- **WHEN** a transcript contains the same message and request identifier pair three times
- **THEN** its tokens SHALL be counted once

#### Scenario: Edited files exclude the spec itself
- **WHEN** a session edited `src/provider/mod.rs` and `openspec/changes/x/tasks.md`
- **THEN** the reported edited files SHALL contain only `src/provider/mod.rs`

---

### Requirement: Cost estimation

The system SHALL estimate cost from a per-model price table matched by model-id prefix,
longest prefix first, covering input, output, cache writes at both durations, and cache reads.

Cost SHALL be labelled an estimate wherever it is displayed.

A model identifier matching no entry SHALL contribute zero cost and SHALL be listed as unpriced.

#### Scenario: Longest prefix wins
- **WHEN** the price table holds entries for both a family prefix and a specific dated model id
- **AND** a message names the dated model id
- **THEN** the dated entry's prices SHALL be used

#### Scenario: Unknown model
- **WHEN** a message names a model id matching no table entry
- **THEN** its cost contribution SHALL be zero
- **AND** the model SHALL be listed as unpriced in the panel

---

### Requirement: Change-level rollup

For each change the system SHALL report the number of bound sessions, the span from earliest to
latest activity, the summed tokens and estimated cost, and the union of edited files.

#### Scenario: Change worked across several sessions
- **WHEN** six sessions are bound to a change
- **THEN** the change SHALL report six sessions and the summed cost across them

#### Scenario: Change with no bound sessions
- **WHEN** no transcript references a change
- **THEN** the change SHALL report no Claude Code activity
- **AND** SHALL NOT report a cost of zero as though it had been measured

---

### Requirement: Checked-without-code signal

The system SHALL surface a signal when a task's completion date falls inside the activity span of
a bound session and no session active on that date edited any file outside `openspec/`.

The signal SHALL name the sessions considered and the dates examined.

#### Scenario: Spec-only session ticked a box
- **WHEN** a task was completed on a date on which the only active bound session edited
  nothing outside `openspec/`
- **THEN** the change SHALL surface the checked-without-code signal for that task

#### Scenario: Source files were edited
- **WHEN** a session active on the completion date edited three source files
- **THEN** no signal SHALL be surfaced for that task

---

### Requirement: Lazy reading and caching

Transcripts SHALL NOT be read during activation, during discovery, or during a model rebuild.
They SHALL be read when a change detail panel is opened, or when the evidence column is enabled.

Parsed results SHALL be cached by file modification time and size. A transcript untouched for
more than thirty days SHALL be skipped without being opened, unless a full rescan is requested.

A scan of the reference corpus of roughly 100 MB SHALL complete within one second when the cache
is warm.

#### Scenario: Activation reads no transcripts
- **WHEN** the extension activates and renders its tree
- **THEN** no transcript file SHALL have been opened

#### Scenario: Cached scan
- **WHEN** a scan runs twice with no transcript modified in between
- **THEN** the second scan SHALL read no transcript file

#### Scenario: Old transcripts are skipped
- **WHEN** a transcript has not been modified for 45 days
- **THEN** it SHALL be skipped unless a full rescan is requested

---

### Requirement: Privacy

The system SHALL NOT transmit transcript content anywhere, SHALL NOT write transcript content to
any file outside its own cache, and SHALL display only derived aggregates and file paths, never
prompt or response text.

The entire layer SHALL be disabled unless `openspecLedger.claudeEvidence.enabled` is set.

#### Scenario: Feature is off by default
- **WHEN** the extension is installed with default settings
- **THEN** no transcript file SHALL be opened

#### Scenario: No prompt text is displayed
- **WHEN** a change detail panel shows six bound sessions
- **THEN** no prompt or response text from those sessions SHALL appear in the panel
