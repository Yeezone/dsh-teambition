/**
 * Host orchestration of the Teambition panel plugin.
 *
 * The service binds the persisted settings to the cookie-authenticated client
 * and turns every panel route into one explicit operation. It owns three
 * invariants: the cookie never leaves the host (views carry only the masked
 * settings), remote writes happen only because a caller asked for them, and a
 * rejected request is surfaced as a classified envelope instead of an
 * unhandled rejection.
 *
 * @module dsh-teambition/host/service
 */
import {
  cardUrl,
  resolveWorkspace,
  type TeambitionBindRequest,
  type TeambitionCardView,
  type TeambitionColumnView,
  type TeambitionConfigRequest,
  type TeambitionDiagnoseView,
  type TeambitionProjectDetail,
  type TeambitionProjectRequest,
  type TeambitionProjectsView,
  type TeambitionScenarioView,
  type TeambitionStageView,
  type TeambitionStateView,
  type TeambitionTaskCreateRequest,
  type TeambitionTaskDetailRequest,
  type TeambitionTaskDetailView,
  type TeambitionTaskStageRequest,
  type TeambitionTaskStatusRequest,
  type TeambitionViewView,
  type TeambitionWorkflowView,
} from '../core/protocol.ts'
import {
  redactMessage,
  type TeambitionDiagnostics,
  type TeambitionEndpoint,
  type TeambitionProject,
  type TeambitionTask,
  type TeambitionTasklist,
  type TeambitionWorkflowStatus,
} from '../core/teambition/index.ts'
import {
  TeambitionClient,
  TeambitionApiError,
  type TeambitionClientOptions,
  type TeambitionScenarioConfig,
  type TeambitionStage,
  type TeambitionTaskWrite,
  type TeambitionView,
  type TeambitionWorkflow,
} from './client.ts'
import type { TeambitionTransport } from './transport.ts'
import {
  normalizeSettings,
  settingsView,
  type TeambitionConfigStore,
  type TeambitionHostSettings,
  type TeambitionHostState,
} from './config-store.ts'

/** Successful route envelope. */
export interface TeambitionEnvelopeOk {
  readonly ok: true
  readonly value: unknown
}

/** Failed route envelope. */
export interface TeambitionEnvelopeError {
  readonly ok: false
  readonly error: { readonly code: string; readonly message: string }
}

/** Envelope every host route returns. */
export type TeambitionEnvelope = TeambitionEnvelopeOk | TeambitionEnvelopeError

/** Build a successful envelope. */
export function ok(value: unknown): TeambitionEnvelopeOk {
  return { ok: true, value }
}

/** Build a failed envelope. */
export function fail(code: string, message: string): TeambitionEnvelopeError {
  return { ok: false, error: { code, message } }
}

/**
 * One classified service failure. Callers translate it into an envelope; it
 * never carries the cookie or a raw response body.
 */
export class TeambitionHostError extends Error {
  constructor(
    /** Stable machine code of the failure. */
    readonly code: 'not-configured' | 'invalid-request' | 'failed',
    message: string,
  ) {
    super(message)
    this.name = 'TeambitionHostError'
  }
}

/** The sub-set of the client the service depends on (tests inject a fake). */
export interface TeambitionClientPort {
  readonly configured: boolean
  diagnose(): Promise<TeambitionDiagnostics>
  listProjects(): Promise<{ projects: readonly TeambitionProject[]; endpoint: TeambitionEndpoint }>
  projectStatuses(projectId: string): Promise<readonly TeambitionWorkflowStatus[]>
  projectTasks(projectId: string): Promise<readonly TeambitionTask[]>
  projectStages(projectId: string): Promise<readonly TeambitionStage[]>
  projectTasklists(projectId: string): Promise<readonly TeambitionTasklist[]>
  projectWorkflows(projectId: string): Promise<readonly TeambitionWorkflow[]>
  projectScenarioConfigs(projectId: string): Promise<readonly TeambitionScenarioConfig[]>
  projectViews(projectId: string): Promise<readonly TeambitionView[]>
  updateTaskStatus(taskId: string, statusId: string): Promise<void>
  updateTaskStage(taskId: string, stageId: string): Promise<void>
  createTask(input: TeambitionTaskWrite): Promise<{ taskId: string }>
  taskDetail(projectId: string, taskId: string): Promise<TeambitionTaskDetailView>
}

