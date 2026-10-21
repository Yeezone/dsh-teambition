/**
 * Route layer: envelope shape, method/content-type guards, loopback fence and
 * bind persistence through a real service.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { registerTeambitionRoutes } from '../src/host/routes.ts'
import {
  TeambitionHostError,
  createTeambitionService,
  type TeambitionService,
} from '../src/host/service.ts'
import { TeambitionConfigStore, type TeambitionHostState } from '../src/host/config-store.ts'
import { TEAMBITION_ROUTE_PREFIX } from '../src/core/protocol.ts'

interface RegisteredRoute {
  readonly kind: string
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
}

interface Harness {
  readonly route: RegisteredRoute
  readonly dispose: () => void
  readonly isDisposed: () => boolean
}

/** Register the routes against a fake webServer and capture the handler. */
function harness(service: TeambitionService): Harness {
  let disposed = false
  const routes: RegisteredRoute[] = []
  const ctx = {
    webServer: {
      register(route: RegisteredRoute) {
        routes.push(route)
        return () => { disposed = true }
      },
    },
  } as unknown as Context
  const dispose = registerTeambitionRoutes(ctx, service)
  const route = routes[0]
  if (route === undefined) throw new Error('route was not registered')
  return { route, dispose, isDisposed: () => disposed }
}

interface CallOptions {
  readonly method?: string
  readonly path: string
  readonly contentType?: string | null
  readonly body?: string
  readonly remoteAddress?: string | null
  readonly contentLength?: number
}

interface Captured {
  readonly status: number
  readonly headers: Record<string, unknown>
  readonly body: unknown
}

/** Drive the captured handler with a synthetic request/response pair. */
async function call(handler: Harness['route']['handler'], options: CallOptions): Promise<Captured> {
  const headers: Record<string, string> = {}
  if (options.contentType !== null) headers['content-type'] = options.contentType ?? 'application/json'
  const bytes = options.body === undefined ? 0 : Buffer.byteLength(options.body)
  headers['content-length'] = String(options.contentLength ?? bytes)
  const req = Object.assign(Readable.from(options.body === undefined ? [] : [Buffer.from(options.body)]), {
    method: options.method ?? 'POST',
    url: options.path,
    headers,
    socket: { remoteAddress: options.remoteAddress === null ? undefined : (options.remoteAddress ?? '127.0.0.1') },
  }) as unknown as IncomingMessage
  const captured: { status: number; headers: Record<string, unknown>; body: unknown } = { status: 0, headers: {}, body: undefined }
  const res = {
    writeHead(status: number, responseHeaders: Record<string, unknown>) {
      captured.status = status
      captured.headers = responseHeaders
    },
    end(chunk?: unknown) {
      captured.body = chunk === undefined ? undefined : JSON.parse(String(chunk)) as unknown
    },
  } as unknown as ServerResponse
  await handler(req, res)
  return captured
}

const EMPTY_VIEW = {
  settings: {
    configured: false,
    apiBase: 'api' as const,
    operatorIdConfigured: false,
    projectBindings: [],
    cardBindings: [],
  },
  projects: [],
}

