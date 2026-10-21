/**
 * The cookie-authenticated Teambition client.
 *
 * This is the only module that knows the *wire* details of the internal API:
 * which candidate paths exist, how a collection is unwrapped out of the
 * response envelope, and how a failure is classified. Everything it returns is
 * either a normalized core type or a redacted diagnostic, so the sync service
 * never sees a raw body.
 *
 * The internal endpoints are UNVERIFIED from outside a logged-in session (the
 * research report could verify only the `InvalidCookie` refusal). That is why
 * every read goes through a candidate list and `diagnose` exists: instead of
 * pretending to know the routes, the provider discovers and reports them.
 *
 * @module dsh-task-board/host/teambition/client
 */
import {
  collapseWhitespace,
  endpointUrl,
  endpointWithQuery,
  isInvalidCookieError,
  projectStageCandidates,
  projectStatusCandidates,
  projectTaskCandidates,
  projectTasklistCandidates,
  PROJECT_LIST_CANDIDATES,
  readApiError,
  readCollection,
  readNextPageToken,
  readProjects,
  readTasks,
  readWorkflowStatuses,
  redactMessage,
  redactPreview,
  selectUsableProjectProbe,
  taskCreateCandidates,
  taskStageUpdateCandidates,
  taskStatusUpdateCandidates,
  truncate,
  TEAMBITION_WEB_APP,
  TEAMBITION_WEB_BASE,
  type TeambitionBase,
  type TeambitionDiagnostics,
  type TeambitionEndpoint,
  type TeambitionProject,
  type TeambitionProbeResult,
  type TeambitionTask,
  type TeambitionTasklist,
  type TeambitionWorkflowStatus,
} from '../core/teambition/index.ts'
import { TeambitionTransportError, createNodeTransport, type TeambitionTransport } from './transport.ts'

/** How a request failed. */
export type TeambitionRequestFailure = 'network' | 'http' | 'invalid-cookie' | 'api' | 'shape'

/** One classified request failure. */
export class TeambitionApiError extends Error {
  constructor(
    readonly failure: TeambitionRequestFailure,
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'TeambitionApiError'
  }
}

/** One parsed response. */
interface ParsedResponse {
  readonly status: number
  readonly contentType: string
  readonly body: string
  /** Parsed JSON body; `undefined` when the body is empty or not JSON. */
  readonly json: unknown
}

/** One kanban column (`stage`) of a project. */
export interface TeambitionStage {
  /** Remote stage id. */
  readonly id: string
  /** Column name. */
  readonly name: string
  /** Owning task-list id; columns belong to a task list when the API says so. */
  readonly tasklistId?: string
  /** Column position when the API reports one. */
  readonly pos?: number
}

/** One task creation request as the write route takes it. */
export interface TeambitionTaskWrite {
  /** Owning project id. */
  readonly projectId: string
  /** Task title (`content`). */
  readonly title: string
  /** Task notes (`note`). */
  readonly note?: string
  /** Owning task-list id; the legacy route requires one. */
  readonly tasklistId?: string
  /** Kanban column id. */
  readonly stageId?: string
  /** Workflow status id, sent as `taskflowstatusId`. */
  readonly statusId?: string
  /** Teambition executor id. */
  readonly executorId?: string
}

/** Options of a client. */
export interface TeambitionClientOptions {
  /** Stored `Cookie` header. Host-only. */
  readonly cookie: string
  /** Which host answered last time; only affects candidate order. */
  readonly apiBase?: TeambitionBase
  /** Teambition user id for `x-operator-id`, when known. */
  readonly operatorId?: string
  /** Transport override (tests). */
  readonly transport?: TeambitionTransport
  /** Per-request timeout. */
  readonly timeoutMs?: number
}

/** Maximum pages walked per project and pass. */
export const MAX_PAGES = 40

/** Page size requested from the internal API. */
export const PAGE_SIZE = 200

/** User agent of the provider. */
const USER_AGENT = 'dsh-client-ui-teambition/0.1'

/** Create a client bound to one cookie. */
export class TeambitionClient {
  private readonly cookie: string
  private readonly apiBase: TeambitionBase
  private readonly operatorId: string | undefined
  private readonly transport: TeambitionTransport
  private readonly timeoutMs: number | undefined