/** Creation seams of the service (tests inject transport, clock and client). */
export interface TeambitionServiceOptions {
  /** Transport override handed to every created client. */
  readonly transport?: TeambitionTransport
  /** Clock override for `lastSyncAt` and diagnostics timestamps. */
  readonly now?: () => number
  /** Client factory override (tests). */
  readonly createClient?: (options: TeambitionClientOptions) => TeambitionClientPort
}

/**
 * One bound request failure: the classified error plus its envelope. Routes
 * and the agent tool both report exactly this shape.
 */
export type TeambitionFailure = TeambitionEnvelopeError

/** Result of one service operation. */
export type TeambitionResult<T> =
  | { readonly ok: true; readonly value: T }
  | TeambitionFailure

/**
 * The Teambition host service: one instance per plugin mount, backed by the
 * persisted config store.
 */
export class TeambitionService {
  private readonly store: TeambitionConfigStore
  private readonly transport: TeambitionTransport | undefined
  private readonly now: () => number
  private readonly createClient: (options: TeambitionClientOptions) => TeambitionClientPort

  constructor(store: TeambitionConfigStore, options: TeambitionServiceOptions = {}) {
    this.store = store
    this.transport = options.transport
    this.now = options.now ?? Date.now
    this.createClient = options.createClient ?? (clientOptions => new TeambitionClient(clientOptions))
  }

  /** Panel snapshot: masked settings, known projects, last diagnostics. */
  async stateView(): Promise<TeambitionStateView> {
    const state = await this.load()
    return {
      settings: settingsView(state),
      projects: state.projects ?? [],
      ...(state.diagnostics === undefined ? {} : { diagnostics: state.diagnostics }),
    }
  }

  /** Apply one settings patch and persist it. */
  async updateConfig(request: TeambitionConfigRequest): Promise<TeambitionStateView> {
    const state = await this.load()
    const settings = patchSettings(state.settings, request)
    // A different cookie invalidates the previous probe. Drop the stale verdict
    // so the settings view never shows "cookie invalid" next to a fresh cookie.
    const cookieChanged = settings.cookie !== state.settings.cookie
    await this.store.save({
      ...state,
      settings,
      ...(cookieChanged ? { diagnostics: undefined, lastError: undefined } : {}),
    })
    return this.stateView()
  }

  /**
   * Probe the stored cookie against every project-list candidate and persist
   * the sanitized diagnostics. Auto-corrects `apiBase` to the winning host.
   */
  async diagnose(): Promise<TeambitionDiagnoseView> {
    const state = await this.load()
    if (state.settings.cookie === undefined) {
      const diagnostics: TeambitionDiagnostics = {
        probedAt: this.now(),
        cookieConfigured: false,
        conclusion: 'no-cookie',
        message: 'No Teambition cookie is configured.',
        results: [],
      }
      await this.store.save({ ...state, diagnostics, lastError: diagnostics.message })
      return { diagnostics }
    }
    const client = this.clientFor(state.settings)
    try {
      const diagnostics = await client.diagnose()
      const winningBase = diagnostics.projectEndpoint?.base ?? state.settings.apiBase
      await this.store.save({
        ...state,
        settings: { ...state.settings, apiBase: winningBase },
        diagnostics,
        lastError: diagnostics.conclusion === 'usable' ? undefined : diagnostics.message,
      })
      return { diagnostics }
    } catch (error) {
      const message = describe(error)
      await this.store.save({ ...state, lastError: message })
      throw new TeambitionHostError('failed', message)
    }
  }

  /** Refresh the joined project list and persist the snapshot. */
  async listProjects(): Promise<TeambitionProjectsView> {
    const state = await this.load()
    const client = this.clientFor(state.settings)
    try {
      const listing = await client.listProjects()
      await this.store.save({
        ...state,
        settings: { ...state.settings, apiBase: listing.endpoint.base },
        projects: listing.projects,
        lastSyncAt: this.now(),
        lastError: undefined,
      })
      return { projects: listing.projects }
    } catch (error) {
      const message = describe(error)
      await this.store.save({ ...state, lastError: message })
      throw new TeambitionHostError('failed', message)
    }
  }

