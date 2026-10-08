import fs from 'fs/promises'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { assertDiskSpaceAvailable, InsufficientDiskSpaceError } from '@/jobs/disk-guard'
import { config } from '@/config'

describe('assertDiskSpaceAvailable', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does nothing when free space is above the configured minimum', async () => {
    vi.spyOn(fs, 'statfs').mockResolvedValue({
      bavail: 1_000_000_000,
      bsize: 4096, // ~3.7 TB free
    } as any)
    await expect(assertDiskSpaceAvailable()).resolves.toBeUndefined()
  })

  it('throws InsufficientDiskSpaceError with a clear message when free space is below the minimum', async () => {
    vi.spyOn(fs, 'statfs').mockResolvedValue({
      bavail: 1000,
      bsize: 4096, // ~4 MB free — nowhere near config.jobs.diskMinFreeBytes
    } as any)

    await expect(assertDiskSpaceAvailable()).rejects.toThrow(InsufficientDiskSpaceError)
    try {
      await assertDiskSpaceAvailable()
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(InsufficientDiskSpaceError)
      const diskErr = err as InstanceType<typeof InsufficientDiskSpaceError>
      expect(diskErr.message).toContain('GB free')
      expect(diskErr.minFreeBytes).toBe(config.jobs.diskMinFreeBytes)
      expect(diskErr.freeBytes).toBeLessThan(diskErr.minFreeBytes)
    }
  })

  it('fails OPEN (does not block uploads) if statfs itself is unavailable on this platform', async () => {
    vi.spyOn(fs, 'statfs').mockRejectedValue(new Error('statfs not supported'))
    await expect(assertDiskSpaceAvailable()).resolves.toBeUndefined()
  })
})
