/**
 * Teambition service: state view, config persistence, diagnostics, project
 * mapping with workspace resolution, writes and binding tables.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TeambitionDiagnostics, TeambitionEndpoint, TeambitionProject, TeambitionTask, TeambitionTasklist, TeambitionWorkflowStatus } from '../src/core/teambition/index.ts'
import { cardUrl } from '../src/core/protocol.ts'
import { TeambitionApiError, type TeambitionScenarioConfig, type TeambitionView, type TeambitionWorkflow } from '../src/host/client.ts'
import { TeambitionConfigStore, type TeambitionHostState } from '../src/host/config-store.ts'
import {
  createTeambitionService,
  TeambitionHostError,
  type TeambitionClientPort,
  type TeambitionServiceOptions,
} from '../src/host/service.ts'

const NOW = 1_700_000_000_000

const DIAGNOSTICS: TeambitionDiagnostics = {
  probedAt: NOW,
  cookieConfigured: true,
  conclusion: 'usable',
  message: 'project list endpoint answered',
  results: [{ id: 'joined', base: 'api', path: '/v3/project/user-joined', status: 200, ok: true, projectCount: 1 }],
  projectEndpoint: { id: 'joined', base: 'web', path: '/v3/project/user-joined' },
}

const ENDPOINT: TeambitionEndpoint = { id: 'joined', base: 'web', path: '/v3/project/user-joined', purpose: 'joined projects' }

const TASKLISTS: readonly TeambitionTasklist[] = [{ id: 'tl1', name: 'List One' }]
const STAGES = [{ id: 's1', name: 'Todo', pos: 0 }]
const STATUSES: readonly TeambitionWorkflowStatus[] = [{ id: 'st1', name: 'Doing', kind: 'start', pos: 0 }]
const TASKS: readonly TeambitionTask[] = [
  { id: 't1', projectId: 'p1', title: 'First', stageId: 's1', statusId: 'st1', scenarioConfigId: 'sc1', updatedAt: 99 },
  { id: 't2', projectId: 'p1', title: 'Second' },
  { id: 't3', projectId: 'p2', title: 'Third' },
]
const PROJECTS: readonly TeambitionProject[] = [{ id: 'p1', name: 'Project One' }]

/** A project whose columns and cards are split over two task lists. */
const TWO_TASKLISTS: readonly TeambitionTasklist[] = [
  { id: 'tl1', name: 'List One' },
  { id: 'tl2', name: 'List Two' },
]
const TWO_LIST_STAGES = [
  { id: 's1', name: 'Todo', tasklistId: 'tl1', pos: 0 },
  { id: 's2', name: 'Review', tasklistId: 'tl2', pos: 0 },
  { id: 's3', name: 'Orphan', pos: 1 },
]
const TWO_LIST_TASKS: readonly TeambitionTask[] = [
  { id: 't1', projectId: 'p1', title: 'First', stageId: 's1', tasklistId: 'tl1' },
  { id: 't2', projectId: 'p1', title: 'Second', stageId: 's2', tasklistId: 'tl2' },
  { id: 't3', projectId: 'p1', title: 'Orphan' },
]

/** Workflow statuses of the workflow project, ordered as Teambition orders them. */
const WORKFLOWS: readonly TeambitionWorkflow[] = [
  {
    id: 'wf1',
    name: 'Default workflow',
    statuses: [
      { id: 'st1', name: 'Doing', kind: 'start', pos: 0 },
      { id: 'st2', name: 'Done', kind: 'end', pos: 1 },
    ],
  },
]
const TASK_TYPES: readonly TeambitionScenarioConfig[] = [
  { id: 'sc1', name: 'Task', taskflowId: 'wf1', statusIds: ['st1', 'st2'] },
]
const VIEWS: readonly TeambitionView[] = [
  { id: 'v-stage', name: 'Stage board', vertical: 'stage', scenarioConfigIds: [], isDefault: true },
  { id: 'v-status', name: 'Status board', vertical: 'status', scenarioConfigIds: ['sc1'] },
]

let root: string
let store: TeambitionConfigStore
let calls: { listProjects: number; updateTaskStatus: string[][]; updateTaskStage: string[][]; createTask: unknown[] }

