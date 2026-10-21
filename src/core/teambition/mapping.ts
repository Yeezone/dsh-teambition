/**
 * Normalization and mapping between a Teambition task and a board card.
 *
 * Everything here is a pure function over already-parsed JSON: no network, no
 * filesystem, no timers. The host adapter hands raw response bodies in and gets
 * board-shaped values out, which keeps the mapping rules independently testable.
 *
 * @module dsh-task-board/core/teambition/mapping
 */
import type { TaskStatus } from './types.ts'
import {
  TEAMBITION_WEB_APP,
  type TeambitionProject,
  type TeambitionTask,
  type TeambitionWorkflowStatus,
} from './types.ts'

/** Board card title cap (the board itself allows longer, remote titles do not). */
const CARD_TITLE_MAX = 160
/** Board card description cap. */
const CARD_DESCRIPTION_MAX = 4_000
/** Board card prompt cap. */
const CARD_PROMPT_MAX = 4_000
/** Remote note cap, so a 100 KiB note cannot bloat a card. */
const NOTE_MAX = 2_000

/** Coerce a JSON member to a non-empty trimmed string. */
function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const next = value.trim()
  return next === '' ? undefined : next
}

/** Coerce a JSON member to a finite number. */
function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** Parse an ISO instant (or an epoch millisecond number) into ms. */
export function parseInstant(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Collapse runs of whitespace, so a remote title stays one card-title line. */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Cut a string to a maximum length without splitting a surrogate pair. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  let cut = value.slice(0, max)
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  return `${cut}…`
}

/**
 * Unwrap the collection out of a Teambition response envelope.
 *
 * The internal API answers either with a bare array or with an envelope; the
 * observed envelope shape is `{ code, result }` (the 401 body is
 * `{ code: "InvalidCookie", ... }`), and some legacy routes use `data`. One
 * level of nesting is unwrapped too, because `{ result: { result: [] } }` shows
 * up on paged routes.
 * @param value - parsed JSON body.
 * @returns the contained array, or undefined when the shape is not a collection.
 */
export function readCollection(value: unknown): readonly unknown[] | undefined {
  if (Array.isArray(value)) return value
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  for (const key of ['result', 'data', 'items', 'list', 'projects', 'tasks']) {
    const inner = record[key]
    if (Array.isArray(inner)) return inner
    if (typeof inner === 'object' && inner !== null && !Array.isArray(inner)) {
      const nested = inner as Record<string, unknown>
      for (const nestedKey of ['result', 'data', 'items', 'list']) {
        const nestedValue = nested[nestedKey]
        if (Array.isArray(nestedValue)) return nestedValue
      }
    }
  }
  return undefined
}

/**
 * Read the paging cursor of a response envelope.
 * @param value - parsed JSON body.
 * @returns the next page token, when present.
 */
export function readNextPageToken(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const token = str(record.nextPageToken) ?? str(record.nextPage)
  return token
}

/**
 * Read the API error code out of a response envelope.
 *
 * Success payloads may also carry a `name` (a saved view, a project, a task
 * flow), so `name` only acts as an error code when the envelope also carries a
 * human message, and a document carrying `_id` is never an error envelope.
 * @param value - parsed JSON body.
 * @returns `code` / `name` / `message` of a failure envelope, else undefined.
 */
export function readApiError(value: unknown): { code?: string; message?: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const explicitCode = str(record.code)
  const message = str(record.message) ?? str(record.msg)
  if (explicitCode === undefined && (message === undefined || record._id !== undefined)) return undefined
  const code = explicitCode ?? (message === undefined ? undefined : str(record.name))
  if (code === undefined && message === undefined) return undefined
  // A success envelope may carry `code: 200`; only non-2xx codes are errors.
  if (code !== undefined && /^2\d\d$/.test(code)) return undefined
  return { ...(code === undefined ? {} : { code }), ...(message === undefined ? {} : { message }) }
}

/** Whether an API error envelope describes an expired/invalid session. */
export function isInvalidCookieError(code: string | undefined, status?: number): boolean {
  if (status === 401) return true
  if (code === undefined) return false
  const normalized = code.toLowerCase()
  return normalized === 'invalidcookie' || normalized === 'unauthorized' || normalized === 'invalidlogout'
}

