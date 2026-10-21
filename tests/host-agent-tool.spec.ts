/**
 * The model-visible `teambition` tool: envelope shape, argument validation,
 * config side input and binding merges.
 */
import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { TeambitionBindRequest, TeambitionStateView } from '../src/core/protocol.ts'
import { buildTeambitionTool, TEAMBITION_TOOL_NAME } from '../src/host/agent-tool.ts'
import { TeambitionHostError, type TeambitionService } from '../src/host/service.ts'

const VIEW: TeambitionStateView = {
  settings: {
    configured: false,
    apiBase: 'api',
    operatorIdConfigured: false,
    projectBindings: [{ projectId: 'p0', workspaceId: 'w0' }],
    cardBindings: [],
  },
  projects: [],
}

interface Harness {
  readonly tool: ToolDefinition
  readonly bound: TeambitionBindRequest[]
  readonly updates: unknown[]
  readonly writes: unknown[]
  readonly calls: string[]
}

/** Tool bound to a fake service; `overrides` replace individual methods. */
function harness(overrides: Partial<Record<string, unknown>> = {}): Harness {
  const bound: TeambitionBindRequest[] = []
  const updates: unknown[] = []
  const writes: unknown[] = []
  const calls: string[] = []
  const service = {
    stateView: async () => { calls.push('stateView'); return VIEW },
    updateConfig: async (request: unknown) => { calls.push('updateConfig'); updates.push(request); return VIEW },
    diagnose: async () => { calls.push('diagnose'); return { diagnostics: { probedAt: 1, cookieConfigured: false, conclusion: 'no-cookie', message: 'none', results: [] } } },
    listProjects: async () => { calls.push('listProjects'); return { projects: [] } },
    projectDetail: async (request: { projectId: string; tasklistId?: string; viewId?: string }) => {
      calls.push(`projectDetail:${request.projectId}:${request.tasklistId ?? '-'}:${request.viewId ?? '-'}`)
      return { project: { id: request.projectId, name: request.projectId }, tasklists: [], stages: [], statuses: [], columns: [], cards: [], views: [], workflows: [], scenarioConfigs: [] }
    },
    createTask: async (request: unknown) => { calls.push('createTask'); writes.push(request); return { taskId: 't-new' } },
    setStatus: async (request: { taskId: string; statusId: string }) => { calls.push(`setStatus:${request.taskId}:${request.statusId}`); return {} },
    setStage: async (request: { taskId: string; stageId: string }) => { calls.push(`setStage:${request.taskId}:${request.stageId}`); return {} },
    bind: async (request: TeambitionBindRequest) => { calls.push('bind'); bound.push(request); return VIEW },
    ...overrides,
  } as unknown as TeambitionService
  return { tool: buildTeambitionTool(service), bound, updates, writes, calls }
}

/** Run the tool once (the definition validates the arguments first). */
async function call(tool: ToolDefinition, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return await tool.execute(args, {} as never) as Record<string, unknown>
}

describe('teambition tool definition', () => {
  it('is named teambition and exposes every action', () => {
    const test = harness()
    expect(test.tool.name).toBe(TEAMBITION_TOOL_NAME)
    const schema = JSON.stringify(test.tool.parameters)
    for (const action of ['status', 'diagnose', 'projects', 'project', 'create-task', 'set-status', 'set-stage', 'bind-workspace']) {
      expect(schema).toContain(action)
    }
    expect(schema).toContain('tasklistId')
    expect(schema).toContain('viewId')
    expect(schema).toContain('scenarioConfigId')
    expect(test.tool.description).toMatch(/columns belong to task lists/)
  })
})