/** Fake client recording the writes it receives. */
function createFakeClient(overrides: Partial<TeambitionClientPort> = {}): TeambitionClientPort {
  return {
    configured: true,
    diagnose: async () => DIAGNOSTICS,
    listProjects: async () => ({ projects: PROJECTS, endpoint: ENDPOINT }),
    projectStatuses: async () => STATUSES,
    projectTasks: async () => TASKS,
    projectStages: async () => STAGES,
    projectTasklists: async () => TASKLISTS,
    projectWorkflows: async () => WORKFLOWS,
    projectScenarioConfigs: async () => TASK_TYPES,
    projectViews: async () => VIEWS,
    updateTaskStatus: async (taskId, statusId) => { calls.updateTaskStatus.push([taskId, statusId]) },
    updateTaskStage: async (taskId, stageId) => { calls.updateTaskStage.push([taskId, stageId]) },
    createTask: async input => { calls.createTask.push(input); return { taskId: 't-new' } },
    ...overrides,
  }
}

/** Service bound to one fake client. */
function createService(client: TeambitionClientPort, options: TeambitionServiceOptions = {}) {
  return createTeambitionService(store, { now: () => NOW, createClient: () => client, ...options })
}

/** Raw persisted JSON. */
async function readRaw(): Promise<TeambitionHostState> {
  return JSON.parse(await readFile(join(root, 'teambition', 'config.json'), 'utf8')) as TeambitionHostState
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-teambition-service-'))
  store = new TeambitionConfigStore({ env: { DSH_HOME: root }, home: root })
  calls = { listProjects: 0, updateTaskStatus: [], updateTaskStage: [], createTask: [] }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('stateView and config', () => {
  it('reports the defaults before anything is configured', async () => {
    const view = await createService(createFakeClient()).stateView()
    expect(view.settings.configured).toBe(false)
    expect(view.settings.apiBase).toBe('api')
    expect(view.settings.projectBindings).toEqual([])
    expect(view.settings.cardBindings).toEqual([])
    expect(view.projects).toEqual([])
    expect(view.diagnostics).toBeUndefined()
  })

  it('persists the cookie host-side but never returns it', async () => {
    const service = createService(createFakeClient())
    const view = await service.updateConfig({ cookie: 'SESS=secret123456', operatorId: 'op-1', apiBase: 'web' })
    expect(view.settings.configured).toBe(true)
    expect(view.settings.cookieTail).toBe('3456')
    expect(view.settings.operatorIdConfigured).toBe(true)
    expect(view.settings.apiBase).toBe('web')
    expect(JSON.stringify(view)).not.toContain('secret')

    const raw = await readRaw()
    expect(raw.settings.cookie).toBe('SESS=secret123456')
    expect(raw.settings.operatorId).toBe('op-1')
  })

  it('clears the cookie and operator id explicitly', async () => {
    const service = createService(createFakeClient())
    await service.updateConfig({ cookie: 'SESS=secret', operatorId: 'op-1' })
    const view = await service.updateConfig({ clearCookie: true, clearOperatorId: true })
    expect(view.settings.configured).toBe(false)
    expect(view.settings.operatorIdConfigured).toBe(false)
  })

  it('drops the stale diagnose verdict when the cookie changes', async () => {
    const service = createService(createFakeClient())
    await service.updateConfig({ cookie: 'SESS=secret' })
    await service.diagnose()
    expect((await service.stateView()).diagnostics).toBeDefined()
    const view = await service.updateConfig({ clearCookie: true })
    expect(view.diagnostics).toBeUndefined()
    expect(view.settings.configured).toBe(false)
  })

  it('refuses remote operations without a cookie', async () => {
    const service = createService(createFakeClient())
    await expect(service.listProjects()).rejects.toMatchObject({ code: 'not-configured' })
  })
})

describe('diagnose', () => {
  it('persists sanitized diagnostics and corrects apiBase to the winning host', async () => {
    const service = createService(createFakeClient())
    await service.updateConfig({ cookie: 'SESS=secret', apiBase: 'api' })
    const result = await service.diagnose()
    expect(result.diagnostics.conclusion).toBe('usable')
    const view = await service.stateView()
    expect(view.settings.apiBase).toBe('web')
    expect(view.diagnostics?.conclusion).toBe('usable')
    const raw = await readRaw()
    expect(raw.diagnostics?.probedAt).toBe(NOW)
  })

  it('reports no-cookie honestly without creating a client', async () => {
    const service = createService(createFakeClient(), {
      createClient: () => { throw new Error('client must not be created') },
    })
    const result = await service.diagnose()
    expect(result.diagnostics.conclusion).toBe('no-cookie')
    const view = await service.stateView()
    expect(view.settings.configured).toBe(false)
    expect(view.settings.lastError).toMatch(/No Teambition cookie/)
  })
})

describe('listProjects', () => {
  it('persists projects, the winning base and lastSyncAt', async () => {
    const service = createService(createFakeClient())
    await service.updateConfig({ cookie: 'SESS=secret' })
    const result = await service.listProjects()
    expect(result.projects).toEqual(PROJECTS)
    const view = await service.stateView()
    expect(view.projects).toEqual(PROJECTS)
    expect(view.settings.apiBase).toBe('web')
    expect(view.settings.lastSyncAt).toBe(NOW)
    expect(view.settings.lastError).toBeUndefined()
  })

  it('persists lastError and rejects with a host error on failure', async () => {
    const service = createService(createFakeClient({
      listProjects: async () => { throw new TeambitionApiError('invalid-cookie', 'session cookie was refused (HTTP 401)') },
    }))
    await service.updateConfig({ cookie: 'SESS=expired' })
    await expect(service.listProjects()).rejects.toMatchObject({ code: 'failed', message: expect.stringMatching(/refused/) })
    const view = await service.stateView()
    expect(view.settings.lastError).toMatch(/refused/)
    expect(view.settings.lastSyncAt).toBeUndefined()
  })
})

describe('projectDetail', () => {
  it('maps cards, resolves workspaces and builds card urls', async () => {
    const service = createService(createFakeClient())
    await service.updateConfig({
      cookie: 'SESS=secret',
      projectBindings: [{ projectId: 'p1', workspaceId: 'ws-project' }],
      cardBindings: [{ taskId: 't2', workspaceId: 'ws-card' }],
      defaultWorkspaceId: 'ws-default',
    })
    await service.listProjects()
    const detail = await service.projectDetail({ projectId: 'p1' })
    expect(detail.project).toEqual({ id: 'p1', name: 'Project One' })
    expect(detail.tasklists).toEqual(TASKLISTS)
    expect(detail.stages).toEqual([{ id: 's1', name: 'Todo', pos: 0, tasklistId: 'tl1' }])
    expect(detail.statuses).toEqual(STATUSES)
    expect(detail.views).toEqual(VIEWS)
    expect(detail.workflows).toEqual([
      {
        id: 'wf1',
        name: 'Default workflow',
        statuses: [
          { id: 'st1', name: 'Doing', kind: 'start', pos: 0 },
          { id: 'st2', name: 'Done', kind: 'end', pos: 1 },
        ],
      },
    ])
    expect(detail.scenarioConfigs).toEqual([{ id: 'sc1', name: 'Task', taskflowId: 'wf1', statusIds: ['st1', 'st2'] }])
    expect(detail.viewId).toBe('v-stage')
    expect(detail.columns).toEqual([{ id: 's1', name: 'Todo', kind: 'stage', pos: 0, tasklistId: 'tl1' }])
    expect(detail.cards).toHaveLength(3)
    expect(detail.cards.every(card => card.tasklistId === 'tl1')).toBe(true)
    const [first, second, third] = detail.cards
    expect(first).toMatchObject({ id: 't1', projectName: 'Project One', workspaceId: 'ws-project', workspaceSource: 'project' })
    expect(first?.scenarioConfigId).toBe('sc1')
    expect(first?.url).toBe(cardUrl('p1', 't1'))
    expect(second).toMatchObject({ id: 't2', workspaceId: 'ws-card', workspaceSource: 'card' })
    expect(third).toMatchObject({ id: 't3', workspaceId: 'ws-default', workspaceSource: 'default' })
    const view = await service.stateView()
    expect(view.settings.lastSyncAt).toBe(NOW)
  })

  it('omits workspace fields when nothing is bound', async () => {
    const service = createService(createFakeClient())
    await service.updateConfig({ cookie: 'SESS=secret' })
    const detail = await service.projectDetail({ projectId: 'p1' })
    expect(detail.project).toEqual({ id: 'p1', name: 'p1' })
    expect(detail.cards.every(card => card.workspaceId === undefined && card.workspaceSource === undefined)).toBe(true)
  })

  it('attributes rows without a tasklistId to the only task list of the project', async () => {
    const service = createService(createFakeClient())
    await service.updateConfig({ cookie: 'SESS=secret' })
    const detail = await service.projectDetail({ projectId: 'p1', tasklistId: 'tl1' })
    expect(detail.stages).toEqual([{ id: 's1', name: 'Todo', pos: 0, tasklistId: 'tl1' }])
    expect(detail.cards).toHaveLength(3)
  })

  it('narrows stages and cards to the requested task list', async () => {
    const service = createService(createFakeClient({
      projectTasklists: async () => TWO_TASKLISTS,
      projectStages: async () => TWO_LIST_STAGES,
      projectTasks: async () => TWO_LIST_TASKS,
    }))
    await service.updateConfig({ cookie: 'SESS=secret' })
    const detail = await service.projectDetail({ projectId: 'p1', tasklistId: 'tl2' })
    expect(detail.tasklists).toEqual(TWO_TASKLISTS)
    expect(detail.stages).toEqual([{ id: 's2', name: 'Review', pos: 0, tasklistId: 'tl2' }])
    expect(detail.cards).toEqual([expect.objectContaining({ id: 't2', tasklistId: 'tl2' })])
  })

  it('keeps unattributed rows unattributed when the project has several task lists', async () => {
    const service = createService(createFakeClient({
      projectTasklists: async () => TWO_TASKLISTS,
      projectStages: async () => TWO_LIST_STAGES,
      projectTasks: async () => TWO_LIST_TASKS,
    }))
    await service.updateConfig({ cookie: 'SESS=secret' })
    const detail = await service.projectDetail({ projectId: 'p1' })
    expect(detail.stages).toHaveLength(3)
    expect(detail.stages.find(stage => stage.id === 's3')?.tasklistId).toBeUndefined()
    expect(detail.cards.find(card => card.id === 't3')?.tasklistId).toBeUndefined()
  })

  it('renders the kanban stages as columns for a stage view', async () => {
    const service = createService(createFakeClient({
      projectViews: async () => [{ id: 'v-stage', name: 'Stage board', vertical: 'stage', scenarioConfigIds: [] }],
    }))
    await service.updateConfig({ cookie: 'SESS=secret' })
    const detail = await service.projectDetail({ projectId: 'p1' })
    expect(detail.viewId).toBe('v-stage')
    expect(detail.columns).toEqual([{ id: 's1', name: 'Todo', kind: 'stage', pos: 0, tasklistId: 'tl1' }])
  })

  it('renders the requested view instead of the default one', async () => {
    const service = createService(createFakeClient({
      projectViews: async () => [
        { id: 'v-other', name: 'Other', vertical: 'status', scenarioConfigIds: ['sc1'], isDefault: true },
        { id: 'v-done-first', name: 'Done first', vertical: 'status', scenarioConfigIds: ['sc1'] },
      ],
    }))
    await service.updateConfig({ cookie: 'SESS=secret' })
    const detail = await service.projectDetail({ projectId: 'p1', viewId: 'v-done-first' })
    expect(detail.viewId).toBe('v-done-first')
    expect(detail.columns.map(column => column.id)).toEqual(['st1', 'st2'])
  })

  it('falls back to the default view when the requested one is unknown', async () => {
    const service = createService(createFakeClient())
    await service.updateConfig({ cookie: 'SESS=secret' })
    const detail = await service.projectDetail({ projectId: 'p1', viewId: 'missing' })
    expect(detail.viewId).toBe('v-stage')
  })

  it('deduplicates statuses shared by several task types', async () => {
    const service = createService(createFakeClient({
      projectScenarioConfigs: async () => [
        { id: 'sc1', name: 'Task', taskflowId: 'wf1', statusIds: ['st1', 'st2'] },
        { id: 'sc2', name: 'Bug', taskflowId: 'wf1', statusIds: ['st1', 'st2'] },
      ],
      projectViews: async () => [{ id: 'v-all', name: 'All', vertical: 'status', scenarioConfigIds: ['sc1', 'sc2'], isDefault: true }],
    }))
    await service.updateConfig({ cookie: 'SESS=secret' })
    const detail = await service.projectDetail({ projectId: 'p1' })
    expect(detail.columns.map(column => column.id)).toEqual(['st1', 'st2'])
  })

  it('narrows stage columns to the requested task list', async () => {
    const service = createService(createFakeClient({
      projectTasklists: async () => TWO_TASKLISTS,
      projectStages: async () => TWO_LIST_STAGES,
      projectTasks: async () => TWO_LIST_TASKS,
      projectViews: async () => [{ id: 'v-stage', name: 'Stage board', vertical: 'stage', scenarioConfigIds: [] }],
    }))
    await service.updateConfig({ cookie: 'SESS=secret' })
    const detail = await service.projectDetail({ projectId: 'p1', tasklistId: 'tl2' })
    expect(detail.columns).toEqual([{ id: 's2', name: 'Review', kind: 'stage', pos: 0, tasklistId: 'tl2' }])
  })

  it('degrades to the workflow statuses when a status view names no readable task type', async () => {
    const service = createService(createFakeClient({
      projectScenarioConfigs: async () => [],
      projectViews: async () => [{ id: 'v-empty', name: 'Empty', vertical: 'status', scenarioConfigIds: ['sc-missing'], isDefault: true }],
    }))
    await service.updateConfig({ cookie: 'SESS=secret' })
    const detail = await service.projectDetail({ projectId: 'p1' })
    expect(detail.columns).toEqual([
      { id: 'st1', name: 'Doing', kind: 'status', pos: 0 },
      { id: 'st2', name: 'Done', kind: 'status', pos: 1 },
    ])
  })

  it('renders the workflow statuses for a status view without task types', async () => {
    const service = createService(createFakeClient({
      projectViews: async () => [{ id: 'v-version', name: 'Version board', vertical: 'status', scenarioConfigIds: [], isDefault: true }],
    }))
    await service.updateConfig({ cookie: 'SESS=secret' })
    const detail = await service.projectDetail({ projectId: 'p1' })
    expect(detail.columns.map(column => column.id)).toEqual(['st1', 'st2'])
    // Without task types there is nothing to narrow the cards to.
    expect(detail.cards.map(card => card.id)).toEqual(['t1', 't2', 't3'])
  })

  it('applies the executor clause of the selected view to the cards', async () => {
    const service = createService(createFakeClient({
      projectTasks: async () => [
        { id: 't1', projectId: 'p1', title: 'Mine', executorId: 'u1' },
        { id: 't2', projectId: 'p1', title: 'Theirs', executorId: 'u2' },
        { id: 't3', projectId: 'p1', title: 'Unassigned' },
      ],
      projectViews: async () => [
        { id: 'v-mine', name: 'My tasks', vertical: 'stage', scenarioConfigIds: [], filter: '_executorId = u1 ORDER BY created DESC', isDefault: true },
      ],
    }))
    await service.updateConfig({ cookie: 'SESS=secret' })
    const detail = await service.projectDetail({ projectId: 'p1' })
    expect(detail.cards.map(card => card.id)).toEqual(['t1'])
    expect(detail.columns).toEqual([{ id: 's1', name: 'Todo', kind: 'stage', pos: 0, tasklistId: 'tl1' }])
  })

  it('applies a creator clause to the cards as well', async () => {
    const service = createService(createFakeClient({
      projectTasks: async () => [
        { id: 't1', projectId: 'p1', title: 'Mine', creatorId: 'u1' },
        { id: 't2', projectId: 'p1', title: 'Theirs', creatorId: 'u2' },
      ],
      projectViews: async () => [
        { id: 'v-created', name: 'Created by me', vertical: 'stage', scenarioConfigIds: [], filter: '_creatorId = u1 ORDER BY created DESC', isDefault: true },
      ],
    }))
    await service.updateConfig({ cookie: 'SESS=secret' })
    const detail = await service.projectDetail({ projectId: 'p1' })
    expect(detail.views[0]?.filter).toBe('_creatorId = u1 ORDER BY created DESC')
    expect(detail.cards.map(card => card.id)).toEqual(['t1'])
  })

  it('keeps only the cards of a status view task types', async () => {
    const service = createService(createFakeClient({
      projectTasks: async () => [
        { id: 't1', projectId: 'p1', title: 'Task', scenarioConfigId: 'sc1' },
        { id: 't2', projectId: 'p1', title: 'Bug', scenarioConfigId: 'sc2' },
        { id: 't3', projectId: 'p1', title: 'Unclassified' },
      ],
      projectViews: async () => [{ id: 'v-status', name: 'Status board', vertical: 'status', scenarioConfigIds: ['sc1'], isDefault: true }],
    }))
    await service.updateConfig({ cookie: 'SESS=secret' })
    const detail = await service.projectDetail({ projectId: 'p1' })
    expect(detail.cards.map(card => card.id)).toEqual(['t1'])
  })
})

describe('writes', () => {
  it('forwards createTask with the optional fields', async () => {
    const service = createService(createFakeClient())
    await service.updateConfig({ cookie: 'SESS=secret' })
    const result = await service.createTask({ projectId: 'p1', title: 'New card', note: 'note', stageId: 's1', statusId: 'st1' })
    expect(result).toEqual({ taskId: 't-new' })
    expect(calls.createTask).toEqual([{ projectId: 'p1', title: 'New card', note: 'note', stageId: 's1', statusId: 'st1' }])
  })

  it('forwards the selected task list when creating a card', async () => {
    const service = createService(createFakeClient())
    await service.updateConfig({ cookie: 'SESS=secret' })
    await service.createTask({ projectId: 'p1', title: 'New card', tasklistId: 'tl2' })
    expect(calls.createTask).toEqual([{ projectId: 'p1', title: 'New card', tasklistId: 'tl2' }])
  })

  it('forwards the task type when creating a card into a workflow status', async () => {
    const service = createService(createFakeClient())
    await service.updateConfig({ cookie: 'SESS=secret' })
    await service.createTask({ projectId: 'p1', title: 'New card', statusId: 'st1', scenarioConfigId: 'sc1' })
    expect(calls.createTask).toEqual([{ projectId: 'p1', title: 'New card', statusId: 'st1', scenarioConfigId: 'sc1' }])
  })

  it('forwards status and stage moves', async () => {
    const service = createService(createFakeClient())
    await service.updateConfig({ cookie: 'SESS=secret' })
    await expect(service.setStatus({ taskId: 't1', statusId: 'st2' })).resolves.toEqual({})
    await expect(service.setStage({ taskId: 't1', stageId: 's2' })).resolves.toEqual({})
    expect(calls.updateTaskStatus).toEqual([['t1', 'st2']])
    expect(calls.updateTaskStage).toEqual([['t1', 's2']])
  })

  it('persists lastError when a write fails', async () => {
    const service = createService(createFakeClient({
      updateTaskStage: async () => { throw new TeambitionApiError('api', 'stage update was refused') },
    }))
    await service.updateConfig({ cookie: 'SESS=secret' })
    await expect(service.setStage({ taskId: 't1', stageId: 's2' })).rejects.toBeInstanceOf(TeambitionHostError)
    const view = await service.stateView()
    expect(view.settings.lastError).toMatch(/stage update was refused/)
  })
})

describe('bind', () => {
  it('persists binding tables and the default workspace, then clears them', async () => {
    const service = createService(createFakeClient())
    const view = await service.bind({
      projectBindings: [{ projectId: 'p1', workspaceId: 'w1' }],
      cardBindings: [{ taskId: 't1', workspaceId: 'w2' }],
      defaultWorkspaceId: 'ws-default',
    })
    expect(view.settings.projectBindings).toEqual([{ projectId: 'p1', workspaceId: 'w1' }])
    expect(view.settings.cardBindings).toEqual([{ taskId: 't1', workspaceId: 'w2' }])
    expect(view.settings.defaultWorkspaceId).toBe('ws-default')

    const reloaded = await new TeambitionConfigStore({ env: { DSH_HOME: root }, home: root }).load()
    expect(reloaded.state.settings.projectBindings).toEqual([{ projectId: 'p1', workspaceId: 'w1' }])
    expect(reloaded.state.settings.cardBindings).toEqual([{ taskId: 't1', workspaceId: 'w2' }])

    const cleared = await service.bind({ defaultWorkspaceId: null, projectBindings: [], cardBindings: [] })
    expect(cleared.settings.defaultWorkspaceId).toBeUndefined()
    expect(cleared.settings.projectBindings).toEqual([])
    expect(cleared.settings.cardBindings).toEqual([])
  })
})
