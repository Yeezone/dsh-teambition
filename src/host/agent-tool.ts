/**
 * The model-visible `teambition` tool.
 *
 * One tool, thin over the host service: it inspects state, probes the
 * endpoints, lists projects and cards, creates a card, changes a card's
 * workflow status or stage, and binds a workspace. The cookie is accepted as
 * an explicit argument but never returned; failures stay inside the JSON
 * envelope so the model can read and correct them instead of seeing a throw.
 *
 * @module dsh-teambition/host/agent-tool
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { TeambitionCardBinding, TeambitionProjectBinding } from '../core/protocol.ts'
import { TeambitionHostError, type TeambitionService } from './service.ts'

/** Unconstrained JSON value the tool returns. */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** Model-facing JSON rendering. */
function renderJson(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

/** Mark an already JSON-safe projection as the tool's canonical value. */
function json(value: unknown): Json {
  return value as Json
}

/** A success envelope, matching the shape the HTTP routes return. */
function view(value: unknown): Json {
  return json({ ok: true, value })
}

/** A domain refusal the model can read and act on. */
function refused(code: string, message: string): Json {
  return json({ ok: false, code, message })
}

/** Message of any thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Name of the one tool this provider registers. */
export const TEAMBITION_TOOL_NAME = 'teambition'

/** Build the tool bound to one service. */
export function buildTeambitionTool(service: TeambitionService): ToolDefinition {
  return defineTool({
    name: TEAMBITION_TOOL_NAME,
    description: [
      'Inspect and operate the Teambition panel of the DSH GUI.',
      'action=status reports the browser-safe settings (cookie configured or not, never the cookie itself), the default workspace and the workspace bindings.',
      'action=diagnose probes the cookie-authenticated Teambition endpoints and returns HTTP status plus a redacted preview per probe; run it first with a new cookie.',
      'action=projects lists the projects the user has joined.',
      'action=project lists one project with its task lists, stages, workflow statuses and cards; each card carries the workspace resolution the panel would use.',
      'Kanban columns belong to task lists (a project has several lists, each with its own columns): pass an optional tasklistId to action=project to narrow the detail to one list, and to action=create-task to place the card in that list.',
      'action=create-task creates a card (projectId and title required; note, tasklistId, stageId, statusId and executorId optional) and is an explicit user write.',
      'action=set-status moves a card to a workflow status (taskId and statusId required).',
      'action=set-stage moves a card to a kanban stage (taskId and stageId required).',
      'action=bind-workspace binds a project (projectId+workspaceId), a card (taskId+workspaceId) or the default workspace (workspaceId alone); with no ids it clears the default workspace.',
      'cookie and operatorId configure the host-side credential and are only applied when provided; the cookie is stored host-side and never returned.',
      'Never assume a remote write succeeded without reading the result: Teambition cookie-auth endpoints are not officially documented.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['status', 'diagnose', 'projects', 'project', 'create-task', 'set-status', 'set-stage', 'bind-workspace'],
        description: 'The operation to perform.',
      },
      projectId: { type: 'string', description: 'project, create-task and bind-workspace: Teambition project id.' },
      taskId: { type: 'string', description: 'set-status, set-stage and bind-workspace: Teambition task id.' },
      title: { type: 'string', description: 'create-task: card title.' },
      note: { type: 'string', description: 'create-task: optional card note.' },
      tasklistId: { type: 'string', description: 'project and create-task: optional Teambition task list id; columns belong to a task list, and create-task places the card in it.' },
      statusId: { type: 'string', description: 'create-task and set-status: workflow status id.' },
      stageId: { type: 'string', description: 'create-task and set-stage: kanban stage id.' },
      workspaceId: { type: 'string', description: 'bind-workspace: DSH workspace id to bind.' },
      cookie: { type: 'string', description: 'Optional: full Cookie request header copied from a logged-in teambition.com tab. Stored host-side and never returned.' },
      operatorId: { type: 'string', description: 'Optional: Teambition user id sent as x-operator-id on remote writes.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      try {
        if (args.cookie !== undefined || args.operatorId !== undefined) {
          await service.updateConfig({
            ...(args.cookie === undefined ? {} : { cookie: args.cookie }),
            ...(args.operatorId === undefined ? {} : { operatorId: args.operatorId }),
          })
        }
        switch (args.action) {
          case 'status':
            return view(await service.stateView())
          case 'diagnose':
            return view(await service.diagnose())
          case 'projects':
            return view(await service.listProjects())
          case 'project': {
            if (args.projectId === undefined) return refused('invalid-request', 'projectId is required')
            return view(await service.projectDetail({
              projectId: args.projectId,
              ...(args.tasklistId === undefined ? {} : { tasklistId: args.tasklistId }),
            }))
          }
          case 'create-task': {
            if (args.projectId === undefined) return refused('invalid-request', 'projectId is required')
            if (args.title === undefined) return refused('invalid-request', 'title is required')
            const result = await service.createTask({
              projectId: args.projectId,
              title: args.title,
              ...(args.note === undefined ? {} : { note: args.note }),
              ...(args.tasklistId === undefined ? {} : { tasklistId: args.tasklistId }),
              ...(args.stageId === undefined ? {} : { stageId: args.stageId }),
              ...(args.statusId === undefined ? {} : { statusId: args.statusId }),
            })
            return view(result)
          }
          case 'set-status': {
            if (args.taskId === undefined) return refused('invalid-request', 'taskId is required')
            if (args.statusId === undefined) return refused('invalid-request', 'statusId is required')
            return view(await service.setStatus({ taskId: args.taskId, statusId: args.statusId }))
          }
          case 'set-stage': {
            if (args.taskId === undefined) return refused('invalid-request', 'taskId is required')
            if (args.stageId === undefined) return refused('invalid-request', 'stageId is required')
            return view(await service.setStage({ taskId: args.taskId, stageId: args.stageId }))
          }
          case 'bind-workspace': {
            const state = await service.stateView()
            const row = bindRow(args.projectId, args.taskId, args.workspaceId)
            if (row === 'invalid') return refused('invalid-request', 'workspaceId is required with projectId or taskId')
            if (row === 'missing-workspace') return view(await service.bind({ defaultWorkspaceId: null }))
            if (row === 'default') return view(await service.bind({ defaultWorkspaceId: args.workspaceId ?? null }))
            if (row.kind === 'project') {
              const projectBindings = mergeProjectBindings(state.settings.projectBindings, row.id, args.workspaceId ?? '')
              return view(await service.bind({ projectBindings }))
            }
            const cardBindings = mergeCardBindings(state.settings.cardBindings, row.id, args.workspaceId ?? '')
            return view(await service.bind({ cardBindings }))
          }
          default:
            return refused('unknown-action', `unknown action ${String(args.action)}`)
        }
      } catch (error) {
        if (error instanceof TeambitionHostError) return refused(error.code, error.message)
        return refused('failed', messageOf(error))
      }
    },
  })
}