  /**
   * One project with its task lists, stages, workflow statuses, saved views and
   * resolved cards.
   *
   * Columns and cards belong to a task list, so a request that names one is
   * narrowed to it; rows the remote API leaves unattributed are treated as
   * belonging to the only list of a single-list project. The board columns are
   * resolved against the requested (or default) saved view: a "status" view
   * renders the union of its task types' workflow statuses, a "stage" view the
   * project's kanban columns.
   */
  async projectDetail(request: TeambitionProjectRequest): Promise<TeambitionProjectDetail> {
    const projectId = request.projectId
    const state = await this.load()
    const client = this.clientFor(state.settings)
    const known = (state.projects ?? []).find(project => project.id === projectId)
    const project: TeambitionProject = known ?? { id: projectId, name: projectId }
    try {
      const [tasklists, stages, statuses, tasks, workflows, scenarioConfigs, views] = await Promise.all([
        client.projectTasklists(projectId),
        client.projectStages(projectId),
        client.projectStatuses(projectId),
        client.projectTasks(projectId),
        client.projectWorkflows(projectId),
        client.projectScenarioConfigs(projectId),
        client.projectViews(projectId),
      ])
      const settings = settingsView(state)
      const stageViews = stages.map(stage => stageView(stage, tasklists))
      const cardViews = tasks.map(task => cardView(task, project, settings, tasklists))
      const requestedList = request.tasklistId
      const stagesOfList = requestedList === undefined
        ? stageViews
        : stageViews.filter(stage => stage.tasklistId === requestedList)
      const cardsOfList = requestedList === undefined
        ? cardViews
        : cardViews.filter(card => card.tasklistId === requestedList)
      const selected = selectView(views, request.viewId)
      const columns = resolveColumns(selected, workflows, scenarioConfigs, statuses, stageViews, requestedList)
      const cardsOfView = filterCardsByView(cardsOfList, selected)
      await this.store.save({ ...state, lastSyncAt: this.now(), lastError: undefined })
      return {
        project,
        tasklists,
        stages: stagesOfList,
        statuses,
        views: views.map(viewViewOf),
        workflows: workflows.map(workflowViewOf),
        scenarioConfigs: scenarioConfigs.map(scenarioViewOf),
        columns,
        ...(selected === undefined ? {} : { viewId: selected.id }),
        cards: cardsOfView,
      }
    } catch (error) {
      const message = describe(error)
      await this.store.save({ ...state, lastError: message })
      throw new TeambitionHostError('failed', message)
    }
  }

  /**
   * One card in full.
   *
   * The client reads the remote payload; the service fills in the two things the
   * client cannot know: the project display name and the DSH workspace the same
   * card would execute in on the board.
   */
  async taskDetail(request: TeambitionTaskDetailRequest): Promise<TeambitionTaskDetailView> {
    const state = await this.load()
    const client = this.clientFor(state.settings)
    const known = (state.projects ?? []).find(project => project.id === request.projectId)
    const settings = settingsView(state)
    try {
      const detail = await client.taskDetail(request.projectId, request.taskId)
      const choice = resolveWorkspace(detail.card.id, request.projectId, settings)
      const card: TeambitionCardView = {
        ...detail.card,
        projectName: known?.name ?? detail.card.projectName,
        ...(choice === undefined ? {} : { workspaceId: choice.workspaceId, workspaceSource: choice.source }),
      }
      await this.store.save({ ...state, lastSyncAt: this.now(), lastError: undefined })
      return { ...detail, card }
    } catch (error) {
      const message = describe(error)
      await this.store.save({ ...state, lastError: message })
      throw new TeambitionHostError('failed', message)
    }
  }

  /** Create one card (explicit user action; never a read side effect). */
  async createTask(request: TeambitionTaskCreateRequest): Promise<{ taskId: string }> {
    const state = await this.load()
    const client = this.clientFor(state.settings)
    try {
      return await client.createTask({
        projectId: request.projectId,
        title: request.title,
        ...(request.note === undefined ? {} : { note: request.note }),
        ...(request.tasklistId === undefined ? {} : { tasklistId: request.tasklistId }),
        ...(request.stageId === undefined ? {} : { stageId: request.stageId }),
        ...(request.statusId === undefined ? {} : { statusId: request.statusId }),
        ...(request.scenarioConfigId === undefined ? {} : { scenarioConfigId: request.scenarioConfigId }),
        ...(request.executorId === undefined ? {} : { executorId: request.executorId }),
      })
    } catch (error) {
      const message = describe(error)
      await this.store.save({ ...state, lastError: message })
      throw new TeambitionHostError('failed', message)
    }
  }

