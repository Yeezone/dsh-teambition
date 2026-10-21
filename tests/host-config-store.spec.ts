/**
 * Config store: persistence, normalization and corrupt-file fallback.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  TEAMBITION_CONFIG_VERSION,
  defaultTeambitionSettings,
  normalizeSettings,
  settingsView,
  TeambitionConfigStore,
  type TeambitionHostState,
} from '../src/host/config-store.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-teambition-store-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A store rooted at the temporary DSH_HOME. */
function createStore(): TeambitionConfigStore {
  return new TeambitionConfigStore({ env: { DSH_HOME: root }, home: root })
}

/** A fully populated state fixture. */
function sampleState(): TeambitionHostState {
  return {
    version: 1,
    settings: {
      cookie: 'SESS=abcdef123456',
      operatorId: 'op-1',
      apiBase: 'web',
      defaultWorkspaceId: 'ws-default',
      projectBindings: [{ projectId: 'p1', workspaceId: 'w1' }],
      cardBindings: [{ taskId: 't1', workspaceId: 'w2' }],
    },
    lastSyncAt: 1_700_000_000_000,
    projects: [{ id: 'p1', name: 'Project One' }],
  }
}

describe('TeambitionConfigStore', () => {
  it('places the file under $DSH_HOME/teambition', () => {
    expect(createStore().path).toBe(join(root, 'teambition', 'config.json'))
  })

  it('starts from the defaults when no file exists', async () => {
    const loaded = await createStore().load()
    expect(loaded.warnings).toEqual([])
    expect(loaded.state).toEqual({ version: TEAMBITION_CONFIG_VERSION, settings: defaultTeambitionSettings() })
  })

  it('persists and reloads the full state', async () => {
    const store = createStore()
    await store.save(sampleState())

    const raw = JSON.parse(await readFile(join(root, 'teambition', 'config.json'), 'utf8')) as TeambitionHostState
    expect(raw.version).toBe(1)
    expect(raw.settings.cookie).toBe('SESS=abcdef123456')
    expect(raw.settings.operatorId).toBe('op-1')
    expect(raw.settings.apiBase).toBe('web')
    expect(raw.settings.defaultWorkspaceId).toBe('ws-default')
    expect(raw.settings.projectBindings).toEqual([{ projectId: 'p1', workspaceId: 'w1' }])
    expect(raw.settings.cardBindings).toEqual([{ taskId: 't1', workspaceId: 'w2' }])
    expect(raw.lastSyncAt).toBe(1_700_000_000_000)
    expect(raw.projects).toEqual([{ id: 'p1', name: 'Project One' }])

    const reloaded = await createStore().load()
    expect(reloaded.warnings).toEqual([])
    expect(reloaded.state.settings.cookie).toBe('SESS=abcdef123456')
    expect(reloaded.state.projects).toEqual([{ id: 'p1', name: 'Project One' }])
  })

  it('writes the file atomically and leaves no temp file behind', async () => {
    const store = createStore()
    await store.save(sampleState())
    await store.save({ ...sampleState(), lastSyncAt: 2 })
    const entries = await readdir(join(root, 'teambition'))
    expect(entries).toEqual(['config.json'])
    const reloaded = await createStore().load()
    expect(reloaded.state.lastSyncAt).toBe(2)
    if (process.platform !== 'win32') {
      const mode = (await stat(join(root, 'teambition', 'config.json'))).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })

  it('falls back to the defaults on corrupt JSON without throwing', async () => {
    await mkdir(join(root, 'teambition'), { recursive: true })
    await writeFile(join(root, 'teambition', 'config.json'), '{ not json', 'utf8')
    const loaded = await createStore().load()
    expect(loaded.warnings[0]).toMatch(/not valid JSON/)
    expect(loaded.state).toEqual({ version: TEAMBITION_CONFIG_VERSION, settings: defaultTeambitionSettings() })
  })

  it('falls back to the defaults on a version mismatch', async () => {
    await mkdir(join(root, 'teambition'), { recursive: true })
    await writeFile(join(root, 'teambition', 'config.json'), JSON.stringify({ version: 2, settings: { cookie: 'x' } }), 'utf8')
    const loaded = await createStore().load()
    expect(loaded.warnings[0]).toMatch(/version/)
    expect(loaded.state.settings.cookie).toBeUndefined()
  })

  it('falls back to the defaults on a non-object root', async () => {
    await mkdir(join(root, 'teambition'), { recursive: true })
    await writeFile(join(root, 'teambition', 'config.json'), '[]', 'utf8')
    const loaded = await createStore().load()
    expect(loaded.warnings[0]).toMatch(/not a JSON object/)
  })

  it('rejects a corrupt file atomically without clobbering the previous file', async () => {
    const store = createStore()
    await store.save(sampleState())
    const target = join(root, 'teambition', 'config.json')
    await rm(target)
    await mkdir(target)
    await expect(store.save(sampleState())).rejects.toThrow()
    expect((await readdir(join(root, 'teambition'))).some(entry => entry.endsWith('.tmp'))).toBe(false)
  })
})

describe('settings normalization', () => {
  it('trims, clamps and dedupes stored settings', () => {
    const settings = normalizeSettings({
      cookie: '  Cookie-A  ',
      operatorId: 42,
      apiBase: 'web',
      projectBindings: [
        { projectId: 'p1', workspaceId: 'w1' },
        { projectId: 'p1', workspaceId: 'w2' },
        { projectId: '', workspaceId: 'w3' },
        { projectId: 'p2' },
      ],
      cardBindings: [{ taskId: 't1', workspaceId: '  w4  ' }],
    })
    expect(settings.cookie).toBe('Cookie-A')
    expect('operatorId' in settings).toBe(false)
    expect(settings.apiBase).toBe('web')
    expect(settings.projectBindings).toEqual([{ projectId: 'p1', workspaceId: 'w1' }])
    expect(settings.cardBindings).toEqual([{ taskId: 't1', workspaceId: 'w4' }])
  })

  it('normalizes an unknown apiBase to api', () => {
    expect(normalizeSettings({ apiBase: 'nope' }).apiBase).toBe('api')
  })
})

describe('settingsView', () => {
  it('masks the cookie to its last four characters', () => {
    const view = settingsView(sampleState())
    expect(view.configured).toBe(true)
    expect(view.cookieTail).toBe('3456')
    expect(view.operatorIdConfigured).toBe(true)
    expect(view.defaultWorkspaceId).toBe('ws-default')
    expect(view.projectBindings).toEqual([{ projectId: 'p1', workspaceId: 'w1' }])
    expect(view.cardBindings).toEqual([{ taskId: 't1', workspaceId: 'w2' }])
    expect(view.lastSyncAt).toBe(1_700_000_000_000)
    expect('cookie' in view).toBe(false)
    expect(JSON.stringify(view)).not.toContain('abcdef')
  })

  it('reports the unconfigured defaults', () => {
    const view = settingsView({ version: 1, settings: defaultTeambitionSettings() })
    expect(view.configured).toBe(false)
    expect(view.cookieTail).toBeUndefined()
    expect(view.operatorIdConfigured).toBe(false)
    expect(view.apiBase).toBe('api')
    expect(view.projectBindings).toEqual([])
    expect(view.cardBindings).toEqual([])
  })
})
