/**
 * Task detail page: the full card view the board and the task table open.
 *
 * The page renders immediately from the card the list already has (title,
 * properties), then fills the extra blocks — description, subtasks, activity
 * feed, custom fields — once `teambition/task/detail` settles. It is a modal
 * drawer with its own focus handling: opening focuses the close button, Escape
 * closes it, a click on the backdrop closes it.
 *
 * The footer keeps the same actions the board card has (run, advance/complete,
 * bind workspace); every action is the caller's callback so the panel owns the
 * remote writes and the refetch.
 *
 * @module @yeezone/dsh-client-ui-teambition/client/TaskDetail
 */
import { useEffect, useId, useRef, type ReactElement, type ReactNode } from 'react'
import type {
  TeambitionCardView,
  TeambitionCustomFieldView,
  TeambitionSettingsView,
  TeambitionSubtaskView,
  TeambitionTaskDetailView,
  TeambitionWorkspaceChoice,
} from '../core/protocol.ts'
import type { WorkspaceItemView } from './faces.ts'
import { t } from './locales.ts'
import css from './panel.module.css'

/** Load phase of the detail payload. */
export type TaskDetailPhase = 'loading' | 'ready' | 'failed'

/** One workflow step the footer can advance the card to. */
export interface TaskDetailStatusChoice {
  readonly id: string
  readonly name: string
}

/** Props of the task detail page. */
export interface TaskDetailPanelProps {
  /** The card the list opened; used for the skeleton and the actions. */
  readonly card: TeambitionCardView
  /** Loaded task page payload, when the host answered. */
  readonly detail: TeambitionTaskDetailView | undefined
  readonly phase: TaskDetailPhase
  /** Failure message of the last load attempt. */
  readonly error: string | undefined
  /** Resolved name of the card's board column / workflow status. */
  readonly columnName: string | undefined
  /** Whether that column is a workflow status column or a board stage column. */
  readonly columnKind: 'stage' | 'status' | undefined
  /** Name of the task list the card belongs to. */
  readonly tasklistName: string | undefined
  /** Name of the card's workflow status. */
  readonly statusName: string | undefined
  /** Name of the card's task type, when the project has one. */
  readonly scenarioName: string | undefined
  readonly settings: TeambitionSettingsView
  readonly roster: readonly WorkspaceItemView[]
  /** Resolved execution workspace of the card. */
  readonly choice: TeambitionWorkspaceChoice | undefined
  readonly running: boolean
  /** A status/stage move is in flight for this card. */
  readonly pending: boolean
  readonly busy: boolean
  /** Last remote-write failure of this card. */
  readonly cardError: string | undefined
  /** Next open workflow status, when the card can advance. */
  readonly nextStatus: TaskDetailStatusChoice | undefined
  /** End status id, when the card can be completed. */
  readonly completeStatusId: string | undefined
  readonly onRun: () => void
  readonly onStatus: (statusId: string) => void
  readonly onBind: (workspaceId: string) => void
  readonly onClose: () => void
  readonly onRetry: () => void
}

type PriorityKey = 'tasks.priorityUrgent' | 'tasks.priorityVeryUrgent' | 'tasks.priorityHighest'

/** Teambition stores the default priority as -10; anything below zero is plain. */
const PRIORITY_KEYS: Readonly<Record<number, PriorityKey>> = {
  0: 'tasks.priorityUrgent',
  1: 'tasks.priorityVeryUrgent',
  2: 'tasks.priorityHighest',
}

/** Label of one priority number (Teambition uses -10..3), undefined for the default. */
function priorityLabel(priority: number | undefined): string | undefined {
  if (priority === undefined || priority === null || Number.isNaN(priority)) return undefined
  if (priority < 0) return undefined
  const key = PRIORITY_KEYS[priority]
  return key === undefined ? t('tasks.priorityOther', { value: String(priority) }) : t(key)
}

