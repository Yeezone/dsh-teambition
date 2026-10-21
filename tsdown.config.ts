/**
 * Build config for the Teambition panel plugin.
 *
 * Uses the vendored shared client-bundle preset (shared/tsdown.client.ts): node-half lib/ plus the
 * browser bundle lib/client.js (closure-factory artifact for the GUI's
 * __ModuleLoader__, CSS Modules inlined with auto-injected <style data-plugin>).
 *
 * Node-half entries point at src (tsdown compiles TS directly), so the build
 * needs no separate tsc emit for runtime artifacts.
 */
import { clientBundle } from './shared/tsdown.client.ts'

export default clientBundle('@yeezone/dsh-client-ui-teambition', ['src/index.ts'], {
  libExternal: [
    '@deepseek-ai/dsh-api-remotes',
    '@deepseek-ai/dsh-api-session-controller',
    '@deepseek-ai/dsh-api-workspace-controller',
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-workspace',
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-settings',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-workspace',
  ],
})
