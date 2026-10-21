/**
 * Copy of the Teambition panel, zh + en.
 *
 * `zh` is the key source: `TeambitionKey` is derived from it, and `en` is typed
 * as the complete mirror, so a key added on one side fails the typecheck on the
 * other. The panel itself only ever calls {@link t}; every user-facing string
 * lives here.
 *
 * The module-level translate seat follows the task-board pattern: the browser
 * `apply()` wires the SDK locale runtime (`setRuntimeTranslate`) once the
 * dictionaries are registered, so React renders and plain-DOM callers read the
 * ACTIVE language at call time; the document-language pick is only the
 * unwired fallback (tests, locale service absent).
 *
 * @module @yeezone/dsh-client-ui-teambition/client/locales
 */
// Type-only: this import also keeps the file a module (a `declare module`
// augmentation is only legal in a module) and pulls the LocaleNamespaceMap
// declaration extended at the bottom of this file.
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Chinese dictionary (key source). */
export const zh = {
  'entry.label': 'Teambition',
  'header.title': 'Teambition',
  'header.project': '项目',
  'header.tasklist': '任务列表',
  'header.tasklistAll': '全部任务列表',
  'header.refresh': '刷新',
  'header.refreshing': '刷新中…',
  'header.settings': '设置',
  'header.back': '返回看板',
  'connection.ok': '已连接',
  'connection.unconfigured': '未配置 Cookie',
  'panel.loading': '正在加载 Teambition 数据…',
  'panel.loadingProject': '正在加载项目…',
  'panel.retry': '重试',
  'panel.noProjects': '还没有可用的项目',
  'panel.noProjectsHint': '打开设置粘贴 Teambition Cookie，然后刷新项目列表。',
  'panel.openSettings': '打开设置',
  'board.empty': '这个项目还没有卡片',
  'board.emptyHint': '该项目没有卡片，可切换项目或任务列表，也可以到 Teambition 创建。',
  'board.emptyTasklistHint': '当前任务列表没有卡片，切换到「全部任务列表」可以查看整个项目。',
  'board.openProject': '去 Teambition',
  'board.unassignedColumn': '未分配看板列',
  'board.unassignedTasklist': '未归属任务列表',
  'board.unboundWorkspace': '未绑定工作区',
  'board.moveStage': '移动到看板列',
  'card.run': '执行',
  'card.running': '执行中…',
  'card.advanceTo': '推进到「{name}」',
  'card.complete': '标记完成',
  'card.openExternal': '在 Teambition 打开',
  'card.workspaceLabel': '执行工作区',
  'card.workspaceSourceCard': '卡片绑定',
  'card.workspaceSourceProject': '项目默认',
  'card.workspaceSourceDefault': '面板默认',
  'card.workspaceUnboundHint': '未绑定：执行时使用列表中的第一个工作区',
  'card.bindingLabel': '绑定执行工作区',
  'create.title': '新建卡片',
  'create.titlePlaceholder': '卡片标题',
  'create.notePlaceholder': '备注（可选）',
  'create.stage': '看板列',
  'create.submit': '新建',
  'create.submitting': '创建中…',
  'create.titleRequired': '请先填写卡片标题。',
  'settings.title': 'Teambition 设置',
  'settings.cookie': 'Cookie',
  'settings.cookiePlaceholder': '粘贴已登录 teambition.com 浏览器的 Cookie 请求头',
  'settings.cookieHint': '在已登录 teambition.com 的浏览器里打开开发者工具 → Network，复制任意请求的 Cookie 请求头粘贴到此处。Cookie 只保存在 Host 端，不会返回浏览器。',
  'settings.cookieStored': '已保存 Cookie（尾号 {tail}）',
  'settings.cookieMissing': '还没有配置 Cookie。粘贴 Cookie 后保存即可连接 Teambition。',
  'settings.cookieRequired': '请先粘贴 Cookie。',
  'settings.cookieLooksLikeUrl': '这里要填的是 Cookie 请求头，不是网址。请在已登录 teambition.com 的浏览器里按 F12 打开开发者工具 → Network → 点任意请求 → 复制请求头里的 Cookie 整行（形如 TEAMBITION_SESSIONID=...; TF_...=...）。',
  'settings.cookieSave': '保存 Cookie',
  'settings.cookieSaving': '保存中…',
  'settings.cookieClear': '清除 Cookie',
  'settings.operatorId': '操作者 ID',
  'settings.operatorIdPlaceholder': 'Teambition 用户 id（可留空）',
  'settings.operatorIdHint': '写入卡片时作为 x-operator-id 发送，留空则不发送。',
  'settings.operatorIdStored': '已配置',
  'settings.operatorIdSave': '保存',
  'settings.operatorIdClear': '清除',
  'settings.apiBase': '接口地址',
  'settings.apiBaseHint': '探测和请求使用的 Teambition 域名。浏览器 Cookie 只能走 www 代理。',
  'settings.apiBaseApi': 'api.teambition.com（需官方应用令牌）',
  'settings.apiBaseWeb': 'www.teambition.com（浏览器 Cookie，推荐）',
  'settings.defaultWorkspace': '默认执行工作区',
  'settings.defaultWorkspaceHint': '卡片没有卡片或项目绑定时，在该工作区创建 DSH 会话。',
  'settings.projectDefaults': '项目默认工作区',
  'settings.projectDefaultsHint': '为每个项目指定默认执行工作区；卡片执行时优先使用卡片绑定。',
  'settings.projectDefaultsEmpty': '还没有项目，刷新项目列表后可在此绑定。',
  'settings.projectDefaultNone': '未设置',
  'settings.diagnose': '诊断连接',
  'settings.diagnosing': '诊断中…',
  'settings.diagnoseConclusion': '结论',
  'settings.diagnoseNoCookie': '未配置 Cookie，诊断会提示 no-cookie。',
  'settings.diagnoseProbes': '探测结果',
  'settings.probeOk': '正常',
  'settings.probeFailed': '失败',
  'settings.probeNoStatus': '无响应',
  'settings.workspaceUnbound': '不绑定（使用默认）',
  'settings.saveBindings': '保存绑定',
  'settings.saving': '保存中…',
  'settings.saved': '设置已保存',
  'conclusion.usable': '可用',
  'conclusion.no-cookie': '未配置 Cookie',
  'conclusion.cookie-invalid': 'Cookie 无效或已过期',
  'conclusion.endpoint-not-found': '接口地址不可用',
  'conclusion.network-error': '网络错误',
  'conclusion.unknown': '无法判断',
  'error.transport': '无法连接 Host 的 Teambition 接口，请确认插件已启用。',
  'error.generic': '操作失败：{message}',
  'error.noWorkspace': '没有可用的 DSH 工作区，请先创建一个工作区。',
  'run.failed': '执行卡片失败：{message}',
  'run.promptIntro': '请在这张 Teambition 卡片上继续工作。',
  'run.promptRejected': '会话未接受本次提示。',
} as const

