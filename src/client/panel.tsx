/**
 * Teambition panel page: the board, the card form and the settings view.
 *
 * The page is mounted by the layout's `main` slot for the `teambition` panel id
 * (see `index.ts`); it receives the live cordis service faces as props plus an
 * optional route client, so a test can mount it with fakes and no network.
 *
 * Every remote write (create a card, move a stage/status, run a card, save a
 * binding) is an explicit user action: nothing is written back as a side effect
 * of reading or of running a card in DSH.
 *
 * @module @yeezone/dsh-client-ui-teambition/client/panel
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactElement } from 'react'
import type { TeambitionProject, TeambitionDiagnostics } from '../core/teambition/types.ts'
import {
  buildCardPrompt,
  resolveWorkspace,
  type TeambitionBindRequest,
  type TeambitionCardBinding,
  type TeambitionCardView,
  type TeambitionColumnView,
  type TeambitionConfigRequest,
  type TeambitionProjectDetail,
  type TeambitionProjectBinding,
  type TeambitionSettingsView,
  type TeambitionStateView,
  type TeambitionStatusView,
  type TeambitionStageView,
  type TeambitionViewView,
  type TeambitionWorkspaceChoice,
} from '../core/protocol.ts'
import { TeambitionApi, type TeambitionApiFace } from './api.ts'
import type { SessionsFace, UiWorkspaceFace, WorkspaceItemView, WorkspacesFace } from './faces.ts'
import { t, type TeambitionKey } from './locales.ts'
import css from './panel.module.css'

/** Route client used when the page is mounted without one. */
const DEFAULT_API: TeambitionApiFace = new TeambitionApi()

/**
 * localStorage key of the remembered board selection.
 *
 * Persisting the selection is what makes the panel open on the project the user
 * last worked in instead of the first project of the joined list, which for a
 * real account is often the empty "空白项目".
 */
export const SELECTION_STORAGE_KEY = 'dsh.teambition.selection.v1'

/** The remembered board selection: a project and optionally one of its task lists. */
export interface TeambitionSelection {
  readonly projectId?: string
  readonly tasklistId?: string
}

/**
 * Read the remembered selection.
 * @returns the stored selection, or an empty object when none/unreadable.
 */
function readSelection(): TeambitionSelection {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(SELECTION_STORAGE_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const record = parsed as { readonly projectId?: unknown; readonly tasklistId?: unknown }
    const projectId = typeof record.projectId === 'string' && record.projectId !== '' ? record.projectId : undefined
    const tasklistId = typeof record.tasklistId === 'string' && record.tasklistId !== '' ? record.tasklistId : undefined
    return {
      ...(projectId === undefined ? {} : { projectId }),
      ...(tasklistId === undefined ? {} : { tasklistId }),
    }
  } catch {
    // Storage disabled or holding unrelated JSON: only this page lifetime remembers.
    return {}
  }
}

/**
 * Remember one board selection for the next visit.
 * @param selection - project (and optional task list) currently shown.
 */
function writeSelection(selection: TeambitionSelection): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(SELECTION_STORAGE_KEY, JSON.stringify(selection))
  } catch {
    // Storage disabled: keep the in-memory selection, never fail the panel.
  }
}

/**
 * localStorage key of the saved view remembered per project.
 *
 * A saved view ("智能视图") is a project fact, so the map is keyed by project id:
 * opening project A on its status board never changes the view project B opens on.
 */
export const VIEW_STORAGE_KEY = 'dsh.teambition.views.v1'

/** Remembered saved view ids, keyed by Teambition project id. */
type ViewByProject = Record<string, string>

/**
 * Read the remembered view map.
 * @returns every remembered `{ projectId: viewId }` pair; empty when none/unreadable.
 */
function readViews(): ViewByProject {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(VIEW_STORAGE_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const views: ViewByProject = {}
    for (const [projectId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (projectId !== '' && typeof value === 'string' && value !== '') views[projectId] = value
    }
    return views
  } catch {
    // Storage disabled or holding unrelated JSON: no remembered view.
    return {}
  }
}

/**
 * Remember (or forget) the saved view of one project.
 * @param projectId - project the view belongs to.
 * @param viewId - saved view id; undefined forgets the entry.
 */
function writeView(projectId: string, viewId: string | undefined): void {
  try {
    if (typeof localStorage === 'undefined') return
    const views = readViews()
    if (viewId === undefined) delete views[projectId]
    else views[projectId] = viewId
    localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(views))
  } catch {
    // Storage disabled: keep the in-memory view, never fail the panel.
  }
}

/** The remembered saved view of one project, read once for the initial state. */
function rememberedView(projectId: string | undefined): string | undefined {
  return projectId === undefined ? undefined : readViews()[projectId]
}

/** A project's saved views, or an empty list when the payload carries none. */
function viewsOf(detail: TeambitionProjectDetail): readonly TeambitionViewView[] {
  return detail.views ?? []
}

/**
 * A project's board columns, falling back to its stages for an older host payload.
 * @param detail - project detail read from the host.
 * @returns the columns of the resolved view, in board order.
 */
function columnsOfDetail(detail: TeambitionProjectDetail): readonly TeambitionColumnView[] {
  const columns = detail.columns ?? []
  if (columns.length > 0) return columns
  return detail.stages.map(stage => ({
    id: stage.id,
    name: stage.name,
    kind: 'stage',
    ...(stage.tasklistId === undefined ? {} : { tasklistId: stage.tasklistId }),
  }))
}

/** Whether the resolved view draws workflow statuses instead of kanban stages. */
function isStatusView(view: TeambitionViewView | undefined, columns: readonly TeambitionColumnView[]): boolean {
  if (view !== undefined) return view.vertical === 'status'
  return columns.length > 0 && columns.every(column => column.kind === 'status')
}

/**
 * The board column a card sits in.
 *
 * Columns are matched by kind: a stage column owns the card's `stageId`, a status
 * column the card's `statusId`; the first match wins (status views only carry
 * status columns, stage views only stage columns).
 * @param card - card to place.
 * @param columns - columns of the resolved view.
 * @returns the matching column id, or undefined when the card sits outside them.
 */
function columnIdOf(card: TeambitionCardView, columns: readonly TeambitionColumnView[]): string | undefined {
  for (const column of columns) {
    if (column.kind === 'stage' && card.stageId === column.id) return column.id
    if (column.kind === 'status' && card.statusId === column.id) return column.id
  }
  return undefined
}

/**
 * Ids of the workflow START statuses of a project.
 *
 * A status board can only receive a new card in a start status (the host sends
 * `_taskflowstatusId` next to `_scenariofieldconfigId`), so the create form asks
 * this set which columns are valid targets.
 * @param detail - project detail read from the host.
 * @returns the ids of `kind: 'start'` statuses of every workflow.
 */
function startStatusIdsOf(detail: TeambitionProjectDetail): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const workflow of detail.workflows ?? []) {
    for (const status of workflow.statuses) if (status.kind === 'start') ids.add(status.id)
  }
  for (const status of detail.statuses) if (status.kind === 'start') ids.add(status.id)
  return ids
}

/**
 * First column a new card can be created in.
 * @param columns - columns of the resolved view.
 * @param startIds - ids of the workflow start statuses.
 * @returns the first status column with a start status, when there is one.
 */
function firstStartColumn(columns: readonly TeambitionColumnView[], startIds: ReadonlySet<string>): TeambitionColumnView | undefined {
  return columns.find(column => column.kind === 'status' && startIds.has(column.id))
}

/** Teambition web board of one project, for the empty-state external link. */
function projectBoardUrl(projectId: string): string {
  return `https://www.teambition.com/project/${encodeURIComponent(projectId)}/board`
}

/**
 * A task list with the columns and cards that belong to it.
 *
 * Columns belong to task lists in Teambition, so the flat project payload is
 * grouped by this id before rendering: two lists of one project may both have a
 * column named "待办", and a flat board would show dozens of duplicate columns.
 */
interface TasklistGroup {
  readonly id: string
  readonly name: string
  readonly columns: readonly TeambitionColumnView[]
  readonly cards: readonly TeambitionCardView[]
}


/** Services the layout's main-slot registration injects into the page. */
export interface TeambitionPanelProps {
  /** Session service: create + retain a Client Session for a card run. */
  readonly sessions: SessionsFace
  /** Workspace roster the binding pickers read. */
  readonly workspaces: WorkspacesFace
  /** Workspace UI navigation: show the session created by a card run. */
  readonly uiWorkspace: UiWorkspaceFace
  /** Route client override (tests inject a fake). */
  readonly api?: TeambitionApiFace
}

/** Which surface the body shows. */
type PanelView = 'tasks' | 'board' | 'settings'

/** How the task module groups its rows. */
type TaskGrouping = 'none' | 'tasklist' | 'stage' | 'executor'

/** Which rows the task module keeps. */
type TaskFilter = 'all' | 'open' | 'done' | 'overdue' | 'unassigned'

/** Row order of the task module. */
type TaskSort = 'updated' | 'created' | 'due' | 'priority'

/** One rendered group of task rows. */
interface TaskGroup {
  readonly key: string
  readonly label: string
  readonly cards: readonly TeambitionCardView[]
}

/** Remembered task-module controls, so a reload keeps the working set. */
export const TASK_VIEW_STORAGE_KEY = 'dsh.teambition.taskview.v2'

/** The two working surfaces of the panel; the setting view is not remembered. */
type TaskView = 'tasks' | 'board'

/** Task-module controls persisted between visits. */
interface TaskViewSettings {
  readonly view: TaskView
  readonly groupBy: TaskGrouping
  readonly filterBy: TaskFilter
  readonly sortBy: TaskSort
  /** Task list the table is narrowed to; empty means every list. */
  readonly tasklistFilter: string
}

/** Read the remembered task-module controls. */
function readTaskView(): TaskViewSettings {
  const fallback: TaskViewSettings = { view: 'tasks', groupBy: 'none', filterBy: 'all', sortBy: 'updated', tasklistFilter: '' }
  try {
    if (typeof localStorage === 'undefined') return fallback
    const raw = localStorage.getItem(TASK_VIEW_STORAGE_KEY)
    if (raw === null) return fallback
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return fallback
    const record = parsed as Record<string, unknown>
    const view: TaskView = record.view === 'board' ? 'board' : 'tasks'
    const groupBy = record.groupBy === 'tasklist' || record.groupBy === 'stage' || record.groupBy === 'executor' ? record.groupBy : 'none'
    const filterBy = record.filterBy === 'open' || record.filterBy === 'done' || record.filterBy === 'overdue' || record.filterBy === 'unassigned' ? record.filterBy : 'all'
    const sortBy = record.sortBy === 'created' || record.sortBy === 'due' || record.sortBy === 'priority' ? record.sortBy : 'updated'
    const tasklistFilter = typeof record.tasklistFilter === 'string' ? record.tasklistFilter : ''
    return { view, groupBy, filterBy, sortBy, tasklistFilter }
  } catch {
    return fallback
  }
}

