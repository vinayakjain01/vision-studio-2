/**
 * MODNet decoding — human alpha matting.
 *
 * Verified output signature:
 *
 *   input   input    float32 [1, 3, H, W]   RGB, (px/255 − 0.5) / 0.5  →  [−1, 1]
 *                    H and W must be multiples of 32.
 *   output  output   float32 [1, 1, H, W]   alpha in 0–1
 *
 * A soft matte rather than a hard mask is the point. Hair, chiffon and lace all
 * sit between 0 and 1, and every downstream anchor that reads the mask edge
 * (`feet`, `head_top`, `garment_hem`) inherits that precision. Thresholding
 * happens once, late, at a configurable value — not here.
 *
 * No letterbox: MODNet is fully convolutional and a padded border would put a
 * hard synthetic edge into the matte, which shows up as a straight line of
 * alpha exactly where the padding started.
 */

import type * as ort from 'onnxruntime-node'
import type { DecodedImage, ProbabilityMask } from '@/vision/types'
import { SEG_INPUT_MAX, SEG_INPUT_MULTIPLE } from '@/vision/model-registry'
import { resizeToTensor, roundUpTo } from './preprocess'
import { tensor, asFloat32, type LoadedSession } from './session'

export async function runSegmentation(
  loaded: LoadedSession,
  image: DecodedImage
): Promise<ProbabilityMask | null> {
  // Preserve aspect ratio, cap the long edge, snap both edges up to a multiple
  // of 32. Snapping up (not down) never discards image content.
  const longest = Math.max(image.width, image.height)
  const scale = Math.min(1, SEG_INPUT_MAX / longest)
  const targetW = roundUpTo(Math.round(image.width * scale), SEG_INPUT_MULTIPLE)
  const targetH = roundUpTo(Math.round(image.height * scale), SEG_INPUT_MULTIPLE)

  const { data } = resizeToTensor(image, targetW, targetH, {
    channelOrder: 'rgb',
    // (px/255 − 0.5) / 0.5  ==  (px − 127.5) / 127.5
    mean: 127.5,
    std: 127.5,
  })

  const inputName = loaded.inputNames[0]
  const outputs = await loaded.session.run({
    [inputName]: tensor(data, [1, 3, targetH, targetW]),
  })

  const raw = outputs[loaded.outputNames[0]] as ort.Tensor | undefined
  if (!raw) return null

  const alpha = asFloat32(raw)
  const dims = raw.dims as number[]
  // [1, 1, H, W] — trust the tensor's own dims over the requested ones.
  const outH = dims[dims.length - 2] ?? targetH
  const outW = dims[dims.length - 1] ?? targetW
  if (alpha.length < outW * outH) return null

  // Quantise 0–1 float to 0–255 for storage. 8 bits is well beyond what any
  // framing decision resolves, and it makes the mask a plain greyscale PNG.
  const out = new Uint8Array(outW * outH)
  for (let i = 0; i < out.length; i++) {
    const v = alpha[i]
    out[i] = v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0
  }

  return { data: out, width: outW, height: outH }
}

// ─── Mask geometry ───────────────────────────────────────────────────────────

export interface MaskStats {
  /** Tight box of pixels at or above threshold, in MASK pixel coordinates. */
  bbox: { left: number; top: number; right: number; bottom: number } | null
  /** Set pixels / total pixels. */
  coverage: number
  /** Mean probability over the set region, 0–1. */
  meanProbability: number
  setPixels: number
}

export function maskStats(mask: ProbabilityMask, threshold01: number): MaskStats {
  const cutoff = Math.round(threshold01 * 255)
  let minX = mask.width
  let minY = mask.height
  let maxX = -1
  let maxY = -1
  let count = 0
  let sum = 0

  for (let y = 0; y < mask.height; y++) {
    const row = y * mask.width
    for (let x = 0; x < mask.width; x++) {
      const v = mask.data[row + x]
      if (v >= cutoff) {
        count++
        sum += v
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }

  const total = mask.width * mask.height
  if (count === 0 || maxX < 0) {
    return { bbox: null, coverage: 0, meanProbability: 0, setPixels: 0 }
  }

  return {
    bbox: { left: minX, top: minY, right: maxX + 1, bottom: maxY + 1 },
    coverage: total > 0 ? count / total : 0,
    meanProbability: sum / count / 255,
    setPixels: count,
  }
}

/**
 * Lowest set pixel, as a fraction of mask height.
 *
 * Used for the `feet` anchor. Reading the mask rather than the ankle keypoints
 * is deliberate: shoes, a gown's train and a wide-leg hem all extend below the
 * ankle joint, and framing that cuts at the ankle clips them.
 */
export function lowestSetRow(mask: ProbabilityMask, threshold01: number): number | null {
  const cutoff = Math.round(threshold01 * 255)
  for (let y = mask.height - 1; y >= 0; y--) {
    const row = y * mask.width
    for (let x = 0; x < mask.width; x++) {
      if (mask.data[row + x] >= cutoff) return y
    }
  }
  return null
}

/** Highest set pixel — the crown of the head, hair included. */
export function highestSetRow(mask: ProbabilityMask, threshold01: number): number | null {
  const cutoff = Math.round(threshold01 * 255)
  for (let y = 0; y < mask.height; y++) {
    const row = y * mask.width
    for (let x = 0; x < mask.width; x++) {
      if (mask.data[row + x] >= cutoff) return y
    }
  }
  return null
}

/** Horizontal extent of set pixels on one row, or null when the row is empty. */
export function rowExtent(
  mask: ProbabilityMask,
  y: number,
  threshold01: number
): { left: number; right: number } | null {
  if (y < 0 || y >= mask.height) return null
  const cutoff = Math.round(threshold01 * 255)
  const row = y * mask.width
  let left = -1
  let right = -1
  for (let x = 0; x < mask.width; x++) {
    if (mask.data[row + x] >= cutoff) {
      if (left < 0) left = x
      right = x
    }
  }
  return left < 0 ? null : { left, right: right + 1 }
}

/** Area-weighted centroid of the set region, in mask pixels. */
export function maskCentroid(
  mask: ProbabilityMask,
  threshold01: number
): { x: number; y: number } | null {
  const cutoff = Math.round(threshold01 * 255)
  let sumX = 0
  let sumY = 0
  let count = 0
  for (let y = 0; y < mask.height; y++) {
    const row = y * mask.width
    for (let x = 0; x < mask.width; x++) {
      if (mask.data[row + x] >= cutoff) {
        sumX += x
        sumY += y
        count++
      }
    }
  }
  return count === 0 ? null : { x: sumX / count, y: sumY / count }
}

/**
 * Per-row set-pixel counts. The garment analyser reads this profile to find the
 * hem (where coverage collapses) and the shoulder line (where it peaks).
 */
export function rowProfile(mask: ProbabilityMask, threshold01: number): Uint32Array {
  const cutoff = Math.round(threshold01 * 255)
  const profile = new Uint32Array(mask.height)
  for (let y = 0; y < mask.height; y++) {
    const row = y * mask.width
    let count = 0
    for (let x = 0; x < mask.width; x++) {
      if (mask.data[row + x] >= cutoff) count++
    }
    profile[y] = count
  }
  return profile
}
