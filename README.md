# dsh-teambition

Teambition panel plugin for the DeepSeek Harness Web GUI. It adds a Teambition
entry to the sidebar and a full-height panel in the main column, so projects
and cards can be browsed and operated without leaving the GUI: switch projects,
read cards per kanban column, create cards, move cards between workflow
statuses and stages, and run a card in a chosen DSH workspace.

The panel talks to Teambition through the user's own browser session cookie,
which is stored host-side only. It is kept out of the browser storage and out of
model-visible output.

## Features

- Sidebar entry (`sidebar.panellist`) plus a main-column page (`main`), mounted
  through the official slot contract without patching the DSH source checkout.
- Project switcher, per-stage card columns, workflow status labels, and card
  creation for the selected project.
- Card actions: run in DSH, move to another status/stage, open in Teambition.
- Workspace bindings: per-card override, per-project default, and a panel-wide
  default, resolved card > project > default.
- Settings view inside the panel: cookie (write/clear), operator id, endpoint
  base (`api`/`web`), diagnose probes, default workspace, per-project workspace
  table.
- One model-visible agent tool, `teambition`, so a session can list projects,
  read a project, create cards, move cards, and record workspace bindings.

## Install (from source)

`@yeezone/dsh-client-ui-teambition` is a dual-face cordis plugin package: the
node half (`exports "."`) runs in the host process and serves
`POST /teambition/*`; the browser half (`exports "./client"`) is served to the
GUI as `/plugins/@yeezone/dsh-client-ui-teambition/client.js`.

```sh
pnpm install
pnpm run build
```

Then add the package to a profile and restart the app:

```sh
dsh plugin --profile desktop add link:<path-to-this-repository>
```

The bundle patch (`cordis.patch.yml`) inserts the `ui-teambition` row, so the
profile boot mounts both halves. Restarting the desktop app is required: the
browser half only loads when the composition includes the new row.

## Data and privacy

- Host state: `$DSH_HOME/teambition/config.json` (mode `0600`), holding the
  cookie, the operator id, endpoint base, workspace bindings, the last
  diagnostics pass, and the last project list. Writes are atomic.
- The browser half receives a settings view with `configured` and a four
  character `cookieTail` only; the cookie itself never crosses the boundary.
- Remote reads use the internal v3 endpoints with a candidate list and a
  `diagnose` probe rather than hardcoded assumptions; response previews are
  redacted before they reach the settings view.
- Card execution creates a DSH session in the bound workspace and submits one
  queued prompt; the panel does not write to Teambition unless you use the
  status/stage/create actions yourself.

## Package layout

- `src/core/` - shared vocabulary, wire contract (`protocol.ts`), Teambition
  types/endpoints/mapping/redaction.
- `src/host/` - config store, Teambition REST service, HTTP routes, agent tool.
- `src/client/` - locale dictionaries, API client, panel, sidebar registration.
- `tests/` - vitest suites for both halves.

## Tests

```sh
pnpm test
pnpm run typecheck
```

See `AGENTS.md` for the repository rules that apply to this package (build
purity, locale parity, dual-face manifest discipline).
