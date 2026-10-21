/**
 * Persisted host-side state of the Teambition panel plugin.
 *
 * The store owns `$DSH_HOME/teambition/config.json`: the cookie (host-only
 * session credential), the operator id, the two binding tables, the last
 * diagnostics pass and the project snapshot. Writes are atomic (temp file plus
 * rename, mode 0600) so a crash never leaves a half-written config behind; a
 * corrupt or unreadable file degrades to defaults instead of failing the boot.
 *
 * @module dsh-teambition/host/config-store
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  TeambitionCardBinding,
  TeambitionProjectBinding,
  TeambitionSettingsView,
} from '../core/protocol.ts'
import {
  TEAMBITION_PANEL_ID,
} from '../core/protocol.ts'
import {
  readProject,
  truncate,
  type TeambitionBase,
  type TeambitionDiagnostics,
  type TeambitionDiagnosis,
  type TeambitionProject,
  type TeambitionProbeResult,
} from '../core/teambition/index.ts'
import { resolveDshHome } from '../dsh-home.ts'

/** On-disk state version this build reads and writes. */
export const TEAMBITION_CONFIG_VERSION = 1

/** Upper bound of either binding table (a runaway client cannot bloat the file). */
const MAX_BINDINGS = 500

/** Upper bound of the persisted project snapshot. */
const MAX_PROJECTS = 500

/** Upper bound of persisted diagnose probes. */
const MAX_PROBES = 12

/** Upper bound of a persisted message. */
const MAX_MESSAGE = 400

/** Upper bound of a persisted response preview. */
const MAX_PREVIEW = 200

/** How many trailing cookie characters the browser-safe view exposes. */
const COOKIE_TAIL_LENGTH = 4

/** The settings the host half persists. The cookie never leaves the host. */
export interface TeambitionHostSettings {
  /** Raw `Cookie` request header copied from a logged-in teambition.com tab. */
  readonly cookie?: string
  /** Teambition user id sent as `x-operator-id` on writes. */
  readonly operatorId?: string
  /** Which host the internal endpoints are addressed to. */
  readonly apiBase: TeambitionBase
  /** Workspace used by cards without a card or project binding. */
  readonly defaultWorkspaceId?: string
  /** Per-project default workspaces. */
  readonly projectBindings: readonly TeambitionProjectBinding[]
  /** Per-card workspace overrides. */
  readonly cardBindings: readonly TeambitionCardBinding[]
}

/** Shape of `$DSH_HOME/teambition/config.json`. */
export interface TeambitionHostState {
  /** On-disk shape version; anything else is discarded on read. */
  readonly version: 1
  readonly settings: TeambitionHostSettings
  /** Sanitized result of the last diagnose pass. */
  readonly diagnostics?: TeambitionDiagnostics
  /** Epoch ms of the last successful refresh. */
  readonly lastSyncAt?: number
  /** Last failure message, cleared by a successful refresh. */
  readonly lastError?: string
  /** Projects seen by the last successful listing. */
  readonly projects?: readonly TeambitionProject[]
}

/** One load: the normalized state plus human-readable warnings. */
export interface TeambitionStoreLoad {
  readonly state: TeambitionHostState
  readonly warnings: readonly string[]
}

/** Construction seam of the store (tests point it at a temp home). */
export interface TeambitionConfigStoreOptions {
  /** Environment to read `DSH_HOME` from. */
  readonly env?: NodeJS.ProcessEnv
  /** Platform home fallback. */
  readonly home?: string
}

/** Defaults of a store that has no file yet. */
export function defaultTeambitionSettings(): TeambitionHostSettings {
  return { apiBase: 'api', projectBindings: [], cardBindings: [] }
}

/** Default state of a store that has no file yet. */
export function defaultTeambitionState(): TeambitionHostState {
  return { version: TEAMBITION_CONFIG_VERSION, settings: defaultTeambitionSettings() }
}

/** Whether a value is a JSON object (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Trimmed non-empty string, else undefined. */
function trimmed(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text === '' ? undefined : text
}

/** Finite number, else undefined. */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Normalize the stored host selector. */
function normalizeApiBase(value: unknown): TeambitionBase {
  return value === 'web' ? 'web' : 'api'
}

/**
 * Normalize one binding table. Entries without both a non-empty id and a
 * non-empty workspace id are dropped; a duplicate id keeps its first entry.
 */