/**
 * Normalize one remote project object.
 * @param raw - one entry of a project collection.
 * @returns the normalized project, or undefined when it is not identifiable.
 */
export function readProject(raw: unknown): TeambitionProject | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const id = str(record.id) ?? str(record._id) ?? str(record.projectId)
  if (id === undefined) return undefined
  const name = str(record.name) ?? str(record.title) ?? id
  const archived = record.isArchived === true || record.archived === true
  return { id, name: collapseWhitespace(name), ...(archived ? { isArchived: true } : {}) }
}

/**
 * Extract every identifiable project from a project-list response body.
 * @param payload - parsed JSON body.
 * @returns normalized projects (possibly empty).
 */
export function readProjects(payload: unknown): readonly TeambitionProject[] {
  const collection = readCollection(payload)
  if (collection === undefined) return []
  const projects: TeambitionProject[] = []
  const seen = new Set<string>()
  for (const entry of collection) {
    const project = readProject(entry)
    if (project === undefined || seen.has(project.id)) continue
    seen.add(project.id)
    projects.push(project)
  }
  return projects
}

/**
 * Normalize one remote task.
 *
 * `projectId` is taken from the task when present and from the query context
 * otherwise: the project task list omits it on some builds.
 * @param raw - one entry of a task collection.
 * @param fallbackProjectId - project the query was scoped to.
 * @returns the normalized task, or undefined when it has no id.
 */
export function readRemoteTask(raw: unknown, fallbackProjectId?: string): TeambitionTask | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const id = str(record.id) ?? str(record.taskId) ?? str(record._id)
  if (id === undefined) return undefined
  const projectId = str(record.projectId) ?? str(record._projectId) ?? fallbackProjectId
  if (projectId === undefined) return undefined
  const title = collapseWhitespace(str(record.content) ?? str(record.title) ?? str(record.name) ?? '')
  const note = str(record.note) ?? str(record.description)
  const updatedRaw = str(record.updated) ?? str(record.updatedAt)
  const updatedAt = parseInstant(updatedRaw)
  const stageId = str(record.stageId) ?? str(record.stage) ?? str(record._stageId)
  const tasklistId = str(record.tasklistId) ?? str(record._tasklistId)
  const statusId = str(record.tfsId) ?? str(record.taskflowstatusId) ?? str(record.statusId) ?? str(record._taskflowstatusId)
  const priority = num(record.priority)
  const parentTaskId = str(record.parentTaskId)
  const uniqueId = num(record.uniqueId)
  const executor = readInlineMember(record.executor)
  const executorId = executor?.id ?? str(record.executorId) ?? str(record._executorId)
  const creatorId = str(record.creatorId) ?? str(record._creatorId)
  const dueAtRaw = str(record.dueDate) ?? str(record.dueAt)
  const dueAt = parseInstant(dueAtRaw)
  const createdAt = parseInstant(str(record.created) ?? str(record.createdAt))
  const subtaskCount = num(record.subtaskCount)
  const commentsCount = num(record.commentsCount)
  const scenarioConfigId = str(record.scenarioConfigId) ?? str(record._scenariofieldconfigId)
  return {
    id,
    projectId,
    title: title === '' ? `Teambition task ${id}` : title,
    ...(note === undefined ? {} : { note }),
    ...(stageId === undefined ? {} : { stageId }),
    ...(tasklistId === undefined ? {} : { tasklistId }),
    ...(statusId === undefined ? {} : { statusId }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(updatedRaw === undefined ? {} : { updatedRaw }),
    ...(record.isDone === true ? { isDone: true } : {}),
    ...(record.isArchived === true ? { isArchived: true } : {}),
    ...(priority === undefined ? {} : { priority }),
    ...(parentTaskId === undefined ? {} : { parentTaskId }),
    ...(uniqueId === undefined ? {} : { uniqueId }),
    ...(executorId === undefined ? {} : { executorId }),
    ...(executor?.name === undefined ? {} : { executorName: executor.name }),
    ...(executor?.avatarUrl === undefined ? {} : { executorAvatarUrl: executor.avatarUrl }),
    ...(creatorId === undefined ? {} : { creatorId }),
    ...(dueAtRaw === undefined ? {} : { dueAtRaw }),
    ...(dueAt === undefined ? {} : { dueAt }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(subtaskCount === undefined ? {} : { subtaskCount }),
    ...(commentsCount === undefined ? {} : { commentsCount }),
    ...(scenarioConfigId === undefined ? {} : { scenarioConfigId }),
  }
}

/** Fields of the member object Teambition inlines on a task (`executor`). */
interface InlineMember {
  readonly id?: string
  readonly name?: string
  readonly avatarUrl?: string
}

/**
 * Read the tiny member shape Teambition inlines on tasks and task lists.
 * @param raw - `executor` / `creator` value from the API.
 * @returns the member fields that are present, or undefined when not an object.
 */
function readInlineMember(raw: unknown): InlineMember | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const id = str(record.id) ?? str(record._id) ?? str(record.userId) ?? str(record._userId)
  const name = collapseWhitespace(str(record.name) ?? str(record.title) ?? '')
  const avatarUrl = str(record.avatarUrl) ?? str(record.avatar)
  if (id === undefined && name === '' && avatarUrl === undefined) return undefined
  return {
    ...(id === undefined ? {} : { id }),
    ...(name === '' ? {} : { name }),
    ...(avatarUrl === undefined ? {} : { avatarUrl }),
  }
}

