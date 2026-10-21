/**
 * Teambition provider vocabulary, shared by both halves of the task board.
 *
 * This module is deliberately free of node and browser APIs: it carries the
 * constants, the persisted configuration shape, the remote-object shapes this
 * provider normalizes, and the per-card integration payload. Everything that
 * touches the network or the filesystem lives in `src/host/teambition/`.
 *
 * Honest limitation encoded here: Teambition's public open API needs an
 * installed app (appId/appSecret/appToken) and the non-admin account this
 * provider targets cannot install one. The supported channel is therefore a
 * user-supplied browser session cookie against the internal v3 endpoints; the
 * endpoints are listed in the research report and are only partially verified,
 * which is why the settings card ships a `diagnose` probe rather than trusting
 * a hardcoded path.
 *
 * @module dsh-task-board/core/teambition/types
 */
/** Local board-column vocabulary kept for the shared status-mapping helpers. */
export type TaskStatus = 'backlog' | 'todo' | 'running' | 'done' | 'failed'

/** Stable extension id; also the key of the per-card integration payload. */
export const TEAMBITION_EXTENSION_ID = 'teambition'

/** Persisted payload version of one linked card. */
export const TEAMBITION_PAYLOAD_VERSION = 1

/** Default host: the internal REST API the logged-in web client calls. */
export const TEAMBITION_API_BASE = 'https://api.teambition.com'

/** Fallback host: same-origin proxy, paths are prefixed with `/api`. */
export const TEAMBITION_WEB_BASE = 'https://www.teambition.com'

/** Web app root, used only for links shown on a card. */
export const TEAMBITION_WEB_APP = 'https://www.teambition.com'

/** Default polling interval (90s). */
export const DEFAULT_POLL_INTERVAL_MS = 90_000

/** Polling is refused below this interval: the internal API is rate limited. */
export const MIN_POLL_INTERVAL_MS = 30_000

/** Upper bound so a typo cannot park the provider for a day. */
export const MAX_POLL_INTERVAL_MS = 30 * 60_000

/** Which host a logical endpoint is addressed to. */
export type TeambitionBase = 'api' | 'web'

/** One candidate endpoint, addressed by base + logical path. */
export interface TeambitionEndpoint {
  /** Stable id used in diagnostics output. */
  readonly id: string
  /** Host selector; see {@link endpointUrl}. */
  readonly base: TeambitionBase
  /** Logical path, e.g. `/v3/project/user-joined`. */
  readonly path: string
  /** Why this candidate exists (shown by the diagnose tool). */
  readonly purpose: string
}

/** Persisted provider settings. Host-only; never sent to the browser whole. */
export interface TeambitionSettings {
  /**
   * Raw `Cookie` request header copied by the user from a logged-in
   * teambition.com tab. This is a session credential: keep it host-side.
   */
  readonly cookie?: string
  /**
   * Optional Teambition user id sent as `x-operator-id` on write requests.
   * Writes may require it; reads never do. Absent means "do not send it".
   */
  readonly operatorId?: string
  /** Which base {@link TEAMBITION_API_BASE} or {@link TEAMBITION_WEB_BASE}. */
  readonly apiBase: TeambitionBase
  /** Background poll interval, clamped to [{@link MIN_POLL_INTERVAL_MS}, {@link MAX_POLL_INTERVAL_MS}]. */
  readonly pollIntervalMs: number
  /** Whether local status changes are written back to Teambition. Default OFF. */
  readonly writeBack: boolean
  /** Project ids to mirror; empty means every joined project. */
  readonly projectFilter: readonly string[]
  /**
   * Overrides of the automatic status mapping, keyed by taskflow status id or
   * by the lower-cased status name. Value is the board column.
   */
  readonly stageStatusOverrides: Readonly<Record<string, TaskStatus>>
}

/** Persisted defaults; `normalizeSettings` always returns every field. */
export const DEFAULT_TEAMBITION_SETTINGS: TeambitionSettings = {
  // A pasted browser cookie is issued for `www.teambition.com`, so the
  // same-origin proxy is the base that accepts it; `api` needs an app token.
  apiBase: 'web',
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  writeBack: false,
  projectFilter: [],
  stageStatusOverrides: {},
}

