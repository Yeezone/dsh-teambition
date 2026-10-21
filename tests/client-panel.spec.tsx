// @vitest-environment jsdom
/**
 * Panel render contract, mounted with a fake route client and fake cordis
 * service faces: no network, no host. Pins the semantic anchors the skins/L2
 * contract resolves, the user-visible board copy, the settings surface, the
 * card-run sequence (create session, retain, prompt, release, open), and the
 * task-list dimension of the board (selector, grouping, remembered selection).
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TeambitionApiFace, TeambitionApiResult } from '../src/client/api.ts'
import type { SessionsFace, UiWorkspaceFace, WorkspacesFace } from '../src/client/faces.ts'
import { zh } from '../src/client/locales.ts'
import { SELECTION_STORAGE_KEY, TeambitionPanel, type TeambitionPanelProps } from '../src/client/panel.tsx'
import type {
  TeambitionProjectDetail,
  TeambitionSettingsView,
  TeambitionStateView,
} from '../src/core/protocol.ts'
import type { TeambitionDiagnostics, TeambitionProject } from '../src/core/teambition/types.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROJECT: TeambitionProject = { id: 'p1', name: '阿波罗计划' }

const SETTINGS: TeambitionSettingsView = {
  configured: true,
  apiBase: 'api',
  operatorIdConfigured: false,
  defaultWorkspaceId: 'ws-1',
  projectBindings: [],
  cardBindings: [],
}

const DETAIL: TeambitionProjectDetail = {
  project: PROJECT,
  tasklists: [{ id: 'l1', name: '迭代一' }],
  stages: [
    { id: 's1', name: '待办', tasklistId: 'l1' },
    { id: 's2', name: '进行中', tasklistId: 'l1' },
  ],
  statuses: [
    { id: 'st1', name: '未开始', kind: 'start' },
    { id: 'st2', name: '进行中' },
    { id: 'st3', name: '已完成', kind: 'end' },
  ],
  cards: [{
    id: 't1',
    projectId: 'p1',
    projectName: '阿波罗计划',
    title: '接入登录接口',
    stageId: 's1',
    tasklistId: 'l1',
    statusId: 'st2',
    url: 'https://www.teambition.com/project/p1/tasks/t1',
    workspaceId: 'ws-1',
    workspaceSource: 'card',
  }],
}

/** Two task lists: the "all task lists" view must group columns per list. */
const DETAIL_ALL: TeambitionProjectDetail = {
  ...DETAIL,
  tasklists: [{ id: 'l1', name: '迭代一' }, { id: 'l2', name: '迭代二' }],
  stages: [
    { id: 's1', name: '待办', tasklistId: 'l1' },
    { id: 's2', name: '进行中', tasklistId: 'l1' },
    { id: 's3', name: '待办', tasklistId: 'l2' },
  ],
  cards: [
    DETAIL.cards[0],
    {
      id: 't2',
      projectId: 'p1',
      projectName: '阿波罗计划',
      title: '发布灰度',
      stageId: 's3',
      tasklistId: 'l2',
      statusId: 'st1',
      url: 'https://www.teambition.com/project/p1/tasks/t2',
      workspaceId: 'ws-1',
      workspaceSource: 'card',
    },
  ],
}

/** The payload of one task list, as the host filters it. */
const DETAIL_L2: TeambitionProjectDetail = {
  ...DETAIL_ALL,
  stages: DETAIL_ALL.stages.filter(stage => stage.tasklistId === 'l2'),
  cards: DETAIL_ALL.cards.filter(card => card.tasklistId === 'l2'),
}

const DIAGNOSTICS: TeambitionDiagnostics = {
  probedAt: Date.parse('2026-10-21T05:00:00Z'),
  cookieConfigured: true,
  conclusion: 'usable',
  message: 'project endpoint answers',
  results: [],
}

/** Success envelope of the route client. */
function ok<T>(value: T): TeambitionApiResult<T> {
  return { ok: true, value }
}

/** Fresh state view, optionally with a different settings section. */
function stateView(settings: Partial<TeambitionSettingsView> = {}): TeambitionStateView {
  return { settings: { ...SETTINGS, ...settings }, projects: [PROJECT], diagnostics: DIAGNOSTICS }
}

