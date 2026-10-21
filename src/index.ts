/**
 * Host entry of the Teambition panel plugin.
 *
 * Wires the three host pieces together: the persisted config store, the
 * Teambition service on top of it, the `/teambition` JSON routes of the GUI
 * web server and the model-visible `teambition` tool. Everything is registered
 * through effects so the plugin unmounts cleanly.
 *
 * @module dsh-teambition/index
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import { mountOnce } from './mount-once.ts'
import { buildTeambitionTool } from './host/agent-tool.ts'
import { TeambitionConfigStore } from './host/config-store.ts'
import { registerTeambitionRoutes } from './host/routes.ts'
import { createTeambitionService } from './host/service.ts'

/** Services this plugin needs before it can mount. */
export const inject = ['webServer']

/** Mount guarded by the shared one-shot registry. */
export const apply = mountOnce('@yeezone/dsh-client-ui-teambition', applyImpl)

/** Mount the host bridge: routes plus agent tool. */
function applyImpl(ctx: Context): void {
  const store = new TeambitionConfigStore()
  const service = createTeambitionService(store)

  const toolFiber = ctx.inject(['tools'], (toolCtx: Context) => {
    toolCtx.effect(
      () => toolCtx.tools.register(buildTeambitionTool(service)),
      'dsh-teambition: teambition tool',
    )
  })

  ctx.effect(() => {
    const disposeRoutes = registerTeambitionRoutes(ctx, service)
    return () => {
      disposeRoutes()
      toolFiber.dispose()
    }
  }, 'dsh-teambition: host bridge')
}
