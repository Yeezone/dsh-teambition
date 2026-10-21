# dsh-teambition

English | [中文说明](README.zh.md)

**Bring Teambition into the DeepSeek Harness sidebar.** Browse projects, task
lists and cards inside DSH, operate them without leaving the GUI, and run any
card in a DSH workspace you pick: the plugin creates a session in that workspace
and submits the card's title, project, link, updated time and note as the opening
prompt.

- Repository: <https://github.com/Yeezone/dsh-teambition>
- Latest release: `v0.1` (`0.1.0`); `main` carries the `0.1.x` increments
- License: Apache-2.0

## Why it exists

Work happens in DSH, while tasks and bugs live in Teambition. Switching windows
to read a card, then pasting its context into a session, is the part worth
automating. The plugin turns Teambition into a DSH panel:

1. Click **Teambition** in the sidebar; the panel opens in the main column.
2. Pick a project (and a task list, for projects with several), then read cards
   per kanban column.
3. Click **Run** on a card: the plugin creates a session in the bound workspace,
   submits the card title, project, link, updated time and note as one queued
   prompt, then opens that session.

Where a card runs is configurable: a per-card binding wins, then the project
default, then the panel-wide default workspace.

## Where it lives in the GUI

- **Sidebar row**: registered on the official `sidebar.panellist` seat, after
  "Plugins" and "Automations".
- **Main page**: registered on the official `main` seat, with project / task list
  switchers plus refresh and settings.
- **Board**: one column group per stage, cards carrying a status badge, their
  workspace marker, and the actions Run, Open in Teambition, Bind workspace,
  Move to stage.
- **New card form** at the bottom of the panel: title, optional note, target
  stage.
- **Settings view**: cookie (write / clear), diagnose probes, operator id,
  endpoint base, default workspace, and a per-project workspace table.

## Features

- Two-level switching (project, then task list). Projects with many task lists
  are grouped by list instead of flattened into dozens of same-named columns; the
  selection is remembered in `localStorage` and restored on the next visit.
- Card actions: run in DSH, move to another stage, move to another workflow
  status (when the project exposes that endpoint), open in Teambition.
- Workspace bindings with card > project > panel-default precedence, resolved by
  the host so the browser half never needs the full binding table.
- Diagnostics: six candidate endpoints are probed one by one and the HTTP status
  plus verdict of each attempt is shown, which makes an expired cookie or an API
  change easy to spot.
- One model-visible agent tool, `teambition`: list projects, read a project,
  create cards, move cards, record workspace bindings.
- Bilingual UI (zh / en) that follows the DSH language and light / dark theme.

## Quick start

1. Sign in to <https://www.teambition.com> in a browser, open DevTools → Network,
   refresh, select any request, and copy its whole **Cookie request header** (not
   the page URL).
2. In DSH: sidebar → **Teambition** → **Settings** → paste the cookie → save →
   **Diagnose**. A usable cookie reports `Cookie accepted`.
3. Back on the board, choose a project (and a task list if the project has
   several; "all task lists" is grouped by list).
4. Choose a default workspace in settings, or bind one per project or per card.
5. Click **Run** on a card; a session opens in that workspace with the card
   context already submitted.

> Cookies expire. When they do, the board and the diagnose verdict report
> `HTTP 401 AccessTokenMissing`; copy a fresh cookie and save it again.

## Install

`@yeezone/dsh-client-ui-teambition` is a dual-face cordis plugin package: the
node half (`exports "."`) runs in the host process and serves
`POST /teambition/*`; the browser half (`exports "./client"`) is served to the
GUI as `/plugins/@yeezone/dsh-client-ui-teambition/client.js`.

```sh
git clone https://github.com/Yeezone/dsh-teambition.git
cd dsh-teambition
pnpm install --frozen-lockfile
pnpm run build
dsh plugin --profile <profile> add link:$PWD
```

The bundle patch (`cordis.patch.yml`) inserts the `ui-teambition` row, so the
profile boot mounts both halves. A **full application restart** is required: the
browser half only loads when the composition includes the new row. After that,
client-only changes need a page refresh.

If the profile is app-owned (the packaged desktop app's `desktop` profile), the
CLI refuses to write it: install from the GUI Plugins page, or add the dependency
and the `dsh.profile.bundles` row to the profile's `package.json` manually, then
restart.

## Data and privacy

- Host state lives in `$DSH_HOME/teambition/config.json` (mode `0600`): cookie,
  operator id, endpoint base, workspace bindings, the last diagnose pass, and the
  last project list. Writes are atomic (temp file + rename).
- The browser half receives `configured` and a four character `cookieTail` only;
  the cookie never crosses the host / browser boundary and never reaches
  model-visible output.
- Remote reads use Teambition's own web REST API through a candidate list plus a
  `diagnose` probe rather than hardcoded assumptions; response previews are
  redacted before they reach the settings view.
- The plugin writes to Teambition only for explicit actions (create card, change
  stage, change status); running a card only creates a local DSH session.

## Known limits

- Teambition's web REST API is an internal, cookie-authenticated API (not the
  official open API) and may change without notice.
- Pushing a workflow status depends on the project exposing that endpoint;
  projects without workflow statuses can only move cards between stages.
- Card listing is capped at 40 pages of 200 tasks per project.
- No background polling or webhook support: data refreshes when you open the
  panel or press refresh.
- Moving a card across projects is not implemented yet (the path is unverified).

## Versioning and branches

- `main` is the development trunk; `v0.1` is the current frozen release line
  (`0.1.x`).
- New work branches as `feat/<slug>`, fixes as `fix/<slug>`. Every change that
  lands on `main` bumps `package.json` `version` and adds a `CHANGELOG.md` entry;
  the pull request template enforces both.
- Release lines only receive cherry-picked fixes, shipped as patch tags. Tags
  (`v<version>`) and GitHub Releases are cut only after `main` CI is green. See
  [CONTRIBUTING.md](CONTRIBUTING.md).

## Package layout

- `src/core/` - shared vocabulary, wire contract (`protocol.ts`), Teambition
  types / endpoints / mapping / redaction.
- `src/host/` - config store, Teambition REST service, HTTP routes, agent tool.
- `src/client/` - locale dictionaries, API client, panel, sidebar registration.
- `shared/` - build preset vendored from the dsh-web monorepo (tsdown client
  bundling plus the platform seed table).
- `tests/` - vitest suites for both halves.

## Tests

```sh
pnpm run typecheck
pnpm test
pnpm run build
```

## Credits and license

Apache-2.0. The Teambition client and config code is adapted from the
`dsh-task-board` package of [dsh-web](https://github.com/zhu1090093659/dsh-web)
(Apache-2.0); see [NOTICE](NOTICE) for the upstream attribution and the scope of
reuse. This plugin is not maintained by that repository's authors.