/** Remember the task-module controls for the next visit. */
function writeTaskView(settings: TaskViewSettings): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(TASK_VIEW_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Storage disabled: keep the in-memory controls, never fail the panel.
  }
}

/** Load phase of one remote read. */
type Phase = 'idle' | 'loading' | 'ready' | 'failed'

/** Message of any thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Throw when a service call answered with a failed `RemoteResult` envelope.
 * A plain value or a success envelope is left alone.
 * @param result - value the session service returned.
 */
function assertRemoteOk(result: unknown): void {
  if (typeof result !== 'object' || result === null) return
  if (!('ok' in result) || (result as { readonly ok?: unknown }).ok !== false) return
  const failure = (result as { readonly error?: unknown }).error
  const message = typeof failure === 'object' && failure !== null && 'message' in failure && typeof (failure as { message?: unknown }).message === 'string'
    ? (failure as { readonly message: string }).message
    : t('run.promptRejected')
  throw new Error(message)
}

/** Display title of a workspace row (title, then path, then id). */
function workspaceTitle(item: WorkspaceItemView): string {
  const title = item.title ?? ''
  if (title !== '') return title
  return item.path !== undefined && item.path !== '' ? item.path : item.workspaceId
}

/** Where a card's execution workspace came from, for the chip tooltip. */
function sourceLabel(choice: TeambitionWorkspaceChoice): string {
  if (choice.source === 'card') return t('card.workspaceSourceCard')
  if (choice.source === 'project') return t('card.workspaceSourceProject')
  return t('card.workspaceSourceDefault')
}

/** Localized conclusion label of a diagnose report. */
function conclusionLabel(diagnostics: TeambitionDiagnostics): string {
  return t(`conclusion.${diagnostics.conclusion}` as TeambitionKey)
}

/** Format an epoch-ms instant, or a dash when unknown. */
function formatTime(value: number | undefined): string {
  if (value === undefined) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString()
}

/**
 * Label of a Teambition priority value.
 *
 * `-10` is the value Teambition reports for its default "普通" priority, so it
 * renders no flag at all; higher values are the explicit levels.
 * @param priority - raw `priority` from the API.
 * @returns the localized label, or undefined when the priority is the default.
 */
function priorityLabel(priority: number | undefined): string | undefined {
  if (priority === undefined || priority === -10) return undefined
  if (priority === 0) return t('tasks.priorityUrgent')
  if (priority === 1) return t('tasks.priorityVeryUrgent')
  if (priority === 2) return t('tasks.priorityHighest')
  return t('tasks.priorityOther', { value: String(priority) })
}

/** Rank of a priority for sorting (higher sorts first). */
function priorityRank(priority: number | undefined): number {
  if (priority === undefined || priority === -10) return 0
  return priority + 1
}