/**
 * Extract every identifiable task from a task-list response body.
 * @param payload - parsed JSON body.
 * @param fallbackProjectId - project the query was scoped to.
 * @returns normalized tasks (possibly empty).
 */
export function readTasks(payload: unknown, fallbackProjectId?: string): readonly TeambitionTask[] {
  const collection = readCollection(payload)
  if (collection === undefined) return []
  const tasks: TeambitionTask[] = []
  const seen = new Set<string>()
  for (const entry of collection) {
    const task = readRemoteTask(entry, fallbackProjectId)
    if (task === undefined || seen.has(task.id)) continue
    seen.add(task.id)
    tasks.push(task)
  }
  return tasks
}

/**
 * Normalize one workflow status object.
 * @param raw - one entry of a taskflowstatus collection.
 * @returns the normalized status, or undefined when it has no id.
 */
export function readWorkflowStatus(raw: unknown): TeambitionWorkflowStatus | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const id = str(record.id) ?? str(record._id)
  if (id === undefined) return undefined
  const name = collapseWhitespace(str(record.name) ?? str(record.title) ?? id)
  const kindValue = str(record.kind)?.toLowerCase()
  const kind = kindValue === 'start' ? 'start' as const : kindValue === 'end' ? 'end' as const : undefined
  const pos = num(record.pos)
  return { id, name, ...(kind === undefined ? {} : { kind }), ...(pos === undefined ? {} : { pos }) }
}

/**
 * Extract every workflow status from a status-list response body.
 * @param payload - parsed JSON body.
 * @returns normalized statuses sorted by `pos` when known.
 */
export function readWorkflowStatuses(payload: unknown): readonly TeambitionWorkflowStatus[] {
  const collection = readCollection(payload)
  if (collection === undefined) return []
  const statuses: TeambitionWorkflowStatus[] = []
  const seen = new Set<string>()
  for (const entry of collection) {
    const status = readWorkflowStatus(entry)
    if (status === undefined || seen.has(status.id)) continue
    seen.add(status.id)
    statuses.push(status)
  }
  return statuses.sort((left, right) => (left.pos ?? Number.MAX_SAFE_INTEGER) - (right.pos ?? Number.MAX_SAFE_INTEGER))
}

/**
 * Keyword table of the automatic mapping, checked in this order.
 *
 * The first group that matches a status name wins, so the more specific
 * "failed" family is checked before the generic "done" and "running" words.
 * Names are Teambition's Chinese defaults plus the English ones some templates
 * use; users whose workflow uses other words can override via settings.
 */
