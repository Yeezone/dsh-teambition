/**
 * Route client contract: document-relative paths, the JSON envelope decode and
 * the never-throw failure policy. `fetch` is stubbed, so the suite runs without
 * a host and pins the exact routes the browser half calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TeambitionApi, post } from '../src/client/api.ts'
import { TEAMBITION_ROUTES } from '../src/core/protocol.ts'

/** One recorded `fetch` invocation. */
interface StubCall {
  route: string
  init: RequestInit
}

let calls: StubCall[] = []
let responder: () => Promise<unknown>

/** Install a fetch stub whose body is produced by {@link responder}. */
function stubFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (route: string, init: RequestInit) => {
    calls.push({ route, init })
    const payload = await responder()
    return { json: async () => payload } as unknown as Response
  }))
}

beforeEach(() => {
  calls = []
  responder = async () => ({ ok: true, value: { decoded: true } })
  stubFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('post', () => {
  it('posts to a document-relative route with a JSON body', async () => {
    const result = await post('teambition/state', { projectId: 'p1' })
    expect(result).toEqual({ ok: true, value: { decoded: true } })
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call.route).toBe('teambition/state')
    expect(call.route.startsWith('/')).toBe(false)
    expect(call.route.startsWith('http')).toBe(false)
    expect(call.init.method).toBe('POST')
    expect(call.init.headers).toEqual({ 'content-type': 'application/json' })
    expect(call.init.body).toBe(JSON.stringify({ projectId: 'p1' }))
  })

  it('sends an empty object when the request body is absent', async () => {
    await post('teambition/state')
    expect(calls[0].init.body).toBe('{}')
  })

  it('decodes a host failure envelope with its code and message', async () => {
    responder = async () => ({ ok: false, error: { code: 'no-cookie', message: 'cookie is not configured' } })
    const result = await post('teambition/diagnose', {})
    expect(result).toEqual({ ok: false, error: { code: 'no-cookie', message: 'cookie is not configured' } })
  })

  it('keeps a failure message when the envelope carries no code', async () => {
    responder = async () => ({ ok: false, error: { message: 'boom' } })
    const result = await post('teambition/projects', {})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toBe('boom')
    expect(result.error.code).toBeUndefined()
  })

  it('reports a transport failure instead of throwing when fetch rejects', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('offline') })
    vi.stubGlobal('fetch', fetchMock)
    const result = await post('teambition/state', {})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('transport')
    expect(result.error.message).toContain('unavailable')
  })

  it('reports a transport failure on a non-JSON body', async () => {
    const fetchMock = vi.fn(async () => ({
      json: async () => { throw new Error('not json') },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await post('teambition/state', {})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('transport')
  })

  it('treats a body without the envelope as a transport failure', async () => {
    responder = async () => ({ settings: {}, projects: [] })
    const result = await post('teambition/state', {})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('transport')
  })
})

describe('TeambitionApi', () => {
  /** Route + body of the latest call. */
  function latest(): { route: string; body: unknown } {
    const call = calls[calls.length - 1]
    return { route: call.route, body: JSON.parse(String(call.init.body)) }
  }

  it('every declared route is document-relative', () => {
    for (const [name, route] of Object.entries(TEAMBITION_ROUTES)) {
      expect(route.startsWith('/'), name).toBe(false)
      expect(route.startsWith('http'), name).toBe(false)
    }
  })

  it('routes every typed wrapper to its contract route', async () => {
    const api = new TeambitionApi()
    await api.fetchState()
    expect(latest()).toEqual({ route: 'teambition/state', body: {} })

    await api.refreshProjects()
    expect(latest()).toEqual({ route: 'teambition/projects', body: {} })

    await api.diagnose()
    expect(latest()).toEqual({ route: 'teambition/diagnose', body: {} })

    await api.saveConfig({ cookie: 'a=b', apiBase: 'web' })
    expect(latest()).toEqual({ route: 'teambition/config', body: { cookie: 'a=b', apiBase: 'web' } })

    await api.fetchProject('p1')
    expect(latest()).toEqual({ route: 'teambition/project', body: { projectId: 'p1' } })

    // A selected task list narrows the board read; "all task lists" omits the field.
    await api.fetchProject('p1', 'l1')
    expect(latest()).toEqual({ route: 'teambition/project', body: { projectId: 'p1', tasklistId: 'l1' } })

    await api.createTask({ projectId: 'p1', title: '接入登录接口', stageId: 's1' })
    expect(latest()).toEqual({ route: 'teambition/task/create', body: { projectId: 'p1', title: '接入登录接口', stageId: 's1' } })

    await api.createTask({ projectId: 'p1', title: '灰度发布', tasklistId: 'l1', stageId: 's1' })
    expect(latest()).toEqual({
      route: 'teambition/task/create',
      body: { projectId: 'p1', title: '灰度发布', tasklistId: 'l1', stageId: 's1' },
    })

    await api.setTaskStatus({ taskId: 't1', statusId: 'st2' })
    expect(latest()).toEqual({ route: 'teambition/task/status', body: { taskId: 't1', statusId: 'st2' } })

    await api.setTaskStage({ taskId: 't1', stageId: 's2' })
    expect(latest()).toEqual({ route: 'teambition/task/stage', body: { taskId: 't1', stageId: 's2' } })

    await api.saveBindings({ cardBindings: [{ taskId: 't1', workspaceId: 'ws-1' }], defaultWorkspaceId: null })
    expect(latest()).toEqual({
      route: 'teambition/bind',
      body: { cardBindings: [{ taskId: 't1', workspaceId: 'ws-1' }], defaultWorkspaceId: null },
    })
  })

  it('surfaces a host failure through the typed wrapper', async () => {
    responder = async () => ({ ok: false, error: { code: 'forbidden', message: 'cookie expired' } })
    const result = await new TeambitionApi().fetchProject('p1')
    expect(result).toEqual({ ok: false, error: { code: 'forbidden', message: 'cookie expired' } })
  })
})