/** Short localized calendar day of an instant. */
function formatDay(value: number | undefined): string {
  if (value === undefined) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Compact date-time for the table cells, without the seconds. */
function formatMoment(value: number | undefined): string {
  if (value === undefined) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? '-'
    : date.toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** Due state of one task, used for the red "overdue" styling. */
function dueState(card: TeambitionCardView): 'none' | 'overdue' | 'soon' | 'normal' {
  if (card.dueAt === undefined) return 'none'
  if (card.isDone === true) return 'normal'
  const due = new Date(card.dueAt)
  if (Number.isNaN(due.getTime())) return 'none'
  const now = new Date()
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const days = Math.round((dueDay - today) / 86_400_000)
  if (days < 0) return 'overdue'
  if (days <= 1) return 'soon'
  return 'normal'
}

/**
 * The panel page.
 * @param props - injected service faces and the optional route client.
 * @returns the full-height Teambition page.
 */
export function TeambitionPanel(props: TeambitionPanelProps): ReactElement {
  const api = props.api ?? DEFAULT_API
  const { sessions, workspaces: workspaceService, uiWorkspace } = props

  // The last visited project and task list come from storage, so a reload opens
  // the board the user worked in instead of the first joined project.
  const [initialSelection] = useState<TeambitionSelection>(readSelection)
  const [projectId, setProjectId] = useState<string | undefined>(initialSelection.projectId)
  const [tasklistId, setTasklistId] = useState<string | undefined>(initialSelection.tasklistId)
  // Saved view of the project; undefined means the project's default view.
  const [viewId, setViewId] = useState<string | undefined>(() => rememberedView(initialSelection.projectId))
  const [detail, setDetail] = useState<TeambitionProjectDetail>()
  const [detailPhase, setDetailPhase] = useState<Phase>('idle')
  const [detailError, setDetailError] = useState<string>()

  const [roster, setRoster] = useState<readonly WorkspaceItemView[]>(() => [...workspaceService.list.getSnapshot().items])

  const [runningCardId, setRunningCardId] = useState<string>()
  const [pendingCardId, setPendingCardId] = useState<string>()
  const [cardErrors, setCardErrors] = useState<Readonly<Record<string, string>>>({})
  /** Card being dragged, plus the column it currently hovers as a drop target. */
  const [draggingCardId, setDraggingCardId] = useState<string>()
  const [dropColumnId, setDropColumnId] = useState<string>()

  const [draftTitle, setDraftTitle] = useState('')
  const [draftNote, setDraftNote] = useState('')
  /** Board column the create form pre-selects (a stage id or a status id). */
  const [draftColumnId, setDraftColumnId] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string>()

  // Task-module controls: surface, search, grouping, filter and order.
  const [initialTaskView] = useState<TaskViewSettings>(readTaskView)
  // The remembered surface is the default view: opening the panel, or picking
  // another project, lands on it instead of always resetting to the task table.
  const [view, setView] = useState<PanelView>(initialTaskView.view)
  // The surface the settings button returns to.
  const [returnView, setReturnView] = useState<TaskView>(initialTaskView.view)
  const [query, setQuery] = useState('')
  const [groupBy, setGroupBy] = useState<TaskGrouping>(initialTaskView.groupBy)
  const [filterBy, setFilterBy] = useState<TaskFilter>(initialTaskView.filterBy)
  const [sortBy, setSortBy] = useState<TaskSort>(initialTaskView.sortBy)
  /** Task list the table is narrowed to; empty means every list of the project. */
  const [tasklistFilter, setTasklistFilter] = useState<string>(initialTaskView.tasklistFilter)
  /** Card whose detail drawer is open; undefined closes it. */
  const [activeCardId, setActiveCardId] = useState<string>()

  const [state, setState] = useState<TeambitionStateView>()
  const [statePhase, setStatePhase] = useState<Phase>('loading')
  const [stateError, setStateError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [noticeError, setNoticeError] = useState(false)
  const [busy, setBusy] = useState(false)

  // Remember the task-module controls between visits; the settings surface is
  // never stored as the default view.
  useEffect(() => {
    const remembered: TaskView = view === 'settings' ? returnView : view
    writeTaskView({ view: remembered, groupBy, filterBy, sortBy, tasklistFilter })
  }, [view, returnView, groupBy, filterBy, sortBy, tasklistFilter])

  /** Read sequence guard: a stale project read must not overwrite a newer one. */
  const projectSeq = useRef(0)

  /** Title input of the create form, focused by a column's quick-add button. */
  const titleInput = useRef<HTMLInputElement>(null)

  // The roster is a live service fact: follow the list instead of snapshotting.
  useEffect(() => {
    const read = (): void => { setRoster([...workspaceService.list.getSnapshot().items]) }
    read()
    return workspaceService.list.subscribe(read)
  }, [workspaceService])

  /** Read the panel snapshot (settings + joined projects + diagnostics). */
  const loadState = useCallback(async (): Promise<TeambitionStateView | undefined> => {
    setStatePhase('loading')
    setStateError(undefined)
    const result = await api.fetchState()
    if (!result.ok) {
      setStatePhase('failed')
      setStateError(result.error.message)
      return undefined
    }
    setState(result.value)
    setStatePhase('ready')
    return result.value
  }, [api])

  /**
   * Read one project (saved views, columns, statuses, cards) — one task list, or
   * all of them — resolved for one saved view (absent means the default view).
   */
  const loadProject = useCallback(async (id: string, list: string | undefined, savedView: string | undefined): Promise<void> => {
    const seq = ++projectSeq.current
    setDetailPhase('loading')
    setDetailError(undefined)
    const result = await api.fetchProject(id, list, savedView)
    if (seq !== projectSeq.current) return
    if (!result.ok) {
      setDetailPhase('failed')
      setDetailError(result.error.message)
      return
    }
    setDetail(result.value)
    setDetailPhase('ready')
  }, [api])

  useEffect(() => { void loadState() }, [loadState])

  // Pick the first project once the list arrives; keep a still-valid choice.
  // A remembered project that no longer exists (left/renamed) falls back to the
  // first one, and the task list belongs to the previous project, so it is reset.
  useEffect(() => {
    if (state === undefined) return
    if (projectId !== undefined && state.projects.some(project => project.id === projectId)) return
    const next = state.projects[0]?.id
    setProjectId(next)
    setTasklistId(undefined)
    // The previous project's saved view does not apply to the new one: use the
    // view remembered for that project, or its default view.
    setViewId(rememberedView(next))
  }, [state, projectId])

  // Remember every explicit selection for the next visit.
  useEffect(() => {
    if (projectId === undefined) return
    writeSelection(tasklistId === undefined ? { projectId } : { projectId, tasklistId })
  }, [projectId, tasklistId])

  // Remember the saved view per project, so the board reopens on it next visit.
  useEffect(() => {
    if (projectId === undefined) return
    writeView(projectId, viewId)
  }, [projectId, viewId])

  // A remembered view the project no longer has (deleted/renamed) drops back to
  // the default view instead of leaving the board on an unknown id.
  useEffect(() => {
    if (viewId === undefined || detail === undefined || detail.project.id !== projectId) return
    if (viewsOf(detail).some(view => view.id === viewId)) return
    setViewId(undefined)
  }, [detail, projectId, viewId])

  // Read the board: the selected task list, or every list of the project, in the
  // selected saved view.
  useEffect(() => {
    if (projectId === undefined) {
      setDetail(undefined)
      setDetailPhase('idle')
      return
    }
    void loadProject(projectId, tasklistId, viewId)
  }, [projectId, tasklistId, viewId, loadProject])

  // A remembered/selected task list that the project no longer has drops back to
  // "all task lists" instead of leaving the board on a nonexistent id.
  useEffect(() => {
    if (tasklistId === undefined || detail === undefined) return
    const tasklists = detail.tasklists ?? []
    if (tasklists.some(list => list.id === tasklistId)) return
    setTasklistId(undefined)
  }, [detail, tasklistId])

  // The toolbar task-list filter belongs to one project: switching projects
  // clears it (but a reload keeps the remembered one).
  const lastProject = useRef<string | undefined>(initialSelection.projectId)
  useEffect(() => {
    if (lastProject.current === projectId) return
    lastProject.current = projectId
    setTasklistFilter('')
  }, [projectId])

  // Same for a remembered filter whose task list the project no longer has.
  useEffect(() => {
    if (tasklistFilter === '' || detail === undefined) return
    const tasklists = detail.tasklists ?? []
    if (tasklists.some(list => list.id === tasklistFilter)) return
    setTasklistFilter('')
  }, [detail, tasklistFilter])

  // The create form's column picker only offers the selected view's columns.
  useEffect(() => { setDraftColumnId('') }, [projectId, tasklistId, viewId])

  const setCardError = useCallback((cardId: string, message: string | undefined): void => {
    setCardErrors(previous => {
      if (previous[cardId] === message) return previous
      const next = { ...previous }
      if (message === undefined) delete next[cardId]
      else next[cardId] = message
      return next
    })
  }, [])

  const flash = useCallback((message: string, isError = false): void => {
    setNotice(message)
    setNoticeError(isError)
  }, [])

  /** Refresh projects from Teambition, then re-read everything on screen. */
  const refreshAll = useCallback(async (): Promise<void> => {
    setBusy(true)
    setNotice(undefined)
    const projects = await api.refreshProjects()
    if (!projects.ok) flash(t('error.generic', { message: projects.error.message }), true)
    await loadState()
    if (projectId !== undefined) await loadProject(projectId, tasklistId, viewId)
    setBusy(false)
  }, [api, flash, loadProject, loadState, projectId, tasklistId, viewId])

  /** Resolved execution workspace of one card (host value, else the contract). */
  const cardChoice = useCallback((card: TeambitionCardView, settings: TeambitionSettingsView): TeambitionWorkspaceChoice | undefined => {
    if (card.workspaceId !== undefined) {
      return { workspaceId: card.workspaceId, source: card.workspaceSource ?? 'default' }
    }
    return resolveWorkspace(card.id, card.projectId, settings)
  }, [])

  /** Run one card in its bound workspace: create, retain, prompt, open. */
  const runCard = useCallback(async (card: TeambitionCardView): Promise<void> => {
    if (runningCardId !== undefined || state === undefined) return
    const choice = cardChoice(card, state.settings)
    const workspaceId = choice?.workspaceId ?? roster[0]?.workspaceId
    if (workspaceId === undefined) {
      setCardError(card.id, t('error.noWorkspace'))
      return
    }
    setCardError(card.id, undefined)
    setRunningCardId(card.id)
    try {
      const sessionId = await sessions.create({ workspaceId })
      const ref = sessions.retain(sessionId, { source: 'teambition' })
      try {
        await ref.ready
        const text = buildCardPrompt({
          id: card.id,
          projectId: card.projectId,
          title: card.title,
          note: card.note,
          updatedAt: card.updatedAt,
        }, card.projectName, t('run.promptIntro'))
        await ref.binding.session.prompt([{ type: 'text', text }], 'queue').then(assertRemoteOk)
      } finally {
        ref.release()
      }
      uiWorkspace.openSession(sessionId)
    } catch (error) {
      setCardError(card.id, t('run.failed', { message: messageOf(error) }))
    } finally {
      setRunningCardId(undefined)
    }
  }, [cardChoice, roster, runningCardId, sessions, setCardError, state, uiWorkspace])

  /** Move one card's workflow status, then re-read the project. */
  const changeStatus = useCallback(async (taskId: string, statusId: string): Promise<void> => {
    if (pendingCardId !== undefined) return
    setPendingCardId(taskId)
    setCardError(taskId, undefined)
    const result = await api.setTaskStatus({ taskId, statusId })
    if (!result.ok) setCardError(taskId, t('error.generic', { message: result.error.message }))
    else if (projectId !== undefined) await loadProject(projectId, tasklistId, viewId)
    setPendingCardId(undefined)
  }, [api, loadProject, pendingCardId, projectId, tasklistId, viewId, setCardError])

  /** Move one card to another kanban column, then re-read the project. */
  const changeStage = useCallback(async (taskId: string, stageId: string): Promise<void> => {
    if (pendingCardId !== undefined) return
    setPendingCardId(taskId)
    setCardError(taskId, undefined)
    const result = await api.setTaskStage({ taskId, stageId })
    if (!result.ok) setCardError(taskId, t('error.generic', { message: result.error.message }))
    else if (projectId !== undefined) await loadProject(projectId, tasklistId, viewId)
    setPendingCardId(undefined)
  }, [api, loadProject, pendingCardId, projectId, tasklistId, viewId, setCardError])

  /** Move a dragged card into a column, choosing the route by kind. */
  const dropCard = useCallback((cardId: string, column: TeambitionColumnView): void => {
    const card = detail?.cards.find(candidate => candidate.id === cardId)
    if (card === undefined || column.id === '') return
    const columns = detail?.columns ?? []
    if (columnIdOf(card, columns) === column.id) return
    if (column.kind === 'status') void changeStatus(card.id, column.id)
    else void changeStage(card.id, column.id)
  }, [changeStage, changeStatus, detail])

  /** Persist one card's workspace override (empty id clears it). */
  const bindCard = useCallback(async (card: TeambitionCardView, workspaceId: string): Promise<void> => {
    if (state === undefined || pendingCardId !== undefined) return
    const cardBindings: TeambitionCardBinding[] = state.settings.cardBindings
      .filter(binding => binding.taskId !== card.id)
      .map(binding => ({ taskId: binding.taskId, workspaceId: binding.workspaceId }))
    if (workspaceId !== '') cardBindings.push({ taskId: card.id, workspaceId })
    const request: TeambitionBindRequest = {
      cardBindings,
      projectBindings: state.settings.projectBindings,
      defaultWorkspaceId: state.settings.defaultWorkspaceId ?? null,
    }
    setPendingCardId(card.id)
    setCardError(card.id, undefined)
    const result = await api.saveBindings(request)
    if (!result.ok) {
      setCardError(card.id, t('error.generic', { message: result.error.message }))
    } else {
      await loadState()
      flash(t('settings.saved'))
    }
    setPendingCardId(undefined)
  }, [api, flash, loadState, pendingCardId, setCardError, state])

  /** Create a card in the selected project/view, then re-read it. */
  const submitCreate = useCallback(async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (projectId === undefined || creating) return
    const title = draftTitle.trim()
    if (title === '') {
      setCreateError(t('create.titleRequired'))
      return
    }
    setCreating(true)
    setCreateError(undefined)
    // The card belongs to the selected task list; with "all task lists" shown,
    // the chosen column names the list it belongs to.
    const columns = detail === undefined ? [] : columnsOfDetail(detail)
    const activeView = detail === undefined
      ? undefined
      : viewsOf(detail).find(candidate => candidate.id === (viewId ?? detail.viewId))
    const statusView = isStatusView(activeView, columns)
    const chosen = columns.find(column => column.id === draftColumnId)
    const cardTasklistId = tasklistId ?? chosen?.tasklistId
    // A status board creates in a workflow START status and needs the view's task
    // type; a stage board creates in a kanban column and sends no scenario id.
    const startIds = detail === undefined ? new Set<string>() : startStatusIdsOf(detail)
    const statusId = statusView
      ? (chosen !== undefined && startIds.has(chosen.id) ? chosen.id : firstStartColumn(columns, startIds)?.id)
      : undefined
    const stageId = statusView ? undefined : (chosen?.kind === 'stage' ? chosen.id : undefined)
    const scenarioConfigId = statusView ? activeView?.scenarioConfigIds[0] : undefined
    const result = await api.createTask({
      projectId,
      title,
      ...(cardTasklistId === undefined ? {} : { tasklistId: cardTasklistId }),
      ...(draftNote.trim() === '' ? {} : { note: draftNote.trim() }),
      ...(stageId === undefined ? {} : { stageId }),
      ...(statusId === undefined ? {} : { statusId }),
      ...(scenarioConfigId === undefined ? {} : { scenarioConfigId }),
    })
    setCreating(false)
    if (!result.ok) {
      setCreateError(t('error.generic', { message: result.error.message }))
      return
    }
    setDraftTitle('')
    setDraftNote('')
    await loadProject(projectId, tasklistId, viewId)
  }, [api, creating, detail, draftColumnId, draftNote, draftTitle, loadProject, projectId, tasklistId, viewId])

  const settings = state?.settings
  const projects: readonly TeambitionProject[] = state?.projects ?? []
  const activeProject = projects.find(project => project.id === projectId)
  const cards = detail?.cards ?? []
  const tasklists = detail?.tasklists ?? []

  const header = (
    <header className={css.header}>
      <h2 className={css.title}>{t('header.title')}</h2>
      {settings === undefined ? null : (
        <span
          className={`${css.status} ${settings.configured ? css.statusOn : css.statusOff}`}
          data-dsh-part="connection"
          data-connected={settings.configured ? 'true' : 'false'}
        >
          {settings.configured ? t('connection.ok') : t('connection.unconfigured')}
        </span>
      )}
      <span className={css.spacer} />
      {view === 'settings' ? null : (
        <div className={css.viewSwitch} role="tablist" aria-label={t('header.title')} data-dsh-part="view-switch">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'tasks'}
            className={view === 'tasks' ? `${css.viewTab} ${css.viewTabActive}` : css.viewTab}
            onClick={() => { setReturnView('tasks'); setView('tasks') }}
          >
            {t('view.tasks')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'board'}
            className={view === 'board' ? `${css.viewTab} ${css.viewTabActive}` : css.viewTab}
            onClick={() => { setReturnView('board'); setView('board') }}
          >
            {t('view.board')}
          </button>
        </div>
      )}
      {view !== 'settings' && projects.length > 0 ? (
        <label className={css.projectField} data-dsh-part="project-picker">
          <span>{t('header.project')}</span>
          <select
            className={css.select}
            value={projectId ?? ''}
            disabled={busy}
            aria-label={t('header.project')}
            onChange={event => {
              // The previous task list and saved view belong to the previous project.
              const next = event.target.value === '' ? undefined : event.target.value
              setProjectId(next)
              setTasklistId(undefined)
              setViewId(rememberedView(next))
            }}
          >
            {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
      ) : null}
      {view !== 'settings' && tasklists.length > 1 ? (
        <label className={css.projectField} data-dsh-part="tasklist-picker">
          <span>{t('header.tasklist')}</span>
          <select
            className={css.select}
            value={tasklistId ?? ''}
            disabled={busy}
            aria-label={t('header.tasklist')}
            onChange={event => { setTasklistId(event.target.value === '' ? undefined : event.target.value) }}
          >
            <option value="">{t('header.tasklistAll')}</option>
            {tasklists.map(list => <option key={list.id} value={list.id}>{list.name}</option>)}
          </select>
        </label>
      ) : null}
      {view !== 'settings' && tasklists.length === 1 ? (
        <span className={css.projectField} data-dsh-part="tasklist" data-tasklist-id={tasklists[0].id}>
          <span>{t('header.tasklist')}</span>
          <span className={css.tasklistName}>{tasklists[0].name}</span>
        </span>
      ) : null}
      <button
        type="button"
        className={css.button}
        disabled={busy || statePhase === 'loading'}
        onClick={() => { void (view === 'settings' ? loadState() : refreshAll()) }}
      >
        {busy ? t('header.refreshing') : t('header.refresh')}
      </button>
      <button
        type="button"
        className={css.button}
        aria-pressed={view === 'settings'}
        onClick={() => {
          if (view === 'settings') setView(returnView)
          else { setReturnView(view); setView('settings') }
        }}
      >
        {view === 'settings' ? t('header.back') : t('header.settings')}
      </button>
    </header>
  )

  const noticeLine = notice === undefined ? null : (
    <p className={`${css.notice} ${noticeError ? css.noticeError : ''}`} role={noticeError ? 'alert' : 'status'}>{notice}</p>
  )

  let body: ReactElement
  if (statePhase === 'loading' && state === undefined) {
    body = <div className={css.stateBox}><span data-dsh-part="loading">{t('panel.loading')}</span></div>
  } else if (statePhase === 'failed' && state === undefined) {
    body = (
      <div className={css.stateBox}>
        <span className={css.errorText} role="alert">{t('error.transport')}{stateError === undefined ? '' : ` ${stateError}`}</span>
        <button type="button" className={css.button} onClick={() => { void loadState() }}>{t('panel.retry')}</button>
      </div>
    )
  } else if (state === undefined) {
    body = <div className={css.stateBox}><span>{t('panel.loading')}</span></div>
  } else if (view === 'settings') {
    body = <TeambitionSettings
      state={state}
      projects={state.projects}
      roster={roster}
      api={api}
      defaultView={view === 'settings' ? returnView : view}
      onDefaultView={(next) => { setReturnView(next); setView(next) }}
      onSaved={async () => { await loadState() }}
      notify={flash}
    />
  } else if (state.projects.length === 0) {
    body = (
      <div className={css.stateBox}>
        <span>{t('panel.noProjects')}</span>
        <span className={css.hint}>{t('panel.noProjectsHint')}</span>
        <button type="button" className={css.button} onClick={() => { setView('settings') }}>{t('panel.openSettings')}</button>
      </div>
    )
  } else if (detailPhase === 'loading' && detail === undefined) {
    body = <div className={css.stateBox}><span>{t('panel.loadingProject')}</span></div>
  } else if (detailPhase === 'failed') {
    body = (
      <div className={css.stateBox}>
        <span className={css.errorText} role="alert">{detailError ?? t('error.transport')}</span>
        <button type="button" className={css.button} onClick={() => { if (projectId !== undefined) void loadProject(projectId, tasklistId, viewId) }}>{t('panel.retry')}</button>
      </div>
    )
  } else if (detail === undefined) {
    body = <div className={css.stateBox}><span>{t('panel.loadingProject')}</span></div>
  } else {
    // The board draws the columns of the resolved saved view (stage or workflow
    // status columns), never `detail.stages` directly: a status view has no
    // stages at all, and a stage view's saved view may reorder them.
    const columns = columnsOfDetail(detail)
    const views = viewsOf(detail)
    const activeView = views.find(view => view.id === (viewId ?? detail.viewId))
      ?? views.find(view => view.isDefault === true)
    const resolvedViewId = activeView?.id ?? viewId ?? detail.viewId
    const statusView = isStatusView(activeView, columns)
    const startIds = startStatusIdsOf(detail)
    // A card's task list falls back to the list of its column: the host tags
    // both, but a payload that only tags the column must still group.
    const columnTasklist = new Map<string, string | undefined>(columns.map(column => [column.id, column.tasklistId]))
    const listIdOfCard = (card: TeambitionCardView): string | undefined => {
      const columnId = columnIdOf(card, columns)
      const fromColumn = columnId === undefined ? undefined : columnTasklist.get(columnId)
      return card.tasklistId ?? fromColumn
    }
    const knownList = (listId: string | undefined): boolean =>
      listId !== undefined && tasklists.some(list => list.id === listId)
    // Only "all task lists" with several lists needs the grouped layout: with one
    // list the flat board already is that list's board. A status view has no
    // per-list columns, so it always renders one flat board.
    const grouped = tasklistId === undefined && tasklists.length > 1 && columns.some(column => column.kind === 'stage')
    const groups: readonly TasklistGroup[] = grouped
      ? tasklists.map(list => ({
          id: list.id,
          name: list.name,
          columns: columns.filter(column => column.tasklistId === list.id),
          cards: cards.filter(card => listIdOfCard(card) === list.id),
        }))
      : []
    // Columns and cards the host did not attribute to a listed task list still
    // render in one trailing group instead of silently disappearing.
    const strayColumns = grouped ? columns.filter(column => !knownList(column.tasklistId)) : []
    const strayCards = grouped ? cards.filter(card => !knownList(listIdOfCard(card))) : []

    /** A project without declared columns still renders its cards: one bucket. */
    const boardColumnsOf = (list: readonly TeambitionColumnView[]): readonly TeambitionColumnView[] =>
      list.length === 0 ? [{ id: '', name: t('board.unassignedColumn'), kind: 'stage' }] : list

    /** Cards of one column of `allColumns`; the placeholder bucket keeps every card. */
    const cardsIn = (
      boardCards: readonly TeambitionCardView[],
      column: TeambitionColumnView,
      allColumns: readonly TeambitionColumnView[],
    ): readonly TeambitionCardView[] =>
      column.id === '' ? boardCards : boardCards.filter(card => columnIdOf(card, allColumns) === column.id)

    const renderColumn = (column: TeambitionColumnView, columnCards: readonly TeambitionCardView[], moveColumns: readonly TeambitionColumnView[]): ReactElement => {
      // A column accepts a dragged card only when the drop actually moves it:
      // the placeholder bucket and the card's own column are not targets.
      const acceptsDrop = draggingCardId !== undefined
        && column.id !== ''
        && !columnCards.some(card => card.id === draggingCardId)
      const isDropTarget = acceptsDrop && dropColumnId === column.id
      return (
      <section
        className={css.column}
        key={column.id === '' ? '__all' : column.id}
        data-dsh-part="column"
        data-column-id={column.id}
        data-column-kind={column.kind}
        data-tasklist-id={column.tasklistId ?? ''}
        data-drop-target={isDropTarget ? 'true' : 'false'}
        onDragOver={event => {
          if (!acceptsDrop) return
          event.preventDefault()
          if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move'
          if (dropColumnId !== column.id) setDropColumnId(column.id)
        }}
        onDragLeave={event => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
          if (dropColumnId === column.id) setDropColumnId(undefined)
        }}
        onDrop={event => {
          event.preventDefault()
          const cardId = event.dataTransfer?.getData('text/plain') ?? draggingCardId ?? ''
          setDropColumnId(undefined)
          setDraggingCardId(undefined)
          if (cardId === '') return
          dropCard(cardId, column)
        }}
      >
        <header className={css.columnHead} data-dsh-part="column-head">
          <h3 className={css.columnTitle}>{column.name}</h3>
          <span className={css.columnCount}>{String(columnCards.length)}</span>
          <span className={css.spacer} />
          <button
            type="button"
            className={css.columnAdd}
            data-dsh-part="column-add"
            aria-label={t('board.addCard', { name: column.name })}
            title={t('board.addCard', { name: column.name })}
            disabled={column.id === ''}
            onClick={() => {
              // "Gutter add": pre-select the column in the create form and focus
              // its title, so the card lands where the user clicked the plus.
              setDraftColumnId(column.id)
              titleInput.current?.focus()
            }}
          >
            +
          </button>
        </header>
        <div className={css.columnBody}>
          {columnCards.length === 0
            ? <p className={css.columnEmpty}>{t('board.empty')}</p>
            : columnCards.map(card => renderCard({
                card,
                statusName: statusNameOf(card),
                columns: moveColumns,
                currentColumnId: columnIdOf(card, moveColumns) ?? '',
                statusView,
                settings: state.settings,
                roster,
                detail,
                running: runningCardId === card.id,
                pending: pendingCardId === card.id,
                busy: runningCardId !== undefined || pendingCardId !== undefined,
                error: cardErrors[card.id],
                choice: cardChoice(card, state.settings),
                dragging: draggingCardId === card.id,
                onDragStart: () => { setDraggingCardId(card.id) },
                onDragEnd: () => { setDraggingCardId(undefined); setDropColumnId(undefined) },
                onRun: () => { void runCard(card) },
                onStatus: statusId => { void changeStatus(card.id, statusId) },
                onStage: stageId => { void changeStage(card.id, stageId) },
                onBind: workspaceId => { void bindCard(card, workspaceId) },
              }))}
        </div>
      </section>
      )
    }

    const renderBoard = (
      boardColumns: readonly TeambitionColumnView[],
      boardCards: readonly TeambitionCardView[],
      moveColumns: readonly TeambitionColumnView[],
      nested = false,
    ): ReactElement => (
      <div
        className={nested ? `${css.board} ${css.boardNested}` : css.board}
        data-dsh-part="board"
        data-view-id={resolvedViewId ?? ''}
        data-view-vertical={statusView ? 'status' : 'stage'}
      >
        {boardColumnsOf(boardColumns).map(column => renderColumn(
          column,
          cardsIn(boardCards, column, boardColumns),
          moveColumns,
        ))}
      </div>
    )

    /** Name of the column a card sits in (status boards resolve statuses here). */
    const statusNameOf = (card: TeambitionCardView): string | undefined => {
      const columnId = columnIdOf(card, columns)
      const column = columnId === undefined ? undefined : columns.find(candidate => candidate.id === columnId)
      if (column !== undefined && column.kind === 'status') return column.name
      return card.statusId === undefined ? undefined : detail.statuses.find(status => status.id === card.statusId)?.name
    }

    /** Left rail of the project's saved views; only shown when it has some. */
    const renderViewRail = (): ReactElement | null => {
      if (views.length === 0) return null
      return (
        <nav className={css.rail} data-dsh-part="view-rail" aria-label={t('board.viewRail')}>
          <span className={css.railTitle}>{t('board.views')}</span>
          {views.map(view => {
            const active = view.id === resolvedViewId
            return (
              <button
                key={view.id}
                type="button"
                className={active ? `${css.railItem} ${css.railItemActive}` : css.railItem}
                data-dsh-part="view-item"
                data-view-id={view.id}
                data-view-vertical={view.vertical}
                data-default={view.id === detail.viewId ? 'true' : 'false'}
                aria-current={active ? 'true' : undefined}
                title={view.name}
                onClick={() => { setViewId(view.id) }}
              >
                <span className={css.railLabel}>{view.name}</span>
                {view.isDefault === true ? <span className={css.railDefault}>{t('board.defaultView')}</span> : null}
              </button>
            )
          })}
        </nav>
      )
    }


    const createForm = (
      <form className={css.boxed} data-dsh-part="create" onSubmit={event => { void submitCreate(event) }}>
        <h3 className={css.formTitle}>{t('create.title')}</h3>
        <div className={css.formGrid}>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('create.title')}</span>
            <input
              ref={titleInput}
              className={css.input}
              value={draftTitle}
              disabled={creating}
              placeholder={t('create.titlePlaceholder')}
              onChange={event => { setDraftTitle(event.target.value) }}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('create.notePlaceholder')}</span>
            <input
              className={css.input}
              value={draftNote}
              disabled={creating}
              placeholder={t('create.notePlaceholder')}
              onChange={event => { setDraftNote(event.target.value) }}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{statusView ? t('board.status') : t('create.stage')}</span>
            <select
              className={css.tableSelect}
              data-dsh-part="create-column"
              value={draftColumnId}
              disabled={creating}
              onChange={event => { setDraftColumnId(event.target.value) }}
            >
              <option value="">{t('board.unassignedColumn')}</option>
              {statusView
                // A status board can only create in a workflow START status; the
                // other status columns stay visible but not selectable.
                ? columns.filter(column => column.kind === 'status').map(column => (
                    <option key={column.id} value={column.id} disabled={!startIds.has(column.id)}>{column.name}</option>
                  ))
                : grouped
                  ? tasklists.flatMap(list => {
                      const listColumns = columns.filter(column => column.tasklistId === list.id)
                      return listColumns.length === 0
                        ? []
                        : [(
                            <optgroup key={list.id} label={list.name}>
                              {listColumns.map(column => <option key={column.id} value={column.id}>{column.name}</option>)}
                            </optgroup>
                          )]
                    })
                  : columns.map(column => <option key={column.id} value={column.id}>{column.name}</option>)}
            </select>
          </label>
          <button type="submit" className={`${css.button} ${css.primary}`} disabled={creating}>
            {creating ? t('create.submitting') : t('create.submit')}
          </button>
        </div>
        {createError === undefined ? null : <p className={css.cardError} role="alert">{createError}</p>}
        {activeProject === undefined ? null : <p className={css.hint}>{activeProject.name}</p>}
      </form>
    )

    /** Name of the column a card sits in: saved-view columns first, then stages. */
    const stageNameOf = (card: TeambitionCardView): string | undefined => {
      const columnId = columnIdOf(card, columns)
      if (columnId !== undefined) return columns.find(column => column.id === columnId)?.name
      if (card.stageId !== undefined) {
        const stage = detail.stages.find(candidate => candidate.id === card.stageId)
        if (stage !== undefined) return stage.name
      }
      if (card.statusId === undefined) return undefined
      return detail.statuses.find(status => status.id === card.statusId)?.name
    }
    /** Name of the task list a card belongs to. */
    const tasklistNameOf = (card: TeambitionCardView): string | undefined => {
      const id = listIdOfCard(card)
      return id === undefined ? undefined : tasklists.find(list => list.id === id)?.name
    }

    /** Executor cell: avatar plus name, or the unassigned hint. */
    const renderExecutor = (card: TeambitionCardView, showName: boolean): ReactElement => {
      if (card.executorName === undefined && card.executorAvatarUrl === undefined) {
        return <span className={css.muted}>{t('tasks.unassigned')}</span>
      }
      const name = card.executorName ?? '-'
      return (
        <span className={css.executor} title={name}>
          {card.executorAvatarUrl === undefined
            ? <span className={css.avatarFallback} aria-hidden="true">{name.slice(0, 1)}</span>
            : <img className={css.avatar} src={card.executorAvatarUrl} alt="" loading="lazy" />}
          {showName ? <span className={css.executorName}>{name}</span> : null}
        </span>
      )
    }

    /** Due cell: calendar day, with the overdue marker when past due. */
    const renderDue = (card: TeambitionCardView): ReactElement => {
      const state = dueState(card)
      if (state === 'none') return <span className={css.muted}>{t('tasks.noDue')}</span>
      return (
        <span className={state === 'overdue' ? `${css.due} ${css.dueOverdue}` : css.due} data-due-state={state}>
          {formatDay(card.dueAt)}
          {state === 'overdue' ? <span className={css.dueFlag}>{t('tasks.overdue')}</span> : null}
        </span>
      )
    }

    const normalizedQuery = query.trim().toLowerCase()
    const visibleCards = cards.filter(card => {
      // Toolbar task-list filter: narrow the table to one list of the project.
      if (tasklistFilter !== '' && listIdOfCard(card) !== tasklistFilter) return false
      if (normalizedQuery !== '') {
        const haystack = [
          card.title,
          card.note ?? '',
          card.uniqueId === undefined ? '' : String(card.uniqueId),
          card.executorName ?? '',
        ].join(' ').toLowerCase()
        if (!haystack.includes(normalizedQuery)) return false
      }
      if (filterBy === 'open') return card.isDone !== true
      if (filterBy === 'done') return card.isDone === true
      if (filterBy === 'overdue') return dueState(card) === 'overdue'
      if (filterBy === 'unassigned') return card.executorName === undefined && card.executorId === undefined
      return true
    })
    const sortedCards = [...visibleCards].sort((left, right) => {
      if (sortBy === 'created') return (right.createdAt ?? 0) - (left.createdAt ?? 0)
      if (sortBy === 'due') return (left.dueAt ?? Number.POSITIVE_INFINITY) - (right.dueAt ?? Number.POSITIVE_INFINITY)
      if (sortBy === 'priority') return priorityRank(right.priority) - priorityRank(left.priority) || (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
      return (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
    })
    const taskGroups: readonly TaskGroup[] = ((): readonly TaskGroup[] => {
      if (groupBy === 'none') return [{ key: 'all', label: '', cards: sortedCards }]
      const buckets = new Map<string, { label: string; cards: TeambitionCardView[] }>()
      for (const card of sortedCards) {
        let key: string
        let label: string
        if (groupBy === 'tasklist') {
          const id = listIdOfCard(card)
          key = `tasklist:${id ?? ''}`
          label = tasklistNameOf(card) ?? t('tasks.groupOther')
        } else if (groupBy === 'stage') {
          key = `stage:${card.stageId ?? ''}`
          label = stageNameOf(card) ?? t('board.unassignedColumn')
        } else {
          key = `executor:${card.executorId ?? card.executorName ?? ''}`
          label = card.executorName ?? t('tasks.groupNobody')
        }
        const bucket = buckets.get(key)
        if (bucket === undefined) buckets.set(key, { label, cards: [card] })
        else bucket.cards.push(card)
      }
      const entries = [...buckets.entries()]
      // Columns and task lists keep their project order, like the Teambition
      // task module; executors stay in first-seen order.
      if (groupBy === 'stage' || groupBy === 'tasklist') {
        const ids = groupBy === 'stage'
          ? detail.stages.map(stage => stage.id)
          : tasklists.map(list => list.id)
        const orderKey = (key: string): number => {
          const id = key.slice(key.indexOf(':') + 1)
          const index = ids.indexOf(id)
          return index === -1 ? Number.MAX_SAFE_INTEGER : index
        }
        entries.sort(([left], [right]) => orderKey(left) - orderKey(right))
      }
      return entries.map(([key, bucket]) => ({ key, label: bucket.label, cards: bucket.cards }))
    })()

    const renderTaskRow = (card: TeambitionCardView): ReactElement => {
      const priority = priorityLabel(card.priority)
      const running = runningCardId === card.id
      const pending = pendingCardId === card.id
      const error = cardErrors[card.id]
      const open = activeCardId === card.id
      return (
        <div
          key={card.id}
          role="row"
          tabIndex={0}
          className={open ? `${css.taskRow} ${css.taskRowActive}` : css.taskRow}
          data-dsh-part="task-row"
          data-card-id={card.id}
          data-done={card.isDone === true ? 'true' : 'false'}
          data-overdue={dueState(card) === 'overdue' ? 'true' : 'false'}
          aria-selected={open}
          onClick={() => { setActiveCardId(card.id) }}
          onKeyDown={event => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            setActiveCardId(card.id)
          }}
        >
          <span role="cell" className={`${css.taskCell} ${css.colTask}`}>
            {priority === undefined ? null : (
              <span className={css.priorityFlag} data-dsh-part="priority" data-priority={String(card.priority)}>{priority}</span>
            )}
            {card.uniqueId === undefined ? null : <span className={css.taskNumber}>#{String(card.uniqueId)}</span>}
            <span className={card.isDone === true ? `${css.taskTitle} ${css.taskTitleDone}` : css.taskTitle}>{card.title}</span>
            {card.subtaskCount === undefined || card.subtaskCount === 0 ? null : (
              <span className={css.metaCount}>{t('tasks.subtasks', { count: String(card.subtaskCount) })}</span>
            )}
            {card.commentsCount === undefined || card.commentsCount === 0 ? null : (
              <span className={css.metaCount}>{t('tasks.comments', { count: String(card.commentsCount) })}</span>
            )}
            {card.isDone === true ? <span className={css.doneBadge}>{t('tasks.done')}</span> : null}
            {error === undefined ? null : <span className={css.cardError} role="alert">{error}</span>}
          </span>
          <span role="cell" className={`${css.taskCell} ${css.colExecutor}`}>{renderExecutor(card, true)}</span>
          <span role="cell" className={`${css.taskCell} ${css.colDue}`}>{renderDue(card)}</span>
          <span role="cell" className={`${css.taskCell} ${css.colStage}`}>
            {stageNameOf(card) === undefined ? <span className={css.muted}>-</span> : stageNameOf(card)}
          </span>
          <span role="cell" className={`${css.taskCell} ${css.colUpdated}`}>{formatMoment(card.updatedAt)}</span>
          <span className={css.rowActions}>
            <button
              type="button"
              className={`${css.button} ${css.primary}`}
              disabled={running || pending || runningCardId !== undefined}
              onClick={event => { event.stopPropagation(); void runCard(card) }}
            >
              {running ? <><span className={css.spinner} aria-hidden="true" /> {t('card.running')}</> : t('card.run')}
            </button>
            <a className={css.link} href={card.url} target="_blank" rel="noreferrer" onClick={event => { event.stopPropagation() }}>
              {t('tasks.open')}
            </a>
          </span>
        </div>
      )
    }

    const activeCard = activeCardId === undefined ? undefined : cards.find(card => card.id === activeCardId)

    /** Detail drawer of the selected task. */
    const renderTaskDetail = (card: TeambitionCardView): ReactElement => {
      const choice = cardChoice(card, state.settings)
      const boundWorkspace = choice === undefined ? undefined : roster.find(item => item.workspaceId === choice.workspaceId)
      const chipText = choice === undefined
        ? t('board.unboundWorkspace')
        : (boundWorkspace === undefined ? choice.workspaceId : workspaceTitle(boundWorkspace))
      const running = runningCardId === card.id
      const busy = runningCardId !== undefined || pendingCardId !== undefined || pendingCardId === card.id
      const error = cardErrors[card.id]
      const row = (label: string, value: ReactElement | string): ReactElement => (
        <div className={css.drawerRow} key={label}>
          <span className={css.drawerLabel}>{label}</span>
          <span className={css.drawerValue}>{value}</span>
        </div>
      )
      const priority = priorityLabel(card.priority)
      // Workflow projects bind every card to one task type; show it only when the
      // project actually carries the scenario list.
      const scenario = card.scenarioConfigId === undefined
        ? undefined
        : detail.scenarioConfigs.find(candidate => candidate.id === card.scenarioConfigId)
      return (
        <aside className={css.drawer} data-dsh-part="task-detail" data-card-id={card.id} aria-label={t('detail.title')}>
          <header className={css.drawerHead}>
            <h3 className={css.drawerTitle}>{card.title}</h3>
            <button type="button" className={css.button} onClick={() => { setActiveCardId(undefined) }}>{t('detail.close')}</button>
          </header>
          <div className={css.drawerFacts}>
            {card.uniqueId === undefined ? null : row(t('detail.taskId'), `#${String(card.uniqueId)}`)}
            {priority === undefined ? null : row(t('toolbar.sortPriority'), priority)}
            {row(t('detail.executor'), renderExecutor(card, true))}
            {row(t('detail.due'), renderDue(card))}
            {row(statusView ? t('board.status') : t('detail.stage'), stageNameOf(card) ?? '-')}
            {scenario === undefined ? null : row(t('board.scenario'), scenario.name)}
            {row(t('detail.tasklist'), tasklistNameOf(card) ?? '-')}
            {row(t('detail.created'), formatTime(card.createdAt))}
            {row(t('detail.updated'), formatTime(card.updatedAt))}
          </div>
          <section className={css.drawerSection}>
            <h4 className={css.drawerSectionTitle}>{t('detail.note')}</h4>
            <p className={css.drawerNote}>{card.note === undefined || card.note.trim() === '' ? t('detail.noNote') : card.note}</p>
          </section>
          {error === undefined ? null : <p className={css.cardError} role="alert">{error}</p>}
          <div className={css.drawerActions}>
            <button type="button" className={`${css.button} ${css.primary}`} disabled={busy} onClick={() => { void runCard(card) }}>
              {running ? <><span className={css.spinner} aria-hidden="true" /> {t('card.running')}</> : t('card.run')}
            </button>
            <a className={css.link} href={card.url} target="_blank" rel="noreferrer">{t('card.openExternal')}</a>
          </div>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('card.bindingLabel')}</span>
            <select
              className={css.tableSelect}
              value={choice === undefined ? '' : choice.workspaceId}
              disabled={busy}
              title={chipText}
              onChange={event => { void bindCard(card, event.target.value) }}
            >
              <option value="">{t('settings.workspaceUnbound')}</option>
              {roster.map(item => <option key={item.workspaceId} value={item.workspaceId}>{workspaceTitle(item)}</option>)}
            </select>
          </label>
          {columns.length === 0 ? null : (
            <label className={css.field} data-dsh-part="task-move">
              <span className={css.fieldLabel}>{statusView ? t('board.status') : t('board.moveStage')}</span>
              <select
                className={css.tableSelect}
                value={columnIdOf(card, columns) ?? ''}
                disabled={busy}
                onChange={event => {
                  const column = columns.find(candidate => candidate.id === event.target.value)
                  if (column === undefined) return
                  // Stage columns move through the kanban endpoint, status columns
                  // through the workflow endpoint: the column kind picks the call.
                  if (column.kind === 'status') void changeStatus(card.id, column.id)
                  else void changeStage(card.id, column.id)
                }}
              >
                <option value="">{t('board.unassignedColumn')}</option>
                {columns.map(column => <option key={column.id} value={column.id}>{column.name}</option>)}
              </select>
            </label>
          )}
        </aside>
      )
    }

    /** The Teambition task module: toolbar, task table and the detail drawer. */
    const renderTasks = (): ReactElement => (
      <div className={css.taskView} data-dsh-part="task-view">
        <div className={css.taskMain}>
        <div className={css.toolbar} data-dsh-part="task-toolbar">
          <input
            type="search"
            className={css.searchInput}
            value={query}
            placeholder={t('toolbar.searchPlaceholder')}
            aria-label={t('toolbar.search')}
            onChange={event => { setQuery(event.target.value) }}
          />
          <label className={css.toolbarField}>
            <span>{t('toolbar.group')}</span>
            <select className={css.select} value={groupBy} onChange={event => { setGroupBy(event.target.value as TaskGrouping) }}>
              <option value="none">{t('toolbar.groupNone')}</option>
              <option value="tasklist">{t('toolbar.groupTasklist')}</option>
              <option value="stage">{t('toolbar.groupStage')}</option>
              <option value="executor">{t('toolbar.groupExecutor')}</option>
            </select>
          </label>
          <label className={css.toolbarField}>
            <span>{t('toolbar.filter')}</span>
            <select className={css.select} value={filterBy} onChange={event => { setFilterBy(event.target.value as TaskFilter) }}>
              <option value="all">{t('toolbar.filterAll')}</option>
              <option value="open">{t('toolbar.filterOpen')}</option>
              <option value="done">{t('toolbar.filterDone')}</option>
              <option value="overdue">{t('toolbar.filterOverdue')}</option>
              <option value="unassigned">{t('toolbar.filterUnassigned')}</option>
            </select>
          </label>
          {tasklists.length > 1 ? (
            <label className={css.toolbarField} data-dsh-part="tasklist-filter">
              <span>{t('toolbar.tasklist')}</span>
              <select
                className={css.select}
                value={tasklistFilter}
                aria-label={t('toolbar.tasklist')}
                onChange={event => { setTasklistFilter(event.target.value) }}
              >
                <option value="">{t('toolbar.tasklistAll')}</option>
                {tasklists.map(list => <option key={list.id} value={list.id}>{list.name}</option>)}
              </select>
            </label>
          ) : null}
          <label className={css.toolbarField}>
            <span>{t('toolbar.sort')}</span>
            <select className={css.select} value={sortBy} onChange={event => { setSortBy(event.target.value as TaskSort) }}>
              <option value="updated">{t('toolbar.sortUpdated')}</option>
              <option value="created">{t('toolbar.sortCreated')}</option>
              <option value="due">{t('toolbar.sortDue')}</option>
              <option value="priority">{t('toolbar.sortPriority')}</option>
            </select>
          </label>
          <span className={css.spacer} />
          <span className={css.toolbarCount} data-dsh-part="task-count">
            {t('toolbar.count', { shown: String(sortedCards.length), total: String(cards.length) })}
          </span>
        </div>
        {sortedCards.length === 0 ? (
          <div className={css.stateBox} data-dsh-part="tasks-empty">
            <span>{t('tasks.empty')}</span>
            <span className={css.hint}>{t('tasks.emptyHint')}</span>
          </div>
        ) : (
          <div className={css.taskTable} role="table" data-dsh-part="task-table">
            <div className={`${css.taskRow} ${css.taskHeadRow}`} role="row">
              <span role="columnheader" className={`${css.taskCell} ${css.colTask}`}>{t('tasks.colTask')}</span>
              <span role="columnheader" className={`${css.taskCell} ${css.colExecutor}`}>{t('tasks.colExecutor')}</span>
              <span role="columnheader" className={`${css.taskCell} ${css.colDue}`}>{t('tasks.colDue')}</span>
              <span role="columnheader" className={`${css.taskCell} ${css.colStage}`}>{t('tasks.colStage')}</span>
              <span role="columnheader" className={`${css.taskCell} ${css.colUpdated}`}>{t('tasks.colUpdated')}</span>
              <span role="columnheader" className={css.rowActions} />
            </div>
            {taskGroups.map(group => (
              <section key={group.key} className={css.taskGroup} data-dsh-part="task-group" data-group-key={group.key}>
                {groupBy === 'none' ? null : (
                  <h3 className={css.groupHead}>
                    <span>{group.label}</span>
                    <span className={css.columnCount}>{String(group.cards.length)}</span>
                  </h3>
                )}
                {group.cards.map(card => renderTaskRow(card))}
              </section>
            ))}
          </div>
        )}
        {createForm}
        </div>
        {activeCard === undefined ? null : renderTaskDetail(activeCard)}
      </div>
    )

    const boardBody = (
      <div className={css.boardFrame} data-dsh-part="board-frame">
        {renderViewRail()}
        <div className={css.boardArea}>
          {grouped ? (
            <div className={css.tasklistGroups} data-dsh-part="tasklist-groups">
              {groups.map(group => (
                <section className={css.tasklistGroup} key={group.id} data-dsh-part="tasklist-group" data-tasklist-id={group.id}>
                  <h3 className={css.tasklistTitle}>
                    <span className={css.tasklistName}>{group.name}</span>
                    <span className={css.columnCount}>{String(group.cards.length)}</span>
                  </h3>
                  {renderBoard(group.columns, group.cards, columns, true)}
                </section>
              ))}
              {strayColumns.length === 0 && strayCards.length === 0 ? null : (
                <section className={css.tasklistGroup} data-dsh-part="tasklist-group" data-tasklist-id="">
                  <h3 className={css.tasklistTitle}>
                    <span className={css.tasklistName}>{t('board.unassignedTasklist')}</span>
                    <span className={css.columnCount}>{String(strayCards.length)}</span>
                  </h3>
                  {renderBoard(strayColumns, strayCards, columns, true)}
                </section>
              )}
            </div>
          ) : (
            renderBoard(columns, cards, columns)
          )}
          {cards.length === 0 ? (
            <div className={css.stateBox} data-dsh-part="board-empty">
              <span>{t('board.empty')}</span>
              <span className={css.hint}>{t('board.emptyHint')}</span>
              {tasklistId !== undefined && tasklists.length > 1 ? <span className={css.hint}>{t('board.emptyTasklistHint')}</span> : null}
              <a className={css.link} href={projectBoardUrl(detail.project.id)} target="_blank" rel="noreferrer" data-dsh-part="open-project">
                {t('board.openProject')}
              </a>
            </div>
          ) : null}
          {createForm}
        </div>
      </div>
    )

    body = view === 'tasks' ? renderTasks() : boardBody
  }

  return (
    <div className={css.panel} data-dsh-plugin="teambition" data-dsh-teambition-view="">
      {header}
      {noticeLine}
      <div className={css.body} data-dsh-part="body">{body}</div>
    </div>
  )
}

