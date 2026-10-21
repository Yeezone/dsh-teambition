/**
 * Teambition client plugin: registers the panel's dictionaries and mounts its
 * two native surfaces — the sidebar entry row and the full-height main page.
 *
 * The panel is an official-style center-column page, not a DOM takeover: it
 * contributes a row into the sidebar shell's own global panel list
 * (`sidebar.panellist`) and its page into the layout's keyed `main` slot. Both
 * registrations go through `ctx.slots.inject`, which fires only once the owning
 * shell entry has declared the seat, so load order between this plugin and
 * ui-layout / ui-sidebar does not matter and a shell that cannot serve the
 * seats leaves the panel absent instead of failing boot.
 *
 * The browser half reaches the session, workspace and workspace-UI services
 * through the cordis registry only (browser-bundle purity): no value import of
 * those packages appears here.
 *
 * @module @yeezone/dsh-client-ui-teambition/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
// Type-only: the session-controller Context merge (ctx.sessions) and the
// reference-source merge table this entry extends below.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the slot registry's Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the workspace UI's Context merge (ctx.uiWorkspace).
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { TEAMBITION_LOCALE_NS, TEAMBITION_PANEL_ID } from '../core/protocol.ts'
import { TeambitionPanel, type TeambitionPanelProps } from './panel.tsx'
import { TeambitionPanelIcon } from './glyph.tsx'
import type { SessionsFace, UiWorkspaceFace, WorkspaceItemView, WorkspacesFace } from './faces.ts'
import { en, setRuntimeTranslate, zh } from './locales.ts'

/** The sidebar row glyph, also the row's semantic anchor. */
export { TeambitionPanelIcon }

/** The panel component, exported for composition tests. */
export { TeambitionPanel }

/**
 * Row order among the shell's global panel rows (Plugins is 0, Schedule 10,
 * task board 20): the Teambition board sits directly below the task board.
 */
export const PANEL_ORDER = 21

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /**
     * A card run: the panel retains the session it just created until the card
     * prompt is queued, then releases it.
     */
    teambition: unknown
  }
}

/**
 * Required services (fiber inject waiting — the runtime must be up first).
 * Every one is a platform service of the shell this plugin is composed into;
 * no optional host half is injected here.
 */
export const inject = ['slots', 'locale', 'sessions', 'workspaces', 'uiWorkspace', 'connection']

/**
 * The injected face the main-slot registration hands the page.
 *
 * Structural faces (not the SDK interfaces) keep the page a plain React
 * component: the live cordis services are cast onto these once, in
 * {@link buildPanelFace}.
 */
export type TeambitionPanelFace = Pick<TeambitionPanelProps, 'sessions' | 'workspaces' | 'uiWorkspace'>

/**
 * Cast the live cordis services onto the structural faces the page consumes.
 * @param ctx - client root context.
 * @returns the page's service face.
 */
export function buildPanelFace(ctx: ClientContext): TeambitionPanelFace {
  const sessions = ctx.get('sessions') as unknown as ISessions
  const workspaces = ctx.get('workspaces') as unknown as IWorkspaces
  const sessionsFace: SessionsFace = {
    create: options => sessions.create({ workspaceId: options.workspaceId as never }) as unknown as Promise<string>,
    retain: (sessionId, options) => sessions.retain(sessionId as never, { source: options.source }) as unknown as ReturnType<SessionsFace['retain']>,
  }
  const workspacesFace: WorkspacesFace = {
    list: workspaces.list as unknown as {
      getSnapshot(): { readonly items: readonly WorkspaceItemView[] }
      subscribe(listener: () => void): () => void
    },
  }
  const uiWorkspaceFace: UiWorkspaceFace = {
    // The layout owns panel selection; the workspace service shows a session.
    openSession: sessionId => { ctx.uiWorkspace.openSession(sessionId as never) },
  }
  return { sessions: sessionsFace, workspaces: workspacesFace, uiWorkspace: uiWorkspaceFace }
}

/**
 * Register the panel's sidebar row and center-column page.
 *
 * Both seats are declared by shell plugins this package does not depend on at
 * runtime, so each registration is wrapped in `ctx.slots.inject`: the callback
 * runs only after the owning entry declares the seat, and a shell that never
 * declares it leaves the panel simply absent instead of failing boot.
 * @param ctx - client root context (services: slots, sessions, workspaces).
 * @returns disposer releasing both registrations.
 */
export function registerTeambitionPanel(ctx: ClientContext): () => void {
  const slots = ctx.slots as unknown as {
    inject(key: string, callback: () => () => void): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  const face = buildPanelFace(ctx)
  const disposers: Array<() => void> = []

  disposers.push(slots.inject('sidebar.panellist', () => slots.register({
    name: 'sidebar.panellist',
    id: TEAMBITION_PANEL_ID,
    order: PANEL_ORDER,
    // The shell resolves this through resolveSlotLabel on every locale change,
    // so the module-level translate reads the active language at call time.
    label: () => ctx.locale.bind(TEAMBITION_LOCALE_NS)('entry.label'),
  }, TeambitionPanelIcon)))

  disposers.push(slots.inject('main', () => slots.register({
    name: 'main',
    key: TEAMBITION_PANEL_ID,
    inject: (): TeambitionPanelFace => face,
  }, TeambitionPanel as never)))

  return () => {
    for (const dispose of disposers.splice(0)) dispose()
  }
}

/**
 * Mount the Teambition panel.
 *
 * Failure policy: DOM mounting problems are logged, never thrown — the web
 * shell fails the whole boot when a plugin apply throws, and an external
 * plugin must not take the GUI down.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    try {
      return ctx.locale.register(TEAMBITION_LOCALE_NS, { zh, en })
    } catch {
      return () => {}
    }
  }, 'teambition: dictionaries')

  // Wire the SDK translate seat into the module-level t (sidebar row label and
  // the plain-text corners of the page): reads the active locale at call time,
  // so both follow the Language setting without a reload.
  try { setRuntimeTranslate(ctx.locale.bind(TEAMBITION_LOCALE_NS)) } catch { /* locale missing: document-language fallback stays */ }
  ctx.effect(() => () => { setRuntimeTranslate(undefined) }, 'teambition: translate seat')

  try {
    const dispose = registerTeambitionPanel(ctx)
    ctx.effect(() => dispose, 'teambition: panel surfaces')
  } catch (error) {
    // A shell that cannot serve the seats degrades the panel, never the GUI.
    console.error('[dsh-teambition] panel registration failed:', error)
  }
}
