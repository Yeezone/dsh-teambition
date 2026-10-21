/**
 * Redaction of remote response previews shown in diagnostics.
 *
 * `diagnose` returns a short preview of every probe response so the user can
 * see *why* an endpoint was refused, but those bodies may echo cookie material
 * or a session token. Everything that leaves the host half as a preview goes
 * through {@link redactPreview} first.
 *
 * @module dsh-task-board/core/teambition/redact
 */
import { truncate } from './mapping.ts'

/** How much of a response body a preview keeps. */
export const PREVIEW_MAX = 200

/** Cookie pairs shorter than this are too generic to redact by value alone. */
const MIN_SECRET_LENGTH = 8

/** `"token": "…"` style members of a JSON body (also covers cookie names). */
const JSON_SECRET = /("(?:token|access_token|refresh_token|tbsessionid|sessionid|authorization|password|secret)"?\s*[:=]\s*")([^"]{6,})(")/gi

/** `Bearer <token>` inside a text body. */
const BEARER_SECRET = /\b(bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi

/**
 * Split a `Cookie` header into its individual values.
 * @param cookie - raw cookie header.
 * @returns values long enough to be treated as secrets.
 */
function cookieValues(cookie: string | undefined): string[] {
  if (cookie === undefined) return []
  const values: string[] = []
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    const value = part.slice(separator + 1).trim()
    if (value.length >= MIN_SECRET_LENGTH) values.push(value)
  }
  return values
}

/**
 * Redact and truncate one remote response preview.
 *
 * The redaction is deterministic and offline: exact stored cookie values, JSON
 * token members and bearer tokens are replaced by `[redacted]`. It is a
 * mitigation for accidental leakage, not a substitute for keeping the cookie
 * out of summaries in the first place.
 * @param body - response body (or error message) to preview.
 * @param cookie - stored cookie, when the host half has one.
 * @returns the safe preview.
 */
export function redactPreview(body: string, cookie?: string): string {
  let text = body.replace(/\s+/g, ' ').trim()
  if (text === '') return ''
  if (cookie !== undefined && cookie.length >= MIN_SECRET_LENGTH) text = text.split(cookie).join('[redacted]')
  for (const value of cookieValues(cookie)) text = text.split(value).join('[redacted]')
  text = text.replace(JSON_SECRET, (_match, prefix: string, _secret: string, suffix: string) => `${prefix}[redacted]${suffix}`)
  text = text.replace(BEARER_SECRET, (_match, prefix: string) => `${prefix}[redacted]`)
  return truncate(text, PREVIEW_MAX)
}

/**
 * Redact a free-form diagnostic message (transport errors can embed URLs).
 * @param message - message to sanitize.
 * @param cookie - stored cookie, when known.
 * @returns the safe message.
 */
export function redactMessage(message: string, cookie?: string): string {
  const text = redactPreview(message, cookie)
  return text === '' ? 'unknown error' : text
}