/** Props of one rendered card. */
interface CardProps {
  readonly card: TeambitionCardView
  /** Column (stage or workflow status) name of the card, when known. */
  readonly statusName: string | undefined
  /** Every column of the resolved view, for the movement select. */
  readonly columns: readonly TeambitionColumnView[]
  /** Column the card currently sits in; empty when it sits outside the view. */
  readonly currentColumnId: string
  /** Whether the view draws workflow statuses instead of kanban stages. */
  readonly statusView: boolean
  readonly settings: TeambitionSettingsView
  readonly roster: readonly WorkspaceItemView[]
  readonly detail: TeambitionProjectDetail
  readonly running: boolean
  readonly pending: boolean
  readonly busy: boolean
  readonly error: string | undefined
  readonly choice: TeambitionWorkspaceChoice | undefined
  /** Whether this card is the one currently being dragged. */
  readonly dragging: boolean
  readonly onDragStart: () => void
  readonly onDragEnd: () => void
  readonly onRun: () => void
  readonly onStatus: (statusId: string) => void
  readonly onStage: (stageId: string) => void
  readonly onBind: (workspaceId: string) => void
}

/**
 * Render one card: title, status badge, workspace chip, stage/status moves and
 * the run action.
 * @param props - the card plus its resolved facts and action callbacks.
 * @returns the card element.
 */
