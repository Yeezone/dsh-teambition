/**
 * Candidate Teambition endpoints and their base-host addressing.
 *
 * The research report verified the *paths* against Teambition's v3 docs but
 * could not verify them as cookie-authenticated internal routes from this
 * machine without a logged-in session. That is why every read path is a list
 * of candidates: the provider probes them in order (see `diagnose`) and then
 * reuses whichever base actually answered.
 *
 * @module dsh-task-board/core/teambition/endpoints
 */
import {
  TEAMBITION_API_BASE,
  TEAMBITION_WEB_BASE,
  type TeambitionBase,
  type TeambitionEndpoint,
  type TeambitionProbeResult,
} from './types.ts'

/**
 * Absolute URL of one logical endpoint.
 *
 * `api` addresses `https://api.teambition.com/<path>`; `web` addresses the
 * same-origin proxy `https://www.teambition.com/api/<path>`.
 * @param endpoint - logical endpoint.
 * @returns absolute URL.
 */
export function endpointUrl(endpoint: Pick<TeambitionEndpoint, 'base' | 'path'>): string {
  const path = endpoint.path.startsWith('/') ? endpoint.path : `/${endpoint.path}`
  return endpoint.base === 'api'
    ? `${TEAMBITION_API_BASE}${path}`
    : `${TEAMBITION_WEB_BASE}/api${path}`
}

/** Append a query object to one logical endpoint URL. */
export function endpointWithQuery(
  endpoint: Pick<TeambitionEndpoint, 'base' | 'path'>,
  query: Readonly<Record<string, string | number | boolean | undefined>>,
): string {
  const base = endpointUrl(endpoint)
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue
    params.set(key, String(value))
  }
  const suffix = params.toString()
  return suffix === '' ? base : `${base}?${suffix}`
}

/**
 * Project-list candidates in probe order.
 *
 * 1. `GET /v3/project/user-joined` on the API host: the v3-documented route.
 * 2. The same logical path through the www same-origin proxy: a browser
 *    session cookie is issued for `www.teambition.com`, so the proxy host is
 *    the one a pasted cookie is most likely to be accepted on.
 * 3. `GET /api/projects`: the legacy web-client route, observed to answer with
 *    the same `InvalidCookie` envelope as the v3 routes.
 * 4. `GET /v3/projects`: a straight plural collection route some builds use.
 */
export const PROJECT_LIST_CANDIDATES: readonly TeambitionEndpoint[] = [
  { id: 'project-user-joined-api', base: 'api', path: '/v3/project/user-joined', purpose: 'v3 project list of the joined user' },
  { id: 'project-user-joined-web', base: 'web', path: '/v3/project/user-joined', purpose: 'v3 project list through the www proxy' },
  { id: 'projects-legacy-api', base: 'api', path: '/api/projects', purpose: 'legacy project list route' },
  { id: 'projects-legacy-web', base: 'web', path: '/projects', purpose: 'legacy project list through the www proxy' },
  { id: 'projects-collection-api', base: 'api', path: '/v3/projects', purpose: 'plural v3 project collection' },
  { id: 'projects-collection-web', base: 'web', path: '/v3/projects', purpose: 'plural v3 project collection through the www proxy' },
]

/**
 * Candidates that list one project's workflow statuses. The status names are
 * how the board maps a remote task onto its columns, and how a write-back
 * resolves the `taskflowstatusId` to send.
 *
 * The legacy `web` route is listed first because a browser cookie is issued for
 * `www.teambition.com`; the v3 API host requires an app token. A project may
 * legitimately answer with no status collection at all, which the caller must
 * treat as "no workflow statuses" rather than a failure.
 * @param projectId - remote project id.
 */
export function projectStatusCandidates(projectId: string): readonly TeambitionEndpoint[] {
  const id = encodeURIComponent(projectId)
  const legacy = `/projects/${id}/taskflowstatuses`
  const path = `/v3/project/${id}/taskflowstatus/search`
  return [
    { id: 'project-status-legacy-web', base: 'web', path: legacy, purpose: 'legacy workflow status list through the www proxy' },
    { id: 'project-status-api', base: 'api', path, purpose: 'workflow status list of one project' },
    { id: 'project-status-web', base: 'web', path, purpose: 'workflow status list through the www proxy' },
  ]
}

