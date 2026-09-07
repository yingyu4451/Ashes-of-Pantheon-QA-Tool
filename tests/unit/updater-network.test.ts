import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OperationResult, UpdateStatus } from '../../src/shared/contracts'
import type { PortableRelease } from '../../src/main/portableArchive'

const platform = vi.hoisted(() => ({
  handlers: new Map<string, () => Promise<OperationResult<UpdateStatus>>>(),
  fetch: vi.fn<typeof fetch>(),
  request: vi.fn()
}))

vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '0.1.10' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: (channel: string, callback: () => Promise<OperationResult<UpdateStatus>>) => platform.handlers.set(channel, callback) },
  net: { fetch: platform.fetch, request: platform.request }
}))

import { initializeUpdater } from '../../src/main/updater'

const root = 'https://github.com/yingyu4451/Ashes-of-Pantheon-QA-Tool/releases'
const latest = `${root}/latest/download/update.json`
const pinned = `${root}/download/v0.2.0/update.json`
const release: PortableRelease = {
  schema: 1,
  version: '0.2.0',
  manifest: {
    schema: 1, version: '0.2.0', platform: 'win32-x64', entry: 'QA.exe',
    files: { 'QA.exe': { size: 3, sha256: 'a'.repeat(64) } }
  },
  full: { name: 'QA-0.2.0.zip', size: 100, sha256: 'b'.repeat(64) },
  deltas: []
}
let userDataRoot: string
let requests: Array<{ url: string; method: string }>
let latestResponse: { status: number; location?: string; headers: Record<string, string[]> }

beforeEach(async () => {
  userDataRoot = await mkdtemp(join(tmpdir(), 'ashes-update-network-'))
  vi.stubEnv('ASHES_OF_PANTHEON_QA_USER_DATA_DIR', userDataRoot)
  vi.useFakeTimers()
  platform.handlers.clear()
  platform.fetch.mockReset()
  platform.request.mockReset()
  requests = []
  latestResponse = { status: 302, location: pinned, headers: {} }
  platform.request.mockImplementation((options: { url: string; method?: string }) => {
    requests.push({ url: options.url, method: options.method ?? 'GET' })
    const request = Object.assign(new EventEmitter(), {
      abort: vi.fn(),
      end: () => {
        if (latestResponse.location) {
          // Electron can close the first hop before delivering its redirect event.
          request.emit('close')
          request.emit('redirect', latestResponse.status, options.method ?? 'GET', latestResponse.location, latestResponse.headers)
        } else {
          request.emit('response', Object.assign(new EventEmitter(), { statusCode: latestResponse.status, headers: latestResponse.headers }))
        }
      }
    })
    return request
  })
  platform.fetch.mockImplementation(async (input, options) => {
    const url = String(input)
    const method = options?.method ?? 'GET'
    requests.push({ url, method })
    if (url.startsWith('https://api.github.com/')) {
      return Response.json({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'x-ratelimit-remaining': '0' } })
    }
    if (options?.redirect === 'manual') throw new Error('Redirect was cancelled')
    if (url === pinned) return Response.json(release)
    if (url === `${root}/download/v0.2.0/QA-0.2.0.zip` && method === 'HEAD') {
      return new Response(null, { status: 200 })
    }
    return new Response(null, { status: 404 })
  })
  await initializeUpdater()
})

afterEach(async () => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await rm(userDataRoot, { recursive: true, force: true })
})

