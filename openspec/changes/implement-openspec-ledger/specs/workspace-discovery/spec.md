# Spec: workspace-discovery

Traces to: D2 (discovery via findFiles), D13 (performance budgets), D14 (Stores layout)

---

## ADDED Requirements

### Requirement: Recursive discovery of OpenSpec roots

The system SHALL locate every OpenSpec root at any depth beneath every open workspace folder.

An OpenSpec root is a directory named `openspec` that contains either a `config.yaml` file or a
`changes` subdirectory.

Discovery SHALL honour the editor's `files.exclude` and `search.exclude` settings, and SHALL
additionally exclude `node_modules`, `.git`, `dist`, `out`, `build` and `target`.

Discovery SHALL be cancellable and SHALL NOT run on the activation path.

#### Scenario: Roots nested in sibling repositories are found
- **WHEN** a workspace folder contains `platform/data-service/openspec/config.yaml`,
  `platform/indexer/openspec/config.yaml` and seven further roots at similar depth
- **THEN** discovery SHALL return all nine roots
- **AND** each root SHALL carry the absolute path of the directory containing `openspec`

#### Scenario: Root at the workspace folder root is found
- **WHEN** a workspace folder contains `openspec/config.yaml` directly
- **THEN** discovery SHALL return exactly one root

#### Scenario: Root without config.yaml is accepted
- **WHEN** a directory `openspec/changes/` exists but `openspec/config.yaml` does not
- **THEN** discovery SHALL return that root
- **AND** the root SHALL be marked as having no configuration

#### Scenario: Excluded directories are not traversed
- **WHEN** a path `node_modules/some-package/openspec/config.yaml` exists
- **THEN** discovery SHALL NOT return it

#### Scenario: Empty workspace
- **WHEN** no workspace folder is open
- **THEN** discovery SHALL return an empty list
- **AND** SHALL NOT raise an error

---

### Requirement: Additional roots from configuration

The system SHALL accept a list of absolute directory paths in the
`openspecLedger.additionalRoots` setting and SHALL include any OpenSpec root found at or beneath
each of them, whether or not it lies inside an open workspace folder.

A configured path that does not exist SHALL be reported once in the extension output channel and
SHALL NOT prevent the remaining roots from loading.

#### Scenario: Root outside the workspace is included
- **WHEN** `openspecLedger.additionalRoots` contains `D:\work\projects\lookup-service`
- **AND** no workspace folder contains that path
- **THEN** discovery SHALL return the root at `D:\work\projects\lookup-service\openspec`

#### Scenario: Nonexistent configured path
- **WHEN** a configured additional root does not exist on disk
- **THEN** discovery SHALL log the path to the output channel
- **AND** SHALL return every other discovered root

---

### Requirement: Root configuration parsing

The system SHALL read `config.yaml` at each root and SHALL extract the `schema` value when
present.

A `config.yaml` that cannot be parsed SHALL NOT remove the root from the results; the root SHALL
be returned with no configuration and the parse failure SHALL be recorded on it.

#### Scenario: Valid configuration
- **WHEN** `config.yaml` contains `schema: spec-driven`
- **THEN** the root SHALL report its schema as `spec-driven`

#### Scenario: Malformed configuration
- **WHEN** `config.yaml` contains text that is not valid YAML
- **THEN** the root SHALL still be returned
- **AND** the root SHALL carry a configuration error describing the failure

---

### Requirement: Discovery caching and invalidation

The system SHALL cache the discovered root list and SHALL re-run discovery when a workspace
folder is added or removed, when `openspecLedger.additionalRoots` changes, or when the user
invokes the refresh command.

The system SHALL NOT re-run discovery in response to changes to files inside an already-known
root.

#### Scenario: Workspace folder added
- **WHEN** a workspace folder is added to the session
- **THEN** discovery SHALL re-run
- **AND** roots beneath the new folder SHALL appear

#### Scenario: File edit does not trigger rediscovery
- **WHEN** a `tasks.md` inside a known root is modified
- **THEN** discovery SHALL NOT re-run

---

### Requirement: Discovery performance

Discovery across fourteen roots in a tree containing nine repositories SHALL complete within
one second, and the extension SHALL render its tree before discovery completes.

#### Scenario: Tree renders before discovery completes
- **WHEN** the extension activates
- **THEN** the Ledger view SHALL be registered and rendering a loading state within 300 ms
- **AND** roots SHALL be appended to the tree as discovery yields them
