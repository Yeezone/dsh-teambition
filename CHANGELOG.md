# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-10-21

### Added

- Saved views: the board renders the project views the Teambition web board
  lists (for example "All tasks", a status board, "My tasks", "Created by me")
  in a rail on the left, and remembers the chosen view per project.
- Workflow-status boards: a view saved with a workflow vertical renders one
  column per workflow status instead of one column per kanban stage, which is
  how the tasks module looks in Teambition. Stage views keep rendering stages.
- Column quick-add: every column header has a "+" button that opens the create
  form with that column preselected, workflow statuses included.
- Card moves understand the column kind: status columns are updated through the
  workflow status API, stage columns through the stage API.
- Task-type chip in the task drawer, and the task type needed to create a card
  into a workflow status is inferred from the target status when unambiguous.
- Saved view filters: executing and creating user filters are applied to the
  cards, and status views narrow the cards to their task types.
- Tests: host view parsing (workflows, task types, views, columns, filters,
  status creation) and the client view rail / status board (146 total).

### Changed

- Board columns now come from the selected view; projects whose views cannot be
  read keep rendering their stages.
- Creating a card into a status column of a project with several task types no
  longer fails when the target status belongs to exactly one type.

## [0.3.0] - 2026-10-21

### Added

- Task-list filter in the task toolbar: with several lists, the table can be
  narrowed to one list without leaving the "all task lists" board; the filter is
  remembered per visit and cleared when the project changes.
- Default-view setting in the settings view (task list / board). The chosen
  surface is remembered and is what the panel and every project switch open on,
  so the table is no longer forced on people who work in the board.
- Three task module tests: the task-list filter, the remembered board view and
  the default-view setting.

### Changed

- The remembered task-view storage moved to `dsh.teambition.taskview.v2` (it now
  carries the view and the task-list filter); v1 entries are ignored and rebuilt.

## [0.2.0] - 2026-10-21

### Added

- Task module view, now the default view of the panel: a task table with the task
  number, title, assignee avatar and name, due date (flagged when overdue), stage
  and last update time.
- Toolbar with search (title / note / number / assignee), grouping by task list,
  stage or assignee, filtering by all / open / done / overdue / unassigned, and
  sorting by updated, created, due or priority; the toolbar state persists in
  `localStorage`.
- Slide-over detail drawer for a task: number, priority, assignee, due date,
  stage, task list, created and updated times, note body, plus the existing
  run / open-in-Teambition / bind-workspace / move-stage actions.
- Host and protocol now carry `uniqueId`, executor (id, name, avatar url), due
  date, created time, subtask count and comment count for every card.
- Eight task module tests covering the default table and count, search, the four
  filters, grouping by stage and assignee, sorting by due date, opening and
  running a card from the drawer, and restoring the persisted toolbar settings.

### Changed

- The panel opens on the task list; the previous card board stays available
  through the Tasks / Board switcher.
- Table rows stay on one line, and the detail drawer floats over the list instead
  of shrinking it.

## [0.1.2] - 2026-10-21

### Changed

- Both READMEs now name the latest release (`v0.1`, `0.1.0`) instead of a fixed
  version number, so the introduction stays correct while `main` carries `0.1.x`
  increments. `README.i18n.yaml` re-recorded.

## [0.1.1] - 2026-10-21

### Changed

- Rewrote the Chinese README as a full introduction: what problem the plugin
  solves, where the entry and panel live, the feature list, a five-step quick
  start (copy the cookie, diagnose, pick project and task list, bind a workspace,
  run a card), install notes for app-owned profiles, privacy rules, known limits,
  and the version/branch policy.
- Rewrote the English README to the same structure so the two sides stay a true
  pair, and re-recorded both git blob hashes in `README.i18n.yaml`.
- README language switcher added on both sides.

## [0.1.0] - 2026-10-21

First tagged release (`v0.1` line).

### Added

- Sidebar entry (`sidebar.panellist`) and a main-column panel (`main`) mounted
  through the official DSH slot contract, without patching the DSH source
  checkout.
- Project switcher plus a task-list switcher: multi-tasklist projects render as
  grouped columns instead of one flattened column list; the selection is
  remembered in `localStorage`.
- Per-stage card columns, card creation with an optional note and target stage,
  and card actions: run in DSH, move to another stage, move to another workflow
  status (where the project exposes one), open in Teambition.
- Workspace bindings with card > project > panel-wide precedence, resolved by the
  host so the browser half never needs the full binding table.
- Settings view inside the panel: cookie write/clear, operator id, endpoint base
  (`api` / `web`), diagnose probes per candidate endpoint, default workspace, and
  a per-project workspace table.
- Host half: `POST /teambition/*` routes (loopback only), atomic host-side config
  at `$DSH_HOME/teambition/config.json` (mode `0600`), endpoint candidate
  fallbacks for the internal `www.teambition.com` REST API, and one model-visible
  agent tool (`teambition`).
- Card execution: creates a session in the bound workspace, submits one queued
  prompt with the card title, project, URL, updated time and note, then opens the
  session.
- CI (typecheck, tests, build, artifact assertions) and bilingual README with a
  paired `README.i18n.yaml` record.

### Fixed

- A pasted page URL in the cookie field is rejected with an actionable hint
  instead of a 401 round trip.
- Deep-theme native `<select>` popups were white-on-white; option and optgroup
  colors now follow the `--dsw-alias-*` tokens in both themes.
- Stale diagnose verdicts are dropped when the cookie changes.