/** The dictionary key union. */
export type TeambitionKey = keyof typeof zh

/** English dictionary: the complete mirror of {@link zh}. */
export const en: Record<TeambitionKey, string> = {
  'entry.label': 'Teambition',
  'header.title': 'Teambition',
  'header.project': 'Project',
  'header.tasklist': 'Task list',
  'header.tasklistAll': 'All task lists',
  'header.refresh': 'Refresh',
  'header.refreshing': 'Refreshing…',
  'header.settings': 'Settings',
  'header.back': 'Back to board',
  'connection.ok': 'Connected',
  'connection.unconfigured': 'Cookie not configured',
  'panel.loading': 'Loading Teambition data…',
  'panel.loadingProject': 'Loading project…',
  'panel.retry': 'Retry',
  'panel.noProjects': 'No project available yet',
  'panel.noProjectsHint': 'Open Settings, paste a Teambition cookie, then refresh the project list.',
  'panel.openSettings': 'Open settings',
  'board.empty': 'This project has no card yet',
  'board.emptyHint': 'This project has no card. Switch the project or task list, or create one in Teambition.',
  'board.emptyTasklistHint': 'This task list has no card; switch to “All task lists” to see the whole project.',
  'board.openProject': 'Open in Teambition',
  'board.unassignedColumn': 'No column',
  'board.unassignedTasklist': 'No task list',
  'board.unboundWorkspace': 'No workspace bound',
  'board.moveStage': 'Move to column',
  'card.run': 'Run',
  'card.running': 'Running…',
  'card.advanceTo': 'Advance to “{name}”',
  'card.complete': 'Mark done',
  'card.openExternal': 'Open in Teambition',
  'card.workspaceLabel': 'Run workspace',
  'card.workspaceSourceCard': 'card binding',
  'card.workspaceSourceProject': 'project default',
  'card.workspaceSourceDefault': 'panel default',
  'card.workspaceUnboundHint': 'Unbound: the first workspace in the list is used when running',
  'card.bindingLabel': 'Bind run workspace',
  'create.title': 'New card',
  'create.titlePlaceholder': 'Card title',
  'create.notePlaceholder': 'Note (optional)',
  'create.stage': 'Column',
  'create.submit': 'Create',
  'create.submitting': 'Creating…',
  'create.titleRequired': 'Enter a card title first.',
  'settings.title': 'Teambition settings',
  'settings.cookie': 'Cookie',
  'settings.cookiePlaceholder': 'Paste the Cookie request header of a logged-in teambition.com tab',
  'settings.cookieHint': 'In a browser logged in to teambition.com open the developer tools → Network, copy the Cookie request header of any request and paste it here. The cookie stays on the host and is never returned to the browser.',
  'settings.cookieStored': 'Cookie stored (ends with {tail})',
  'settings.cookieMissing': 'No cookie configured yet. Paste one and save to connect Teambition.',
  'settings.cookieRequired': 'Paste a cookie first.',
  'settings.cookieLooksLikeUrl': 'That is a page URL, not a Cookie header. In a browser logged in to teambition.com press F12, open Network, click any request and copy the whole Cookie request header (for example TEAMBITION_SESSIONID=...; TF_...=...).',
  'settings.cookieSave': 'Save cookie',
  'settings.cookieSaving': 'Saving…',
  'settings.cookieClear': 'Clear cookie',
  'settings.operatorId': 'Operator id',
  'settings.operatorIdPlaceholder': 'Teambition user id (optional)',
  'settings.operatorIdHint': 'Sent as x-operator-id on writes; left blank it is not sent.',
  'settings.operatorIdStored': 'Configured',
  'settings.operatorIdSave': 'Save',
  'settings.operatorIdClear': 'Clear',
  'settings.apiBase': 'API base',
  'settings.apiBaseHint': 'Teambition domain used for probes and requests. A browser cookie only works through the www proxy.',
  'settings.apiBaseApi': 'api.teambition.com (official app token required)',
  'settings.apiBaseWeb': 'www.teambition.com (browser cookie, recommended)',
  'settings.defaultWorkspace': 'Default run workspace',
  'settings.defaultWorkspaceHint': 'Cards with no card or project binding create their DSH session in this workspace.',
  'settings.projectDefaults': 'Project default workspaces',
  'settings.projectDefaultsHint': 'Pick the default run workspace per project; a card binding still wins.',
  'settings.projectDefaultsEmpty': 'No project yet; refresh the project list to bind one here.',
  'settings.projectDefaultNone': 'Not set',
  'settings.diagnose': 'Diagnose connection',
  'settings.diagnosing': 'Diagnosing…',
  'settings.diagnoseConclusion': 'Conclusion',
  'settings.diagnoseNoCookie': 'No cookie configured; a diagnose pass reports no-cookie.',
  'settings.diagnoseProbes': 'Probes',
  'settings.probeOk': 'OK',
  'settings.probeFailed': 'Failed',
  'settings.probeNoStatus': 'No response',
  'settings.workspaceUnbound': 'Not bound (use default)',
  'settings.saveBindings': 'Save bindings',
  'settings.saving': 'Saving…',
  'settings.saved': 'Settings saved',
  'conclusion.usable': 'Usable',
  'conclusion.no-cookie': 'No cookie configured',
  'conclusion.cookie-invalid': 'Cookie invalid or expired',
  'conclusion.endpoint-not-found': 'Endpoint unavailable',
  'conclusion.network-error': 'Network error',
  'conclusion.unknown': 'Undetermined',
  'error.transport': 'Cannot reach the host Teambition routes; check that the plugin is enabled.',
  'error.generic': 'Action failed: {message}',
  'error.noWorkspace': 'No DSH workspace available; create a workspace first.',
  'run.failed': 'Running the card failed: {message}',
  'run.promptIntro': 'Continue the work on this Teambition card.',
  'run.promptRejected': 'The session rejected the prompt.',
}

/** Active dictionary, picked by the document language (the unwired fallback). */
export function dictionary(): Record<TeambitionKey, string> {
  const lang = typeof document !== 'undefined' ? document.documentElement.lang : 'zh'
  return lang.toLowerCase().startsWith('en') ? en : zh
}

/** SDK translate seat wired by `apply()`; reads the ACTIVE locale at call time. */
let runtimeT: ((key: TeambitionKey, params?: Record<string, string>) => string) | undefined

/** Wire the SDK translate seat; pass undefined to restore the document-language pick. */
export function setRuntimeTranslate(t: ((key: TeambitionKey, params?: Record<string, string>) => string) | undefined): void {
  runtimeT = t
}

/**
 * Translate a key with optional `{name}` template params.
 * @param key - dictionary key.
 * @param params - values substituted into `{name}` placeholders.
 * @returns the localized text.
 */
export function t(key: TeambitionKey, params?: Record<string, string>): string {
  if (runtimeT !== undefined) return runtimeT(key, params)
  let text: string = dictionary()[key]
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, value)
  }
  return text
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Teambition panel copy. */
    teambition: TeambitionKey
  }
}
