import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import sharp from 'sharp'
import { config } from '@/config'

async function testPhoto(): Promise<Buffer> {
  return sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .jpeg()
    .toBuffer()
}

/**
 * Reported 2026-11-10: a background_fill job sat `running` for 6+ minutes
 * with ZERO retry log activity — unlike every other Cloudinary failure mode
 * seen so far (423, auth, rate-limited), which fail and retry within
 * seconds. Traced to the upload step (`client().uploader.upload`, the very
 * first Cloudinary call `generativeFill` makes): the Cloudinary SDK sets an
 * IDLE-socket timeout on that request (`post_request.setTimeout`, default
 * 60s — see node_modules/cloudinary/lib/uploader.js), not a TOTAL-DURATION
 * timeout. As long as the connection keeps seeing *any* traffic, that timer
 * never fires, however long the upload actually takes end to end — there
 * was no equivalent of the generative-fill fetch step's own
 * AbortController-based timeout.
 *
 * generativeFill now races the upload against the same
 * `config.cloudinary.requestTimeoutMs` budget the fetch step already uses,
 * throwing a properly classified (`'timeout'`, retryable) CloudinaryServiceError
 * instead of hanging indefinitely.
 */

const uploadMock = vi.fn()

vi.mock('cloudinary', () => ({
  v2: {
    config: vi.fn(),
    uploader: { upload: (...args: unknown[]) => uploadMock(...args) },
    url: vi.fn(() => 'https://example.com/fake.jpg'),
  },
}))

describe('generativeFill — upload step cannot hang forever', () => {
  const originalCloudName = config.cloudinary.cloudName
  const originalApiKey = config.cloudinary.apiKey
  const originalApiSecret = config.cloudinary.apiSecret
  const originalTimeout = config.cloudinary.requestTimeoutMs

  beforeEach(() => {
    ;(config.cloudinary as any).cloudName = 'test-cloud'
    ;(config.cloudinary as any).apiKey = 'test-key'
    ;(config.cloudinary as any).apiSecret = 'test-secret'
    ;(config.cloudinary as any).requestTimeoutMs = 50
    uploadMock.mockReset()
  })

  afterEach(() => {
    ;(config.cloudinary as any).cloudName = originalCloudName
    ;(config.cloudinary as any).apiKey = originalApiKey
    ;(config.cloudinary as any).apiSecret = originalApiSecret
    ;(config.cloudinary as any).requestTimeoutMs = originalTimeout
    vi.restoreAllMocks()
  })

  it('throws a retryable timeout error instead of hanging when the upload never resolves', async () => {
    uploadMock.mockImplementation(() => new Promise(() => {})) // never settles — the exact reported symptom

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
    ).rejects.toMatchObject({
      name: 'CloudinaryServiceError',
      kind: 'timeout',
    })
  })

  it('still rejects with the UPLOAD error (not a timeout) when the upload fails quickly on its own', async () => {
    uploadMock.mockRejectedValue({ http_code: 400, message: 'bad request' })

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
    ).rejects.toMatchObject({
      name: 'CloudinaryServiceError',
      kind: 'rejected',
    })
  })
})