  /** Move one card to another workflow status. */
  async setStatus(request: TeambitionTaskStatusRequest): Promise<Record<string, never>> {
    const state = await this.load()
    const client = this.clientFor(state.settings)
    try {
      await client.updateTaskStatus(request.taskId, request.statusId)
      return {}
    } catch (error) {
      const message = describe(error)
      await this.store.save({ ...state, lastError: message })
      throw new TeambitionHostError('failed', message)
    }
  }

  /** Move one card to another kanban column. */
  async setStage(request: TeambitionTaskStageRequest): Promise<Record<string, never>> {
    const state = await this.load()
    const client = this.clientFor(state.settings)
    try {
      await client.updateTaskStage(request.taskId, request.stageId)
      return {}
    } catch (error) {
      const message = describe(error)
      await this.store.save({ ...state, lastError: message })
      throw new TeambitionHostError('failed', message)
    }
  }

  /** Replace the binding tables and/or the default workspace. */
  async bind(request: TeambitionBindRequest): Promise<TeambitionStateView> {
    return this.updateConfig(request)
  }

  /** Load the persisted state (memoized by the store). */
  private async load(): Promise<TeambitionHostState> {
    return (await this.store.load()).state
  }

  /** Create the client for one settings snapshot. */
  private clientFor(settings: TeambitionHostSettings): TeambitionClientPort {
    if (settings.cookie === undefined) {
      throw new TeambitionHostError('not-configured', 'No Teambition cookie is configured.')
    }
    const options: TeambitionClientOptions = {
      cookie: settings.cookie,
      apiBase: settings.apiBase,
      ...(settings.operatorId === undefined ? {} : { operatorId: settings.operatorId }),
      ...(this.transport === undefined ? {} : { transport: this.transport }),
    }
    return this.createClient(options)
  }
}

/** Create the service of one plugin mount. */
export function createTeambitionService(
  store: TeambitionConfigStore,
  options: TeambitionServiceOptions = {},
): TeambitionService {
  return new TeambitionService(store, options)
}

/** Build one stage view, attributing it to its task list. */
function stageView(stage: TeambitionStage, tasklists: readonly TeambitionTasklist[]): TeambitionStageView {
  const tasklistId = tasklistIdOf(stage.tasklistId, tasklists)
  return {
    id: stage.id,
    name: stage.name,
    ...(tasklistId === undefined ? {} : { tasklistId }),
    ...(stage.pos === undefined ? {} : { pos: stage.pos }),
  }
}

/**
 * Resolve the task list a stage or card belongs to.
 *
 * The remote rows of older projects carry no `tasklistId`; when the project
 * has exactly one task list that list is the only possible owner.
 */
function tasklistIdOf(explicit: string | undefined, tasklists: readonly TeambitionTasklist[]): string | undefined {
  if (explicit !== undefined) return explicit
  return tasklists.length === 1 ? tasklists[0]?.id : undefined
}

/** Build one card view, resolving its execution workspace. */
function cardView(
  task: TeambitionTask,
  project: TeambitionProject,
  settings: ReturnType<typeof settingsView>,
  tasklists: readonly TeambitionTasklist[],
): TeambitionCardView {
  const choice = resolveWorkspace(task.id, task.projectId, settings)
  const tasklistId = tasklistIdOf(task.tasklistId, tasklists)
  return {
    id: task.id,
    projectId: task.projectId,
    projectName: project.name,
    title: task.title,
    ...(task.note === undefined ? {} : { note: task.note }),
    ...(task.stageId === undefined ? {} : { stageId: task.stageId }),
    ...(tasklistId === undefined ? {} : { tasklistId }),
    ...(task.statusId === undefined ? {} : { statusId: task.statusId }),
    ...(task.scenarioConfigId === undefined ? {} : { scenarioConfigId: task.scenarioConfigId }),
    ...(task.isDone === undefined ? {} : { isDone: task.isDone }),
    ...(task.updatedAt === undefined ? {} : { updatedAt: task.updatedAt }),
    ...(task.priority === undefined ? {} : { priority: task.priority }),
    ...(task.uniqueId === undefined ? {} : { uniqueId: task.uniqueId }),
    ...(task.executorId === undefined ? {} : { executorId: task.executorId }),
    ...(task.executorName === undefined ? {} : { executorName: task.executorName }),
    ...(task.executorAvatarUrl === undefined ? {} : { executorAvatarUrl: task.executorAvatarUrl }),
    ...(task.creatorId === undefined ? {} : { creatorId: task.creatorId }),
    ...(task.dueAt === undefined ? {} : { dueAt: task.dueAt }),
    ...(task.dueAtRaw === undefined ? {} : { dueAtRaw: task.dueAtRaw }),
    ...(task.createdAt === undefined ? {} : { createdAt: task.createdAt }),
    ...(task.subtaskCount === undefined ? {} : { subtaskCount: task.subtaskCount }),
    ...(task.commentsCount === undefined ? {} : { commentsCount: task.commentsCount }),
    ...(choice === undefined ? {} : { workspaceId: choice.workspaceId, workspaceSource: choice.source }),
    url: cardUrl(task.projectId, task.id),
  }
}