function renderCard(props: CardProps): ReactElement {
  const { card, statusName, columns, currentColumnId, statusView, roster, detail, running, pending, busy, error, choice, dragging } = props
  const boundWorkspace = choice === undefined ? undefined : roster.find(item => item.workspaceId === choice.workspaceId)
  const chipText = choice === undefined
    ? t('board.unboundWorkspace')
    : (boundWorkspace === undefined ? choice.workspaceId : workspaceTitle(boundWorkspace))
  const chipTitle = choice === undefined ? t('card.workspaceUnboundHint') : `${t('card.workspaceLabel')}: ${sourceLabel(choice)}`

  // Next open status after the current one, and the end status: the two moves
  // the card offers (a card already at the end offers neither).
  const currentIndex = card.statusId === undefined
    ? -1
    : detail.statuses.findIndex(candidate => candidate.id === card.statusId)
  const nextOpen = detail.statuses.slice(currentIndex + 1).find(candidate => candidate.kind !== 'end')
  const endStatus = detail.statuses.find(candidate => candidate.kind === 'end')
  const completeId = endStatus !== undefined && card.statusId !== endStatus.id && card.isDone !== true
    ? endStatus.id
    : undefined

  return (
    <article
      key={card.id}
      className={css.card}
      data-dsh-part="card"
      data-card-id={card.id}
      data-running={running ? 'true' : 'false'}
      data-dragging={dragging ? 'true' : 'false'}
      data-workspace-bound={choice === undefined ? 'false' : 'true'}
      draggable={!busy}
      title={busy ? undefined : t('board.dragHint')}
      onDragStart={event => {
        // The data transfer carries the id so a drop target does not have to
        // track render state, and it makes the drag a real move for the browser.
        event.dataTransfer?.setData('text/plain', card.id)
        if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = 'move'
        props.onDragStart()
      }}
      onDragEnd={() => { props.onDragEnd() }}
    >
      <h4 className={css.cardTitle}>{card.title}</h4>
      <div className={css.cardMeta}>
        {statusName === undefined ? null : <span className={css.badge} data-dsh-part="status">{statusName}</span>}
        <span
          className={`${css.chip} ${choice === undefined ? css.chipUnbound : css.chipOn}`}
          title={chipTitle}
          data-dsh-part="workspace-chip"
        >
          {chipText}
        </span>
      </div>

      {error === undefined ? null : <p className={css.cardError} role="alert">{error}</p>}

      <div className={css.cardActions}>
        <button
          type="button"
          className={`${css.button} ${css.primary}`}
          disabled={busy}
          onClick={props.onRun}
        >
          {running ? <><span className={css.spinner} aria-hidden="true" /> {t('card.running')}</> : t('card.run')}
        </button>
        {nextOpen === undefined ? null : (
          <button type="button" className={css.button} disabled={busy} onClick={() => { props.onStatus(nextOpen.id) }}>
            {t('card.advanceTo', { name: nextOpen.name })}
          </button>
        )}
        {completeId === undefined ? null : (
          <button type="button" className={css.button} disabled={busy} onClick={() => { props.onStatus(completeId) }}>
            {t('card.complete')}
          </button>
        )}
        <a className={css.link} href={card.url} target="_blank" rel="noreferrer">{t('card.openExternal')}</a>
      </div>

      <label className={css.field}>
        <span className={css.fieldLabel}>{t('card.bindingLabel')}</span>
        <select
          className={css.tableSelect}
          value={choice === undefined ? '' : choice.workspaceId}
          disabled={busy}
          onChange={event => { props.onBind(event.target.value) }}
        >
          <option value="">{t('settings.workspaceUnbound')}</option>
          {roster.map(item => <option key={item.workspaceId} value={item.workspaceId}>{workspaceTitle(item)}</option>)}
        </select>
      </label>

      {columns.length === 0 ? null : (
        <label className={css.field}>
          <span className={css.fieldLabel}>{statusView ? t('board.status') : t('board.moveStage')}</span>
          <select
            className={css.tableSelect}
            data-dsh-part="card-move"
            value={currentColumnId}
            disabled={busy || pending}
            onChange={event => {
              const column = columns.find(candidate => candidate.id === event.target.value)
              if (column === undefined) return
              if (column.kind === 'status') props.onStatus(column.id)
              else props.onStage(column.id)
            }}
          >
            <option value="">{t('board.unassignedColumn')}</option>
            {columns.map(column => <option key={column.id} value={column.id}>{column.name}</option>)}
          </select>
        </label>
      )}
    </article>
  )
}