/**
 * Candidates that list one project's kanban stages (the board columns).
 * @param projectId - remote project id.
 */
export function projectStageCandidates(projectId: string): readonly TeambitionEndpoint[] {
  const id = encodeURIComponent(projectId)
  const legacy = `/projects/${id}/stages`
  const path = `/v3/project/${id}/stage/search`
  return [
    { id: 'project-stage-legacy-web', base: 'web', path: legacy, purpose: 'legacy kanban stage list through the www proxy' },
    { id: 'project-stage-api', base: 'api', path, purpose: 'kanban stage list of one project' },
    { id: 'project-stage-web', base: 'web', path, purpose: 'kanban stage list through the www proxy' },
  ]
}

/**
 * Candidates that list one project's tasks.
 *
 * The legacy `GET /api/projects/{id}/tasks` collection is what the current web
 * client serves to a browser cookie; the v3 query/search routes are kept as the
 * fallback for tenants that expose them.
 * @param projectId - remote project id.
 */
export function projectTaskCandidates(projectId: string): readonly TeambitionEndpoint[] {
  const id = encodeURIComponent(projectId)
  const legacy = `/projects/${id}/tasks`
  const query = `/v3/project/${id}/task/query`
  const search = `/v3/project/${id}/task/search`
  return [
    { id: 'project-task-legacy-web', base: 'web', path: legacy, purpose: 'legacy project task collection through the www proxy' },
    { id: 'project-task-query-api', base: 'api', path: query, purpose: 'project task query' },
    { id: 'project-task-query-web', base: 'web', path: query, purpose: 'project task query through the www proxy' },
    { id: 'project-task-search-api', base: 'api', path: search, purpose: 'older project task search' },
    { id: 'project-task-search-web', base: 'web', path: search, purpose: 'older project task search through the www proxy' },
  ]
}

/**
 * Candidates that list one project's task lists (the legacy create route wants
 * a `_tasklistId` and falls back to the first list).
 * @param projectId - remote project id.
 */
export function projectTasklistCandidates(projectId: string): readonly TeambitionEndpoint[] {
  const path = `/projects/${encodeURIComponent(projectId)}/tasklists`
  return [{ id: 'project-tasklist-legacy-web', base: 'web', path, purpose: 'legacy task-list collection through the www proxy' }]
}

/**
 * Candidates that update one task's workflow status. Both bases are tried
 * because the proxy may accept a browser session where the API host refuses.
 * @param taskId - remote task id.
 */
export function taskStatusUpdateCandidates(taskId: string): readonly TeambitionEndpoint[] {
  const id = encodeURIComponent(taskId)
  const legacy = `/tasks/${id}/taskflowstatus`
  const path = `/v3/task/${id}/taskflowstatus`
  return [
    {
      id: 'task-status-update-legacy-web',
      base: 'web',
      path: legacy,
      purpose: 'move the task to a workflow status through the www proxy',
    },
    { id: 'task-status-update-api', base: 'api', path, purpose: 'write the task workflow status' },
    { id: 'task-status-update-web', base: 'web', path, purpose: 'write the task workflow status through the www proxy' },
  ]
}

/**
 * Candidates that create one task. The legacy collection route is what the web
 * client posts to with a browser cookie (`_projectId` + `content` fields).
 * @returns candidates in probe order.
 */
export function taskCreateCandidates(): readonly TeambitionEndpoint[] {
  return [
    { id: 'task-create-legacy-web', base: 'web', path: '/tasks', purpose: 'legacy task create through the www proxy' },
    { id: 'task-create-api', base: 'api', path: '/v3/task/create', purpose: 'create one task' },
    { id: 'task-create-web', base: 'web', path: '/v3/task/create', purpose: 'create one task through the www proxy' },
  ]
}