  constructor(options: TeambitionClientOptions) {
    this.cookie = options.cookie.trim()
    this.apiBase = options.apiBase ?? 'api'
    this.operatorId = options.operatorId
    this.transport = options.transport ?? createDefaultTransport()
    this.timeoutMs = options.timeoutMs
  }

  /** Whether the client holds a usable-looking cookie. */
  get configured(): boolean {
    return this.cookie !== ''
  }

  /** Request headers shared by every call. */
  private headers(url: string, body: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'application/json, text/plain, */*',
      // The host fetch proxy rewrites content-encoding; a raw https request
      // keeps whatever the server sends, so ask for no compression at all.
      'accept-encoding': 'identity',
      cookie: this.cookie,
      'user-agent': USER_AGENT,
    }
    if (body) headers['content-type'] = 'application/json'
    if (url.startsWith(TEAMBITION_WEB_BASE)) {
      headers.referer = `${TEAMBITION_WEB_APP}/`
      headers.origin = TEAMBITION_WEB_APP
    }
    return headers
  }

  /** Send one request and classify its outcome. */
  private async send(url: string, method: 'GET' | 'PUT' | 'POST', body?: string): Promise<ParsedResponse> {
    const headers = this.headers(url, body !== undefined)
    if (method !== 'GET' && this.operatorId !== undefined) headers['x-operator-id'] = this.operatorId
    let response
    try {
      response = await this.transport.request({
        url,
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        ...(this.timeoutMs === undefined ? {} : { timeoutMs: this.timeoutMs }),
      })
    } catch (error) {
      if (error instanceof TeambitionTransportError) {
        throw new TeambitionApiError('network', redactMessage(error.message, this.cookie))
      }
      throw new TeambitionApiError('network', redactMessage(messageOf(error), this.cookie))
    }
    let json: unknown
    if (response.body.trim() !== '') {
      try {
        json = JSON.parse(response.body) as unknown
      } catch {
        json = undefined
      }
    }
    const apiError = readApiError(json)
    if (response.status === 401 || isInvalidCookieError(apiError?.code, response.status)) {
      throw new TeambitionApiError(
        'invalid-cookie',
        `session cookie was refused (HTTP ${String(response.status)}${apiError?.code === undefined ? '' : ` ${apiError.code}`}); log in to teambition.com again and paste a fresh cookie`,
        response.status,
        apiError?.code,
      )
    }
    if (response.status < 200 || response.status >= 300) {
      const preview = redactPreview(response.body, this.cookie)
      throw new TeambitionApiError(
        'http',
        `HTTP ${String(response.status)}${apiError?.code === undefined ? '' : ` ${apiError.code}`}${preview === '' ? '' : `: ${preview}`}`,
        response.status,
        apiError?.code,
      )
    }
    if (apiError !== undefined) {
      const preview = redactPreview(response.body, this.cookie)
      throw new TeambitionApiError('api', `API error ${apiError.code ?? 'unknown'}${apiError.message === undefined ? '' : `: ${apiError.message}`}${preview === '' ? '' : ` (${preview})`}`, response.status, apiError.code)
    }
    return { status: response.status, contentType: response.contentType, body: response.body, json }
  }

  /**
   * Probe one project-list candidate.
   * @param endpoint - candidate.
   * @returns probe result plus the projects it yielded.
   */
  private async probeProjectEndpoint(endpoint: TeambitionEndpoint): Promise<{ result: TeambitionProbeResult; projects: readonly TeambitionProject[] }> {
    try {
      const response = await this.send(endpointWithQuery(endpoint, { count: 20, pageSize: 20 }), 'GET')
      const projects = readProjects(response.json)
      const preview = redactPreview(response.body, this.cookie)
      return {
        result: {
          id: endpoint.id,
          base: endpoint.base,
          path: endpoint.path,
          status: response.status,
          ...(response.contentType === '' ? {} : { contentType: response.contentType }),
          ...(preview === '' ? {} : { preview }),
          ok: projects.length > 0,
          projectCount: projects.length,
        },
        projects,
      }
    } catch (error) {
      const failure = error instanceof TeambitionApiError ? error : undefined
      return {
        result: {
          id: endpoint.id,
          base: endpoint.base,
          path: endpoint.path,
          ...(failure?.status === undefined ? {} : { status: failure.status }),
          ok: false,
          ...(failure === undefined ? { error: redactMessage(messageOf(error), this.cookie) } : { error: failure.message }),
        },
        projects: [],
      }
    }
  }

  /** Candidate order with the last known working base first. */
  private ordered(candidates: readonly TeambitionEndpoint[]): TeambitionEndpoint[] {
    const preferred = candidates.filter(endpoint => endpoint.base === this.apiBase)
    const rest = candidates.filter(endpoint => endpoint.base !== this.apiBase)
    return [...preferred, ...rest]
  }

  /**
   * Run one diagnose pass over every project-list candidate.
   * @returns diagnostics, with previews redacted and cookie state masked.
   */
  async diagnose(): Promise<TeambitionDiagnostics> {
    const probedAt = Date.now()
    if (this.cookie === '') {
      return {
        probedAt,
        cookieConfigured: false,
        conclusion: 'no-cookie',
        message: 'No cookie is configured. Log in to teambition.com, copy the Cookie request header from DevTools and save it in the settings card.',
        results: [],
      }
    }
    const results: TeambitionProbeResult[] = []
    for (const endpoint of this.ordered(PROJECT_LIST_CANDIDATES)) {
      const probe = await this.probeProjectEndpoint(endpoint)
      results.push(probe.result)
      // Stop at the first usable route: the later candidates exist as fallbacks.
      if (probe.result.ok) break
    }
    const winner = selectUsableProjectProbe(results)
    if (winner !== undefined) {
      return {
        probedAt,
        cookieConfigured: true,
        conclusion: 'usable',
        message: `Cookie accepted. ${String(winner.projectCount ?? 0)} project(s) listed via ${winner.base}:${winner.path}.`,
        results,
        projectEndpoint: { id: winner.id, base: winner.base, path: winner.path },
      }
    }
    const invalid = results.some(result => result.status === 401)
    const notFound = results.some(result => result.status === 404 || result.status === 405)
    const network = results.some(result => result.status === undefined && result.error !== undefined)
    const conclusion = invalid ? 'cookie-invalid' : notFound ? 'endpoint-not-found' : network ? 'network-error' : 'unknown'
    const message = invalid
      ? 'Teambition refused the cookie (HTTP 401 InvalidCookie). Log in to teambition.com again, copy a fresh Cookie header and save it.'
      : notFound
        ? 'The cookie was not refused, but none of the known project-list paths answered. Paste this diagnose output into the provider doc issue so the real paths can be added.'
        : network
          ? 'No probe reached Teambition (network/DNS/timeout). Check connectivity and any proxy configuration.'
          : 'None of the candidate endpoints returned a project list. The response previews tell what answered.'
    return { probedAt, cookieConfigured: true, conclusion, message, results }
  }

  /**
   * List the projects the user joined, using the first candidate that works.
   * @returns projects and the endpoint that answered.
   */
  async listProjects(): Promise<{ projects: readonly TeambitionProject[]; endpoint: TeambitionEndpoint }> {
    const failures: string[] = []
    for (const endpoint of this.ordered(PROJECT_LIST_CANDIDATES)) {
      const probe = await this.probeProjectEndpoint(endpoint)
      if (probe.result.ok) return { projects: probe.projects, endpoint }
      failures.push(`${endpoint.base}:${endpoint.path} -> ${describeFailure(probe.result)}`)
      if (probe.result.status === 401) {
        throw new TeambitionApiError('invalid-cookie', probe.result.error ?? 'session cookie was refused')
      }
    }
    throw new TeambitionApiError('api', `no project-list endpoint answered: ${truncate(failures.join('; '), 400)}`)
  }

  /**
   * Read one project's workflow statuses.
   *
   * A project without a workflow answers 404 on every status route, which is a
   * normal state (simple projects are organized by stage only), so an exhausted
   * candidate list yields an empty collection instead of failing the panel.
   * @param projectId - remote project id.
   * @returns statuses (empty when the project has none).
   */
  async projectStatuses(projectId: string): Promise<readonly TeambitionWorkflowStatus[]> {
    for (const endpoint of this.ordered(projectStatusCandidates(projectId))) {
      try {
        const response = await this.send(endpointWithQuery(endpoint, { pageSize: 200 }), 'GET')
        return readWorkflowStatuses(response.json)
      } catch (error) {
        if (error instanceof TeambitionApiError && error.failure === 'invalid-cookie') throw error
      }
    }
    return []
  }

  /**
   * Read every task of one project, walking the cursor pages.
   * @param projectId - remote project id.
   * @returns normalized tasks (deduplicated by id).
   */
  async projectTasks(projectId: string): Promise<readonly TeambitionTask[]> {
    const failures: string[] = []
    for (const endpoint of this.ordered(projectTaskCandidates(projectId))) {
      try {
        return await this.walkTaskPages(endpoint, projectId)
      } catch (error) {
        failures.push(`${endpoint.base}:${endpoint.path} -> ${redactMessage(messageOf(error), this.cookie)}`)
        if (error instanceof TeambitionApiError && error.failure === 'invalid-cookie') throw error
      }
    }
    throw new TeambitionApiError('api', `no project-task endpoint answered: ${truncate(failures.join('; '), 400)}`)
  }

  /** Paginate one project-task endpoint. */
  private async walkTaskPages(endpoint: TeambitionEndpoint, projectId: string): Promise<readonly TeambitionTask[]> {
    const byId = new Map<string, TeambitionTask>()
    let pageToken: string | undefined
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query: Record<string, string | number> = { pageSize: PAGE_SIZE }
      if (pageToken !== undefined) query.pageToken = pageToken
      const response = await this.requestPage(endpoint, query)
      for (const task of readTasks(response.json, projectId)) byId.set(task.id, task)
      const next = readNextPageToken(response.json)
      if (next === undefined || next === pageToken) break
      pageToken = next
    }
    return [...byId.values()]
  }

  /**
   * GET one page, falling back to POST when the route rejects GET.
   *
   * The documented task query is a GET with query parameters, but some builds
   * expose only the POST form; trying both is cheaper than requiring the user
   * to discover which one their tenant serves.
   */
  private async requestPage(endpoint: TeambitionEndpoint, query: Readonly<Record<string, string | number>>): Promise<ParsedResponse> {
    try {
      return await this.send(endpointWithQuery(endpoint, query), 'GET')
    } catch (error) {
      if (error instanceof TeambitionApiError && error.failure === 'http' && (error.status === 404 || error.status === 405)) {
        return this.send(endpointUrl(endpoint), 'POST', JSON.stringify(query))
      }
      throw error
    }
  }

  /**
   * Read one project's kanban stages.
   * @param projectId - remote project id.
   * @returns stages, sorted by `pos` when known.
   */
  async projectStages(projectId: string): Promise<readonly TeambitionStage[]> {
    const failures: string[] = []
    for (const endpoint of this.ordered(projectStageCandidates(projectId))) {
      try {
        const response = await this.send(endpointWithQuery(endpoint, { pageSize: 200 }), 'GET')
        return readStages(response.json)
      } catch (error) {
        failures.push(`${endpoint.base}:${endpoint.path} -> ${redactMessage(messageOf(error), this.cookie)}`)
        if (error instanceof TeambitionApiError && error.failure === 'invalid-cookie') throw error
      }
    }
    throw new TeambitionApiError('api', `no kanban-stage endpoint answered: ${truncate(failures.join('; '), 400)}`)
  }

  /**
   * Read one project's task lists.
   *
   * Columns (stages) belong to a task list, so the panel navigates
   * project -> list -> columns. A project whose task-list route does not
   * answer yields an empty collection instead of failing the panel; a refused
   * cookie still propagates.
   * @param projectId - remote project id.
   * @returns task lists (empty when the project has none).
   */
  async projectTasklists(projectId: string): Promise<readonly TeambitionTasklist[]> {
    for (const endpoint of this.ordered(projectTasklistCandidates(projectId))) {
      try {
        const response = await this.send(endpointUrl(endpoint), 'GET')
        return readTasklists(response.json)
      } catch (error) {
        if (error instanceof TeambitionApiError && error.failure === 'invalid-cookie') throw error
      }
    }
    return []
  }

  /**
   * Create one task.
   * @param input - title, project and optional task list/stage/status/executor.
   * @returns the created task id and the endpoint that accepted it.
   */
  async createTask(input: TeambitionTaskWrite): Promise<{ taskId: string; endpoint: TeambitionEndpoint }> {
    const failures: string[] = []
    for (const endpoint of this.ordered(taskCreateCandidates())) {
      try {
        const body = JSON.stringify(await this.createBodyFor(endpoint, input))
        const response = await this.send(endpointUrl(endpoint), 'POST', body)
        const taskId = readCreatedTaskId(response.json)
        if (taskId === undefined) {
          throw new TeambitionApiError('shape', `create-task answered without a task id: ${redactPreview(response.body, this.cookie)}`)
        }
        return { taskId, endpoint }
      } catch (error) {
        failures.push(`${endpoint.base}:${endpoint.path} -> ${redactMessage(messageOf(error), this.cookie)}`)
        if (error instanceof TeambitionApiError && error.failure === 'invalid-cookie') throw error
      }
    }
    throw new TeambitionApiError('api', `no task-create endpoint accepted the request: ${truncate(failures.join('; '), 400)}`)
  }

  /**
   * Build the create payload the endpoint expects.
   *
   * The v3 route takes camelCase fields; the legacy collection route the web
   * client uses takes underscore fields and requires a `_tasklistId`, so the
   * selected task list is used when given and the project's first task list is
   * fetched on demand otherwise.
   */
  private async createBodyFor(endpoint: TeambitionEndpoint, input: TeambitionTaskWrite): Promise<Record<string, string>> {
    if (!isLegacyTaskRoute(endpoint)) {
      return {
        content: input.title,
        projectId: input.projectId,
        ...(input.tasklistId === undefined ? {} : { tasklistId: input.tasklistId }),
        ...(input.note === undefined ? {} : { note: input.note }),
        ...(input.stageId === undefined ? {} : { stageId: input.stageId }),
        ...(input.statusId === undefined ? {} : { taskflowstatusId: input.statusId }),
        ...(input.executorId === undefined ? {} : { executorId: input.executorId }),
      }
    }
    const tasklistId = input.tasklistId ?? (await this.firstTasklistId(input.projectId))
    if (tasklistId === undefined) {
      throw new TeambitionApiError('api', `project ${input.projectId} did not list a task list, so the legacy create route cannot be used`)
    }
    return {
      _projectId: input.projectId,
      _tasklistId: tasklistId,
      content: input.title,
      ...(input.note === undefined ? {} : { note: input.note }),
      ...(input.stageId === undefined ? {} : { _stageId: input.stageId }),
    }
  }

  /** Read the id of the first task list of a project, if it has one. */
  private async firstTasklistId(projectId: string): Promise<string | undefined> {
    const tasklists = await this.projectTasklists(projectId)
    return tasklists[0]?.id
  }

  /**
   * Write one task's workflow status.
   *
   * Only the workflow API accepts this; simple projects reject it with
   * `NotSupportActionInTaskflowProject`, which is reported as a plain message
   * instead of a stack-level failure.
   * @param taskId - remote task id.
   * @param statusId - target `taskflowstatusId`.
   */
  async updateTaskStatus(taskId: string, statusId: string): Promise<void> {
    const body = JSON.stringify({ taskflowstatusId: statusId })
    const failures: string[] = []
    for (const endpoint of this.ordered(taskStatusUpdateCandidates(taskId))) {
      try {
        await this.send(endpointUrl(endpoint), 'PUT', body)
        return
      } catch (error) {
        if (error instanceof TeambitionApiError && error.code === 'NotSupportActionInTaskflowProject') {
          throw new TeambitionApiError('api', 'this project has no workflow statuses, drag the card to another stage instead')
        }
        failures.push(`${endpoint.base}:${endpoint.path} -> ${redactMessage(messageOf(error), this.cookie)}`)
        if (error instanceof TeambitionApiError && error.failure === 'invalid-cookie') throw error
      }
    }
    throw new TeambitionApiError('api', `no workflow-status write endpoint accepted the update: ${truncate(failures.join('; '), 400)}`)
  }

  /**
   * Write one task's kanban stage.
   *
   * The legacy task resource takes `_stageId`; the v3 route takes `stageId`.
   * @param taskId - remote task id.
   * @param stageId - target `stageId`.
   */
  async updateTaskStage(taskId: string, stageId: string): Promise<void> {
    const failures: string[] = []
    for (const endpoint of this.ordered(taskStageUpdateCandidates(taskId))) {
      try {
        const body = JSON.stringify(isLegacyTaskRoute(endpoint) ? { _stageId: stageId } : { stageId })
        await this.send(endpointUrl(endpoint), 'PUT', body)
        return
      } catch (error) {
        failures.push(`${endpoint.base}:${endpoint.path} -> ${redactMessage(messageOf(error), this.cookie)}`)
        if (error instanceof TeambitionApiError && error.failure === 'invalid-cookie') throw error
      }
    }
    throw new TeambitionApiError('api', `no kanban-stage write endpoint accepted the update: ${truncate(failures.join('; '), 400)}`)
  }
}