describe('packaged updater network', () => {
  it('discovers an official ZIP release while the anonymous GitHub API is rate limited', async () => {
    const result = await platform.handlers.get('update:check')!()

    expect(result).toMatchObject({ ok: true, data: { phase: 'available', latestVersion: '0.2.0' } })
    expect(requests.some(({ url }) => url.startsWith('https://api.github.com/'))).toBe(false)
    expect(requests).toContainEqual({ url: latest, method: 'HEAD' })
    expect(requests).toContainEqual({ url: pinned, method: 'GET' })
    expect(requests).toContainEqual({ url: `${root}/download/v0.2.0/QA-0.2.0.zip`, method: 'HEAD' })
  })

  it('explains rate limiting and the retry delay instead of only showing HTTP 403', async () => {
    latestResponse = { status: 403, headers: { 'x-ratelimit-remaining': ['0'], 'retry-after': ['120'] } }

    const result = await platform.handlers.get('update:check')!()

    expect(result.ok).toBe(false)
    expect(result.message).toContain('GitHub 请求被限流')
    expect(result.message).toContain('120 秒')
    expect(result.message).toContain('请勿连续点击重试')
    expect(platform.request).toHaveBeenCalledTimes(1)
    expect(platform.fetch).not.toHaveBeenCalled()
  })

  it('explains an invalid JSON response without exposing an HTML or parser error', async () => {
    platform.fetch.mockResolvedValueOnce(new Response('<html>Proxy error page</html>'))

    const result = await platform.handlers.get('update:check')!()

    expect(result.ok).toBe(false)
    expect(result.message).toContain('更新清单不是有效的 JSON')
    expect(result.message).toContain('代理或网络')
    expect(result.message).not.toContain('<html>')
  })

  it.each([
    'https://example.com/releases/download/v0.2.0/update.json',
    `${root}/download/v0.2.0-beta/update.json`,
    `${root}/download/v0.2.0/update.json?unexpected=1`,
    'https://github.com/another/project/releases/download/v0.2.0/update.json'
  ])('rejects unexpected release redirects: %s', async (location) => {
    latestResponse.location = location
    const result = await platform.handlers.get('update:check')!()
    expect(result).toMatchObject({ ok: false, data: { phase: 'error' } })
    expect(platform.fetch).not.toHaveBeenCalled()
  })

  it('rejects a manifest whose version does not match the official release tag', async () => {
    platform.fetch.mockResolvedValueOnce(Response.json({ ...release, version: '0.3.0', manifest: { ...release.manifest, version: '0.3.0' } }))
    const result = await platform.handlers.get('update:check')!()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('清单与正式版本不一致')
    expect(requests.every(({ url }) => !url.endsWith('.zip'))).toBe(true)
  })

  it.each([
    { ...release, full: { ...release.full, name: '../unsafe.zip' } },
    { ...release, full: { ...release.full, sha256: 'invalid' } },
    { ...release, manifest: { ...release.manifest, platform: 'linux-x64' } }
  ])('preserves manifest path, checksum and platform validation', async (invalid) => {
    platform.fetch.mockResolvedValueOnce(Response.json(invalid))
    const result = await platform.handlers.get('update:check')!()
    expect(result).toMatchObject({ ok: false, data: { phase: 'error' } })
    expect((await platform.handlers.get('update:download')!()).ok).toBe(false)
  })

  it('does not offer an update whose ZIP has not been published', async () => {
    platform.fetch.mockResolvedValueOnce(Response.json(release))
    platform.fetch.mockResolvedValueOnce(new Response(null, { status: 404 }))
    const result = await platform.handlers.get('update:check')!()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('检查 ZIP 发布文件')
    expect(result.message).toContain('404')
    expect((await platform.handlers.get('update:download')!()).ok).toBe(false)
  })

  it('does not mistake a generic forbidden response for a rate limit', async () => {
    latestResponse = { status: 403, headers: {} }
    const result = await platform.handlers.get('update:check')!()
    expect(result.message).toContain('GitHub 拒绝访问')
    expect(result.message).toContain('代理或网络')
    expect(result.message).not.toContain('被限流')
  })

  it('aborts a stalled version lookup and permits a later manual retry', async () => {
    const stalled = Object.assign(new EventEmitter(), { abort: vi.fn(), end: vi.fn() })
    platform.request.mockReturnValueOnce(stalled)
    const pending = platform.handlers.get('update:check')!()
    await vi.advanceTimersByTimeAsync(30_000)
    expect((await pending).message).toContain('超时')
    expect(stalled.abort).toHaveBeenCalledOnce()
    expect((await platform.handlers.get('update:check')!()).ok).toBe(true)
  })
})