describe('teambition tool dispatch', () => {
  it('wraps the state view in the success envelope', async () => {
    const test = harness()
    expect(await call(test.tool, { action: 'status' })).toEqual({ ok: true, value: VIEW })
  })

  it('requires projectId for the project action without calling the service', async () => {
    const test = harness()
    expect(await call(test.tool, { action: 'project' })).toMatchObject({ ok: false, code: 'invalid-request' })
    expect(test.calls).toEqual([])
  })

  it('forwards project detail', async () => {
    const test = harness()
    const result = await call(test.tool, { action: 'project', projectId: 'p1' })
    expect(result).toMatchObject({ ok: true, value: { project: { id: 'p1', name: 'p1' } } })
  })

  it('forwards the selected task list to the project detail', async () => {
    const test = harness()
    await call(test.tool, { action: 'project', projectId: 'p1', tasklistId: 'tl2' })
    expect(test.calls).toEqual(['projectDetail:p1:tl2:-'])
  })

  it('forwards the selected view to the project detail', async () => {
    const test = harness()
    await call(test.tool, { action: 'project', projectId: 'p1', viewId: 'v-status' })
    expect(test.calls).toEqual(['projectDetail:p1:-:v-status'])
  })

  it('forwards the task type to create-task', async () => {
    const test = harness()
    await call(test.tool, { action: 'create-task', projectId: 'p1', title: 'New', statusId: 'st1', scenarioConfigId: 'sc1' })
    expect(test.writes).toEqual([{ projectId: 'p1', title: 'New', statusId: 'st1', scenarioConfigId: 'sc1' }])
  })

  it('forwards the selected task list to create-task', async () => {
    const test = harness()
    await call(test.tool, { action: 'create-task', projectId: 'p1', title: 'New', tasklistId: 'tl2' })
    expect(test.writes).toEqual([{ projectId: 'p1', title: 'New', tasklistId: 'tl2' }])
  })

  it('requires title for create-task', async () => {
    const test = harness()
    expect(await call(test.tool, { action: 'create-task', projectId: 'p1' })).toMatchObject({ ok: false, code: 'invalid-request' })
    expect(await call(test.tool, { action: 'create-task', projectId: 'p1', title: 'New' })).toEqual({ ok: true, value: { taskId: 't-new' } })
  })

  it('requires ids for status and stage moves', async () => {
    const test = harness()
    expect(await call(test.tool, { action: 'set-status', taskId: 't1' })).toMatchObject({ ok: false, code: 'invalid-request' })
    expect(await call(test.tool, { action: 'set-stage', taskId: 't1' })).toMatchObject({ ok: false, code: 'invalid-request' })
    expect(test.calls).toEqual([])
  })

  it('applies cookie and operatorId before the requested action', async () => {
    const test = harness()
    await call(test.tool, { action: 'diagnose', cookie: 'SESS=secret', operatorId: 'op-1' })
    expect(test.updates).toEqual([{ cookie: 'SESS=secret', operatorId: 'op-1' }])
    expect(test.calls).toEqual(['updateConfig', 'diagnose'])
  })

  it('merges a project binding instead of replacing the table', async () => {
    const test = harness()
    await call(test.tool, { action: 'bind-workspace', projectId: 'p1', workspaceId: 'w1' })
    expect(test.bound).toEqual([{ projectBindings: [{ projectId: 'p0', workspaceId: 'w0' }, { projectId: 'p1', workspaceId: 'w1' }] }])
  })

  it('merges a card binding', async () => {
    const test = harness()
    await call(test.tool, { action: 'bind-workspace', taskId: 't1', workspaceId: 'w1' })
    expect(test.bound).toEqual([{ cardBindings: [{ taskId: 't1', workspaceId: 'w1' }] }])
  })

  it('binds the default workspace and clears it with no ids', async () => {
    const test = harness()
    await call(test.tool, { action: 'bind-workspace', workspaceId: 'ws-default' })
    await call(test.tool, { action: 'bind-workspace' })
    expect(test.bound).toEqual([{ defaultWorkspaceId: 'ws-default' }, { defaultWorkspaceId: null }])
  })

  it('reports host errors as a failure envelope', async () => {
    const test = harness({ listProjects: async () => { throw new TeambitionHostError('not-configured', 'No Teambition cookie is configured.') } })
    expect(await call(test.tool, { action: 'projects' })).toEqual({
      ok: false,
      code: 'not-configured',
      message: 'No Teambition cookie is configured.',
    })
  })

  it('reports unexpected errors as a failed envelope', async () => {
    const test = harness({ diagnose: async () => { throw new Error('boom') } })
    expect(await call(test.tool, { action: 'diagnose' })).toEqual({ ok: false, code: 'failed', message: 'boom' })
  })
})