/** Props of the settings view. */
interface SettingsProps {
  readonly state: TeambitionStateView
  readonly projects: readonly TeambitionProject[]
  readonly roster: readonly WorkspaceItemView[]
  readonly api: TeambitionApiFace
  /** Surface the panel opens on, chosen here and remembered. */
  readonly defaultView: TaskView
  readonly onDefaultView: (view: TaskView) => void
  readonly onSaved: () => Promise<void>
  readonly notify: (message: string, isError?: boolean) => void
}

/**
 * Settings surface: cookie, connection diagnose, operator id, endpoint and the
 * workspace bindings (panel default, per project).
 * @param props - current state, workspace roster, route client and callbacks.
 * @returns the settings view.
 */
function TeambitionSettings(props: SettingsProps): ReactElement {
  const { state, projects, roster, api } = props
  const settings = state.settings
  const [cookie, setCookie] = useState('')
  const [operatorId, setOperatorId] = useState('')
  const [diagnostics, setDiagnostics] = useState<TeambitionDiagnostics | undefined>(state.diagnostics)
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()

  useEffect(() => { setDiagnostics(state.diagnostics) }, [state.diagnostics])

  const fail = useCallback((message: string): void => {
    setError(message)
    setNotice(undefined)
  }, [])

  const succeed = useCallback((message: string): void => {
    setNotice(message)
    setError(undefined)
  }, [])

  const saveConfig = useCallback(async (request: TeambitionConfigRequest, action: string): Promise<boolean> => {
    setBusy(action)
    setError(undefined)
    setNotice(undefined)
    const result = await api.saveConfig(request)
    setBusy(undefined)
    if (!result.ok) {
      fail(t('error.generic', { message: result.error.message }))
      return false
    }
    succeed(t('settings.saved'))
    // Credential edits invalidate the stored probe: the host drops its diagnostics,
    // and this view must drop the copy it rendered from the previous cookie too.
    if (request.cookie !== undefined || request.clearCookie === true) setDiagnostics(undefined)
    await props.onSaved()
    return true
  }, [api, fail, props, succeed])

  const saveBindings = useCallback(async (request: TeambitionBindRequest, action: string): Promise<void> => {
    setBusy(action)
    setError(undefined)
    setNotice(undefined)
    const result = await api.saveBindings(request)
    setBusy(undefined)
    if (!result.ok) {
      fail(t('error.generic', { message: result.error.message }))
      return
    }
    succeed(t('settings.saved'))
    await props.onSaved()
  }, [api, fail, props, succeed])

  const runDiagnose = useCallback(async (): Promise<void> => {
    setBusy('diagnose')
    setError(undefined)
    setNotice(undefined)
    const result = await api.diagnose()
    setBusy(undefined)
    if (!result.ok) {
      fail(t('error.generic', { message: result.error.message }))
      return
    }
    setDiagnostics(result.value.diagnostics)
  }, [api, fail])

  const saveCookie = async (): Promise<void> => {
    const value = cookie.trim()
    if (value === '') {
      setError(t('settings.cookieRequired'))
      return
    }
    // A page URL is the most common paste mistake; it can never be a Cookie
    // header and saving it would only turn into an opaque 401 later.
    const looksLikeUrl = value.includes('://') || (!value.includes('=') && /^www\./i.test(value))
    if (looksLikeUrl) {
      setError(t('settings.cookieLooksLikeUrl'))
      return
    }
    if (await saveConfig({ cookie: value }, 'cookie')) setCookie('')
  }

  const setProjectBinding = async (projectId: string, workspaceId: string): Promise<void> => {
    const projectBindings: TeambitionProjectBinding[] = settings.projectBindings
      .filter(binding => binding.projectId !== projectId)
      .map(binding => ({ projectId: binding.projectId, workspaceId: binding.workspaceId }))
    if (workspaceId !== '') projectBindings.push({ projectId, workspaceId })
    await saveBindings({ projectBindings }, 'bindings')
  }

  const disabled = busy !== undefined

  return (
    <div className={css.settings} data-dsh-part="settings">
      {error === undefined ? null : <p className={`${css.notice} ${css.noticeError}`} role="alert">{error}</p>}
      {notice === undefined ? null : <p className={css.notice} role="status">{notice}</p>}

      <section className={css.settingsBlock} data-dsh-part="cookie">
        <div className={css.settingsHead}>
          <h3 className={css.settingsTitle}>{t('settings.cookie')}</h3>
          {settings.configured
            ? <span className={css.status + ' ' + css.statusOn}>{settings.cookieTail === undefined ? t('connection.ok') : t('settings.cookieStored', { tail: settings.cookieTail })}</span>
            : <span className={css.status + ' ' + css.statusOff}>{t('connection.unconfigured')}</span>}
        </div>
        {settings.configured ? null : <p className={css.hint}>{t('settings.cookieMissing')}</p>}
        <textarea
          className={`${css.textarea} ${css.textareaCookie}`}
          value={cookie}
          disabled={disabled}
          placeholder={t('settings.cookiePlaceholder')}
          spellCheck={false}
          autoComplete="off"
          aria-label={t('settings.cookie')}
          onChange={event => { setCookie(event.target.value) }}
        />
        <p className={css.hint}>{t('settings.cookieHint')}</p>
        <div className={css.actions}>
          <button type="button" className={`${css.button} ${css.primary}`} disabled={disabled} onClick={() => { void saveCookie() }}>
            {busy === 'cookie' ? t('settings.cookieSaving') : t('settings.cookieSave')}
          </button>
          <button type="button" className={css.button} disabled={disabled || !settings.configured} onClick={() => { void saveConfig({ clearCookie: true }, 'cookie') }}>
            {t('settings.cookieClear')}
          </button>
        </div>
      </section>

      <section className={css.settingsBlock} data-dsh-part="diagnose">
        <div className={css.settingsHead}>
          <h3 className={css.settingsTitle}>{t('settings.diagnoseConclusion')}</h3>
          <button type="button" className={css.button} disabled={disabled} onClick={() => { void runDiagnose() }}>
            {busy === 'diagnose' ? t('settings.diagnosing') : t('settings.diagnose')}
          </button>
        </div>
        {diagnostics === undefined
          ? <p className={css.hint}>{t('settings.diagnoseNoCookie')}</p>
          : (
            <>
              <p className={css.notice}>
                <strong>{conclusionLabel(diagnostics)}</strong>
                {` - ${diagnostics.message}`}
              </p>
              <p className={css.hint}>{formatTime(diagnostics.probedAt)}</p>
              <ul className={css.probeList}>
                {diagnostics.results.map(probe => (
                  <li className={css.probe} key={probe.id} data-dsh-part="probe" data-probe-id={probe.id}>
                    <div className={css.probeFacts}>
                      <span className={css.code}>{probe.id}</span>
                      <span className={css.muted}>{`${probe.base}: ${probe.path}`}</span>
                      <span>{probe.status === undefined ? t('settings.probeNoStatus') : `HTTP ${String(probe.status)}`}</span>
                      {probe.contentType === undefined ? null : <span className={css.muted}>{probe.contentType}</span>}
                      <span className={probe.ok ? css.statusOn : css.statusOff}>{probe.ok ? t('settings.probeOk') : t('settings.probeFailed')}</span>
                    </div>
                    {probe.error === undefined ? null : <p className={css.cardError}>{probe.error}</p>}
                    {probe.preview === undefined ? null : <p className={css.hint}>{probe.preview}</p>}
                  </li>
                ))}
              </ul>
            </>
          )}
      </section>

      <section className={css.settingsBlock} data-dsh-part="operator">
        <div className={css.settingsHead}>
          <h3 className={css.settingsTitle}>{t('settings.operatorId')}</h3>
          {settings.operatorIdConfigured ? <span className={css.hint}>{t('settings.operatorIdStored')}</span> : null}
        </div>
        <input
          className={css.input}
          value={operatorId}
          disabled={disabled}
          placeholder={t('settings.operatorIdPlaceholder')}
          spellCheck={false}
          autoComplete="off"
          aria-label={t('settings.operatorId')}
          onChange={event => { setOperatorId(event.target.value) }}
        />
        <p className={css.hint}>{t('settings.operatorIdHint')}</p>
        <div className={css.actions}>
          <button
            type="button"
            className={css.button}
            disabled={disabled || operatorId.trim() === ''}
            onClick={() => {
              const value = operatorId.trim()
              void saveConfig({ operatorId: value }, 'operator').then(saved => { if (saved) setOperatorId('') })
            }}
          >
            {t('settings.operatorIdSave')}
          </button>
          <button
            type="button"
            className={css.button}
            disabled={disabled || !settings.operatorIdConfigured}
            onClick={() => { void saveConfig({ clearOperatorId: true }, 'operator') }}
          >
            {t('settings.operatorIdClear')}
          </button>
        </div>
      </section>

      <section className={css.settingsBlock} data-dsh-part="endpoint">
        <h3 className={css.settingsTitle}>{t('settings.apiBase')}</h3>
        <select
          className={css.select}
          value={settings.apiBase}
          disabled={disabled}
          aria-label={t('settings.apiBase')}
          onChange={event => { void saveConfig({ apiBase: event.target.value === 'web' ? 'web' : 'api' }, 'apiBase') }}
        >
          <option value="api">{t('settings.apiBaseApi')}</option>
          <option value="web">{t('settings.apiBaseWeb')}</option>
        </select>
        <p className={css.hint}>{t('settings.apiBaseHint')}</p>
      </section>

      <section className={css.settingsBlock} data-dsh-part="default-view">
        <h3 className={css.settingsTitle}>{t('settings.defaultView')}</h3>
        <select
          className={css.select}
          value={props.defaultView}
          aria-label={t('settings.defaultView')}
          onChange={event => { props.onDefaultView(event.target.value === 'board' ? 'board' : 'tasks') }}
        >
          <option value="tasks">{t('settings.defaultViewTasks')}</option>
          <option value="board">{t('settings.defaultViewBoard')}</option>
        </select>
        <p className={css.hint}>{t('settings.defaultViewHint')}</p>
      </section>

      <section className={css.settingsBlock} data-dsh-part="default-workspace">
        <h3 className={css.settingsTitle}>{t('settings.defaultWorkspace')}</h3>
        <select
          className={css.select}
          value={settings.defaultWorkspaceId ?? ''}
          disabled={disabled}
          aria-label={t('settings.defaultWorkspace')}
          onChange={event => { void saveBindings({ defaultWorkspaceId: event.target.value === '' ? null : event.target.value }, 'bindings') }}
        >
          <option value="">{t('settings.workspaceUnbound')}</option>
          {roster.map(item => <option key={item.workspaceId} value={item.workspaceId}>{workspaceTitle(item)}</option>)}
        </select>
        <p className={css.hint}>{t('settings.defaultWorkspaceHint')}</p>
      </section>

      <section className={css.settingsBlock} data-dsh-part="project-bindings">
        <h3 className={css.settingsTitle}>{t('settings.projectDefaults')}</h3>
        <p className={css.hint}>{t('settings.projectDefaultsHint')}</p>
        {projects.length === 0
          ? <p className={css.hint}>{t('settings.projectDefaultsEmpty')}</p>
          : (
            <div className={css.tableWrap}>
              <table className={css.projectTable}>
                <thead>
                  <tr>
                    <th>{t('header.project')}</th>
                    <th>{t('settings.defaultWorkspace')}</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map(project => {
                    const binding = settings.projectBindings.find(item => item.projectId === project.id)
                    return (
                      <tr key={project.id}>
                        <td>{project.name}</td>
                        <td>
                          <select
                            className={css.tableSelect}
                            value={binding?.workspaceId ?? ''}
                            disabled={disabled}
                            aria-label={`${project.name} - ${t('settings.defaultWorkspace')}`}
                            onChange={event => { void setProjectBinding(project.id, event.target.value) }}
                          >
                            <option value="">{t('settings.projectDefaultNone')}</option>
                            {roster.map(item => <option key={item.workspaceId} value={item.workspaceId}>{workspaceTitle(item)}</option>)}
                          </select>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
      </section>
    </div>
  )
}
