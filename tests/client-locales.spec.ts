// @vitest-environment jsdom
/**
 * Dictionary contract of the Teambition panel: the two languages carry the
 * same key set (so a missing translation fails here instead of rendering a raw
 * key), and the module-level translate follows the document language when the
 * SDK seat is unwired.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { en, setRuntimeTranslate, t, zh } from '../src/client/locales.ts'

/** `{name}` placeholders of one template, sorted. */
function placeholders(value: string): string[] {
  return (value.match(/\{[a-zA-Z0-9_]+\}/g) ?? []).sort()
}

afterEach(() => {
  setRuntimeTranslate(undefined)
  document.documentElement.lang = ''
})

describe('teambition locales', () => {
  it('en mirrors every zh key', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('every value is a non-empty single-line string', () => {
    for (const [key, value] of Object.entries(zh)) {
      expect(typeof value, key).toBe('string')
      expect(value.trim(), key).not.toBe('')
      expect(value.includes('\n'), key).toBe(false)
    }
    for (const [key, value] of Object.entries(en)) {
      expect(value.trim(), key).not.toBe('')
      expect(value.includes('\n'), key).toBe(false)
    }
  })

  it('keeps the placeholder set of every key identical across languages', () => {
    for (const key of Object.keys(zh) as Array<keyof typeof zh>) {
      expect(placeholders(en[key]), key).toEqual(placeholders(zh[key]))
    }
  })

  it('carries no emoji (the design policy is text-only)', () => {
    const emoji = /\p{Extended_Pictographic}/u
    for (const [key, value] of [...Object.entries(zh), ...Object.entries(en)]) {
      expect(emoji.test(value), key).toBe(false)
    }
  })

  it('follows the document language while the SDK seat is unwired', () => {
    document.documentElement.lang = 'en-US'
    expect(t('entry.label')).toBe(en['entry.label'])
    document.documentElement.lang = 'zh-CN'
    expect(t('header.refresh')).toBe(zh['header.refresh'])
  })

  it('prefers the wired SDK seat and interpolates params', () => {
    setRuntimeTranslate((key, params) => `${key}:${params?.name ?? ''}`)
    expect(t('card.advanceTo', { name: '进行中' })).toBe('card.advanceTo:进行中')
  })

  it('interpolates params locally when unwired', () => {
    document.documentElement.lang = 'zh-CN'
    const text = t('card.advanceTo', { name: '已完成' })
    expect(text).toBe(zh['card.advanceTo'].replaceAll('{name}', '已完成'))
    expect(text.includes('{name}')).toBe(false)
  })
})
