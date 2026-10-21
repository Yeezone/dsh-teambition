/**
 * Wire contract shared by both halves of the Teambition panel plugin.
 *
 * This module is deliberately free of node and browser APIs: it carries the
 * panel identity, the HTTP route table, and the request/response shapes the
 * browser half posts to the host half. Everything that touches the network or
 * the filesystem lives in `src/host/`.
 *
 * @module dsh-teambition/core/protocol
 */
import type { TeambitionBase, TeambitionDiagnostics, TeambitionProject, TeambitionTask } from './teambition/types.ts'

/** Browser-visible panel id; the sidebar entry id and the `main` slot key. */
export const TEAMBITION_PANEL_ID = 'teambition'

/** Locale namespace of the panel UI (registered by the browser half). */
export const TEAMBITION_LOCALE_NS = 'teambition'

/** HTTP prefix the host half serves, mounted on the GUI web server. */
export const TEAMBITION_ROUTE_PREFIX = '/teambition'

/** Logical URLs posted by the browser half (document-relative, no leading slash). */
export const TEAMBITION_ROUTES = {
  /** Panel snapshot: settings view + known projects. */
  state: 'teambition/state',
  /** Update settings (cookie, operator id, bindings, defaults). */
  config: 'teambition/config',
  /** Probe the cookie against the candidate endpoints. */
  diagnose: 'teambition/diagnose',
  /** Refresh the joined project list. */
  projects: 'teambition/projects',
  /** One project: stages, workflow statuses, cards. */
  project: 'teambition/project',
  /** Create a card in a project. */
  taskCreate: 'teambition/task/create',
  /** Move a card to another workflow status. */
  taskStatus: 'teambition/task/status',
  /** Move a card to another kanban column (stage). */
  taskStage: 'teambition/task/stage',
  /** Persist per-card / per-project workspace bindings. */
  bind: 'teambition/bind',
} as const

/** One project's default DSH workspace. */
export interface TeambitionProjectBinding {
  /** Teambition project id. */
  readonly projectId: string
  /** DSH workspace id a card of this project runs in by default. */
  readonly workspaceId: string
}

/** One card's DSH workspace override. */
export interface TeambitionCardBinding {
  /** Teambition task id. */
  readonly taskId: string
  /** DSH workspace id this card runs in. */
  readonly workspaceId: string
}

/**
 * Browser-safe view of the panel settings. The Teambition cookie never crosses
 * this boundary: the panel only learns whether one is stored and its last four
 * characters.
 */
export interface TeambitionSettingsView {
  /** Whether a cookie is stored on the host. */
  readonly configured: boolean
  /** Last four characters of the stored cookie, when configured. */
  readonly cookieTail?: string
  /** Which host logical endpoints are addressed to. */
  readonly apiBase: TeambitionBase
  /** Whether an operator id (`x-operator-id`) is stored. */
  readonly operatorIdConfigured: boolean
  /** Workspace used by cards that have no card/project binding. */
  readonly defaultWorkspaceId?: string
  /** Per-project default workspaces. */
  readonly projectBindings: readonly TeambitionProjectBinding[]
  /** Per-card workspace overrides. */
  readonly cardBindings: readonly TeambitionCardBinding[]
  /** Epoch ms of the last successful refresh, when known. */
  readonly lastSyncAt?: number
  /** Last failure message, cleared by a successful refresh. */
  readonly lastError?: string
}

/** One kanban column of a project. Columns belong to exactly one task list. */
export interface TeambitionStageView {
  readonly id: string
  readonly name: string
  /** Owning task list id; two lists may each own a column with the same name. */
  readonly tasklistId?: string
  readonly pos?: number
}

/** One task list of a project; each list owns its own board columns. */
export interface TeambitionTasklistView {
  readonly id: string
  readonly name: string
}

/** One workflow status (`taskflowstatus`) of a project. */
export interface TeambitionStatusView {
  readonly id: string
  readonly name: string
  readonly kind?: 'start' | 'end'
  readonly pos?: number
}

/** One card rendered by the panel, already resolved against the bindings. */
export interface TeambitionCardView {
  readonly id: string
  readonly projectId: string
  readonly projectName: string
  readonly title: string
  readonly note?: string
  /** Kanban column id. */
  readonly stageId?: string
  /** Task list this card belongs to; the panel groups cards by list. */
  readonly tasklistId?: string
  /** Workflow status id. */
  readonly statusId?: string
  readonly isDone?: boolean
  /** Remote `updated` instant in ms. */
  readonly updatedAt?: number
  readonly priority?: number
  /** Human task number Teambition shows next to the title. */
  readonly uniqueId?: number
  /** Executor user id. */
  readonly executorId?: string
  /** Executor display name. */
  readonly executorName?: string
  /** Executor avatar URL. */
  readonly executorAvatarUrl?: string
  /** Due date instant in ms (the task module renders overdue states from it). */
  readonly dueAt?: number
  /** Due date as returned by the API (ISO string). */
  readonly dueAtRaw?: string
  /** `created` instant in ms. */
  readonly createdAt?: number
  /** Subtask count. */
  readonly subtaskCount?: number
  /** Comment count. */
  readonly commentsCount?: number
  /** DSH workspace this card executes in (card > project > default). */
  readonly workspaceId?: string
  /** Where this binding came from, so the panel can explain it. */
  readonly workspaceSource?: 'card' | 'project' | 'default'
  /** Web link to the card. */
  readonly url: string
}

