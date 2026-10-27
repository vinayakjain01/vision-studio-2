import { describe, it, expect } from 'vitest'
import { createTestTenant } from '../helpers/tenancy-fixture'
import { runWithTenant, type TenantContext } from '@/tenancy/context'
import { visionAnalyses } from '@/db/repositories'
import { getUsableAnalysis } from '@/services/vision-service'
import type { VisionMetadata } from '@/vision/types'

/**
 * User request (2026-10-27): a per-product shot-type override (see
 * tests/db/product-shot-type-override.test.ts) needs ONE place that applies
 * it, so every consumer of `getUsableAnalysis` (framing, AI-Extend
 * eligibility, the Products badge, the template preview) picks it up without
 * each of them re-implementing "override ?? detected" themselves. This is
 * that place — an optional second argument that replaces `shot.type` in the
 * returned metadata, leaving everything else (including the stored record)
 * untouched.
 */
function buildMetadata(sourceHash: string, shotType: VisionMetadata['shot']['type']): VisionMetadata {
  return {
    schemaVersion: 1,
    sourceHash,
    image: { width: 1200, height: 1800 },
    persons: [],
    primaryPersonIndex: null,
    faces: [],
    primaryFaceIndex: null,
    segmentation: { person: null, garment: null },
    garment: { type: 'unknown', box: null } as unknown as VisionMetadata['garment'],
    anchors: {} as unknown as VisionMetadata['anchors'],
    shot: { type: shotType, confidence: 1, reasoning: 'test fixture', signals: {} as any },
    quality: { overall: 1 } as unknown as VisionMetadata['quality'],
    engineVersion: 'test-engine',
    provider: 'test',
    modelVersions: {},
    timings: {},
    durationMs: 1,
    createdAt: new Date().toISOString(),
  }
}

describe('getUsableAnalysis — shot-type override', () => {
  it('returns the detected shot type unchanged when no override is given', async () => {
    const tenant = await createTestTenant('VisionOverrideNone')
    const ctx: TenantContext = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' }
    const sourceHash = 'a'.repeat(64)

    await runWithTenant(ctx, async () => {
      visionAnalyses.put(buildMetadata(sourceHash, 'product_only'))
      const { metadata } = getUsableAnalysis(sourceHash)
      expect(metadata?.shot.type).toBe('product_only')
    })
  })

  it('replaces shot.type with the override when one is given', async () => {
    const tenant = await createTestTenant('VisionOverrideSet')
    const ctx: TenantContext = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' }
    const sourceHash = 'b'.repeat(64)

    await runWithTenant(ctx, async () => {
      visionAnalyses.put(buildMetadata(sourceHash, 'product_only'))
      const { metadata } = getUsableAnalysis(sourceHash, 'flat_lay')
      expect(metadata?.shot.type).toBe('flat_lay')
    })
  })

  it('leaves every other field untouched when overriding shot.type', async () => {
    const tenant = await createTestTenant('VisionOverrideUntouched')
    const ctx: TenantContext = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' }
    const sourceHash = 'c'.repeat(64)

    await runWithTenant(ctx, async () => {
      visionAnalyses.put(buildMetadata(sourceHash, 'half_body'))
      const { metadata } = getUsableAnalysis(sourceHash, 'flat_lay')
      expect(metadata?.image).toEqual({ width: 1200, height: 1800 })
      expect(metadata?.shot.confidence).toBe(1)
    })
  })

  it('treats an explicit null override the same as no override', async () => {
    const tenant = await createTestTenant('VisionOverrideNull')
    const ctx: TenantContext = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' }
    const sourceHash = 'd'.repeat(64)

    await runWithTenant(ctx, async () => {
      visionAnalyses.put(buildMetadata(sourceHash, 'three_quarter'))
      const { metadata } = getUsableAnalysis(sourceHash, null)
      expect(metadata?.shot.type).toBe('three_quarter')
    })
  })

  it('does not mutate the stored record — a later unoverridden read still sees the detected type', async () => {
    const tenant = await createTestTenant('VisionOverrideNoMutation')
    const ctx: TenantContext = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' }
    const sourceHash = 'e'.repeat(64)

    await runWithTenant(ctx, async () => {
      visionAnalyses.put(buildMetadata(sourceHash, 'product_only'))
      getUsableAnalysis(sourceHash, 'flat_lay')
      const { metadata } = getUsableAnalysis(sourceHash)
      expect(metadata?.shot.type).toBe('product_only')
    })
  })
})
