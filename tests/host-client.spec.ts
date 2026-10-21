/**
 * The wire client: task-list parsing, stage task-list attribution and the
 * legacy create payload that requires a `_tasklistId`.
 */
import { describe, expect, it } from 'vitest'
import { TeambitionClient } from '../src/host/client.ts'
import type {
  TeambitionHttpRequest,
  TeambitionHttpResponse,
  TeambitionTransport,
} from '../src/host/transport.ts'

interface Route {
  readonly method?: TeambitionHttpRequest['method']
  readonly url: string | RegExp
  readonly status?: number
  readonly body: unknown
}

interface FakeTransport {
  readonly transport: TeambitionTransport
  readonly requests: TeambitionHttpRequest[]
}

/** Whether one recorded request matches a route. */
function matches(url: string | RegExp, actual: string): boolean {
  return typeof url === 'string' ? url === actual : url.test(actual)
}

/** Transport answering from a route table and recording every request. */
function fakeTransport(routes: readonly Route[]): FakeTransport {
  const requests: TeambitionHttpRequest[] = []
  const transport: TeambitionTransport = {
    async request(request) {
      requests.push(request)
      const route = routes.find(candidate =>
        (candidate.method === undefined || candidate.method === request.method) && matches(candidate.url, request.url))
      if (route === undefined) throw new Error(`unexpected request ${request.method} ${request.url}`)
      const response: TeambitionHttpResponse = {
        status: route.status ?? 200,
        contentType: 'application/json',
        body: JSON.stringify(route.body),
      }
      return response
    },
  }
  return { transport, requests }
}

const TASKLIST_URL = 'https://www.teambition.com/api/projects/p1/tasklists'
const STAGES_URL = /^https:\/\/www\.teambition\.com\/api\/projects\/p1\/stages/
const LEGACY_CREATE_URL = 'https://www.teambition.com/api/tasks'
const V3_CREATE_URL = 'https://api.teambition.com/v3/task/create'

/** Client bound to a fake transport on the www proxy host. */
function webClient(transport: TeambitionTransport): TeambitionClient {
  return new TeambitionClient({ cookie: 'SESS=secret', apiBase: 'web', transport })
}

/** Parse one recorded request body. */
function bodyOf(request: TeambitionHttpRequest | undefined): Record<string, string> {
  if (request?.body === undefined) throw new Error('request carried no body')
  return JSON.parse(request.body) as Record<string, string>
}

describe('projectTasklists', () => {
  it('parses the legacy task-list collection', async () => {
    const fake = fakeTransport([{
      url: TASKLIST_URL,
      body: [{ _id: 'tl1', title: 'List One' }, { _id: 'tl2', title: '  List Two  ' }],
    }])
    await expect(webClient(fake.transport).projectTasklists('p1')).resolves.toEqual([
      { id: 'tl1', name: 'List One' },
      { id: 'tl2', name: 'List Two' },
    ])
  })

  it('returns no task lists when the project route does not answer', async () => {
    const fake = fakeTransport([{ url: TASKLIST_URL, status: 404, body: { code: 'NotFound', message: 'nope' } }])
    await expect(webClient(fake.transport).projectTasklists('p1')).resolves.toEqual([])
  })

  it('propagates a refused cookie instead of hiding it', async () => {
    const fake = fakeTransport([{ url: TASKLIST_URL, status: 401, body: { code: 'InvalidCookie', message: 'expired' } }])
    await expect(webClient(fake.transport).projectTasklists('p1')).rejects.toMatchObject({ failure: 'invalid-cookie' })
  })
})

describe('projectStages', () => {
  it('attributes every column to its task list', async () => {
    const fake = fakeTransport([{
      url: STAGES_URL,
      body: [
        { _id: 's1', title: 'Todo', _tasklistId: 'tl1', pos: 0 },
        { _id: 's2', title: 'Doing', tasklistId: 'tl2', pos: 1 },
      ],
    }])
    await expect(webClient(fake.transport).projectStages('p1')).resolves.toEqual([
      { id: 's1', name: 'Todo', tasklistId: 'tl1', pos: 0 },
      { id: 's2', name: 'Doing', tasklistId: 'tl2', pos: 1 },
    ])
  })
})

describe('createTask', () => {
  it('sends the selected task list on the legacy route without a lookup', async () => {
    const fake = fakeTransport([{ method: 'POST', url: LEGACY_CREATE_URL, body: { _id: 't-new' } }])
    const result = await webClient(fake.transport).createTask({
      projectId: 'p1',
      title: 'New card',
      tasklistId: 'tl2',
      stageId: 's2',
    })
    expect(result.taskId).toBe('t-new')
    expect(fake.requests).toHaveLength(1)
    expect(bodyOf(fake.requests[0])).toEqual({
      _projectId: 'p1',
      _tasklistId: 'tl2',
      content: 'New card',
      _stageId: 's2',
    })
  })

  it('falls back to the first task list of the project on the legacy route', async () => {
    const fake = fakeTransport([
      { method: 'GET', url: TASKLIST_URL, body: [{ _id: 'tl1', title: 'List One' }] },
      { method: 'POST', url: LEGACY_CREATE_URL, body: { _id: 't-new' } },
    ])
    await webClient(fake.transport).createTask({ projectId: 'p1', title: 'New card' })
    expect(bodyOf(fake.requests.at(-1))).toEqual({ _projectId: 'p1', _tasklistId: 'tl1', content: 'New card' })
  })

  it('carries the selected task list on the v3 route', async () => {
    const fake = fakeTransport([{ method: 'POST', url: V3_CREATE_URL, body: { id: 't-new' } }])
    const client = new TeambitionClient({ cookie: 'SESS=secret', apiBase: 'api', transport: fake.transport })
    await client.createTask({ projectId: 'p1', title: 'New card', tasklistId: 'tl2' })
    expect(bodyOf(fake.requests[0])).toEqual({ content: 'New card', projectId: 'p1', tasklistId: 'tl2' })
  })
})