/**
 * Candidates that read a project's workflows with their ordered statuses (the
 * columns of a workflow board). The web client calls this route when it renders
 * a "status" view.
 * @param projectId - remote project id.
 */
export function projectWorkflowCandidates(projectId: string): readonly TeambitionEndpoint[] {
  const path = `/projects/${encodeURIComponent(projectId)}/taskflows`
  return [
    {
      id: 'project-workflow-legacy-web',
      base: 'web',
      path,
      purpose: 'workflows with their taskflow statuses through the www proxy',
    },
  ]
}

/**
 * Candidates that read a project's task types (`scenariofieldconfig`), each
 * bound to a workflow.
 * @param projectId - remote project id.
 */
export function projectScenarioConfigCandidates(projectId: string): readonly TeambitionEndpoint[] {
  const path = `/v2/projects/${encodeURIComponent(projectId)}/scenariofieldconfigs`
  return [
    {
      id: 'project-scenario-config-web',
      base: 'web',
      path,
      purpose: 'task types with their workflows through the www proxy',
    },
  ]
}

/**
 * Candidates that read a project's saved views (smartgroups): the default view
 * and the custom view list.
 * @param projectId - remote project id.
 */
export function projectViewCandidates(projectId: string): readonly TeambitionEndpoint[] {
  const encoded = encodeURIComponent(projectId)
  return [
    {
      id: 'project-view-default-web',
      base: 'web',
      path: `/projects/${encoded}/smartgroups/default`,
      purpose: 'the project default view through the www proxy',
    },
    {
      id: 'project-view-custom-web',
      base: 'web',
      path: `/v2/projects/${encoded}/smartgroups`,
      purpose: 'the saved view list through the www proxy',
    },
  ]
}

/**
 * Candidates that move one task between kanban stages.
 *
 * The current web client drags a card with `PUT /api/tasks/{id}/stage/move`
 * (`{ stageId, preTaskId, nextTaskId }`); the legacy task resource accepts
 * `_stageId` in principle but the www proxy answers 204 without applying it,
 * so the dedicated move route is tried first.
 * @param taskId - remote task id.
 */
export function taskStageUpdateCandidates(taskId: string): readonly TeambitionEndpoint[] {
  const id = encodeURIComponent(taskId)
  const move = `/tasks/${id}/stage/move`
  const legacy = `/tasks/${id}`
  const path = `/v3/task/${id}/stage/update`
  return [
    { id: 'task-stage-move-web', base: 'web', path: move, purpose: 'move the task to a kanban stage through the www proxy' },
    { id: 'task-stage-update-legacy-web', base: 'web', path: legacy, purpose: 'legacy task update through the www proxy' },
    { id: 'task-stage-update-api', base: 'api', path, purpose: 'write the task kanban stage' },
    { id: 'task-stage-update-web', base: 'web', path, purpose: 'write the task kanban stage through the www proxy' },
  ]
}

/** Project-list candidate ids, used to decide whether a probe result is one. */
const PROJECT_PROBE_IDS = new Set(PROJECT_LIST_CANDIDATES.map(endpoint => endpoint.id))

/**
 * Pick the first probe that returned a usable project list.
 * @param results - probe results in probe order.
 * @returns the winning result, or undefined when none was usable.
 */
export function selectUsableProjectProbe(results: readonly TeambitionProbeResult[]): TeambitionProbeResult | undefined {
  for (const result of results) {
    if (result.ok && (result.projectCount ?? 0) > 0) return result
  }
  return undefined
}

/** Whether one endpoint is a project-list candidate. */
export function isProjectListEndpoint(endpoint: TeambitionEndpoint): boolean {
  return PROJECT_PROBE_IDS.has(endpoint.id)
}

/**
 * The base that answered the last diagnose, expressed as the persisted
 * `apiBase` setting. A winning `web` probe switches every later request to the
 * www proxy; a winning `api` probe keeps the default.
 * @param result - winning probe.
 */
export function baseOfProbe(result: TeambitionProbeResult): TeambitionBase {
  return result.base
}
