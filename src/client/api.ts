/**
 * Browser client of the host `/teambition` routes: typed JSON envelope calls.
 *
 * Every call posts to a DOCUMENT-RELATIVE route (no leading slash) because the
 * harness serves the GUI with `<base href="./">`: a root-absolute path escapes
 * a sub-path deployment prefix and never reaches the host route. The host
 * answers with the shared `{ ok: true, value } | { ok: false, error }` envelope;
 * this module decodes it and never throws, so the panel always has something to
 * render.
 *
 * @module @yeezone/dsh-client-ui-teambition/client/api
 */
import type {
  TeambitionBindRequest,
  TeambitionConfigRequest,
  TeambitionDiagnoseView,
  TeambitionProjectDetail,
  TeambitionProjectsView,
  TeambitionStateView,
  TeambitionTaskCreateRequest,
  TeambitionTaskStageRequest,
  TeambitionTaskStatusRequest,
} from '../core/protocol.ts'
import { TEAMBITION_ROUTES } from '../core/protocol.ts'

/** Failure half of the host envelope. */
export interface TeambitionApiError {
  /** Stable failure code when the host classified the failure. */
  readonly code?: string
  /** Human-readable failure message (host text, may be technical). */
  readonly message: string
}

/** Result of one route call; a transport failure is a normal `ok: false` result. */
export type TeambitionApiResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: TeambitionApiError }

/** Host echo of a card creation (advisory: the panel refetches the project). */
export interface TeambitionTaskCreateView {
  /** Id of the card the host created. */
  readonly taskId: string
}

/** Host acknowledgement of a status/stage move (the panel refetches the project). */
export type TeambitionTaskMoveAck = Record<string, never>

/** Transport failure: the route was unreachable or answered a non-envelope body. */
const TRANSPORT_ERROR: TeambitionApiError = { code: 'transport', message: 'teambition route unavailable' }

/**
 * POST one JSON payload to a document-relative route and decode the envelope.
 * @param route - route path from `TEAMBITION_ROUTES` (no leading slash).
 * @param body - request payload; serialized as JSON (defaults to an empty object).
 * @returns the decoded value, or a transport/host failure; never throws.
 */
export async function post<T = unknown>(route: string, body: unknown = {}): Promise<TeambitionApiResult<T>> {
  let response: Response
  try {
    response = await fetch(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
  } catch {
    return { ok: false, error: TRANSPORT_ERROR }
  }
  try {
    const envelope = await response.json() as unknown
    if (typeof envelope !== 'object' || envelope === null) return { ok: false, error: TRANSPORT_ERROR }
    const record = envelope as Record<string, unknown>
    if (record.ok === true) return { ok: true, value: record.value as T }
    const failure = record.error
    if (typeof failure === 'object' && failure !== null) {
      const details = failure as { code?: unknown; message?: unknown }
      const message = typeof details.message === 'string' && details.message !== '' ? details.message : TRANSPORT_ERROR.message
      const code = typeof details.code === 'string' ? details.code : undefined
      return { ok: false, error: code === undefined ? { message } : { code, message } }
    }
    return { ok: false, error: TRANSPORT_ERROR }
  } catch {
    return { ok: false, error: TRANSPORT_ERROR }
  }
}

/** The typed route surface the panel drives; a fake implements it in tests. */
export interface TeambitionApiFace {
  /** Panel snapshot: settings view + joined project list + last diagnostics. */
  fetchState(): Promise<TeambitionApiResult<TeambitionStateView>>
  /** Update settings; absent fields keep their stored value. */
  saveConfig(request: TeambitionConfigRequest): Promise<TeambitionApiResult<TeambitionStateView>>
  /** Probe the stored cookie against the candidate endpoints. */
  diagnose(): Promise<TeambitionApiResult<TeambitionDiagnoseView>>
  /** Refresh the joined project list from Teambition. */
  refreshProjects(): Promise<TeambitionApiResult<TeambitionProjectsView>>
  /** One project: stages, workflow statuses, resolved cards; one task list when given. */
  fetchProject(projectId: string, tasklistId?: string): Promise<TeambitionApiResult<TeambitionProjectDetail>>
  /** Create a card in a project. */
  createTask(request: TeambitionTaskCreateRequest): Promise<TeambitionApiResult<TeambitionTaskCreateView>>
  /** Move a card to another workflow status. */
  setTaskStatus(request: TeambitionTaskStatusRequest): Promise<TeambitionApiResult<TeambitionTaskMoveAck>>
  /** Move a card to another kanban column (stage). */
  setTaskStage(request: TeambitionTaskStageRequest): Promise<TeambitionApiResult<TeambitionTaskMoveAck>>
  /** Persist per-card / per-project workspace bindings. */
  saveBindings(request: TeambitionBindRequest): Promise<TeambitionApiResult<TeambitionStateView>>
}

/** HTTP implementation of {@link TeambitionApiFace}. */
export class TeambitionApi implements TeambitionApiFace {
  fetchState(): Promise<TeambitionApiResult<TeambitionStateView>> {
    return post<TeambitionStateView>(TEAMBITION_ROUTES.state, {})
  }

  saveConfig(request: TeambitionConfigRequest): Promise<TeambitionApiResult<TeambitionStateView>> {
    return post<TeambitionStateView>(TEAMBITION_ROUTES.config, request)
  }

  diagnose(): Promise<TeambitionApiResult<TeambitionDiagnoseView>> {
    return post<TeambitionDiagnoseView>(TEAMBITION_ROUTES.diagnose, {})
  }

  refreshProjects(): Promise<TeambitionApiResult<TeambitionProjectsView>> {
    return post<TeambitionProjectsView>(TEAMBITION_ROUTES.projects, {})
  }

  fetchProject(projectId: string, tasklistId?: string): Promise<TeambitionApiResult<TeambitionProjectDetail>> {
    return post<TeambitionProjectDetail>(TEAMBITION_ROUTES.project, {
      projectId,
      ...(tasklistId === undefined ? {} : { tasklistId }),
    })
  }

  createTask(request: TeambitionTaskCreateRequest): Promise<TeambitionApiResult<TeambitionTaskCreateView>> {
    return post<TeambitionTaskCreateView>(TEAMBITION_ROUTES.taskCreate, request)
  }

  setTaskStatus(request: TeambitionTaskStatusRequest): Promise<TeambitionApiResult<TeambitionTaskMoveAck>> {
    return post<TeambitionTaskMoveAck>(TEAMBITION_ROUTES.taskStatus, request)
  }

  setTaskStage(request: TeambitionTaskStageRequest): Promise<TeambitionApiResult<TeambitionTaskMoveAck>> {
    return post<TeambitionTaskMoveAck>(TEAMBITION_ROUTES.taskStage, request)
  }

  saveBindings(request: TeambitionBindRequest): Promise<TeambitionApiResult<TeambitionStateView>> {
    return post<TeambitionStateView>(TEAMBITION_ROUTES.bind, request)
  }
}
