import type { Session } from 'electron'
import { CoreError } from './core/errors'
import type { Transport, TransportRequest, TransportResponse } from './core/transport'

export class ElectronSessionTransport implements Transport {
  constructor(
    private readonly accountSession: Session,
    private readonly defaultTimeout: () => number
  ) {}

  async request(request: TransportRequest): Promise<TransportResponse> {
    const controller = new AbortController()
    const timeoutMs = request.timeoutMs ?? this.defaultTimeout()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await this.accountSession.fetch(request.url, {
        method: request.method ?? 'GET',
        credentials: request.credentials ?? 'include',
        redirect: 'follow',
        cache: 'no-store',
        signal: controller.signal,
        headers: request.headers,
        body:
          typeof request.body === 'string'
            ? request.body
            : request.body
              ? Buffer.from(request.body)
              : undefined
      })
      const contentType = response.headers.get('content-type')
      const responseBuffer = await response.arrayBuffer()
      return {
        status: response.status,
        body:
          request.responseType === 'binary' ? '' : decodeResponseBody(responseBuffer, contentType),
        ...(request.responseType === 'binary' ? { bytes: new Uint8Array(responseBuffer) } : {}),
        url: response.url,
        headers: { 'content-type': contentType ?? undefined }
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new CoreError('NETWORK_TIMEOUT', undefined, { retryable: true, cause: error })
      }
      throw new CoreError('NETWORK_ERROR', undefined, { retryable: true, cause: error })
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Fetch's Response.text() always assumes UTF-8, while Tieba's legacy personal
 * center still serves some pages as GBK/GB2312. Decode the raw bytes using the
 * declared charset and fall back to a strict UTF-8/GB18030 probe.
 */
export function decodeResponseBody(buffer: ArrayBuffer, contentType?: string | null): string {
  const bytes = new Uint8Array(buffer)
  const declared = charsetFromContentType(contentType) ?? charsetFromMeta(bytes)
  const labels = [charsetFromBom(bytes), declared, 'utf-8', 'gb18030'].filter(
    (value, index, values): value is string => Boolean(value) && values.indexOf(value) === index
  )

  for (const label of labels) {
    try {
      return new TextDecoder(label, { fatal: true }).decode(bytes)
    } catch {
      // Try the next known encoding. Unsupported labels are handled here too.
    }
  }
  return new TextDecoder('utf-8').decode(bytes)
}

function charsetFromContentType(contentType?: string | null): string | undefined {
  const value = contentType?.match(/charset\s*=\s*["']?([^;\s"']+)/iu)?.[1]
  return normalizeCharset(value)
}

function charsetFromMeta(bytes: Uint8Array): string | undefined {
  const prefix = bytes.subarray(0, 1_024)
  let ascii = ''
  for (const byte of prefix) ascii += String.fromCharCode(byte)
  const direct = ascii.match(/<meta[^>]+charset\s*=\s*["']?([^\s"'/>]+)/iu)?.[1]
  const httpEquiv = ascii.match(
    /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([^\s;"']+)/iu
  )?.[1]
  return normalizeCharset(direct ?? httpEquiv)
}

function charsetFromBom(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8'
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  return undefined
}

function normalizeCharset(value: string | undefined): string | undefined {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase()
  if (['gbk', 'gb2312', 'gb_2312-80', 'x-gbk', 'cp936'].includes(normalized)) return 'gb18030'
  if (normalized === 'utf8') return 'utf-8'
  return normalized
}
