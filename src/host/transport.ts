/**
 * The HTTP transport of the Teambition provider.
 *
 * The transport is a one-method interface so the sync service never constructs
 * a request by itself: tests substitute a fake transport, and the production
 * implementation is a thin `node:https` wrapper. `fetch` is deliberately not
 * used — it brings its own proxy/redirect/compression policy, and the internal
 * API wants a plain cookie-authenticated request with an untouched body.
 *
 * @module dsh-task-board/host/teambition/http
 */
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'

/** One request the provider makes. */
export interface TeambitionHttpRequest {
  /** Absolute URL. */
  readonly url: string
  readonly method: 'GET' | 'PUT' | 'POST'
  /** Request headers; the caller decides which ones carry credentials. */
  readonly headers: Readonly<Record<string, string>>
  /** Raw request body, already serialized. */
  readonly body?: string
  /** Per-request timeout, defaulting to {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number
}

/** One response, with the body fully buffered. */
export interface TeambitionHttpResponse {
  readonly status: number
  /** Content type exactly as reported (`""` when absent). */
  readonly contentType: string
  /** Response body decoded as UTF-8. */
  readonly body: string
}

/** How a transport failure is classified. */
export type TeambitionTransportFailure = 'network' | 'timeout' | 'too-large' | 'invalid-url'

/** Transport-level failure; the sync service turns this into a diagnostic. */
export class TeambitionTransportError extends Error {
  constructor(readonly failure: TeambitionTransportFailure, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'TeambitionTransportError'
  }
}

/** One-method transport contract. */
export interface TeambitionTransport {
  request(request: TeambitionHttpRequest): Promise<TeambitionHttpResponse>
}

/** Default per-request timeout. */
export const DEFAULT_TIMEOUT_MS = 20_000

/** Refuse bodies above this size: a task list is large, an error page is not. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024

/** Pick the header value as a single string (drops array-valued headers). */
function readHeader(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name]
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value[0] ?? ''
  return ''
}

/**
 * Production transport over `node:https` (and `node:http` for local tests).
 *
 * Redirects are not followed: a 3xx is reported as-is, because a login redirect
 * to `www.teambition.com` is exactly the signal `diagnose` needs to show the
 * user instead of silently chasing it.
 * @returns the transport.
 */
export function createNodeTransport(): TeambitionTransport {
  return {
    request(request) {
      return new Promise<TeambitionHttpResponse>((resolve, reject) => {
        let url: URL
        try {
          url = new URL(request.url)
        } catch (cause) {
          reject(new TeambitionTransportError('invalid-url', `invalid URL ${request.url}`, { cause }))
          return
        }
        const send = url.protocol === 'http:' ? httpRequest : httpsRequest
        const payload = request.body
        const headers: Record<string, string> = { ...request.headers }
        if (payload !== undefined) headers['content-length'] = String(Buffer.byteLength(payload))
        const req = send(url, { method: request.method, headers }, response => {
          const chunks: Buffer[] = []
          let size = 0
          response.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > MAX_BODY_BYTES) {
              req.destroy(new TeambitionTransportError('too-large', `response body exceeded ${String(MAX_BODY_BYTES)} bytes`))
              return
            }
            chunks.push(chunk)
          })
          response.on('end', () => {
            resolve({
              status: response.statusCode ?? 0,
              contentType: readHeader(response.headers, 'content-type'),
              body: Buffer.concat(chunks).toString('utf8'),
            })
          })
          response.on('error', cause => {
            reject(new TeambitionTransportError('network', cause instanceof Error ? cause.message : String(cause), { cause }))
          })
        })
        req.setTimeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS, () => {
          req.destroy(new TeambitionTransportError('timeout', `request to ${url.host} timed out`))
        })
        req.on('error', cause => {
          if (cause instanceof TeambitionTransportError) reject(cause)
          else reject(new TeambitionTransportError('network', cause instanceof Error ? cause.message : String(cause), { cause }))
        })
        if (payload !== undefined) req.write(payload)
        req.end()
      })
    },
  }
}
