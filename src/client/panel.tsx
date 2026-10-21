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
  type TeambitionConfigRequest,
  type TeambitionProjectDetail,
  type TeambitionProjectBinding,
  type TeambitionSettingsView,
  type TeambitionStateView,
  type TeambitionStatusView,
  type TeambitionStageView,
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
  readonly stages: readonly TeambitionStageView[]
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
type PanelView = 'board' | 'settings'

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
 * The panel page.
 * @param props - injected service faces and the optional route client.
 * @returns the full-height Teambition page.
 */
export function TeambitionPanel(props: TeambitionPanelProps): ReactElement {
  const api = props.api ?? DEFAULT_API
  const { sessions, workspaces: workspaceService, uiWorkspace } = props

  const [view, setView] = useState<PanelView>('board')
  const [state, setState] = useState<TeambitionStateView>()
  const [statePhase, setStatePhase] = useState<Phase>('loading')
  const [stateError, setStateError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [noticeError, setNoticeError] = useState(false)
  const [busy, setBusy] = useState(false)

  // The last visited project and task list come from storage, so a reload opens
  // the board the user worked in instead of the first joined project.
  const [initialSelection] = useState<TeambitionSelection>(readSelection)
  const [projectId, setProjectId] = useState<string | undefined>(initialSelection.projectId)
  const [tasklistId, setTasklistId] = useState<string | undefined>(initialSelection.tasklistId)
  const [detail, setDetail] = useState<TeambitionProjectDetail>()
  const [detailPhase, setDetailPhase] = useState<Phase>('idle')
  const [detailError, setDetailError] = useState<string>()

  const [roster, setRoster] = useState<readonly WorkspaceItemView[]>(() => [...workspaceService.list.getSnapshot().items])

  const [runningCardId, setRunningCardId] = useState<string>()
  const [pendingCardId, setPendingCardId] = useState<string>()
  const [cardErrors, setCardErrors] = useState<Readonly<Record<string, string>>>({})

  const [draftTitle, setDraftTitle] = useState('')
  const [draftNote, setDraftNote] = useState('')
  const [draftStageId, setDraftStageId] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string>()

  /** Read sequence guard: a stale project read must not overwrite a newer one. */
  const projectSeq = useRef(0)

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

  /** Read one project (columns, statuses, cards) — one task list, or all of them. */
  const loadProject = useCallback(async (id: string, list: string | undefined): Promise<void> => {
    const seq = ++projectSeq.current
    setDetailPhase('loading')
    setDetailError(undefined)
    const result = await api.fetchProject(id, list)
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
    setProjectId(state.projects[0]?.id)
    setTasklistId(undefined)
  }, [state, projectId])

  // Remember every explicit selection for the next visit.
  useEffect(() => {
    if (projectId === undefined) return
    writeSelection(tasklistId === undefined ? { projectId } : { projectId, tasklistId })
  }, [projectId, tasklistId])

  // Read the board: the selected task list, or every list of the project.
  useEffect(() => {
    if (projectId === undefined) {
      setDetail(undefined)
      setDetailPhase('idle')
      return
    }
    void loadProject(projectId, tasklistId)
  }, [projectId, tasklistId, loadProject])

  // A remembered/selected task list that the project no longer has drops back to
  // "all task lists" instead of leaving the board on a nonexistent id.
  useEffect(() => {
    if (tasklistId === undefined || detail === undefined) return
    const tasklists = detail.tasklists ?? []
    if (tasklists.some(list => list.id === tasklistId)) return
    setTasklistId(undefined)
  }, [detail, tasklistId])

  // The create form's column picker only offers the selected task list's columns.
  useEffect(() => { setDraftStageId('') }, [projectId, tasklistId])

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
    if (projectId !== undefined) await loadProject(projectId, tasklistId)
    setBusy(false)
  }, [api, flash, loadProject, loadState, projectId, tasklistId])

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
    else if (projectId !== undefined) await loadProject(projectId, tasklistId)
    setPendingCardId(undefined)
  }, [api, loadProject, pendingCardId, projectId, tasklistId, setCardError])

  /** Move one card to another kanban column, then re-read the project. */
  const changeStage = useCallback(async (taskId: string, stageId: string): Promise<void> => {
    if (pendingCardId !== undefined) return
    setPendingCardId(taskId)
    setCardError(taskId, undefined)
    const result = await api.setTaskStage({ taskId, stageId })
    if (!result.ok) setCardError(taskId, t('error.generic', { message: result.error.message }))
    else if (projectId !== undefined) await loadProject(projectId, tasklistId)
    setPendingCardId(undefined)
  }, [api, loadProject, pendingCardId, projectId, tasklistId, setCardError])

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

  /** Create a card in the selected project, then re-read it. */
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
    const stage = detail?.stages.find(candidate => candidate.id === draftStageId)
    const cardTasklistId = tasklistId ?? stage?.tasklistId
    const result = await api.createTask({
      projectId,
      title,
      ...(cardTasklistId === undefined ? {} : { tasklistId: cardTasklistId }),
      ...(draftNote.trim() === '' ? {} : { note: draftNote.trim() }),
      ...(draftStageId === '' ? {} : { stageId: draftStageId }),
    })
    setCreating(false)
    if (!result.ok) {
      setCreateError(t('error.generic', { message: result.error.message }))
      return
    }
    setDraftTitle('')
    setDraftNote('')
    await loadProject(projectId, tasklistId)
  }, [api, creating, detail, draftNote, draftStageId, draftTitle, loadProject, projectId, tasklistId])

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
      {view === 'board' && projects.length > 0 ? (
        <label className={css.projectField} data-dsh-part="project-picker">
          <span>{t('header.project')}</span>
          <select
            className={css.select}
            value={projectId ?? ''}
            disabled={busy}
            aria-label={t('header.project')}
            onChange={event => {
              // The previous task list belongs to the previous project.
              setProjectId(event.target.value === '' ? undefined : event.target.value)
              setTasklistId(undefined)
            }}
          >
            {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
      ) : null}
      {view === 'board' && tasklists.length > 1 ? (
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
      {view === 'board' && tasklists.length === 1 ? (
        <span className={css.projectField} data-dsh-part="tasklist" data-tasklist-id={tasklists[0].id}>
          <span>{t('header.tasklist')}</span>
          <span className={css.tasklistName}>{tasklists[0].name}</span>
        </span>
      ) : null}
      <button
        type="button"
        className={css.button}
        disabled={busy || statePhase === 'loading'}
        onClick={() => { void (view === 'board' ? refreshAll() : loadState()) }}
      >
        {busy ? t('header.refreshing') : t('header.refresh')}
      </button>
      <button
        type="button"
        className={css.button}
        aria-pressed={view === 'settings'}
        onClick={() => { setView(view === 'board' ? 'settings' : 'board') }}
      >
        {view === 'board' ? t('header.settings') : t('header.back')}
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
        <button type="button" className={css.button} onClick={() => { if (projectId !== undefined) void loadProject(projectId, tasklistId) }}>{t('panel.retry')}</button>
      </div>
    )
  } else if (detail === undefined) {
    body = <div className={css.stateBox}><span>{t('panel.loadingProject')}</span></div>
  } else {
    const statusById = new Map<string, TeambitionStatusView>(detail.statuses.map(status => [status.id, status]))
    // A card's task list falls back to the list of its column: the host tags
    // both, but a payload that only tags the column must still group.
    const stageTasklist = new Map<string, string | undefined>(detail.stages.map(stage => [stage.id, stage.tasklistId]))
    const listIdOfCard = (card: TeambitionCardView): string | undefined =>
      card.tasklistId ?? (card.stageId === undefined ? undefined : stageTasklist.get(card.stageId))
    const knownList = (listId: string | undefined): boolean =>
      listId !== undefined && tasklists.some(list => list.id === listId)
    // Only "all task lists" with several lists needs the grouped layout: with one
    // list the flat board already is that list's board.
    const grouped = tasklistId === undefined && tasklists.length > 1
    const groups: readonly TasklistGroup[] = grouped
      ? tasklists.map(list => ({
          id: list.id,
          name: list.name,
          stages: detail.stages.filter(stage => stage.tasklistId === list.id),
          cards: cards.filter(card => listIdOfCard(card) === list.id),
        }))
      : []
    // Columns and cards the host did not attribute to a listed task list still
    // render in one trailing group instead of silently disappearing.
    const strayStages = grouped ? detail.stages.filter(stage => !knownList(stage.tasklistId)) : []
    const strayCards = grouped ? cards.filter(card => !knownList(listIdOfCard(card))) : []

    /** A project without declared columns still renders its cards: one bucket. */
    const columnsOf = (stages: readonly TeambitionStageView[]): readonly TeambitionStageView[] =>
      stages.length === 0 ? [{ id: '', name: t('board.unassignedColumn') }] : stages

    const renderColumn = (stage: TeambitionStageView, stageCards: readonly TeambitionCardView[], moveStages: readonly TeambitionStageView[]): ReactElement => (
      <section className={css.column} key={stage.id === '' ? '__all' : stage.id} data-dsh-part="column" data-stage-id={stage.id} data-tasklist-id={stage.tasklistId ?? ''}>
        <header className={css.columnHead}>
          <h3 className={css.columnTitle}>{stage.name}</h3>
          <span className={css.columnCount}>{String(stageCards.length)}</span>
        </header>
        <div className={css.columnBody}>
          {stageCards.length === 0
            ? <p className={css.columnEmpty}>{t('board.empty')}</p>
            : stageCards.map(card => renderCard({
                card,
                status: card.statusId === undefined ? undefined : statusById.get(card.statusId),
                stages: moveStages,
                settings: state.settings,
                roster,
                detail,
                running: runningCardId === card.id,
                pending: pendingCardId === card.id,
                busy: runningCardId !== undefined || pendingCardId !== undefined,
                error: cardErrors[card.id],
                choice: cardChoice(card, state.settings),
                onRun: () => { void runCard(card) },
                onStatus: statusId => { void changeStatus(card.id, statusId) },
                onStage: stageId => { void changeStage(card.id, stageId) },
                onBind: workspaceId => { void bindCard(card, workspaceId) },
              }))}
        </div>
      </section>
    )

    const renderBoard = (
      stages: readonly TeambitionStageView[],
      boardCards: readonly TeambitionCardView[],
      moveStages: readonly TeambitionStageView[],
      nested = false,
    ): ReactElement => (
      <div className={nested ? `${css.board} ${css.boardNested}` : css.board} data-dsh-part="board">
        {columnsOf(stages).map(stage => renderColumn(
          stage,
          stage.id === '' ? boardCards : boardCards.filter(card => card.stageId === stage.id),
          moveStages,
        ))}
      </div>
    )

    body = (
      <>
        {grouped ? (
          <div className={css.tasklistGroups} data-dsh-part="tasklist-groups">
            {groups.map(group => (
              <section className={css.tasklistGroup} key={group.id} data-dsh-part="tasklist-group" data-tasklist-id={group.id}>
                <h3 className={css.tasklistTitle}>
                  <span className={css.tasklistName}>{group.name}</span>
                  <span className={css.columnCount}>{String(group.cards.length)}</span>
                </h3>
                {renderBoard(group.stages, group.cards, group.stages, true)}
              </section>
            ))}
            {strayStages.length === 0 && strayCards.length === 0 ? null : (
              <section className={css.tasklistGroup} data-dsh-part="tasklist-group" data-tasklist-id="">
                <h3 className={css.tasklistTitle}>
                  <span className={css.tasklistName}>{t('board.unassignedTasklist')}</span>
                  <span className={css.columnCount}>{String(strayCards.length)}</span>
                </h3>
                {renderBoard(strayStages, strayCards, detail.stages, true)}
              </section>
            )}
          </div>
        ) : (
          renderBoard(detail.stages, cards, detail.stages)
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
        <form className={css.boxed} data-dsh-part="create" onSubmit={event => { void submitCreate(event) }}>
          <h3 className={css.formTitle}>{t('create.title')}</h3>
          <div className={css.formGrid}>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('create.title')}</span>
              <input
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
              <span className={css.fieldLabel}>{t('create.stage')}</span>
              <select
                className={css.tableSelect}
                value={draftStageId}
                disabled={creating}
                onChange={event => { setDraftStageId(event.target.value) }}
              >
                <option value="">{t('board.unassignedColumn')}</option>
                {grouped
                  ? tasklists.flatMap(list => {
                      const listStages = detail.stages.filter(stage => stage.tasklistId === list.id)
                      return listStages.length === 0
                        ? []
                        : [(
                            <optgroup key={list.id} label={list.name}>
                              {listStages.map(stage => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
                            </optgroup>
                          )]
                    })
                  : detail.stages.map(stage => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
              </select>
            </label>
            <button type="submit" className={`${css.button} ${css.primary}`} disabled={creating}>
              {creating ? t('create.submitting') : t('create.submit')}
            </button>
          </div>
          {createError === undefined ? null : <p className={css.cardError} role="alert">{createError}</p>}
          {activeProject === undefined ? null : <p className={css.hint}>{activeProject.name}</p>}
        </form>
      </>
    )
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
  readonly status: TeambitionStatusView | undefined
  readonly stages: readonly TeambitionStageView[]
  readonly settings: TeambitionSettingsView
  readonly roster: readonly WorkspaceItemView[]
  readonly detail: TeambitionProjectDetail
  readonly running: boolean
  readonly pending: boolean
  readonly busy: boolean
  readonly error: string | undefined
  readonly choice: TeambitionWorkspaceChoice | undefined
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
  const { card, status, stages, roster, detail, running, pending, busy, error, choice } = props
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
      data-workspace-bound={choice === undefined ? 'false' : 'true'}
    >
      <h4 className={css.cardTitle}>{card.title}</h4>
      <div className={css.cardMeta}>
        {status === undefined ? null : <span className={css.badge} data-dsh-part="status">{status.name}</span>}
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

      {stages.length === 0 ? null : (
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('board.moveStage')}</span>
          <select
            className={css.tableSelect}
            value={card.stageId ?? ''}
            disabled={busy || pending}
            onChange={event => { props.onStage(event.target.value) }}
          >
            <option value="">{t('board.unassignedColumn')}</option>
            {stages.map(stage => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
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