/** One project with everything the panel needs to render it. */
export interface TeambitionProjectDetail {
  readonly project: TeambitionProject
  /** Task lists of the project, in board order. */
  readonly tasklists: readonly TeambitionTasklistView[]
  readonly stages: readonly TeambitionStageView[]
  readonly statuses: readonly TeambitionStatusView[]
  readonly cards: readonly TeambitionCardView[]
}

/** `teambition/state` response. */
export interface TeambitionStateView {
  readonly settings: TeambitionSettingsView
  readonly projects: readonly TeambitionProject[]
  /** Last diagnose pass, persisted on the host. */
  readonly diagnostics?: TeambitionDiagnostics
}

/** `teambition/config` request; absent fields keep their stored value. */
export interface TeambitionConfigRequest {
  /** Raw `Cookie` header copied from a logged-in teambition.com tab. */
  readonly cookie?: string
  /** Remove the stored cookie. */
  readonly clearCookie?: boolean
  /** Teambition user id sent as `x-operator-id` on writes. */
  readonly operatorId?: string
  /** Remove the stored operator id. */
  readonly clearOperatorId?: boolean
  /** Host selector for the internal endpoints. */
  readonly apiBase?: TeambitionBase
  /** Default execution workspace; `null` clears it. */
  readonly defaultWorkspaceId?: string | null
  /** Replaces the per-project binding table when present. */
  readonly projectBindings?: readonly TeambitionProjectBinding[]
  /** Replaces the per-card binding table when present. */
  readonly cardBindings?: readonly TeambitionCardBinding[]
}

/** `teambition/diagnose` response. */
export interface TeambitionDiagnoseView {
  readonly diagnostics: TeambitionDiagnostics
}

/** `teambition/projects` response. */
export interface TeambitionProjectsView {
  readonly projects: readonly TeambitionProject[]
}

/** `teambition/project` request. */
export interface TeambitionProjectRequest {
  readonly projectId: string
  /** Restrict columns and cards to one task list; absent means every list. */
  readonly tasklistId?: string
}

/** `teambition/task/create` request. */
export interface TeambitionTaskCreateRequest {
  readonly projectId: string
  readonly title: string
  readonly note?: string
  /** Task list to create the card in; the project's first list when omitted. */
  readonly tasklistId?: string
  /** Kanban column id; the task list's first stage when omitted. */
  readonly stageId?: string
  /** Workflow status id; the project's start status when omitted. */
  readonly statusId?: string
  /** Teambition executor id. */
  readonly executorId?: string
}

/** `teambition/task/status` request. */
export interface TeambitionTaskStatusRequest {
  readonly taskId: string
  readonly statusId: string
}

/** `teambition/task/stage` request. */
export interface TeambitionTaskStageRequest {
  readonly taskId: string
  readonly stageId: string
}

/** `teambition/bind` request; each present field replaces that binding table. */
export interface TeambitionBindRequest {
  readonly projectBindings?: readonly TeambitionProjectBinding[]
  readonly cardBindings?: readonly TeambitionCardBinding[]
  readonly defaultWorkspaceId?: string | null
}

/** Web link of one card (uses the project id as Teambition does). */
export function cardUrl(projectId: string, taskId: string): string {
  return `https://www.teambition.com/project/${projectId}/tasks/${taskId}`
}

/** Resolved execution workspace of one card. */
export interface TeambitionWorkspaceChoice {
  readonly workspaceId: string
  readonly source: 'card' | 'project' | 'default'
}

/**
 * Resolve which DSH workspace a card runs in: card binding, then project
 * binding, then the panel default. Returns undefined when the host has no
 * workspace configured for it (the panel then asks the user to pick one).
 */
export function resolveWorkspace(
  taskId: string,
  projectId: string,
  settings: Pick<TeambitionSettingsView, 'defaultWorkspaceId' | 'projectBindings' | 'cardBindings'>,
): TeambitionWorkspaceChoice | undefined {
  const card = settings.cardBindings.find(binding => binding.taskId === taskId)
  if (card !== undefined) return { workspaceId: card.workspaceId, source: 'card' }
  const project = settings.projectBindings.find(binding => binding.projectId === projectId)
  if (project !== undefined) return { workspaceId: project.workspaceId, source: 'project' }
  if (settings.defaultWorkspaceId !== undefined) return { workspaceId: settings.defaultWorkspaceId, source: 'default' }
  return undefined
}

/** Render one card into a Teambition-agnostic prompt body. */
export function buildCardPrompt(
  task: Pick<TeambitionTask, 'id' | 'projectId' | 'title' | 'note' | 'updatedAt'>,
  projectName: string,
  intro: string,
): string {
  const lines = [intro, '', `- ${task.title}`]
  lines.push(`- project: ${projectName}`)
  lines.push(`- task: ${cardUrl(task.projectId, task.id)}`)
  if (task.updatedAt !== undefined) lines.push(`- updated: ${new Date(task.updatedAt).toISOString()}`)
  if (task.note !== undefined && task.note.trim() !== '') lines.push('', task.note.trim())
  return lines.join('\n')
}
