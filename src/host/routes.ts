/**
 * /teambition/* route layer: one JSON envelope per call, loopback-only.
 *
 * The browser half posts document-relative route names from
 * `core/protocol.ts`; this layer validates their shape, calls the service, and
 * answers `{ ok: true, value }` or `{ ok: false, error: { code, message } }`.
 * It owns HTTP shape and the trust fence only: no Teambition vocabulary leaks
 * here, and an unexpected rejection still becomes an envelope instead of an
 * unhandled rejection.
 *
 * @module dsh-teambition/host/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  TEAMBITION_ROUTE_PREFIX,
  TEAMBITION_ROUTES,
  type TeambitionBindRequest,
  type TeambitionCardBinding,
  type TeambitionConfigRequest,
  type TeambitionProjectBinding,
} from '../core/protocol.ts'
import type { TeambitionBase } from '../core/teambition/index.ts'
import { asJsonObject, readJsonBody, writeJson } from './http.ts'
import {
  fail,
  ok,
  TeambitionHostError,
  type TeambitionEnvelope,
  type TeambitionService,
} from './service.ts'

/** Body cap of every route: enough for a cookie plus the binding tables. */
const MAX_BODY_BYTES = 1024 * 1024

/** Absolute paths of the panel routes (the route table is document-relative). */
const ROUTES = {
  state: `/${TEAMBITION_ROUTES.state}`,
  config: `/${TEAMBITION_ROUTES.config}`,
  diagnose: `/${TEAMBITION_ROUTES.diagnose}`,
  projects: `/${TEAMBITION_ROUTES.projects}`,
  project: `/${TEAMBITION_ROUTES.project}`,
  taskCreate: `/${TEAMBITION_ROUTES.taskCreate}`,
  taskStatus: `/${TEAMBITION_ROUTES.taskStatus}`,
  taskStage: `/${TEAMBITION_ROUTES.taskStage}`,
  bind: `/${TEAMBITION_ROUTES.bind}`,
} as const

/** Addresses the loopback trust fence accepts. */
const LOOPBACK_ADDRESSES: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** A structurally invalid request body; answered as `invalid-request`. */
class InvalidRequest extends Error {}

/** One dispatch result: HTTP status plus envelope. */
interface RouteOutcome {
  readonly status: number
  readonly body: TeambitionEnvelope
}

/** Message of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Whether the request arrived over the loopback interface. A missing address
 * (in-process client, some proxies) is treated as loopback: the route is
 * additionally reachable only through the same-origin GUI.
 */
function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress
  return address === undefined || LOOPBACK_ADDRESSES.has(address)
}

/** The request body must be a JSON object (empty bodies are not). */
function requireObject(payload: unknown): Record<string, unknown> {
  const record = asJsonObject(payload)
  if (record === undefined) throw new InvalidRequest('expected a JSON object')
  return record
}

/** Required non-empty string member. */
function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidRequest(`${key} must be a non-empty string`)
  }
  return value.trim()
}

/** Optional string member; blank values are dropped. */
function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new InvalidRequest(`${key} must be a string`)
  const text = value.trim()
  return text === '' ? undefined : text
}

/** Optional boolean member. */
function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new InvalidRequest(`${key} must be a boolean`)
  return value
}

/** Optional string-or-null member; an explicit null clears the value. */
function optionalNullableString(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') throw new InvalidRequest(`${key} must be a string or null`)
  const text = value.trim()
  return text === '' ? null : text
}

/** Optional host selector. */
function optionalApiBase(record: Record<string, unknown>): TeambitionBase | undefined {
  const value = record.apiBase
  if (value === undefined) return undefined
  if (value !== 'api' && value !== 'web') throw new InvalidRequest("apiBase must be 'api' or 'web'")
  return value
}

/** One validated binding row. */
interface BindingRow {
  readonly id: string
  readonly workspaceId: string
}

/** Optional binding table: an array of objects carrying the id and a workspace. */
function optionalBindingRows(
  record: Record<string, unknown>,
  key: string,
  idKey: 'projectId' | 'taskId',
): readonly BindingRow[] | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new InvalidRequest(`${key} must be an array`)
  const rows: BindingRow[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      throw new InvalidRequest(`${key} entries must be objects`)
    }
    const item = entry as Record<string, unknown>
    const id = requiredString(item, idKey)
    const workspaceId = requiredString(item, 'workspaceId')
    rows.push({ id, workspaceId })
  }
  return rows
}

/** Read a `teambition/config` request. */
function readConfigRequest(payload: unknown): TeambitionConfigRequest {
  const record = requireObject(payload)
  const cookie = optionalString(record, 'cookie')
  const clearCookie = optionalBoolean(record, 'clearCookie')
  const operatorId = optionalString(record, 'operatorId')
  const clearOperatorId = optionalBoolean(record, 'clearOperatorId')
  const apiBase = optionalApiBase(record)
  const defaultWorkspaceId = optionalNullableString(record, 'defaultWorkspaceId')
  const projectRows = optionalBindingRows(record, 'projectBindings', 'projectId')
  const cardRows = optionalBindingRows(record, 'cardBindings', 'taskId')
  const projectBindings: readonly TeambitionProjectBinding[] | undefined = projectRows?.map(row => ({
    projectId: row.id,
    workspaceId: row.workspaceId,
  }))
  const cardBindings: readonly TeambitionCardBinding[] | undefined = cardRows?.map(row => ({
    taskId: row.id,
    workspaceId: row.workspaceId,
  }))
  return {
    ...(cookie === undefined ? {} : { cookie }),
    ...(clearCookie === undefined ? {} : { clearCookie }),
    ...(operatorId === undefined ? {} : { operatorId }),
    ...(clearOperatorId === undefined ? {} : { clearOperatorId }),
    ...(apiBase === undefined ? {} : { apiBase }),
    ...(defaultWorkspaceId === undefined ? {} : { defaultWorkspaceId }),
    ...(projectBindings === undefined ? {} : { projectBindings }),
    ...(cardBindings === undefined ? {} : { cardBindings }),
  }
}