/** One normalized remote task (only the fields the board consumes). */
export interface TeambitionTask {
  /** Remote task id. */
  readonly id: string
  /** Owning project id (from the response or the query context). */
  readonly projectId: string
  /** Task title (`content`). */
  readonly title: string
  /** Task notes (`note`), plain text as returned. */
  readonly note?: string
  /** Kanban column id (`stageId`). Columns belong to one task list. */
  readonly stageId?: string
  /** Owning task list id (`tasklistId`); every column belongs to one list. */
  readonly tasklistId?: string
  /** Workflow status id (`tfsId`). */
  readonly statusId?: string
  /** Remote `updated` instant in ms, when parseable. */
  readonly updatedAt?: number
  /** `isDone` as reported by the API. */
  readonly isDone?: boolean
  /** `isArchived` as reported by the API. */
  readonly isArchived?: boolean
  /** `updated` value as returned (ISO string), kept for diagnostics. */
  readonly updatedRaw?: string
  /** Remote priority value, if present. */
  readonly priority?: number
  /** Parent task id when the remote task is a subtask. */
  readonly parentTaskId?: string
  /** Human task number Teambition shows next to the title (`uniqueId`). */
  readonly uniqueId?: number
  /** Executor user id (`_executorId`, or the inlined `executor._id`). */
  readonly executorId?: string
  /** Executor display name, when the API inlined the member object. */
  readonly executorName?: string
  /** Executor avatar URL, when the API inlined the member object. */
  readonly executorAvatarUrl?: string
  /** Due date as returned (`dueDate`, ISO string), kept verbatim. */
  readonly dueAtRaw?: string
  /** Due date instant in ms, when parseable. */
  readonly dueAt?: number
  /** `created` instant in ms, when parseable. */
  readonly createdAt?: number
  /** Subtask count (`subtaskCount`), when the API reports it. */
  readonly subtaskCount?: number
  /** Comment count (`commentsCount`), when the API reports it. */
  readonly commentsCount?: number
}

/** One normalized remote project. */
export interface TeambitionProject {
  readonly id: string
  readonly name: string
  readonly isArchived?: boolean
}

/**
 * One task list (`tasklistId`) of a project.
 *
 * Teambition groups kanban columns per task list: the same project has one
 * board per list, and two lists may each own a column named "未分类". The
 * panel therefore navigates project -> task list -> columns.
 */
export interface TeambitionTasklist {
  readonly id: string
  readonly name: string
}

/** One workflow status (`taskflowstatus`) of a project. */
export interface TeambitionWorkflowStatus {
  readonly id: string
  readonly name: string
  /** `start` / `end` when the API reports a special kind, else undefined. */
  readonly kind?: 'start' | 'end'
  readonly pos?: number
}

/* The per-card integration payload (`TeambitionLink`) lives in `payload.ts`:
   it is the storage contract rather than a transport shape. */

/** One endpoint probe performed by `diagnose`. */
export interface TeambitionProbeResult {
  readonly id: string
  readonly base: TeambitionBase
  readonly path: string
  /** HTTP status, absent when the request itself failed. */
  readonly status?: number
  readonly contentType?: string
  /** First characters of the body, redacted and truncated. */
  readonly preview?: string
  /** Whether this probe produced a usable project list. */
  readonly ok: boolean
  /** Transport or API failure description. */
  readonly error?: string
  /** Number of projects parsed out of the response (0 when unusable). */
  readonly projectCount?: number
}

/** Machine-readable conclusion of one diagnose pass. */
export type TeambitionDiagnosis =
  | 'usable'
  | 'no-cookie'
  | 'cookie-invalid'
  | 'endpoint-not-found'
  | 'network-error'
  | 'unknown'

/** One diagnose pass. Persisted (sanitized) so the settings card survives restarts. */
export interface TeambitionDiagnostics {
  readonly probedAt: number
  readonly cookieConfigured: boolean
  readonly conclusion: TeambitionDiagnosis
  readonly message: string
  readonly results: readonly TeambitionProbeResult[]
  /** Endpoint that produced the project list, when one did. */
  readonly projectEndpoint?: Pick<TeambitionEndpoint, 'id' | 'base' | 'path'>
}

/** Outcome of one synchronization pass. */
export interface TeambitionSyncCounts {
  /** Cards created from remote tasks. */
  readonly created: number
  /** Linked cards whose content was refreshed from the remote task. */
  readonly contentUpdated: number
  /** Linked cards whose status was moved to match the remote task. */
  readonly statusUpdated: number
  /** Linked cards already in sync. */
  readonly unchanged: number
  /** Cards whose refresh was refused or failed. */
  readonly errors: readonly string[]
}

/** Shape of `$DSH_HOME/task-board/teambition.json`. */
export interface TeambitionStoredState {
  readonly version: 1
  readonly settings: TeambitionSettings
  readonly diagnostics?: TeambitionDiagnostics
  readonly lastSyncAt?: number
  readonly lastErrors?: readonly string[]
  /** Projects seen by the last successful project listing. */
  readonly projects?: readonly TeambitionProject[]
}

/**
 * Browser-safe view of the settings. The cookie never crosses into it: only
 * whether one is stored and, optionally, its last four characters.
 */
export interface TeambitionSettingsView {
  readonly configured: boolean
  readonly cookieTail?: string
  readonly apiBase: TeambitionBase
  readonly pollIntervalMs: number
  readonly writeBack: boolean
  readonly projectFilter: readonly string[]
  readonly operatorIdConfigured: boolean
  readonly stageStatusOverrides: Readonly<Record<string, TaskStatus>>
}

/** A settings/sync failure carrying a stable code for the browser half. */
export class TeambitionConfigError extends Error {
  constructor(readonly code: TeambitionConfigErrorCode, message: string) {
    super(message)
    this.name = 'TeambitionConfigError'
  }
}

/** Stable failure codes of the configuration surface. */
export type TeambitionConfigErrorCode =
  | 'invalid-cookie'
  | 'invalid-api-base'
  | 'invalid-interval'
  | 'invalid-write-back'
  | 'invalid-project-filter'
  | 'invalid-status-override'
  | 'invalid-operator-id'
