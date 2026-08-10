/**
 * Preview subjects for the template builder.
 *
 * Returns a handful of analysed images with their FULL anchor set, so the
 * builder can solve framing locally on every slider move — no request per
 * change, no debounce, no server round trip. This endpoint is the reason the
 * live preview is instant.
 *
 * Selection is deliberately diverse: a template author needs to see the framing
 * against a full-body shot AND a close-up AND a flat-lay, because those are the
 * cases where a strategy chain falls through to a fallback. Showing five
 * near-identical full-body shots hides exactly the behaviour worth checking.
 */

import { NextRequest } from 'next/server'
import { images, products } from '@/db/repositories'
import { getUsableAnalysis } from '@/services/vision-service'
import { mediaUrl } from '@/storage/media-store'
import { handler, ok } from '@/lib/api'
import type { Anchors, Box, ShotType, Size } from '@/vision/types'

export const dynamic = 'force-dynamic'

/**
 * Trimmed payload for the client solver — exactly `FramingSubject` plus what
 * the overlay draws. Sending whole `VisionMetadata` documents for a dozen
 * subjects would be megabytes of person boxes and per-keypoint scores the
 * builder never reads.
 */
export interface PreviewSubject {
  imageId: string
  productId: string
  productName: string
  fileName: string
  imageUrl: string
  image: Size
  anchors: Anchors
  shotType: ShotType
  subjectBox: Box | null
  confidence: number
  personBox: Box | null
  faceBox: Box | null
  garmentBox: Box | null
}

const MAX_SUBJECTS = 12

export const GET = handler(async (request: NextRequest) => {
  const params = request.nextUrl.searchParams
  const requested = Math.min(MAX_SUBJECTS, Math.max(1, Number(params.get('limit')) || 6))
  const explicitImageId = params.get('imageId')
  const productId = params.get('productId')

  const ready = images.listByStatus('ready', 600)

  const subjects: PreviewSubject[] = []
  const seenShotTypes = new Set<ShotType>()

  const build = (image: (typeof ready)[number]): PreviewSubject | null => {
    const { metadata } = getUsableAnalysis(image.sourceHash)
    if (!metadata) return null

    const product = products.get(image.productId)
    const person =
      metadata.primaryPersonIndex !== null ? metadata.persons[metadata.primaryPersonIndex] : null
    const face =
      metadata.primaryFaceIndex !== null ? metadata.faces[metadata.primaryFaceIndex] : null

    return {
      imageId: image.id,
      productId: image.productId,
      productName: product?.name ?? image.fileName,
      fileName: image.fileName,
      imageUrl: mediaUrl('originals', image.storageKey),
      image: metadata.image,
      anchors: metadata.anchors,
      shotType: metadata.shot.type,
      subjectBox: metadata.segmentation.person?.bbox ?? person?.box ?? metadata.garment.box ?? null,
      confidence: metadata.quality.overall,
      personBox: person?.box ?? null,
      faceBox: face?.box ?? null,
      garmentBox: metadata.garment.box,
    }
  }

  // Scoped to one folder: every analysed photo in it, in import order — not a
  // cross-catalog sample. The operator picked this product deliberately, so
  // what shows here is exactly that product, not whatever the diversity
  // heuristic below would have surfaced instead.
  if (productId) {
    const productSubjects = images
      .listByProduct(productId)
      .filter(image => image.visionStatus === 'ready')
      .map(build)
      .filter((s): s is PreviewSubject => s !== null)

    return ok({ subjects: productSubjects, availableReady: productSubjects.length })
  }

  // An explicitly requested image always comes first — the builder pins the
  // image the operator opened it from.
  if (explicitImageId) {
    const image = images.get(explicitImageId)
    if (image) {
      const subject = build(image)
      if (subject) {
        subjects.push(subject)
        seenShotTypes.add(subject.shotType)
      }
    }
  }

  // First pass: one of each shot type, for coverage.
  for (const image of ready) {
    if (subjects.length >= requested) break
    if (subjects.some(s => s.imageId === image.id)) continue

    const subject = build(image)
    if (!subject || seenShotTypes.has(subject.shotType)) continue

    subjects.push(subject)
    seenShotTypes.add(subject.shotType)
  }

  // Second pass: fill any remaining slots, preferring high-confidence analyses
  // so the author is not judging a template against a bad detection.
  if (subjects.length < requested) {
    const remaining = ready
      .filter(image => !subjects.some(s => s.imageId === image.id))
      .map(build)
      .filter((s): s is PreviewSubject => s !== null)
      .sort((a, b) => b.confidence - a.confidence)

    subjects.push(...remaining.slice(0, requested - subjects.length))
  }

  return ok({ subjects, availableReady: ready.length })
})