/** Read a `teambition/bind` request. */
function readBindRequest(payload: unknown): TeambitionBindRequest {
  const record = requireObject(payload)
  const defaultWorkspaceId = optionalNullableString(record, 'defaultWorkspaceId')
  const projectRows = optionalBindingRows(record, 'projectBindings', 'projectId')
  const cardRows = optionalBindingRows(record, 'cardBindings', 'taskId')
  const projectBindings: readonly TeambitionProjectBinding[] | undefined = projectRows?.map(row => ({
    projectId: row.id,
    workspaceId: row.workspaceId,
  }))
  const cardBindings: readonly TeambitionCardBinding[] | undefined = cardRows?.map(row => ({
    taskId: row.id,
    workspaceId: row.workspaceId,
  }))
  return {
    ...(defaultWorkspaceId === undefined ? {} : { defaultWorkspaceId }),
    ...(projectBindings === undefined ? {} : { projectBindings }),
    ...(cardBindings === undefined ? {} : { cardBindings }),
  }
}

/**
 * Register the `/teambition` prefix route.
 * @param ctx - context carrying the webServer service.
 * @param service - the Teambition host service.
 * @returns the route disposer.
 */
export function registerTeambitionRoutes(ctx: Context, service: TeambitionService): () => void {
  const valid = (value: unknown): RouteOutcome => ({ status: 200, body: ok(value) })

  const dispatch = async (pathname: string, payload: unknown): Promise<RouteOutcome | undefined> => {
    try {
      switch (pathname) {
        case ROUTES.state:
          return valid(await service.stateView())
        case ROUTES.config:
          return valid(await service.updateConfig(readConfigRequest(payload)))
        case ROUTES.diagnose:
          return valid(await service.diagnose())
        case ROUTES.projects:
          return valid(await service.listProjects())
        case ROUTES.project: {
          const record = requireObject(payload)
          const projectId = requiredString(record, 'projectId')
          const tasklistId = optionalString(record, 'tasklistId')
          return valid(await service.projectDetail({
            projectId,
            ...(tasklistId === undefined ? {} : { tasklistId }),
          }))
        }
        case ROUTES.taskCreate: {
          const record = requireObject(payload)
          const projectId = requiredString(record, 'projectId')
          const title = requiredString(record, 'title')
          const note = optionalString(record, 'note')
          const tasklistId = optionalString(record, 'tasklistId')
          const stageId = optionalString(record, 'stageId')
          const statusId = optionalString(record, 'statusId')
          const executorId = optionalString(record, 'executorId')
          return valid(await service.createTask({
            projectId,
            title,
            ...(note === undefined ? {} : { note }),
            ...(tasklistId === undefined ? {} : { tasklistId }),
            ...(stageId === undefined ? {} : { stageId }),
            ...(statusId === undefined ? {} : { statusId }),
            ...(executorId === undefined ? {} : { executorId }),
          }))
        }
        case ROUTES.taskStatus: {
          const record = requireObject(payload)
          return valid(await service.setStatus({
            taskId: requiredString(record, 'taskId'),
            statusId: requiredString(record, 'statusId'),
          }))
        }
        case ROUTES.taskStage: {
          const record = requireObject(payload)
          return valid(await service.setStage({
            taskId: requiredString(record, 'taskId'),
            stageId: requiredString(record, 'stageId'),
          }))
        }
        case ROUTES.bind:
          return valid(await service.bind(readBindRequest(payload)))
        default:
          return undefined
      }
    } catch (error) {
      if (error instanceof InvalidRequest) return { status: 200, body: fail('invalid-request', error.message) }
      if (error instanceof TeambitionHostError) return { status: 200, body: fail(error.code, error.message) }
      return { status: 200, body: fail('failed', messageOf(error)) }
    }
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      // Trust fence first: never let a non-loopback client reach any operation.
      if (!isLoopback(req)) {
        writeJson(res, 403, fail('forbidden', 'loopback only'))
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, fail('method-not-allowed', 'POST only'))
        return
      }
      // CSRF hardening: cross-site forms cannot set application/json without a
      // CORS preflight, which the same-origin panel never bypasses.
      const contentType = req.headers['content-type'] ?? ''
      if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
        writeJson(res, 415, fail('unsupported-media-type', 'application/json required'))
        return
      }
      const declared = Number(req.headers['content-length'] ?? '0')
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        writeJson(res, 413, fail('body-too-large', 'request body exceeds 1 MiB'))
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      const payload = await readJsonBody(req, { maxBytes: MAX_BODY_BYTES })
      const result = await dispatch(pathname, payload)
      if (result === undefined) {
        writeJson(res, 404, fail('not-found', 'unknown route'))
        return
      }
      writeJson(res, result.status, result.body)
    } catch (error) {
      writeJson(res, 500, fail('failed', messageOf(error)))
    }
  }

  const dispose = ctx.webServer.register({ kind: 'prefix', path: TEAMBITION_ROUTE_PREFIX, handler })
  return () => { dispose() }
}
