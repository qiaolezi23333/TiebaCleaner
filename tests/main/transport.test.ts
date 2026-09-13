import type { Session } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { decodeResponseBody, ElectronSessionTransport } from '../../src/main/electron-transport'
import { CoreError } from '../../src/main/core/errors'

describe('ElectronSessionTransport', () => {
  it('使用账号 Session 的 Chromium fetch 并携带会话凭据', async () => {
    const fetch = vi.fn(
      async () =>
        new Response('ok', {
          status: 200,
          headers: { 'content-type': 'text/plain' }
        })
    )
    const transport = new ElectronSessionTransport({ fetch } as unknown as Session, () => 1_000)

    await expect(
      transport.request({ url: 'https://tieba.baidu.com/i/i/my_reply', operation: 'test' })
    ).resolves.toMatchObject({ status: 200, body: 'ok' })
    expect(fetch).toHaveBeenCalledWith(
      'https://tieba.baidu.com/i/i/my_reply',
      expect.objectContaining({ credentials: 'include', cache: 'no-store' })
    )
  })

  it('保留删除请求的同站请求头和表单内容', async () => {
    const fetch = vi.fn(
      async () =>
        new Response('{"no":0}', {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    )
    const transport = new ElectronSessionTransport({ fetch } as unknown as Session, () => 1_000)
    const body = 'tid=123&pid=456&tbs=fresh-tbs'
    const headers = {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Origin: 'https://tieba.baidu.com',
      Referer: 'https://tieba.baidu.com/i/i/my_reply',
      'X-Requested-With': 'XMLHttpRequest'
    }

    await transport.request({
      url: 'https://tieba.baidu.com/f/commit/post/delete',
      method: 'POST',
      headers,
      body,
      operation: 'delete:reply'
    })

    expect(fetch).toHaveBeenCalledWith(
      'https://tieba.baidu.com/f/commit/post/delete',
      expect.objectContaining({
        method: 'POST',
        headers,
        body,
        credentials: 'include',
        cache: 'no-store'
      })
    )
  })

  it('原样发送和接收 Protobuf 二进制数据', async () => {
    const responseBytes = Uint8Array.from([8, 1, 18, 2, 8, 0])
    const fetch = vi.fn(
      async () =>
        new Response(responseBytes, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' }
        })
    )
    const transport = new ElectronSessionTransport({ fetch } as unknown as Session, () => 1_000)
    const requestBytes = Uint8Array.from([10, 2, 8, 42])

    const result = await transport.request({
      url: 'https://tiebac.baidu.com/c/u/feed/userpost?cmd=303002',
      method: 'POST',
      headers: { x_bd_data_type: 'protobuf' },
      body: requestBytes,
      responseType: 'binary',
      credentials: 'omit'
    })

    expect(result.body).toBe('')
    expect(result.bytes).toEqual(responseBytes)
    expect(fetch).toHaveBeenCalledWith(
      'https://tiebac.baidu.com/c/u/feed/userpost?cmd=303002',
      expect.objectContaining({ body: Buffer.from(requestBytes), credentials: 'omit' })
    )
  })

  it('根据响应头解码贴吧 GBK 页面', async () => {
    const body = joinBytes(
      new TextEncoder().encode('<html><div title="'),
      Uint8Array.from([0xbf, 0xbc, 0xd1, 0xd0]),
      new TextEncoder().encode('"></div></html>')
    )
    const fetch = vi.fn(
      async () =>
        new Response(body.buffer, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=GBK' }
        })
    )
    const transport = new ElectronSessionTransport({ fetch } as unknown as Session, () => 1_000)

    await expect(
      transport.request({ url: 'https://tieba.baidu.com/f/like/mylike' })
    ).resolves.toMatchObject({ body: '<html><div title="考研"></div></html>' })
  })

  it('支持 HTML meta 字符集并优先识别 BOM', () => {
    const gbkBody = joinBytes(
      new TextEncoder().encode('<meta charset="gbk"><p>'),
      Uint8Array.from([0xbf, 0xbc, 0xd1, 0xd0]),
      new TextEncoder().encode('</p>')
    )
    expect(decodeResponseBody(gbkBody.buffer)).toContain('考研')

    const utf8Body = joinBytes(
      Uint8Array.from([0xef, 0xbb, 0xbf]),
      new TextEncoder().encode('<p>考研</p>')
    )
    expect(decodeResponseBody(utf8Body.buffer, 'text/html; charset=gbk')).toBe('<p>考研</p>')
  })

  it('把超时归类为 NETWORK_TIMEOUT', async () => {
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          )
        })
    )
    const transport = new ElectronSessionTransport({ fetch } as unknown as Session, () => 5)

    await expect(transport.request({ url: 'https://tieba.baidu.com/' })).rejects.toMatchObject<
      Partial<CoreError>
    >({ code: 'NETWORK_TIMEOUT' })
  })
})

function joinBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}