/** Bind target resolution for `bind-workspace`. */
type BindTarget = 'invalid' | 'missing-workspace' | 'default' | { readonly kind: 'project' | 'card'; readonly id: string }

/** Resolve which binding a `bind-workspace` call addresses. */
function bindRow(projectId: string | undefined, taskId: string | undefined, workspaceId: string | undefined): BindTarget {
  if (projectId !== undefined && taskId !== undefined) return 'invalid'
  if (projectId !== undefined) return workspaceId === undefined ? 'invalid' : { kind: 'project', id: projectId }
  if (taskId !== undefined) return workspaceId === undefined ? 'invalid' : { kind: 'card', id: taskId }
  return workspaceId === undefined ? 'missing-workspace' : 'default'
}

/** Replace one project binding, keeping the other rows. */
function mergeProjectBindings(
  rows: readonly TeambitionProjectBinding[],
  projectId: string,
  workspaceId: string,
): readonly TeambitionProjectBinding[] {
  return [...rows.filter(row => row.projectId !== projectId), { projectId, workspaceId }]
}

/** Replace one card binding, keeping the other rows. */
function mergeCardBindings(
  rows: readonly TeambitionCardBinding[],
  taskId: string,
  workspaceId: string,
): readonly TeambitionCardBinding[] {
  return [...rows.filter(row => row.taskId !== taskId), { taskId, workspaceId }]
}