/** Whether a candidate is the legacy `/tasks[/{id}]` route rather than v3. */
function isLegacyTaskRoute(endpoint: TeambitionEndpoint): boolean {
  return endpoint.base === 'web' && /^\/tasks(\/|$)/.test(endpoint.path)
}

/** Read the kanban stages out of a stage-list payload. */
function readStages(payload: unknown): readonly TeambitionStage[] {
  const collection = readCollection(payload)
  if (collection === undefined) return []
  const stages: TeambitionStage[] = []
  const seen = new Set<string>()
  for (const raw of collection) {
    if (typeof raw !== 'object' || raw === null) continue
    const record = raw as Record<string, unknown>
    const id = stringOf(record.id) ?? stringOf(record._id)
    if (id === undefined || seen.has(id)) continue
    const name = collapseWhitespace(stringOf(record.name) ?? stringOf(record.title) ?? id)
    const tasklistId = stringOf(record.tasklistId) ?? stringOf(record._tasklistId)
    const pos = typeof record.pos === 'number' ? record.pos : typeof record.position === 'number' ? record.position : undefined
    seen.add(id)
    stages.push({ id, name, ...(tasklistId === undefined ? {} : { tasklistId }), ...(pos === undefined ? {} : { pos }) })
  }
  return stages.sort((left, right) => (left.pos ?? Number.MAX_SAFE_INTEGER) - (right.pos ?? Number.MAX_SAFE_INTEGER))
}

