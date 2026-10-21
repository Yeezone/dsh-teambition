# AGENTS.md - dsh-teambition

Teambition panel plugin for the DSH Web GUI: sidebar entry + main-column page,
supported by a host-half REST bridge. This package is a self-contained cordis
plugin, mounted as a profile bundle without modifying the DSH source checkout.

## Repository rules

- Follow the turtle-ui conventions: a standalone pnpm package
  (`"type": "module"`, node `^22.19 || >=24`), peer APIs through
  `@deepseek-ai/dsh-*` peer/dev dependencies, and
  `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` for bundle activation.
- One program per face is not required here (both halves compile in one
  program like dsh-task-board), but a half must never import the other half:
  `src/client/**` imports only `src/core/**`; `src/host/**` imports only
  `src/core/**` and `src/index.ts` wires the two.
- Browser bundle discipline: `@deepseek-ai/*` imports in `src/client/**` are
  type-only unless the specifier is a platform module
  (`shared/web-platform.ts`: react, react/jsx-runtime, react-dom,
  react-dom/client, cordis, zod, @tanstack/react-virtual,
  @deepseek-ai/dsh-client-store, @deepseek-ai/dsh-client-ui-slots,
  @deepseek-ai/dsh-client-ui-primitives, @deepseek-ai/dsh-client-ui-dockkit`).
  Cross-plugin collaboration goes through cordis services (`ctx.slots`,
  `ctx.sessions`, `ctx.workspaces`, `ctx.uiWorkspace`), never through value
  imports.
- Shared build preset: `tsdown.config.ts` imports the vendored
  `shared/tsdown.client.ts` (copied from the dsh-web monorepo preset together
  with the platform seed table `shared/web-platform.ts`). Keep that copy in sync
  when the upstream preset changes.
- Bilingual copy: dictionaries live in `src/client/locales.ts` (`zh` is the key
  source, `en` carries the complete mirror). README is a pair
  (`README.md` + `README.zh.md`) recorded in `README.i18n.yaml`.
- Styling uses the `--dsw-alias-*` design tokens only; no hardcoded palette.
- The Teambition cookie is a session credential: keep it host-side, never log
  it, never return it to the browser half, and redact response previews
  (`src/core/teambition/redact.ts`) before they leave the host.
- Remote writes (create card, change status, change stage) are explicit user
  actions only; never write back as a side effect of reading or of running a
  card in DSH.
- Card execution creates a session through the public session-controller
  service and releases the retained reference after the prompt is submitted.

## Branches and versions

- `main` is the development trunk. `v0.1` is the frozen `v0.1` release line; a
  newer line gets its own `vX.Y` branch.
- Never commit a feature or fix straight to `main` or a release line. Work on
  `feat/<slug>` or `fix/<slug>` and merge through a pull request.
- Every change that lands on `main` bumps `package.json` `version` (feature →
  minor, fix → patch, breaking → major) and adds a `CHANGELOG.md` entry in the
  same pull request.
- Release lines only receive cherry-picked fixes and ship them as patch tags.
- Tag a release only after `main` CI is green: annotated tag `v<version>`
  (for example `v0.2.0`) plus a GitHub Release written from `CHANGELOG.md`.
- See [CONTRIBUTING.md](CONTRIBUTING.md) for the full flow.

## Layout

- `src/index.ts` - host entry (webServer routes, agent tool, mount-once).
- `src/host/` - config store, Teambition service, routes, agent tool,
  transport/client.
- `src/core/` - wire contract (`protocol.ts`) and Teambition vocabulary
  (`core/teambition/`).
- `src/client/` - browser half (sidebar/main registration, panel, locales, API
  client, CSS modules).
- `tests/` - vitest suites for both halves.

## Pre-commit checks

```sh
pnpm run typecheck
pnpm test
pnpm run build
```

The build must pass the bundle purity gate: any non-platform `@deepseek-ai/*`
value import in a client file fails the build.