/**
 * Pick the view columns and cards are resolved for: the requested view when the
 * project has it, the project default otherwise, then any first view.
 */
function selectView(views: readonly TeambitionView[], requestedId: string | undefined): TeambitionView | undefined {
  if (requestedId !== undefined) {
    const requested = views.find(view => view.id === requestedId)
    if (requested !== undefined) return requested
  }
  return views.find(view => view.isDefault === true) ?? views[0]
}

/** Render one saved view into the wire shape. */
function viewViewOf(view: TeambitionView): TeambitionViewView {
  return {
    id: view.id,
    name: view.name,
    vertical: view.vertical,
    scenarioConfigIds: view.scenarioConfigIds,
    ...(view.filter === undefined ? {} : { filter: view.filter }),
    ...(view.orderBy === undefined ? {} : { orderBy: view.orderBy }),
    ...(view.isDefault === true ? { isDefault: true } : {}),
  }
}

/** Render one workflow into the wire shape. */
function workflowViewOf(workflow: TeambitionWorkflow): TeambitionWorkflowView {
  return {
    id: workflow.id,
    name: workflow.name,
    statuses: workflow.statuses.map(status => ({
      id: status.id,
      name: status.name,
      ...(status.kind === undefined ? {} : { kind: status.kind }),
      ...(status.pos === undefined ? {} : { pos: status.pos }),
    })),
  }
}

/** Render one task type into the wire shape. */
function scenarioViewOf(config: TeambitionScenarioConfig): TeambitionScenarioView {
  return {
    id: config.id,
    name: config.name,
    ...(config.taskflowId === undefined ? {} : { taskflowId: config.taskflowId }),
    statusIds: config.statusIds,
  }
}

/**
 * Resolve the board columns of the selected view.
 *
 * A stage view renders the project's kanban columns (narrowed to one task list
 * when the request names one). A status view renders the union of its task
 * types' workflow statuses, deduplicated and kept in workflow order; when its
 * task types or workflows cannot be read it degrades to the project-wide
 * workflow statuses instead of rendering a columnless board.
 */
function resolveColumns(
  view: TeambitionView | undefined,
  workflows: readonly TeambitionWorkflow[],
  scenarioConfigs: readonly TeambitionScenarioConfig[],
  statuses: readonly TeambitionWorkflowStatus[],
  stageViews: readonly TeambitionStageView[],
  tasklistId: string | undefined,
): readonly TeambitionColumnView[] {
  const stageColumns: TeambitionColumnView[] = stageViews
    .filter(stage => tasklistId === undefined || stage.tasklistId === tasklistId)
    .map(stage => ({
      id: stage.id,
      name: stage.name,
      kind: 'stage' as const,
      ...(stage.tasklistId === undefined ? {} : { tasklistId: stage.tasklistId }),
      ...(stage.pos === undefined ? {} : { pos: stage.pos }),
    }))
  if (view === undefined || view.vertical !== 'status') return stageColumns
  const configIds = view.scenarioConfigIds
  const columns: TeambitionColumnView[] = []
  const seen = new Set<string>()
  const append = (status: TeambitionWorkflowStatus): void => {
    if (seen.has(status.id)) return
    seen.add(status.id)
    columns.push({
      id: status.id,
      name: status.name,
      kind: 'status',
      ...(status.pos === undefined ? {} : { pos: status.pos }),
    })
  }
  for (const configId of configIds) {
    const config = scenarioConfigs.find(candidate => candidate.id === configId)
    if (config === undefined) continue
    const workflow = workflows.find(candidate => candidate.id === config.taskflowId)
    for (const status of workflow?.statuses ?? []) append(status)
  }
  // A status view without task types (or whose task types the host could not
  // read) would otherwise render a columnless board: fall back to every
  // workflow status, which is what the web board shows for such a view.
  if (columns.length === 0) {
    for (const workflow of workflows) for (const status of workflow.statuses) append(status)
  }
  if (columns.length === 0) for (const status of statuses) append(status)
  return columns
}