function normalizeBindingRows(value: unknown, key: 'projectId' | 'taskId'): { id: string; workspaceId: string }[] {
  if (!Array.isArray(value)) return []
  const rows: { id: string; workspaceId: string }[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const id = trimmed(entry[key])
    const workspaceId = trimmed(entry.workspaceId)
    if (id === undefined || workspaceId === undefined || seen.has(id)) continue
    seen.add(id)
    rows.push({ id, workspaceId })
    if (rows.length >= MAX_BINDINGS) break
  }
  return rows
}

/** Normalize the persisted settings of a possibly older/corrupt file. */
export function normalizeSettings(value: unknown): TeambitionHostSettings {
  const record = isRecord(value) ? value : {}
  const cookie = trimmed(record.cookie)
  const operatorId = trimmed(record.operatorId)
  const defaultWorkspaceId = trimmed(record.defaultWorkspaceId)
  return {
    ...(cookie === undefined ? {} : { cookie }),
    ...(operatorId === undefined ? {} : { operatorId }),
    apiBase: normalizeApiBase(record.apiBase),
    ...(defaultWorkspaceId === undefined ? {} : { defaultWorkspaceId }),
    projectBindings: normalizeBindingRows(record.projectBindings, 'projectId').map(row => ({
      projectId: row.id,
      workspaceId: row.workspaceId,
    })),
    cardBindings: normalizeBindingRows(record.cardBindings, 'taskId').map(row => ({
      taskId: row.id,
      workspaceId: row.workspaceId,
    })),
  }
}

/** Normalize the browser-safe view of one state. */
export function settingsView(state: TeambitionHostState): TeambitionSettingsView {
  const { cookie, operatorId, apiBase, defaultWorkspaceId, projectBindings, cardBindings } = state.settings
  return {
    configured: cookie !== undefined,
    ...(cookie === undefined ? {} : { cookieTail: cookie.slice(-COOKIE_TAIL_LENGTH) }),
    apiBase,
    operatorIdConfigured: operatorId !== undefined,
    ...(defaultWorkspaceId === undefined ? {} : { defaultWorkspaceId }),
    projectBindings,
    cardBindings,
    ...(state.lastSyncAt === undefined ? {} : { lastSyncAt: state.lastSyncAt }),
    ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
  }
}

/** The diagnose conclusions this build understands. */
const DIAGNOSIS_CONCLUSIONS: ReadonlySet<string> = new Set<TeambitionDiagnosis>([
  'usable',
  'no-cookie',
  'cookie-invalid',
  'endpoint-not-found',
  'network-error',
  'unknown',
])

/** Normalize one persisted probe result. */
function normalizeProbe(value: unknown): TeambitionProbeResult | undefined {
  if (!isRecord(value)) return undefined
  const id = trimmed(value.id)
  const path = trimmed(value.path)
  if (id === undefined || path === undefined) return undefined
  const status = finiteNumber(value.status)
  const contentType = trimmed(value.contentType)
  const preview = trimmed(value.preview)
  const error = trimmed(value.error)
  const projectCount = finiteNumber(value.projectCount)
  return {
    id,
    base: normalizeApiBase(value.base),
    path,
    ...(status === undefined ? {} : { status }),
    ...(contentType === undefined ? {} : { contentType }),
    ...(preview === undefined ? {} : { preview: truncate(preview, MAX_PREVIEW) }),
    ok: value.ok === true,
    ...(error === undefined ? {} : { error: truncate(error, MAX_MESSAGE) }),
    ...(projectCount === undefined ? {} : { projectCount }),
  }
}

/** Normalize one persisted diagnose pass. */
export function normalizeDiagnostics(value: unknown): TeambitionDiagnostics | undefined {
  if (!isRecord(value)) return undefined
  const probedAt = finiteNumber(value.probedAt)
  if (probedAt === undefined) return undefined
  const conclusion = typeof value.conclusion === 'string' && DIAGNOSIS_CONCLUSIONS.has(value.conclusion)
    ? value.conclusion as TeambitionDiagnosis
    : 'unknown'
  const message = truncate(trimmed(value.message) ?? '', MAX_MESSAGE)
  const results: TeambitionProbeResult[] = []
  if (Array.isArray(value.results)) {
    for (const entry of value.results) {
      const probe = normalizeProbe(entry)
      if (probe === undefined) continue
      results.push(probe)
      if (results.length >= MAX_PROBES) break
    }
  }
  const endpoint = isRecord(value.projectEndpoint) ? value.projectEndpoint : undefined
  const endpointId = endpoint === undefined ? undefined : trimmed(endpoint.id)
  const endpointPath = endpoint === undefined ? undefined : trimmed(endpoint.path)
  return {
    probedAt,
    cookieConfigured: value.cookieConfigured === true,
    conclusion,
    message,
    results,
    ...(endpointId === undefined || endpointPath === undefined
      ? {}
      : { projectEndpoint: { id: endpointId, base: normalizeApiBase(endpoint?.base), path: endpointPath } }),
  }
}