const STATUS_KEYWORDS: readonly (readonly [TaskStatus, readonly string[]])[] = [
  ['failed', ['失败', '阻塞', '取消', '驳回', 'failed', 'blocked', 'cancelled', 'canceled', 'rejected']],
  ['done', ['已完成', '完成', '已关闭', '已解决', 'done', 'closed', 'finished', 'resolved', 'accomplished']],
  ['running', ['进行中', '处理中', '开发中', '开始处理', 'doing', 'in progress', 'inprogress', 'started', 'active']],
  ['backlog', ['待规划', '待办池', '需求池', '规划中', 'backlog', 'icebox', 'triage', 'planned']],
  ['todo', ['待办', '未开始', '待处理', '待认领', 'todo', 'to do', 'open', 'new', 'ready']],
]

/**
 * Match a board status by a workflow status name.
 * @param name - remote status name.
 * @returns the matching board status, if the name is recognized.
 */
export function matchStatusByName(name: string): TaskStatus | undefined {
  const normalized = name.toLowerCase()
  for (const [status, keywords] of STATUS_KEYWORDS) {
    if (keywords.some(keyword => normalized.includes(keyword))) return status
  }
  return undefined
}

/** Lookup structures used to map a remote task onto a board column. */
export interface StatusMappingContext {
  /** Workflow statuses of the task's project, by id. */
  readonly statusesById: ReadonlyMap<string, TeambitionWorkflowStatus>
  /** Per-taskflow-status or per-name overrides from the settings. */
  readonly overrides: Readonly<Record<string, TaskStatus>>
}

/**
 * Build the lookup used by {@link mapRemoteToBoardStatus}.
 * @param statuses - workflow statuses of one project.
 * @param overrides - configured overrides.
 */
export function buildStatusMappingContext(
  statuses: readonly TeambitionWorkflowStatus[],
  overrides: Readonly<Record<string, TaskStatus>>,
): StatusMappingContext {
  const statusesById = new Map<string, TeambitionWorkflowStatus>()
  for (const status of statuses) statusesById.set(status.id, status)
  return { statusesById, overrides }
}

/**
 * Map one remote task onto a board column.
 *
 * Precedence: explicit override by status id, explicit override by lower-cased
 * status name, `isDone`, the workflow status kind (`end` = done, `start` =
 * todo), then name keywords. Unknown tasks land in `todo`: claiming "running"
 * would mislead the execution chain, and `backlog` would hide them from the
 * default queue.
 * @param task - normalized remote task.
 * @param context - status lookup and overrides.
 * @returns the board status.
 */
export function mapRemoteToBoardStatus(task: TeambitionTask, context: StatusMappingContext): TaskStatus {
  const status = task.statusId === undefined ? undefined : context.statusesById.get(task.statusId)
  if (task.statusId !== undefined) {
    const byId = context.overrides[task.statusId]
    if (byId !== undefined) return byId
  }
  if (status !== undefined) {
    const byName = context.overrides[status.name.toLowerCase()]
    if (byName !== undefined) return byName
  }
  if (task.isDone === true) return 'done'
  if (status !== undefined) {
    const keyword = matchStatusByName(status.name)
    if (keyword !== undefined) return keyword
    if (status.kind === 'end') return 'done'
    if (status.kind === 'start') return 'todo'
  }
  if (task.isArchived === true) return 'done'
  return 'todo'
}

/** Result of resolving which remote status a board column maps back to. */
export type WriteTargetResolution =
  | { readonly ok: true; readonly status: TeambitionWorkflowStatus }
  | { readonly ok: false; readonly reason: string }

/**
 * Resolve the remote workflow status a board column should be written to.
 *
 * A board column has no Teambition equivalent for some workflows: `failed` in
 * particular needs a real "failed/rejected/blocked" status, and reporting that
 * honestly is better than marking a failed card "done" on the remote side.
 * @param localStatus - board column the card moved to.
 * @param statuses - workflow statuses of the project.
 * @param overrides - configured overrides (reverse-matched first).
 * @returns the target status or a reason the write cannot be expressed.
 */