/** Envelope narrowing for assertions. */
function envelope(body: unknown): { ok: boolean; value?: unknown; error?: { code: string; message: string } } {
  if (typeof body !== 'object' || body === null) throw new Error('response body is not an object')
  return body as { ok: boolean; value?: unknown; error?: { code: string; message: string } }
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-teambition-routes-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('route registration', () => {
  it('registers one POST prefix route under /teambition and disposes it', () => {
    const test = harness({ stateView: async () => EMPTY_VIEW } as unknown as TeambitionService)
    expect(test.route.kind).toBe('prefix')
    expect(test.route.path).toBe(TEAMBITION_ROUTE_PREFIX)
    expect(test.isDisposed()).toBe(false)
    test.dispose()
    expect(test.isDisposed()).toBe(true)
  })
})

describe('guards', () => {
  it('rejects non-POST methods with 405', async () => {
    const test = harness({ stateView: async () => EMPTY_VIEW } as unknown as TeambitionService)
    const response = await call(test.route.handler, { method: 'GET', path: '/teambition/state', contentType: null })
    expect(response.status).toBe(405)
    expect(envelope(response.body).error?.code).toBe('method-not-allowed')
  })

  it('rejects a non-JSON content type with 415', async () => {
    const test = harness({ stateView: async () => EMPTY_VIEW } as unknown as TeambitionService)
    const response = await call(test.route.handler, { path: '/teambition/state', contentType: 'text/plain', body: '{}' })
    expect(response.status).toBe(415)
    expect(envelope(response.body).error?.code).toBe('unsupported-media-type')
  })

  it('rejects a missing content type with 415', async () => {
    const test = harness({ stateView: async () => EMPTY_VIEW } as unknown as TeambitionService)
    const response = await call(test.route.handler, { path: '/teambition/state', contentType: null, body: '{}' })
    expect(response.status).toBe(415)
  })

  it('rejects a declared body above 1 MiB with 413', async () => {
    const test = harness({ stateView: async () => EMPTY_VIEW } as unknown as TeambitionService)
    const response = await call(test.route.handler, { path: '/teambition/state', body: '{}', contentLength: 1024 * 1024 + 1 })
    expect(response.status).toBe(413)
    expect(envelope(response.body).error?.code).toBe('body-too-large')
  })

  it('rejects non-loopback peers with 403', async () => {
    const test = harness({ stateView: async () => EMPTY_VIEW } as unknown as TeambitionService)
    const response = await call(test.route.handler, { path: '/teambition/state', body: '{}', remoteAddress: '10.1.2.3' })
    expect(response.status).toBe(403)
    expect(envelope(response.body).error?.code).toBe('forbidden')
  })

  it('accepts a missing peer address and mixes in JSON response headers', async () => {
    const test = harness({ stateView: async () => EMPTY_VIEW } as unknown as TeambitionService)
    const response = await call(test.route.handler, { path: '/teambition/state', body: '{}', remoteAddress: null })
    expect(response.status).toBe(200)
    expect(String(response.headers['content-type'])).toContain('application/json')
  })

  it('answers unknown paths with 404', async () => {
    const test = harness({ stateView: async () => EMPTY_VIEW } as unknown as TeambitionService)
    const response = await call(test.route.handler, { path: '/teambition/nope', body: '{}' })
    expect(response.status).toBe(404)
    expect(envelope(response.body).error?.code).toBe('not-found')
  })
})

describe('dispatch', () => {
  it('wraps values in the success envelope', async () => {
    const test = harness({ stateView: async () => EMPTY_VIEW } as unknown as TeambitionService)
    const response = await call(test.route.handler, { path: '/teambition/state', body: '{}' })
    expect(response.status).toBe(200)
    const body = envelope(response.body)
    expect(body.ok).toBe(true)
    expect(body.value).toEqual(EMPTY_VIEW)
  })

  it('rejects a missing projectId with invalid-request', async () => {
    const test = harness({ projectDetail: async () => ({ project: { id: 'p', name: 'p' }, tasklists: [], stages: [], statuses: [], cards: [] }) } as unknown as TeambitionService)
    const response = await call(test.route.handler, { path: '/teambition/project', body: '{}' })
    expect(response.status).toBe(200)
    expect(envelope(response.body)).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
  })

  it('forwards the selected task list to the project detail', async () => {
    const requests: unknown[] = []
    const test = harness({
      projectDetail: async (request: unknown) => {
        requests.push(request)
        return { project: { id: 'p', name: 'p' }, tasklists: [], stages: [], statuses: [], cards: [] }
      },
    } as unknown as TeambitionService)
    const response = await call(test.route.handler, { path: '/teambition/project', body: '{"projectId":"p1","tasklistId":"tl2"}' })
    expect(envelope(response.body).ok).toBe(true)
    expect(requests).toEqual([{ projectId: 'p1', tasklistId: 'tl2' }])
  })

  it('rejects a non-string tasklistId with invalid-request', async () => {
    const test = harness({
      projectDetail: async () => { throw new Error('the service must not be called') },
    } as unknown as TeambitionService)
    const response = await call(test.route.handler, { path: '/teambition/project', body: '{"projectId":"p1","tasklistId":42}' })
    expect(response.status).toBe(200)
    expect(envelope(response.body)).toMatchObject({ ok: false, error: { code: 'invalid-request', message: 'tasklistId must be a string' } })
  })

  it('forwards the selected task list to create-task', async () => {
    const requests: unknown[] = []
    const test = harness({
      createTask: async (request: unknown) => {
        requests.push(request)
        return { taskId: 't-new' }
      },
    } as unknown as TeambitionService)
    const response = await call(test.route.handler, {
      path: '/teambition/task/create',
      body: '{"projectId":"p1","title":"New","tasklistId":"tl2"}',
    })
    expect(envelope(response.body)).toMatchObject({ ok: true, value: { taskId: 't-new' } })
    expect(requests).toEqual([{ projectId: 'p1', title: 'New', tasklistId: 'tl2' }])
  })

  it('rejects a non-object body with invalid-request', async () => {
    const test = harness({ updateConfig: async () => EMPTY_VIEW } as unknown as TeambitionService)
    const response = await call(test.route.handler, { path: '/teambition/config', body: '[]' })
    expect(envelope(response.body)).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
  })

  it('turns a host error into a failure envelope instead of a throw', async () => {
    const test = harness({
      updateConfig: async () => { throw new TeambitionHostError('failed', 'boom') },
    } as unknown as TeambitionService)
    const response = await call(test.route.handler, { path: '/teambition/config', body: '{"cookie":"SESS=x"}' })
    expect(response.status).toBe(200)
    expect(envelope(response.body)).toMatchObject({ ok: false, error: { code: 'failed', message: 'boom' } })
  })

  it('turns an unexpected rejection into a failed envelope', async () => {
    const test = harness({
      listProjects: async () => { throw new Error('unexpected') },
    } as unknown as TeambitionService)
    const response = await call(test.route.handler, { path: '/teambition/projects', body: '{}' })
    expect(envelope(response.body).error?.code).toBe('failed')
  })
})

describe('real service through the routes', () => {
  it('masks the cookie in the config response', async () => {
    const store = new TeambitionConfigStore({ env: { DSH_HOME: root }, home: root })
    const service = createTeambitionService(store, { now: () => 1 })
    const test = harness(service)
    const response = await call(test.route.handler, { path: '/teambition/config', body: '{"cookie":"SESS=abcdef123456"}' })
    const body = envelope(response.body)
    expect(body.ok).toBe(true)
    expect(JSON.stringify(body.value)).not.toContain('abcdef')
    expect((body.value as { settings: { cookieTail?: string } }).settings.cookieTail).toBe('3456')
  })

  it('persists bind requests to the config file', async () => {
    const store = new TeambitionConfigStore({ env: { DSH_HOME: root }, home: root })
    const test = harness(createTeambitionService(store, { now: () => 1 }))
    const response = await call(test.route.handler, {
      path: '/teambition/bind',
      body: JSON.stringify({
        defaultWorkspaceId: 'ws-default',
        projectBindings: [{ projectId: 'p1', workspaceId: 'w1' }],
        cardBindings: [{ taskId: 't1', workspaceId: 'w2' }],
      }),
    })
    expect(envelope(response.body).ok).toBe(true)
    const raw = JSON.parse(await readFile(join(root, 'teambition', 'config.json'), 'utf8')) as TeambitionHostState
    expect(raw.settings.defaultWorkspaceId).toBe('ws-default')
    expect(raw.settings.projectBindings).toEqual([{ projectId: 'p1', workspaceId: 'w1' }])
    expect(raw.settings.cardBindings).toEqual([{ taskId: 't1', workspaceId: 'w2' }])
  })
})