/** Absolute date, when the value is a usable instant. */
function formatDay(value: number | undefined): string {
  if (value === undefined) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/** Absolute date-time, when the value is a usable instant. */
function formatMoment(value: number | undefined): string {
  if (value === undefined) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? '-'
    : date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** Parse an ISO string the host returned; undefined when absent/invalid. */
function instantOf(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** Overdue flag of the due date. */
function isOverdue(value: number | undefined): boolean {
  return value !== undefined && value < Date.now()
}

/** Title of one roster workspace: its title, else its path, else its id. */
function workspaceTitle(item: WorkspaceItemView): string {
  const title = item.title ?? ''
  if (title !== '') return title
  return item.path !== undefined && item.path !== '' ? item.path : item.workspaceId
}

/** Where a card's execution workspace binding came from. */
function sourceLabel(choice: TeambitionWorkspaceChoice): string {
  if (choice.source === 'card') return t('card.workspaceSourceCard')
  if (choice.source === 'project') return t('card.workspaceSourceProject')
  return t('card.workspaceSourceDefault')
}

/** First character of a display name, as an avatar fallback. */
function initialOf(name: string | undefined): string {
  const trimmed = (name ?? '').trim()
  return trimmed === '' ? '?' : Array.from(trimmed)[0]
}

/** One label/value row of the property grid. */
function PropertyRow(props: { readonly label: string; readonly children: ReactNode }): ReactElement {
  return (
    <div className={css.detailProp} data-dsh-part="detail-prop">
      <dt className={css.detailPropLabel}>{props.label}</dt>
      <dd className={css.detailPropValue}>{props.children}</dd>
    </div>
  )
}

/** One subtask row. */
function SubtaskRow(props: { readonly subtask: TeambitionSubtaskView }): ReactElement {
  const { subtask } = props
  const due = instantOf(subtask.dueAtRaw)
  const meta = [subtask.executorName, due === undefined ? undefined : formatDay(due)].filter(part => part !== undefined && part !== '')
  return (
    <li className={css.detailSubtask} data-dsh-part="detail-subtask" data-subtask-id={subtask.id} data-done={subtask.isDone ? 'true' : 'false'}>
      <span
        className={css.detailCheckbox}
        data-checked={subtask.isDone ? 'true' : 'false'}
        role="checkbox"
        aria-checked={subtask.isDone}
        aria-disabled="true"
      >{subtask.isDone ? '✓' : ''}</span>
      <span className={css.detailSubtaskTitle}>{subtask.title}</span>
      {meta.length === 0 ? null : <span className={css.detailSubtaskMeta}>{meta.join(' · ')}</span>}
    </li>
  )
}

/** One activity row of the feed. */
function ActivityRow(props: { readonly name: string | undefined; readonly action: string; readonly at: number | undefined }): ReactElement {
  return (
    <li className={css.detailActivity} data-dsh-part="detail-activity">
      <span className={css.detailAvatar} aria-hidden="true">{initialOf(props.name)}</span>
      <span className={css.detailActivityBody}>
        <span className={css.detailActivityText}>{props.action}</span>
        <span className={css.detailActivityTime}>{formatMoment(props.at)}</span>
      </span>
    </li>
  )
}

/** One custom field row. */
function CustomFieldRow(props: { readonly field: TeambitionCustomFieldView }): ReactElement {
  return (
    <li className={css.detailCustomField} data-dsh-part="detail-custom-field">
      <span className={css.detailPropLabel}>{props.field.name}</span>
      <span className={css.detailPropValue}>{props.field.value}</span>
    </li>
  )
}

/** Skeleton block shown while the task page payload loads. */
function DetailSkeleton(): ReactElement {
  return (
    <div className={css.detailSkeleton} data-dsh-part="detail-skeleton" aria-busy="true">
      <p className={css.muted}>{t('detail.loading')}</p>
      <span className={css.detailSkeletonBar} />
      <span className={css.detailSkeletonBar} />
      <span className={css.detailSkeletonBar} />
    </div>
  )
}

/**
 * Render the task detail page.
 * @param props - card, loaded detail payload and the action callbacks.
 * @returns the modal drawer element.
 */
export function TaskDetailPanel(props: TaskDetailPanelProps): ReactElement {
  const closeButton = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const card = props.detail?.card ?? props.card
  const detail = props.detail
  const due = card.dueAt
  const start = instantOf(detail?.startAtRaw)
  const subtasks = detail?.subtasks ?? []
  const doneSubtasks = subtasks.filter(subtask => subtask.isDone).length
  const note = detail?.note ?? ''
  const activities = detail === undefined
    ? []
    : [...detail.activities].sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0)).slice(0, 30)
  const priority = priorityLabel(card.priority)
  const boundWorkspace = props.choice === undefined ? undefined : props.roster.find(item => item.workspaceId === props.choice?.workspaceId)
  const bindingText = props.choice === undefined
    ? t('board.unboundWorkspace')
    : `${sourceLabel(props.choice)}${boundWorkspace === undefined ? '' : ` · ${workspaceTitle(boundWorkspace)}`}`
  const loaded = props.phase === 'ready'
  const failed = props.phase === 'failed'
  const nextStatus = props.nextStatus
  const completeStatusId = props.completeStatusId
  const columnLabel = props.columnKind === 'status' ? t('board.status') : t('detail.stage')
  const columnValue = props.columnName ?? props.statusName ?? '-'
  // Workflow projects expose their board column as a workflow status, which is
  // also what Teambition labels "status" in the task page, so the two rows merge.
  const showsColumnRow = props.columnKind !== 'status'
  const stateValue = props.columnKind === 'status' && props.columnName !== undefined
    ? props.columnName
    : (loaded ? (props.card.isDone === true ? t('tasks.done') : t('tasks.notDone')) : '…')

  useEffect(() => {
    closeButton.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        props.onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [props])

  return (
    <div
      className={css.detailOverlay}
      data-dsh-part="task-detail-overlay"
      onClick={event => {
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <div
        className={css.detailPanel}
        data-dsh-part="task-detail"
        data-card-id={card.id}
        data-phase={props.phase}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className={css.detailHead} data-dsh-part="detail-head">
          {priority === undefined ? null : <span className={css.priorityFlag} data-dsh-part="detail-priority">{priority}</span>}
          {card.uniqueId === undefined ? null : <span className={css.taskNumber} data-dsh-part="detail-number">#{card.uniqueId}</span>}
          <h2 id={titleId} className={`${css.detailTitle}${card.isDone === true ? ` ${css.detailTitleDone}` : ''}`}>{card.title}</h2>
          {card.isDone === true ? <span className={css.doneBadge} data-dsh-part="detail-done">✓ {t('tasks.done')}</span> : null}
          <span className={css.spacer} />
          <a className={css.link} href={card.url} target="_blank" rel="noreferrer" data-dsh-part="detail-open-external">
            {t('card.openExternal')}
          </a>
          <button
            ref={closeButton}
            type="button"
            className={css.detailClose}
            data-dsh-part="detail-close"
            aria-label={t('detail.close')}
            title={t('detail.close')}
            onClick={props.onClose}
          >
            ✕
          </button>
        </header>

        <div className={css.detailScroll}>
          <dl className={css.detailProps} data-dsh-part="detail-props">
            <PropertyRow label={t('tasks.state')}>{stateValue}</PropertyRow>
            <PropertyRow label={t('detail.executor')}>
              <span className={css.detailExecutor}>
                {card.executorName === undefined
                  ? null
                  : <span className={css.detailAvatar} aria-hidden="true">{initialOf(card.executorName)}</span>}
                {card.executorName ?? t('tasks.unassigned')}
              </span>
            </PropertyRow>
            <PropertyRow label={t('detail.creator')}>{detail?.creatorName ?? (loaded ? '-' : '…')}</PropertyRow>
            <PropertyRow label={t('detail.involvers')}>{detail === undefined ? '…' : (detail.involverNames.length === 0 ? '-' : detail.involverNames.join('、'))}</PropertyRow>
            <PropertyRow label={t('detail.priority')}>{priority ?? '-'}</PropertyRow>
            {detail?.storyPoint === undefined ? null : <PropertyRow label={t('detail.storyPoint')}>{String(detail.storyPoint)}</PropertyRow>}
            <PropertyRow label={t('detail.startAt')}>{start === undefined ? (loaded ? '-' : '…') : formatDay(start)}</PropertyRow>
            <PropertyRow label={t('detail.due')}>
              <span className={`${css.detailDue}${isOverdue(due) ? ` ${css.detailDueOverdue}` : ''}`} data-overdue={isOverdue(due) ? 'true' : 'false'}>
                {formatDay(due)}
              </span>
              {isOverdue(due) ? <span className={css.dueFlag}>{t('tasks.overdue')}</span> : null}
            </PropertyRow>
            {showsColumnRow ? <PropertyRow label={columnLabel}>{columnValue}</PropertyRow> : null}
            <PropertyRow label={t('detail.tasklist')}>{props.tasklistName ?? '-'}</PropertyRow>
            {props.scenarioName === undefined ? null : <PropertyRow label={t('detail.scenario')}>{props.scenarioName}</PropertyRow>}
            <PropertyRow label={t('detail.created')}>{formatMoment(card.createdAt)}</PropertyRow>
            <PropertyRow label={t('detail.updated')}>{formatMoment(card.updatedAt)}</PropertyRow>
            {detail?.attachmentsCount === undefined ? null : <PropertyRow label={t('detail.attachments')}>{String(detail.attachmentsCount)}</PropertyRow>}
            <PropertyRow label={t('detail.subtasks')}>{loaded ? `${doneSubtasks}/${subtasks.length}` : '…'}</PropertyRow>
          </dl>

          {props.cardError === undefined ? null : <p className={css.errorText} data-dsh-part="detail-card-error">{props.cardError}</p>}
          {failed ? (
            <p className={css.errorText} role="alert" data-dsh-part="detail-error">
              {props.error ?? '-'}
              <button type="button" className={css.button} data-dsh-part="detail-retry" onClick={props.onRetry}>{t('detail.retry')}</button>
            </p>
          ) : null}

          {loaded ? null : <DetailSkeleton />}

          <section className={css.detailSection} data-dsh-part="detail-note">
            <header className={css.detailSectionHead}>
              <h3 className={css.detailSectionTitle}>{t('detail.note')}</h3>
            </header>
            {loaded
              ? (note.trim() === ''
                  ? <p className={css.muted}>{t('detail.emptyNote')}</p>
                  : <p className={css.detailNote}>{note}</p>)
              : null}
          </section>

          <section className={css.detailSection} data-dsh-part="detail-subtasks">
            <header className={css.detailSectionHead}>
              <h3 className={css.detailSectionTitle}>{t('detail.subtasks')}</h3>
              {loaded ? <span className={css.columnCount}>{t('detail.subtaskProgress', { done: String(doneSubtasks), total: String(subtasks.length) })}</span> : null}
            </header>
            {loaded
              ? (subtasks.length === 0
                  ? <p className={css.muted}>{t('detail.emptySubtasks')}</p>
                  : <ul className={css.detailSubtaskList}>{subtasks.map(subtask => <SubtaskRow key={subtask.id} subtask={subtask} />)}</ul>)
              : null}
          </section>

          <section className={css.detailSection} data-dsh-part="detail-activities">
            <header className={css.detailSectionHead}>
              <h3 className={css.detailSectionTitle}>{t('detail.activities')}</h3>
              {loaded ? <span className={css.columnCount}>{String(activities.length)}</span> : null}
            </header>
            {loaded
              ? (activities.length === 0
                  ? <p className={css.muted}>{t('detail.emptyActivities')}</p>
                  : <ul className={css.detailActivityList}>{activities.map(activity => <ActivityRow key={activity.id} name={activity.actorName} action={activity.title} at={activity.createdAt} />)}</ul>)
              : null}
          </section>

          {detail !== undefined && detail.customFields.length > 0 ? (
            <section className={css.detailSection} data-dsh-part="detail-custom-fields">
              <header className={css.detailSectionHead}>
                <h3 className={css.detailSectionTitle}>{t('detail.customFields')}</h3>
              </header>
              <ul className={css.detailSubtaskList}>{detail.customFields.map(field => <CustomFieldRow key={field.name} field={field} />)}</ul>
            </section>
          ) : null}
        </div>

        <footer className={css.detailActions} data-dsh-part="detail-actions">
          <button type="button" className={`${css.button} ${css.primary}`} data-dsh-part="detail-run" disabled={props.busy} onClick={props.onRun}>
            {props.running ? <span className={css.spinner} aria-hidden="true" /> : null}
            {props.running ? t('card.running') : t('card.run')}
          </button>
          {nextStatus === undefined ? null : (
            <button type="button" className={css.button} data-dsh-part="detail-advance" disabled={props.busy || props.pending} onClick={() => { props.onStatus(nextStatus.id) }}>
              {nextStatus.name === '' ? t('detail.advance') : t('card.advanceTo', { name: nextStatus.name })}
            </button>
          )}
          {completeStatusId === undefined ? null : (
            <button type="button" className={css.button} data-dsh-part="detail-complete" disabled={props.busy || props.pending} onClick={() => { props.onStatus(completeStatusId) }}>
              {t('card.complete')}
            </button>
          )}
          <span className={css.spacer} />
          <a className={css.link} href={card.url} target="_blank" rel="noreferrer" data-dsh-part="detail-open-teambition">
            {t('card.openExternal')}
          </a>
          <label className={css.toolbarField} data-dsh-part="detail-bind">
            <span className={css.fieldLabel}>{t('card.bindingLabel')}</span>
            <select
              className={css.select}
              value={props.choice?.workspaceId ?? ''}
              title={bindingText}
              onChange={event => { props.onBind(event.target.value) }}
            >
              <option value="">{t('board.unboundWorkspace')}</option>
              {props.roster.map(item => <option key={item.workspaceId} value={item.workspaceId}>{workspaceTitle(item)}</option>)}
            </select>
          </label>
        </footer>
      </div>
    </div>
  )
}