/** Normalize the persisted project snapshot. */
export function normalizeProjects(value: unknown): readonly TeambitionProject[] | undefined {
  if (!Array.isArray(value)) return undefined
  const projects: TeambitionProject[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const project = readProject(entry)
    if (project === undefined || seen.has(project.id)) continue
    seen.add(project.id)
    projects.push(project)
    if (projects.length >= MAX_PROJECTS) break
  }
  return projects
}

/**
 * Normalize one parsed on-disk state. Unknown versions and non-objects fall
 * back to the defaults; every member is clamped and filtered so a hostile or
 * corrupt file cannot project an invalid shape into the service.
 */
export function normalizeStoredState(value: unknown): TeambitionStoreLoad {
  if (value === undefined) return { state: defaultTeambitionState(), warnings: [] }
  if (!isRecord(value)) {
    return { state: defaultTeambitionState(), warnings: ['stored config is not a JSON object; using defaults'] }
  }
  if (value.version !== TEAMBITION_CONFIG_VERSION) {
    return {
      state: defaultTeambitionState(),
      warnings: [`stored config version ${String(value.version)} is not ${String(TEAMBITION_CONFIG_VERSION)}; using defaults`],
    }
  }
  const diagnostics = normalizeDiagnostics(value.diagnostics)
  const lastSyncAt = finiteNumber(value.lastSyncAt)
  const lastError = trimmed(value.lastError)
  const projects = normalizeProjects(value.projects)
  return {
    state: {
      version: TEAMBITION_CONFIG_VERSION,
      settings: normalizeSettings(value.settings),
      ...(diagnostics === undefined ? {} : { diagnostics }),
      ...(lastSyncAt === undefined ? {} : { lastSyncAt }),
      ...(lastError === undefined ? {} : { lastError: truncate(lastError, MAX_MESSAGE) }),
      ...(projects === undefined ? {} : { projects }),
    },
    warnings: [],
  }
}

/** Message of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether a read failure just means "no file yet". */
function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * The persisted config store. `load` is memoized after the first call and
 * `save` updates the memo, so the service sees one consistent state.
 */
export class TeambitionConfigStore {
  private readonly filePath: string
  private cached: TeambitionHostState | undefined

  constructor(options: TeambitionConfigStoreOptions = {}) {
    this.filePath = join(resolveDshHome(options.env, options.home), TEAMBITION_PANEL_ID, 'config.json')
  }

  /** Absolute path of the persisted file. */
  get path(): string {
    return this.filePath
  }

  /** The memoized state; defaults before the first {@link load}. */
  get current(): TeambitionHostState {
    return this.cached ?? defaultTeambitionState()
  }

  /**
   * Read and normalize the persisted state. Never throws: a missing,
   * unreadable, or corrupt file degrades to the defaults with a warning.
   */
  async load(): Promise<TeambitionStoreLoad> {
    if (this.cached !== undefined) return { state: this.cached, warnings: [] }
    let text: string
    try {
      text = await readFile(this.filePath, 'utf8')
    } catch (error) {
      this.cached = defaultTeambitionState()
      return {
        state: this.cached,
        warnings: isMissingFile(error) ? [] : [`could not read the stored config: ${messageOf(error)}`],
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      this.cached = defaultTeambitionState()
      return { state: this.cached, warnings: ['stored config is not valid JSON; using defaults'] }
    }
    const loaded = normalizeStoredState(parsed)
    this.cached = loaded.state
    return loaded
  }

  /**
   * Atomically persist one state: write a private temp file next to the
   * target, then rename it over the target.
   */
  async save(state: TeambitionHostState): Promise<void> {
    const normalized = normalizeStoredState(state).state
    const payload = `${JSON.stringify(normalized, null, 2)}\n`
    const directory = dirname(this.filePath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = join(directory, `.${process.pid}-${randomUUID()}.config.tmp`)
    try {
      await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600, flag: 'w' })
      await rename(temporary, this.filePath)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
    this.cached = normalized
  }
}
