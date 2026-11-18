import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import sharp from 'sharp'
import { config } from '@/config'

async function testPhoto(): Promise<Buffer> {
  return sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .jpeg()
    .toBuffer()
}

/**
 * Reported 2026-11-16: a brand-new, freshly-funded Cloudinary account still
 * failed generative fill on every single attempt — 6/6 attempts, ~165s,
 * same 423 "Processing continued in the background" as every other account
 * tried this session. Root cause was not the account, the plan, or the test
 * image (a real production photo reproduced it identically): the OUTER
 * retry loop (ai-extend-dispatcher.ts) calls `provider.generativeFill()`
 * fresh on every attempt, and `generativeFill()` uploads with
 * `unique_filename: true` on every call — so every single retry created a
 * BRAND NEW Cloudinary asset under a brand new public_id and kicked off an
 * entirely independent background AI job, which this code then never
 * revisited. A 423 here is Cloudinary's documented way of saying "this
 * exact derivation is still being computed asynchronously — poll the SAME
 * URL again", not "try again from scratch." Re-uploading on every retry
 * guaranteed every attempt landed on a job too young to have finished,
 * forever, regardless of account, plan, or image content.
 */
const uploadMock = vi.fn()
const destroyMock = vi.fn()
const urlMock = vi.fn(() => 'https://example.com/fake-genfill-url.jpg')

vi.mock('cloudinary', () => ({
  v2: {
    config: vi.fn(),
    uploader: {
      upload: (...args: unknown[]) => uploadMock(...args),
      destroy: (...args: unknown[]) => destroyMock(...args),
    },
    url: () => urlMock(),
  },
}))

describe('generativeFill — a 423 polls the SAME derivation instead of re-uploading', () => {
  const originalCloudName = config.cloudinary.cloudName
  const originalApiKey = config.cloudinary.apiKey
  const originalApiSecret = config.cloudinary.apiSecret
  const originalTimeout = config.cloudinary.requestTimeoutMs
  const originalPollInterval = config.cloudinary.pollIntervalMs

  beforeEach(() => {
    ;(config.cloudinary as any).cloudName = 'test-cloud'
    ;(config.cloudinary as any).apiKey = 'test-key'
    ;(config.cloudinary as any).apiSecret = 'test-secret'
    ;(config.cloudinary as any).requestTimeoutMs = 500
    ;(config.cloudinary as any).pollIntervalMs = 5
    uploadMock.mockReset()
    uploadMock.mockResolvedValue({ public_id: 'vision-studio/ai-extend/fake-id' })
    destroyMock.mockReset()
    destroyMock.mockResolvedValue({ result: 'ok' })
    urlMock.mockClear()
  })

  afterEach(() => {
    ;(config.cloudinary as any).cloudName = originalCloudName
    ;(config.cloudinary as any).apiKey = originalApiKey
    ;(config.cloudinary as any).apiSecret = originalApiSecret
    ;(config.cloudinary as any).requestTimeoutMs = originalTimeout
    ;(config.cloudinary as any).pollIntervalMs = originalPollInterval
    vi.unstubAllGlobals()
  })

  it('re-fetches the identical URL on 423 and succeeds without uploading more than once', async () => {
    const finalBytes = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .jpeg()
      .toBuffer()

    let fetchCalls = 0
    const urlsFetched: unknown[] = []
    const fetchMock = vi.fn(async (url: unknown) => {
      fetchCalls++
      urlsFetched.push(url)
      if (fetchCalls < 3) {
        return new Response('', {
          status: 423,
          headers: { 'x-cld-error': 'Processing continued in the background' },
        })
      }
      return new Response(finalBytes, {
        status: 200,
        headers: { 'content-length': String(finalBytes.length) },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { generativeFill } = await import('@/services/cloudinary-service')

    const result = await generativeFill({
      photo: await testPhoto(),
      canvasWidth: 100,
      canvasHeight: 100,
      offsetX: 0,
      offsetY: 0,
      placedWidth: 100,
      placedHeight: 100,
    })

    expect(result.width).toBe(100)
    expect(result.height).toBe(100)

    // The whole point of the fix: exactly one upload (one background job),
    // not one upload per 423.
    expect(uploadMock).toHaveBeenCalledTimes(1)

    // Every fetch hit the SAME transformation URL — polling the same
    // derivation, not a freshly-generated one.
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(new Set(urlsFetched).size).toBe(1)
  })

  it('gives up with a retryable timeout error if 423 persists past the overall deadline', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('', {
          status: 423,
          headers: { 'x-cld-error': 'Processing continued in the background' },
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    const { generativeFill } = await import('@/services/cloudinary-service')

    await expect(
      generativeFill({
        photo: await testPhoto(),
        canvasWidth: 100,
        canvasHeight: 100,
        offsetX: 0,
        offsetY: 0,
        placedWidth: 100,
        placedHeight: 100,
      })
    ).rejects.toMatchObject({ name: 'CloudinaryServiceError', kind: 'timeout' })

    // Still only ONE upload even though it gave up — the deadline bounds
    // polling the same job, it never silently starts a second one.
    expect(uploadMock).toHaveBeenCalledTimes(1)
  })
})
