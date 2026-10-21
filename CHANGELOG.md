# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