/** One equality clause of a view filter expression. */
interface ViewFilterClause {
  readonly field: '_executorId' | '_creatorId'
  readonly value: string
}

/**
 * Read the card filter of a saved view.
 *
 * Teambition writes expressions such as `_executorId = <userId> ORDER BY
 * created DESC`; only the equality on `_executorId` / `_creatorId` is
 * understood, the ordering clause is ignored (the host keeps its own order).
 */
function readViewFilter(filter: string | undefined): ViewFilterClause | undefined {
  if (filter === undefined) return undefined
  const match = /(_executorId|_creatorId)\s*=\s*([^\s]+)/.exec(filter)
  if (match === null) return undefined
  const field = match[1]
  const value = match[2]
  if ((field !== '_executorId' && field !== '_creatorId') || value === undefined) return undefined
  return { field, value }
}

/**
 * Apply the saved view to the card rows: an `_executorId` filter keeps the
 * cards executed by that user, a `_creatorId` filter the cards they created,
 * and a status view keeps only the cards of its task types.
 */
function filterCardsByView(
  cards: readonly TeambitionCardView[],
  view: TeambitionView | undefined,
): readonly TeambitionCardView[] {
  if (view === undefined) return cards
  let filtered = cards
  const clause = readViewFilter(view.filter)
  if (clause?.field === '_executorId') {
    filtered = filtered.filter(card => card.executorId === clause.value)
  } else if (clause?.field === '_creatorId') {
    filtered = filtered.filter(card => card.creatorId === clause.value)
  }
  if (view.vertical === 'status' && view.scenarioConfigIds.length > 0) {
    const scenarioIds = new Set(view.scenarioConfigIds)
    filtered = filtered.filter(card => card.scenarioConfigId !== undefined && scenarioIds.has(card.scenarioConfigId))
  }
  return filtered
}

/**
 * Apply one settings patch. Absent fields keep their stored value; `clear`
 * flags win over a simultaneous value, and an empty string clears a field.
 */
function patchSettings(
  base: TeambitionHostSettings,
  request: TeambitionConfigRequest,
): TeambitionHostSettings {
  let cookie = base.cookie
  if (request.clearCookie === true) cookie = undefined
  else if (request.cookie !== undefined) cookie = nonEmpty(request.cookie)
  let operatorId = base.operatorId
  if (request.clearOperatorId === true) operatorId = undefined
  else if (request.operatorId !== undefined) operatorId = nonEmpty(request.operatorId)
  const apiBase = request.apiBase ?? base.apiBase
  let defaultWorkspaceId = base.defaultWorkspaceId
  if (request.defaultWorkspaceId !== undefined) {
    defaultWorkspaceId = request.defaultWorkspaceId === null ? undefined : nonEmpty(request.defaultWorkspaceId)
  }
  const projectBindings = request.projectBindings === undefined
    ? base.projectBindings
    : normalizeSettings({ projectBindings: request.projectBindings }).projectBindings
  const cardBindings = request.cardBindings === undefined
    ? base.cardBindings
    : normalizeSettings({ cardBindings: request.cardBindings }).cardBindings
  return {
    ...(cookie === undefined ? {} : { cookie }),
    ...(operatorId === undefined ? {} : { operatorId }),
    apiBase,
    ...(defaultWorkspaceId === undefined ? {} : { defaultWorkspaceId }),
    projectBindings,
    cardBindings,
  }
}

/** Trimmed non-empty string, else undefined. */
function nonEmpty(value: string): string | undefined {
  const text = value.trim()
  return text === '' ? undefined : text
}

/** Redacted message of an unknown failure. */
function describe(error: unknown): string {
  if (error instanceof TeambitionApiError) return redactMessage(error.message)
  if (error instanceof Error) return redactMessage(error.message)
  return redactMessage(String(error))
}