/** Fake route client plus the service spies a test asserts on. */
function harness(state: TeambitionStateView = stateView(), detail: TeambitionProjectDetail = DETAIL) {
  const prompt = vi.fn(async (_blocks: unknown, _mode: string) => ({ ok: true }))
  const release = vi.fn()
  const create = vi.fn(async (_options: { workspaceId: string }) => 'session-1')
  const openSession = vi.fn()
  const createTask = vi.fn(async (_request: unknown) => ok({ taskId: 'new-1' }))
  const setTaskStatus = vi.fn(async (_request: unknown) => ok<Record<string, never>>({}))
  const setTaskStage = vi.fn(async (_request: unknown) => ok<Record<string, never>>({}))
  const saveBindings = vi.fn(async (_request: unknown) => ok(stateView()))
  const fetchProject = vi.fn(async (_projectId: string, _tasklistId?: string) => ok(detail))
  const api: TeambitionApiFace = {
    fetchState: vi.fn(async () => ok(state)),
    saveConfig: vi.fn(async () => ok(state)),
    diagnose: vi.fn(async () => ok({ diagnostics: DIAGNOSTICS })),
    refreshProjects: vi.fn(async () => ok({ projects: [PROJECT] })),
    fetchProject,
    createTask,
    setTaskStatus,
    setTaskStage,
    saveBindings,
  }
  const sessions: SessionsFace = {
    create,
    retain: (_sessionId: string) => ({
      ready: Promise.resolve(),
      binding: { session: { prompt } },
      release,
    }),
  }
  const workspaces: WorkspacesFace = {
    list: {
      getSnapshot: () => ({ items: [{ workspaceId: 'ws-1', title: '阿尔法工作区' }] }),
      subscribe: () => () => {},
    },
  }
  const uiWorkspace: UiWorkspaceFace = { openSession }
  return { api, sessions, workspaces, uiWorkspace, create, prompt, release, openSession, fetchProject, createTask, setTaskStatus, setTaskStage, saveBindings }
}

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount() })
  document.body.replaceChildren()
  localStorage.clear()
})

/** Mount the panel and flush its initial reads. */
async function mount(props: TeambitionPanelProps): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => { root.render(<TeambitionPanel {...props} />) })
  return container
}

/** Flush pending microtasks inside act until `check` holds. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 25; attempt++) {
    if (check()) return
    await act(async () => { await Promise.resolve() })
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** The first button whose trimmed text is exactly `text`. */
function buttonByText(scope: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll('button')].find(button => button.textContent?.trim() === text)
}