export function resolveWriteTarget(
  localStatus: TaskStatus,
  statuses: readonly TeambitionWorkflowStatus[],
  overrides: Readonly<Record<string, TaskStatus>> = {},
): WriteTargetResolution {
  if (statuses.length === 0) return { ok: false, reason: 'the project workflow statuses are unknown' }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== localStatus) continue
    const byId = statuses.find(status => status.id === key)
    if (byId !== undefined) return { ok: true, status: byId }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== localStatus) continue
    const byName = statuses.find(status => status.name.toLowerCase() === key.toLowerCase())
    if (byName !== undefined) return { ok: true, status: byName }
  }
  const keywordMatch = statuses.find(status => matchStatusByName(status.name) === localStatus)
  if (keywordMatch !== undefined) return { ok: true, status: keywordMatch }
  if (localStatus === 'done') {
    const end = statuses.find(status => status.kind === 'end')
    if (end !== undefined) return { ok: true, status: end }
  }
  if (localStatus === 'todo' || localStatus === 'backlog') {
    const start = statuses.find(status => status.kind === 'start')
    if (start !== undefined) return { ok: true, status: start }
    const first = statuses[0]
    if (first !== undefined && localStatus === 'todo') return { ok: true, status: first }
  }
  return { ok: false, reason: `no remote workflow status maps to "${localStatus}"` }
}

/** Card fields composed from one remote task. */
export interface TeambitionCardContent {
  readonly title: string
  readonly description: string
  readonly prompt: string
}

/**
 * Compose the three card text fields from a remote task.
 *
 * The description and the prompt are metadata + the remote note; labels stay
 * English because they are content (the agent reads the prompt) rather than UI
 * copy, so no locale dictionary applies.
 * @param task - normalized remote task.
 * @param project - owning project.
 * @returns card fields, each capped.
 */
export function composeCardContent(task: TeambitionTask, project: TeambitionProject): TeambitionCardContent {
  const title = truncate(collapseWhitespace(task.title), CARD_TITLE_MAX)
  const link = remoteTaskUrl(task.projectId, task.id)
  const note = task.note === undefined ? '' : truncate(task.note, NOTE_MAX)
  const header = `Synced from Teambition project "${project.name}".\nTask: ${task.id}\nLink: ${link}`
  const description = truncate(
    note === '' ? header : `${header}\n\n${note}`,
    CARD_DESCRIPTION_MAX,
  )
  const prompt = truncate(
    `Complete this task, which is mirrored from Teambition.\n\nProject: ${project.name}\nTask: ${title}\nLink: ${link}\nTask id: ${task.id}\n${note === '' ? '' : `\nNotes:\n${note}\n`}`,
    CARD_PROMPT_MAX,
  )
  return { title, description, prompt }
}

/**
 * Web link of one remote task.
 *
 * Best effort: Teambition's web routes are not part of the documented API, and
 * the `/project/{id}/task/{id}` shape could change. A wrong link is cosmetic
 * (the card still carries the ids), so this does not gate synchronization.
 * @param projectId - remote project id.
 * @param taskId - remote task id.
 */
export function remoteTaskUrl(projectId: string, taskId: string): string {
  return `${TEAMBITION_WEB_APP}/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}`
}

/** External-key prefix that claims a board for one remote project. */
export const BOARD_EXTERNAL_KEY_PREFIX = 'teambition:'

/**
 * Board external key of one remote project.
 * @param projectId - remote project id.
 */
export function boardExternalKey(projectId: string): string {
  return `${BOARD_EXTERNAL_KEY_PREFIX}${projectId}`
}

/**
 * Read back the project id of a Teambition external key.
 * @param externalKey - board external key.
 * @returns the project id, or undefined when the key belongs to another provider.
 */
export function projectIdFromBoardKey(externalKey: string | undefined): string | undefined {
  if (externalKey === undefined || !externalKey.startsWith(BOARD_EXTERNAL_KEY_PREFIX)) return undefined
  const projectId = externalKey.slice(BOARD_EXTERNAL_KEY_PREFIX.length).trim()
  return projectId === '' ? undefined : projectId
}
