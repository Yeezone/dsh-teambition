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
const TASKFLOW_URL = 'https://www.teambition.com/api/projects/p1/taskflows?withTaskflowstatus=true&type=task'
const SCENARIO_CONFIG_URL = 'https://www.teambition.com/api/v2/projects/p1/scenariofieldconfigs?objectType=task&withTaskflowstatus=true&withCustomfields=true'
const VIEW_DEFAULT_URL = 'https://www.teambition.com/api/projects/p1/smartgroups/default?type=tasks'
const VIEW_LIST_URL = 'https://www.teambition.com/api/v2/projects/p1/smartgroups?pageSize=200&type=custom&labels=common&withGlobal=true'
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

describe('projectTasks', () => {
  it('unions the project collection with the task-list collections', async () => {
    const fake = fakeTransport([
      { url: 'https://www.teambition.com/api/projects/p1/tasks?pageSize=200', body: [] },
      { url: TASKLIST_URL, body: [{ _id: 'tl1', title: '任务' }] },
      {
        url: /^https:\/\/www\.teambition\.com\/api\/tasks\?_projectId=p1&_tasklistId=tl1&pageSize=200&page=1$/,
        body: [{ _id: 't1', content: 'Alpha' }, { _id: 't2', content: 'Beta' }],
      },
    ])
    const tasks = await webClient(fake.transport).projectTasks('p1')
    expect(tasks.map(task => task.id)).toEqual(['t1', 't2'])
    expect(tasks.map(task => task.title)).toEqual(['Alpha', 'Beta'])
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

describe('projectWorkflows', () => {
  it('parses workflows with their ordered statuses', async () => {
    const fake = fakeTransport([{
      url: TASKFLOW_URL,
      body: [{
        _id: 'wf1',
        name: 'Default workflow',
        statuses: [
          { _id: 'st1', name: 'Doing', kind: 'start', pos: 0 },
          { _id: 'st2', name: 'Done', kind: 'end', pos: 1 },
        ],
      }],
    }])
    await expect(webClient(fake.transport).projectWorkflows('p1')).resolves.toEqual([
      {
        id: 'wf1',
        name: 'Default workflow',
        statuses: [
          { id: 'st1', name: 'Doing', kind: 'start', pos: 0 },
          { id: 'st2', name: 'Done', kind: 'end', pos: 1 },
        ],
      },
    ])
  })

  it('returns no workflows when the project route does not answer', async () => {
    const fake = fakeTransport([{ url: TASKFLOW_URL, status: 404, body: { code: 'NotFound', message: 'nope' } }])
    await expect(webClient(fake.transport).projectWorkflows('p1')).resolves.toEqual([])
  })
})

describe('projectScenarioConfigs', () => {
  it('parses task types with their workflow and status ids', async () => {
    const fake = fakeTransport([{
      url: SCENARIO_CONFIG_URL,
      body: [{ _id: 'sc1', name: 'Task', _taskflowId: 'wf1', _statusIds: ['st1', 'st2'] }],
    }])
    await expect(webClient(fake.transport).projectScenarioConfigs('p1')).resolves.toEqual([
      { id: 'sc1', name: 'Task', taskflowId: 'wf1', statusIds: ['st1', 'st2'] },
    ])
  })

  it('reads the statuses of the bound workflow instead of the raw id list', async () => {
    const fake = fakeTransport([{
      url: SCENARIO_CONFIG_URL,
      body: [{ _id: 'sc1', name: 'Task', _taskflowId: 'wf1', statuses: [{ _id: 'st3', name: 'Review', kind: 'start', pos: 0 }] }],
    }])
    await expect(webClient(fake.transport).projectScenarioConfigs('p1')).resolves.toEqual([
      { id: 'sc1', name: 'Task', taskflowId: 'wf1', statusIds: ['st3'] },
    ])
  })
})

describe('projectViews', () => {
  it('reads the default view and the saved view list, default first', async () => {
    const fake = fakeTransport([
      { url: VIEW_DEFAULT_URL, body: { projectDefaultSmartgroup: { _id: 'v-default', name: 'My tasks' } } },
      {
        url: VIEW_LIST_URL,
        body: {
          result: [
            { _id: 'v-stage', name: 'Stage board', view: { type: 'kanban', vertical: 'stage', _verticalIds: [] } },
            {
              _id: 'v-status',
              name: 'Status board',
              view: { type: 'kanban', vertical: 'scenarioConfigStatus', _verticalIds: ['sc1'] },
              filter: '_executorId = u1 ORDER BY created DESC',
              orderBy: 'created',
            },
          ],
        },
      },
    ])
    await expect(webClient(fake.transport).projectViews('p1')).resolves.toEqual([
      { id: 'v-default', name: 'My tasks', vertical: 'unknown', scenarioConfigIds: [], isDefault: true },
      { id: 'v-stage', name: 'Stage board', vertical: 'stage', scenarioConfigIds: [] },
      {
        id: 'v-status',
        name: 'Status board',
        vertical: 'status',
        scenarioConfigIds: ['sc1'],
        filter: '_executorId = u1 ORDER BY created DESC',
        orderBy: 'created',
      },
    ])
  })

  it('returns no views when the project has none', async () => {
    const fake = fakeTransport([
      { url: VIEW_DEFAULT_URL, body: { code: 'NotFound', message: 'nope' } },
      { url: VIEW_LIST_URL, status: 404, body: { code: 'NotFound', message: 'nope' } },
    ])
    await expect(webClient(fake.transport).projectViews('p1')).resolves.toEqual([])
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

  it('carries the workflow status and task type on the legacy route', async () => {
    const fake = fakeTransport([{ method: 'POST', url: LEGACY_CREATE_URL, body: { _id: 't-new' } }])
    const result = await webClient(fake.transport).createTask({
      projectId: 'p1',
      title: 'New card',
      tasklistId: 'tl2',
      statusId: 'st1',
      scenarioConfigId: 'sc1',
    })
    expect(result.taskId).toBe('t-new')
    expect(bodyOf(fake.requests[0])).toEqual({
      _projectId: 'p1',
      _tasklistId: 'tl2',
      content: 'New card',
      _taskflowstatusId: 'st1',
      _scenariofieldconfigId: 'sc1',
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

  it('carries the workflow status and task type on the v3 route', async () => {
    const fake = fakeTransport([{ method: 'POST', url: V3_CREATE_URL, body: { id: 't-new' } }])
    const client = new TeambitionClient({ cookie: 'SESS=secret', apiBase: 'api', transport: fake.transport })
    await client.createTask({ projectId: 'p1', title: 'New card', statusId: 'st1', scenarioConfigId: 'sc1' })
    expect(bodyOf(fake.requests[0])).toEqual({
      content: 'New card',
      projectId: 'p1',
      taskflowstatusId: 'st1',
      scenarioConfigId: 'sc1',
    })
  })

  it('infers the single task type of the project when creating into a workflow status', async () => {
    const fake = fakeTransport([
      { method: 'GET', url: SCENARIO_CONFIG_URL, body: [{ _id: 'sc1', name: 'Task', _taskflowId: 'wf1' }] },
      { method: 'POST', url: V3_CREATE_URL, body: { id: 't-new' } },
    ])
    const client = new TeambitionClient({ cookie: 'SESS=secret', apiBase: 'api', transport: fake.transport })
    await client.createTask({ projectId: 'p1', title: 'New card', statusId: 'st1' })
    expect(bodyOf(fake.requests.at(-1))).toEqual({
      content: 'New card',
      projectId: 'p1',
      taskflowstatusId: 'st1',
      scenarioConfigId: 'sc1',
    })
  })

  it('refuses to guess the task type when the status names none of them', async () => {
    const fake = fakeTransport([
      {
        method: 'GET',
        url: SCENARIO_CONFIG_URL,
        body: [
          { _id: 'sc1', name: 'Task', _taskflowId: 'wf1' },
          { _id: 'sc2', name: 'Bug', _taskflowId: 'wf1' },
        ],
      },
      {
        method: 'GET',
        url: TASKFLOW_URL,
        body: {
          result: [
            { _id: 'wf1', name: 'Default workflow', taskflowstatuses: [{ _id: 'st1', name: 'Todo' }] },
          ],
        },
      },
    ])
    const client = new TeambitionClient({ cookie: 'SESS=secret', apiBase: 'api', transport: fake.transport })
    await expect(client.createTask({ projectId: 'p1', title: 'New card', statusId: 'st-unknown' }))
      .rejects.toMatchObject({ failure: 'api', message: expect.stringMatching(/2 task types/) })
  })

  it('infers the task type whose workflow owns the target status', async () => {
    const fake = fakeTransport([
      {
        method: 'GET',
        url: SCENARIO_CONFIG_URL,
        body: [
          { _id: 'sc1', name: 'Task', _taskflowId: 'wf1' },
          { _id: 'sc2', name: 'Bug', _taskflowId: 'wf2' },
        ],
      },
      {
        method: 'GET',
        url: TASKFLOW_URL,
        body: {
          result: [
            { _id: 'wf1', name: 'Request workflow', taskflowstatuses: [{ _id: 'st1', name: 'Designing' }] },
            { _id: 'wf2', name: 'Bug workflow', taskflowstatuses: [{ _id: 'st2', name: 'Fixing' }] },
          ],
        },
      },
      { method: 'POST', url: V3_CREATE_URL, body: { id: 't-new' } },
    ])
    const client = new TeambitionClient({ cookie: 'SESS=secret', apiBase: 'api', transport: fake.transport })
    await client.createTask({ projectId: 'p1', title: 'New bug', statusId: 'st2' })
    expect(bodyOf(fake.requests.at(-1))).toMatchObject({ taskflowstatusId: 'st2', scenarioConfigId: 'sc2' })
  })
})

const TASK_DETAIL_URL = 'https://www.teambition.com/api/tasks/t1'
const TASK_SUBTASKS_V2_URL = /^https:\/\/www\.teambition\.com\/api\/v2\/tasks\/t1\/subtasks\?withSubtasks=true&excludeInTfsNode=false&pageSize=200$/
const TASK_SUBTASKS_LEGACY_URL = 'https://www.teambition.com/api/tasks/t1/subtasks'
const TASK_ACTIVITIES_V2_URL = /^https:\/\/www\.teambition\.com\/api\/v2\/tasks\/t1\/activities\?/
const TASK_ACTIVITIES_LEGACY_URL = 'https://www.teambition.com/api/tasks/t1/activities'

/** One full detail payload as the web client receives it. */
const DETAIL_BODY = {
  _id: 't1',
  content: '  Build the detail page  ',
  note: 'Line one\nLine two',
  _projectId: 'p1',
  _tasklistId: 'tl1',
  _stageId: 's1',
  _taskflowstatusId: 'st1',
  uniqueId: 42,
  priority: 2,
  created: '2024-01-02T03:04:05.000Z',
  updated: '2024-02-03T04:05:06.000Z',
  dueDate: '2024-03-01T00:00:00.000Z',
  startDate: '2024-02-01T00:00:00.000Z',
  storyPoint: 5,
  attachmentsCount: 3,
  commentsCount: 2,
  subtaskCount: { total: 2, done: 1 },
  _creatorId: 'u1',
  creator: { _id: 'u1', name: 'Creator One' },
  executor: { _id: 'u2', name: 'Executor Two', avatarUrl: 'https://x/e.png' },
  involvers: [{ _id: 'u3', name: 'Involver Three' }],
  involveMembers: ['u1', 'u2'],
  customfields: [
    { _id: 'cf1', title: 'Severity', value: 'High' },
    { name: 'Estimate', value: 3 },
    { title: 'Empty', value: '' },
  ],
  subtasks: [{ _id: 'st-embedded', content: ' Embedded ', isDone: true }],
}

const SUBTASK_BODY = {
  result: [
    { _id: 'sub1', content: '  Write tests  ', isDone: true, dueDate: '2024-04-01T00:00:00.000Z', executor: { name: 'Executor Two' } },
    { _id: 'sub2', content: 'Ship', accomplished: true },
  ],
  nextPageToken: 'page-two',
}

const ACTIVITY_BODY = {
  result: [
    {
      _id: 'a1',
      action: 'activity.task.update.taskflowstatus.v2',
      title: 'Creator One 将任务状态从 Doing 改为 Done',
      creator: { name: 'Creator One' },
      created: '2024-02-04T00:00:00.000Z',
    },
  ],
  total: 1,
}

describe('taskDetail', () => {
  it('reads the card, description, members, fields, subtasks and activities', async () => {
    const fake = fakeTransport([
      { url: TASK_DETAIL_URL, body: DETAIL_BODY },
      { url: TASK_SUBTASKS_V2_URL, body: SUBTASK_BODY },
      { url: TASK_ACTIVITIES_V2_URL, body: ACTIVITY_BODY },
    ])
    const detail = await webClient(fake.transport).taskDetail('p1', 't1')
    expect(detail.card).toEqual({
      id: 't1',
      projectId: 'p1',
      projectName: 'p1',
      title: 'Build the detail page',
      note: 'Line one\nLine two',
      stageId: 's1',
      tasklistId: 'tl1',
      statusId: 'st1',
      updatedAt: Date.parse('2024-02-03T04:05:06.000Z'),
      priority: 2,
      uniqueId: 42,
      executorId: 'u2',
      executorName: 'Executor Two',
      executorAvatarUrl: 'https://x/e.png',
      creatorId: 'u1',
      dueAt: Date.parse('2024-03-01T00:00:00.000Z'),
      dueAtRaw: '2024-03-01T00:00:00.000Z',
      createdAt: Date.parse('2024-01-02T03:04:05.000Z'),
      subtaskCount: 2,
      commentsCount: 2,
      url: 'https://www.teambition.com/project/p1/tasks/t1',
    })
    expect(detail.note).toBe('Line one\nLine two')
    expect(detail.creatorName).toBe('Creator One')
    expect(detail.involverNames).toEqual(['Involver Three'])
    expect(detail.startAtRaw).toBe('2024-02-01T00:00:00.000Z')
    expect(detail.storyPoint).toBe(5)
    expect(detail.attachmentsCount).toBe(3)
    expect(detail.customFields).toEqual([
      { name: 'Severity', value: 'High' },
      { name: 'Estimate', value: '3' },
    ])
    expect(detail.subtasks).toEqual([
      { id: 'sub1', title: 'Write tests', isDone: true, executorName: 'Executor Two', dueAtRaw: '2024-04-01T00:00:00.000Z' },
      { id: 'sub2', title: 'Ship', isDone: true },
    ])
    expect(detail.activities).toEqual([
      {
        id: 'a1',
        title: 'Creator One 将任务状态从 Doing 改为 Done',
        action: 'activity.task.update.taskflowstatus.v2',
        actorName: 'Creator One',
        createdAt: Date.parse('2024-02-04T00:00:00.000Z'),
      },
    ])
    expect(detail.fetchedAt).toEqual(expect.any(Number))
  })

  it('falls back to the embedded subtasks and an empty feed when those routes fail', async () => {
    const fake = fakeTransport([
      { url: TASK_DETAIL_URL, body: DETAIL_BODY },
      { url: TASK_SUBTASKS_V2_URL, status: 404, body: { code: 'NotFound' } },
      { url: TASK_SUBTASKS_LEGACY_URL, status: 404, body: { code: 'NotFound' } },
      { url: TASK_ACTIVITIES_V2_URL, status: 404, body: { code: 'NotFound' } },
      { url: TASK_ACTIVITIES_LEGACY_URL, status: 404, body: { code: 'NotFound' } },
    ])
    const detail = await webClient(fake.transport).taskDetail('p1', 't1')
    expect(detail.subtasks).toEqual([{ id: 'st-embedded', title: 'Embedded', isDone: true }])
    expect(detail.activities).toEqual([])
    expect(detail.card.subtaskCount).toBe(2)
  })

  it('reads a legacy bare-array subtask list and activity feed', async () => {
    const fake = fakeTransport([
      { url: TASK_DETAIL_URL, body: DETAIL_BODY },
      { url: TASK_SUBTASKS_V2_URL, status: 404, body: { code: 'NotFound' } },
      { url: TASK_SUBTASKS_LEGACY_URL, body: [{ _id: 'sub-legacy', content: 'Legacy', isDone: false }] },
      { url: TASK_ACTIVITIES_V2_URL, status: 404, body: { code: 'NotFound' } },
      {
        url: TASK_ACTIVITIES_LEGACY_URL,
        body: [{ _id: 'a-legacy', action: 'activity.task.create.v2', title: 'created', created: '2024-05-01T00:00:00.000Z' }],
      },
    ])
    const detail = await webClient(fake.transport).taskDetail('p1', 't1')
    expect(detail.subtasks).toEqual([{ id: 'sub-legacy', title: 'Legacy', isDone: false }])
    expect(detail.activities).toEqual([
      {
        id: 'a-legacy',
        title: 'created',
        action: 'activity.task.create.v2',
        createdAt: Date.parse('2024-05-01T00:00:00.000Z'),
      },
    ])
  })

  it('propagates a refused cookie from the detail route', async () => {
    const fake = fakeTransport([
      { url: TASK_DETAIL_URL, status: 401, body: { code: 'InvalidCookie', message: 'expired' } },
    ])
    await expect(webClient(fake.transport).taskDetail('p1', 't1')).rejects.toMatchObject({ failure: 'invalid-cookie' })
  })
})