/** Click a button inside act (the handlers are async). */
async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** Type into a controlled input the way React's value tracker sees it. */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Pick a controlled select option. */
function pickOption(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
  setter?.call(select, value)
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

/** The task-list picker select, when the project has several lists. */
function tasklistPicker(scope: ParentNode): HTMLSelectElement {
  return scope.querySelector('[data-dsh-part="tasklist-picker"] select') as HTMLSelectElement
}

describe('TeambitionPanel', () => {
  it('renders the board with the project columns, cards and workspace chips', async () => {
    const h = harness()
    const container = await mount({ sessions: h.sessions, workspaces: h.workspaces, uiWorkspace: h.uiWorkspace, api: h.api })

    await until(() => container.querySelector('[data-dsh-part="card"]') !== null, 'the card board')

    expect(container.querySelector('[data-dsh-plugin="teambition"]')).not.toBeNull()
    expect(container.querySelector('[data-dsh-teambition-view]')).not.toBeNull()
    expect(container.querySelector('[data-dsh-part="connection"]')?.textContent).toBe(zh['connection.ok'])
    expect(container.querySelector('[data-dsh-part="connection"]')?.getAttribute('data-connected')).toBe('true')

    const columns = [...container.querySelectorAll('[data-dsh-part="column"]')]
    expect(columns).toHaveLength(2)
    expect(columns[0].textContent).toContain('待办')
    expect(columns[0].querySelector('[data-dsh-part="card"]')).not.toBeNull()
    expect(columns[1].querySelector('[data-dsh-part="card"]')).toBeNull()

    const card = container.querySelector('[data-dsh-part="card"]') as HTMLElement
    expect(card.getAttribute('data-card-id')).toBe('t1')
    expect(card.querySelector('[data-dsh-part="status"]')?.textContent).toBe('进行中')
    expect(card.textContent).toContain('接入登录接口')
    // The chip shows the workspace TITLE, not its id.
    expect(card.querySelector('[data-dsh-part="workspace-chip"]')?.textContent).toBe('阿尔法工作区')
    expect(card.getAttribute('data-workspace-bound')).toBe('true')
    // The create form is present for a selected project.
    expect(container.querySelector('[data-dsh-part="create"]')).not.toBeNull()
    // A project with one task list shows it read-only, without a picker.
    expect(container.querySelector('[data-dsh-part="tasklist"]')?.textContent).toContain('迭代一')
    expect(container.querySelector('[data-dsh-part="tasklist-picker"]')).toBeNull()
  })

  it('marks a card without an execution workspace as unbound', async () => {
    const unbound: TeambitionProjectDetail = {
      ...DETAIL,
      cards: [{ ...DETAIL.cards[0], workspaceId: undefined, workspaceSource: undefined }],
    }
    const h = harness(stateView({ defaultWorkspaceId: undefined }), unbound)
    const container = await mount({ sessions: h.sessions, workspaces: h.workspaces, uiWorkspace: h.uiWorkspace, api: h.api })
    await until(() => container.querySelector('[data-dsh-part="card"]') !== null, 'the card board')

    const card = container.querySelector('[data-dsh-part="card"]') as HTMLElement
    expect(card.getAttribute('data-workspace-bound')).toBe('false')
    expect(card.querySelector('[data-dsh-part="workspace-chip"]')?.textContent).toBe(zh['board.unboundWorkspace'])
  })

  it('runs a card in its bound workspace: create, retain, prompt, release, open', async () => {
    const h = harness()
    const container = await mount({ sessions: h.sessions, workspaces: h.workspaces, uiWorkspace: h.uiWorkspace, api: h.api })
    await until(() => container.querySelector('[data-dsh-part="card"]') !== null, 'the card board')

    const card = container.querySelector('[data-dsh-part="card"]') as HTMLElement
    const run = buttonByText(card, zh['card.run'])
    expect(run).toBeDefined()
    await click(run as HTMLButtonElement)
    await until(() => h.openSession.mock.calls.length > 0, 'the created session to open')

    expect(h.create).toHaveBeenCalledTimes(1)
    expect(h.create.mock.calls[0][0]).toEqual({ workspaceId: 'ws-1' })
    expect(h.prompt).toHaveBeenCalledTimes(1)
    const blocks = h.prompt.mock.calls[0][0] as Array<{ type: string; text: string }>
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('text')
    expect(blocks[0].text).toContain('接入登录接口')
    expect(blocks[0].text).toContain('阿波罗计划')
    expect(blocks[0].text).toContain('https://www.teambition.com/project/p1/tasks/t1')
    expect(h.prompt.mock.calls[0][1]).toBe('queue')
    expect(h.release).toHaveBeenCalledTimes(1)
    expect(h.openSession).toHaveBeenCalledWith('session-1')
  })

  it('shows the settings surface with the cookie setup hint when unconfigured', async () => {
    const h = harness(stateView({ configured: false, defaultWorkspaceId: undefined }))
    const container = await mount({ sessions: h.sessions, workspaces: h.workspaces, uiWorkspace: h.uiWorkspace, api: h.api })
    await until(() => container.querySelector('[data-dsh-part="connection"]') !== null, 'the header')

    expect(container.querySelector('[data-dsh-part="connection"]')?.textContent).toBe(zh['connection.unconfigured'])

    const settingsButton = buttonByText(container, zh['header.settings'])
    expect(settingsButton).toBeDefined()
    await click(settingsButton as HTMLButtonElement)

    const settings = container.querySelector('[data-dsh-part="settings"]')
    expect(settings).not.toBeNull()
    expect(container.querySelector('[data-dsh-part="cookie"] textarea')).not.toBeNull()
    expect(container.textContent).toContain(zh['settings.cookieMissing'])
    expect(buttonByText(container, zh['header.back'])).toBeDefined()
  })

  it('shows the empty-project hint instead of an empty board', async () => {
    const empty: TeambitionProjectDetail = { ...DETAIL, cards: [] }
    const h = harness(stateView(), empty)
    const container = await mount({ sessions: h.sessions, workspaces: h.workspaces, uiWorkspace: h.uiWorkspace, api: h.api })
    await until(() => container.querySelector('[data-dsh-part="board"]') !== null, 'the board')

    expect(container.querySelectorAll('[data-dsh-part="card"]')).toHaveLength(0)
    expect(container.textContent).toContain(zh['board.empty'])
    expect(container.textContent).toContain(zh['board.emptyHint'])
  })

  it('drops the rendered diagnose verdict once the cookie is cleared', async () => {
    const h = harness()
    const container = await mount({ sessions: h.sessions, workspaces: h.workspaces, uiWorkspace: h.uiWorkspace, api: h.api })
    await until(() => container.querySelector('[data-dsh-part="connection"]') !== null, 'the header')

    await click(buttonByText(container, zh['header.settings']) as HTMLButtonElement)
    const diagnoseSection = container.querySelector('[data-dsh-part="diagnose"]') as HTMLElement
    expect(diagnoseSection.textContent).toContain(zh['conclusion.usable'])

    // The host drops its stored verdict together with the cookie; a fresh read has none.
    h.api.fetchState = vi.fn(async () => ok({ ...stateView({ configured: false }), diagnostics: undefined }))
    await click(buttonByText(container, zh['settings.cookieClear']) as HTMLButtonElement)

    await until(
      () => (container.querySelector('[data-dsh-part="diagnose"]')?.textContent ?? '').includes(zh['settings.diagnoseNoCookie']),
      'the stale verdict to disappear',
    )
    expect(container.querySelector('[data-dsh-part="connection"]')?.textContent).toBe(zh['connection.unconfigured'])
  })
})

describe('TeambitionPanel task lists', () => {
  it('groups the all-lists board by task list and offers every list in the picker', async () => {
    const h = harness(stateView(), DETAIL_ALL)
    const container = await mount({ sessions: h.sessions, workspaces: h.workspaces, uiWorkspace: h.uiWorkspace, api: h.api })
    await until(() => container.querySelector('[data-dsh-part="tasklist-group"]') !== null, 'the task list groups')

    // "All task lists" is the default: every list gets its own board.
    expect(h.fetchProject).toHaveBeenCalledWith('p1', undefined)

    const groups = [...container.querySelectorAll('[data-dsh-part="tasklist-group"]')]
    expect(groups).toHaveLength(2)
    expect(groups[0].getAttribute('data-tasklist-id')).toBe('l1')
    expect(groups[0].textContent).toContain('迭代一')
    expect(groups[0].querySelectorAll('[data-dsh-part="column"]')).toHaveLength(2)
    expect(groups[0].querySelectorAll('[data-dsh-part="card"]')).toHaveLength(1)
    expect(groups[1].getAttribute('data-tasklist-id')).toBe('l2')
    expect(groups[1].querySelectorAll('[data-dsh-part="column"]')).toHaveLength(1)
    expect(groups[1].querySelector('[data-dsh-part="card"]')?.textContent).toContain('发布灰度')

    // Every card renders exactly once across the groups.
    expect(container.querySelectorAll('[data-dsh-part="card"]')).toHaveLength(2)

    const picker = tasklistPicker(container)
    expect([...picker.options].map(option => option.textContent)).toEqual([
      zh['header.tasklistAll'],
      '迭代一',
      '迭代二',
    ])
    expect(picker.value).toBe('')
  })

  it('reads the selected task list and remembers it for the next visit', async () => {
    const h = harness(stateView(), DETAIL_ALL)
    const container = await mount({ sessions: h.sessions, workspaces: h.workspaces, uiWorkspace: h.uiWorkspace, api: h.api })
    await until(() => container.querySelector('[data-dsh-part="tasklist-picker"]') !== null, 'the task list picker')

    await act(async () => { pickOption(tasklistPicker(container), 'l2') })
    expect(h.fetchProject).toHaveBeenLastCalledWith('p1', 'l2')

    await until(
      () => JSON.parse(localStorage.getItem(SELECTION_STORAGE_KEY) ?? '{}').tasklistId === 'l2',
      'the remembered selection',
    )
    expect(JSON.parse(localStorage.getItem(SELECTION_STORAGE_KEY) ?? '{}')).toEqual({ projectId: 'p1', tasklistId: 'l2' })
  })

  it('restores the remembered project and task list selection on mount', async () => {
    localStorage.setItem(SELECTION_STORAGE_KEY, JSON.stringify({ projectId: 'p1', tasklistId: 'l2' }))
    const h = harness(stateView(), DETAIL_ALL)
    const container = await mount({ sessions: h.sessions, workspaces: h.workspaces, uiWorkspace: h.uiWorkspace, api: h.api })

    await until(() => h.fetchProject.mock.calls.some(call => call[1] === 'l2'), 'the task-list read')
    expect(h.fetchProject).toHaveBeenCalledWith('p1', 'l2')
    expect(tasklistPicker(container).value).toBe('l2')
  })

  it('drops a remembered task list the project no longer has', async () => {
    localStorage.setItem(SELECTION_STORAGE_KEY, JSON.stringify({ projectId: 'p1', tasklistId: 'gone' }))
    const h = harness(stateView(), DETAIL_ALL)
    const container = await mount({ sessions: h.sessions, workspaces: h.workspaces, uiWorkspace: h.uiWorkspace, api: h.api })

    await until(() => {
      const picker = tasklistPicker(container)
      return picker !== null && picker.value === ''
    }, 'the fallback to all task lists')
    expect(h.fetchProject).toHaveBeenLastCalledWith('p1', undefined)
    expect(JSON.parse(localStorage.getItem(SELECTION_STORAGE_KEY) ?? '{}')).toEqual({ projectId: 'p1' })
  })

  it('creates a card in the selected task list and its column', async () => {
    const h = harness(stateView(), DETAIL_ALL)
    const container = await mount({ sessions: h.sessions, workspaces: h.workspaces, uiWorkspace: h.uiWorkspace, api: h.api })
    await until(() => container.querySelector('[data-dsh-part="tasklist-picker"]') !== null, 'the task list picker')

    // The host filters the payload by task list: emulate that on the second read.
    h.api.fetchProject = vi.fn(async (_projectId: string, tasklistId?: string) => ok(tasklistId === 'l2' ? DETAIL_L2 : DETAIL_ALL))
    await act(async () => { pickOption(tasklistPicker(container), 'l2') })
    await until(
      () => container.querySelector('[data-dsh-part="create"] select option[value="s3"]') !== null,
      'the columns of the selected task list',
    )

    const form = container.querySelector('[data-dsh-part="create"]') as HTMLFormElement
    await act(async () => { typeInto(form.querySelector('input') as HTMLInputElement, '灰度发布') })
    await act(async () => { pickOption(form.querySelector('select') as HTMLSelectElement, 's3') })
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await until(() => h.createTask.mock.calls.length > 0, 'the create call')

    expect(h.createTask.mock.calls[0][0]).toEqual({
      projectId: 'p1',
      tasklistId: 'l2',
      title: '灰度发布',
      stageId: 's3',
    })
  })

  it('shows the enhanced empty-project hint with the Teambition link', async () => {
    const h = harness(stateView(), { ...DETAIL, cards: [] })
    const container = await mount({ sessions: h.sessions, workspaces: h.workspaces, uiWorkspace: h.uiWorkspace, api: h.api })
    await until(() => container.querySelector('[data-dsh-part="board-empty"]') !== null, 'the empty hint')

    const empty = container.querySelector('[data-dsh-part="board-empty"]') as HTMLElement
    expect(empty.textContent).toContain(zh['board.empty'])
    expect(empty.textContent).toContain(zh['board.emptyHint'])
    const link = empty.querySelector('[data-dsh-part="open-project"]') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('https://www.teambition.com/project/p1/board')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.textContent).toBe(zh['board.openProject'])
  })
})
