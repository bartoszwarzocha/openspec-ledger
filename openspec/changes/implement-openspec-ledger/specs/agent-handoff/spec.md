# Spec: agent-handoff

Traces to: D12 (terminal delivery with clipboard fallback)

---

## ADDED Requirements

### Requirement: Prompt construction

The system SHALL construct a handoff prompt for a selected task containing the change
identifier, the task number when it has one, the task label verbatim, the workspace-relative path
of its `tasks.md`, and the line number.

When the change has a `proposal.md`, the prompt SHALL reference it so the agent can read the
intent.

The prompt SHALL instruct the agent to tick the task's box on completion, and SHALL be a single
paragraph with no leading or trailing blank line.

The prompt template SHALL be overridable through the `openspecLedger.handoff.template` setting,
with placeholders for each of the above fields.

#### Scenario: Prompt for a numbered task
- **WHEN** the user hands off task 4.3 of the change `add-lookup-provider`
- **THEN** the prompt SHALL name the change, the number 4.3, the task text, the path to
  `tasks.md` and the line number

#### Scenario: Prompt for an unnumbered task
- **WHEN** the task has no `N.M` prefix
- **THEN** the prompt SHALL omit the number and remain otherwise complete

#### Scenario: Custom template
- **WHEN** `openspecLedger.handoff.template` is set to a string containing the placeholders
- **THEN** the constructed prompt SHALL use that template with the placeholders substituted

---

### Requirement: Section handoff

The system SHALL offer handoff for a whole section, producing a prompt that names the section and
lists its incomplete tasks in file order.

Complete tasks SHALL be omitted from a section handoff prompt.

#### Scenario: Section with mixed states
- **WHEN** a section holds five tasks of which two are incomplete
- **THEN** the section handoff prompt SHALL list exactly those two tasks

#### Scenario: Fully complete section
- **WHEN** every task in a section is complete
- **THEN** the section handoff command SHALL NOT be offered

---

### Requirement: Terminal selection

The system SHALL deliver the prompt to a terminal chosen as follows, in order: a terminal whose
shell-integration working directory is at or beneath the change's root; a terminal whose name
indicates a Claude Code session; otherwise a newly created terminal whose working directory is
the change's root and which runs the configured Claude Code command.

The command used to start a new terminal SHALL be configurable through
`openspecLedger.handoff.command` and SHALL default to `claude`.

The chosen terminal SHALL be shown before the text is sent.

#### Scenario: Existing terminal in the right directory
- **WHEN** a terminal's working directory is the change's root
- **THEN** the prompt SHALL be sent to that terminal
- **AND** no new terminal SHALL be created

#### Scenario: No suitable terminal
- **WHEN** no open terminal matches
- **THEN** a new terminal SHALL be created at the change's root running the configured command
- **AND** the prompt SHALL be sent to it

#### Scenario: Terminal is revealed
- **WHEN** a prompt is delivered to a terminal
- **THEN** that terminal SHALL be brought to the foreground

---

### Requirement: Delivery without submission

The prompt SHALL be written to the terminal without a trailing newline, so that it is not
submitted until the user presses Enter.

#### Scenario: Prompt awaits confirmation
- **WHEN** a prompt is delivered to a terminal
- **THEN** the terminal SHALL contain the prompt text
- **AND** no newline SHALL have been sent after it

---

### Requirement: Clipboard fallback

The system SHALL copy the prompt to the clipboard and inform the user when terminal delivery is
not possible, and SHALL offer clipboard delivery as an explicit alternative command.

#### Scenario: Terminal creation fails
- **WHEN** a terminal cannot be created
- **THEN** the prompt SHALL be copied to the clipboard
- **AND** a message SHALL tell the user it was copied and why

#### Scenario: Explicit copy command
- **WHEN** the user invokes the copy-prompt command on a task
- **THEN** the prompt SHALL be placed on the clipboard
- **AND** no terminal SHALL be created or revealed

---

### Requirement: Handoff availability

Handoff SHALL be offered only for tasks that are pending or in progress, and SHALL NOT be offered
for completed tasks or for changes in the undecomposed state.

#### Scenario: Completed task
- **WHEN** the user opens the context menu on a completed task
- **THEN** the handoff command SHALL NOT be present

#### Scenario: Undecomposed change
- **WHEN** the user opens the context menu on a change with no `tasks.md`
- **THEN** the handoff command SHALL NOT be present