/** Read the task lists out of a task-list payload. */
function readTasklists(payload: unknown): readonly TeambitionTasklist[] {
  const collection = readCollection(payload)
  if (collection === undefined) return []
  const tasklists: TeambitionTasklist[] = []
  const seen = new Set<string>()
  for (const raw of collection) {
    if (typeof raw !== 'object' || raw === null) continue
    const record = raw as Record<string, unknown>
    const id = stringOf(record._id) ?? stringOf(record.id)
    if (id === undefined || seen.has(id)) continue
    const name = collapseWhitespace(stringOf(record.title) ?? stringOf(record.name) ?? id)
    seen.add(id)
    tasklists.push({ id, name })
  }
  return tasklists
}

/** Read the id of a freshly created task out of a create response. */
function readCreatedTaskId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  const direct = stringOf(record.id) ?? stringOf(record._id) ?? stringOf(record.taskId)
  if (direct !== undefined) return direct
  for (const key of ['result', 'data', 'task']) {
    const nested = record[key]
    if (typeof nested !== 'object' || nested === null) continue
    const inner = nested as Record<string, unknown>
    const id = stringOf(inner.id) ?? stringOf(inner._id) ?? stringOf(inner.taskId)
    if (id !== undefined) return id
  }
  return undefined
}

/** Non-empty non-blank string, else undefined. */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Describe one failed probe for an aggregate error message. */
function describeFailure(result: TeambitionProbeResult): string {
  if (result.status !== undefined) return `HTTP ${String(result.status)}`
  return result.error ?? 'unknown failure'
}

/** Message of an unknown error. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Lazily create the production transport (keeps `node:https` out of the core half). */
function createDefaultTransport(): TeambitionTransport {
  return createNodeTransport()
}

/** Whether a diagnose conclusion means the cookie itself is the problem. */
export function isCookieFailure(diagnostics: TeambitionDiagnostics | undefined): boolean {
  return diagnostics?.conclusion === 'cookie-invalid' || diagnostics?.conclusion === 'no-cookie'
}
