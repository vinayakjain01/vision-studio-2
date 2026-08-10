/**
 * SegFormer-B2 human parsing — per-pixel garment semantics.
 *
 * Verified output signature:
 *
 *   input   pixel_values  float32 [1, 3, 512, 512]  RGB, /255, ImageNet norm
 *   output  logits        float32 [1, 18, 128, 128]
 *
 * SegFormer's decode head runs at 1/4 of the input resolution, so the map comes
 * back at 128². It is NOT upsampled here: 128² is already finer than any
 * measurement taken from it (a hem row, a sleeve endpoint) needs, and keeping
 * it small makes the per-class scans in `analysis/garment.ts` cheap enough to
 * run on every image in a bulk import. Consumers scale to source coordinates
 * through the returned `scaleX`/`scaleY`.
 *
 * Argmax over the 18 channels gives the class id per cell. The per-cell winning
 * margin is also returned — a soft confidence that distinguishes "this is
 * clearly a dress" from "this is a coin-flip between dress and skirt", which
 * the garment analyser propagates into its own confidence.
 */

import type * as ort from 'onnxruntime-node'
import type { DecodedImage } from '@/vision/types'
import {
  PARSING_INPUT_SIZE,
  PARSING_MEAN,
  PARSING_STD,
  ATR_LABELS,
} from '@/vision/model-registry'
import { resizeToTensor } from './preprocess'
import { tensor, asFloat32, type LoadedSession } from './session'

/**
 * A dense class map. `data[y * width + x]` is an ATR class id (0–17);
 * `confidence[i]` is the softmax probability of that winning class.
 */
export interface ParsingMap {
  data: Uint8Array
  confidence: Float32Array
  width: number
  height: number
  /** Multiply a map x by this to reach source pixels. */
  scaleX: number
  scaleY: number
}

export async function runParsing(
  loaded: LoadedSession,
  image: DecodedImage
): Promise<ParsingMap | null> {
  // Stretch to a square rather than letterboxing. SegFormer was trained on
  // resized (not padded) crops, and padding introduces a background band the
  // model happily labels as clothing near the seam.
  const { data } = resizeToTensor(image, PARSING_INPUT_SIZE, PARSING_INPUT_SIZE, {
    channelOrder: 'rgb',
    mean: PARSING_MEAN,
    std: PARSING_STD,
  })

  const inputName = loaded.inputNames[0]
  const outputs = await loaded.session.run({
    [inputName]: tensor(data, [1, 3, PARSING_INPUT_SIZE, PARSING_INPUT_SIZE]),
  })

  const raw = outputs[loaded.outputNames[0]] as ort.Tensor | undefined
  if (!raw) return null

  const logits = asFloat32(raw)
  const dims = raw.dims as number[]
  const classes = dims[1] ?? ATR_LABELS.length
  const height = dims[2] ?? 0
  const width = dims[3] ?? 0
  if (width === 0 || height === 0) return null

  const plane = width * height
  if (logits.length < plane * classes) return null

  const map = new Uint8Array(plane)
  const confidence = new Float32Array(plane)

  for (let i = 0; i < plane; i++) {
    // Argmax and softmax in one pass over the channel dimension. Subtracting
    // the max before exponentiating keeps this stable for large logits.
    let best = 0
    let bestValue = logits[i]
    for (let c = 1; c < classes; c++) {
      const value = logits[c * plane + i]
      if (value > bestValue) {
        bestValue = value
        best = c
      }
    }

    let sum = 0
    for (let c = 0; c < classes; c++) {
      sum += Math.exp(logits[c * plane + i] - bestValue)
    }

    map[i] = best
    confidence[i] = sum > 0 ? 1 / sum : 0
  }

  return {
    data: map,
    confidence,
    width,
    height,
    scaleX: image.sourceWidth / width,
    scaleY: image.sourceHeight / height,
  }
}

// ─── Query helpers ───────────────────────────────────────────────────────────
//
// `analysis/garment.ts` reasons in terms of class SETS ("any garment class",
// "any skin class"), so everything below takes an id list rather than a single
// class. Membership is tested through a 256-entry lookup table built once per
// query — cheaper than `Array.includes` inside a per-pixel loop.

function membership(classes: number[]): Uint8Array {
  const table = new Uint8Array(256)
  for (const c of classes) table[c] = 1
  return table
}

export interface ClassRegion {
  /** Tight box in MAP coordinates. Null when no pixel matched. */
  bbox: { left: number; top: number; right: number; bottom: number } | null
  pixelCount: number
  /** Mean per-pixel confidence over the matched region. */
  meanConfidence: number
}

export function regionOf(map: ParsingMap, classes: number[]): ClassRegion {
  const table = membership(classes)
  let left = map.width
  let top = map.height
  let right = -1
  let bottom = -1
  let count = 0
  let confidenceSum = 0

  for (let y = 0; y < map.height; y++) {
    const row = y * map.width
    for (let x = 0; x < map.width; x++) {
      const i = row + x
      if (!table[map.data[i]]) continue
      count++
      confidenceSum += map.confidence[i]
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }

  if (count === 0) {
    return { bbox: null, pixelCount: 0, meanConfidence: 0 }
  }

  return {
    bbox: { left, top, right: right + 1, bottom: bottom + 1 },
    pixelCount: count,
    meanConfidence: confidenceSum / count,
  }
}

export function countOf(map: ParsingMap, classes: number[]): number {
  const table = membership(classes)
  let count = 0
  for (let i = 0; i < map.data.length; i++) if (table[map.data[i]]) count++
  return count
}

/**
 * Lowest map row containing any of `classes`, ignoring rows with fewer than
 * `minPixels` matches.
 *
 * The threshold matters for hems: a handful of stray pixels several rows below
 * the real hem — parsing noise around a shoe or a shadow — would otherwise set
 * the hem anchor and drag the framing down.
 */
export function lowestRowOf(
  map: ParsingMap,
  classes: number[],
  minPixels = 2
): number | null {
  const table = membership(classes)
  for (let y = map.height - 1; y >= 0; y--) {
    const row = y * map.width
    let count = 0
    for (let x = 0; x < map.width; x++) {
      if (table[map.data[row + x]] && ++count >= minPixels) return y
    }
  }
  return null
}

export function highestRowOf(
  map: ParsingMap,
  classes: number[],
  minPixels = 2
): number | null {
  const table = membership(classes)
  for (let y = 0; y < map.height; y++) {
    const row = y * map.width
    let count = 0
    for (let x = 0; x < map.width; x++) {
      if (table[map.data[row + x]] && ++count >= minPixels) return y
    }
  }
  return null
}

/** Per-row pixel counts for a class set. */
export function rowCounts(map: ParsingMap, classes: number[]): Uint32Array {
  const table = membership(classes)
  const counts = new Uint32Array(map.height)
  for (let y = 0; y < map.height; y++) {
    const row = y * map.width
    let count = 0
    for (let x = 0; x < map.width; x++) if (table[map.data[row + x]]) count++
    counts[y] = count
  }
  return counts
}

/**
 * Class at a source-space point, or null when the point falls outside the map.
 * Used to ask "is the wrist covered by clothing" directly at a keypoint.
 */
export function classAtSourcePoint(
  map: ParsingMap,
  x: number,
  y: number
): number | null {
  const mx = Math.round(x / map.scaleX)
  const my = Math.round(y / map.scaleY)
  if (mx < 0 || my < 0 || mx >= map.width || my >= map.height) return null
  return map.data[my * map.width + mx]
}

/**
 * Fraction of pixels in a small disc around a source-space point belonging to
 * `classes`.
 *
 * Sampling a neighbourhood rather than a single cell is what makes limb queries
 * robust: at 128² one map cell covers ~10 source pixels, and a wrist keypoint
 * landing one cell off the arm would otherwise read as background.
 */
export function classFractionNear(
  map: ParsingMap,
  x: number,
  y: number,
  classes: number[],
  radiusCells = 2
): number {
  const table = membership(classes)
  const cx = Math.round(x / map.scaleX)
  const cy = Math.round(y / map.scaleY)

  let matched = 0
  let total = 0
  for (let dy = -radiusCells; dy <= radiusCells; dy++) {
    const py = cy + dy
    if (py < 0 || py >= map.height) continue
    for (let dx = -radiusCells; dx <= radiusCells; dx++) {
      const px = cx + dx
      if (px < 0 || px >= map.width) continue
      if (dx * dx + dy * dy > radiusCells * radiusCells) continue
      total++
      if (table[map.data[py * map.width + px]]) matched++
    }
  }

  return total > 0 ? matched / total : 0
}

/** Render a class set as a binary mask at map resolution, 0 or 255. */
export function maskOfClasses(map: ParsingMap, classes: number[]): Uint8Array {
  const table = membership(classes)
  const out = new Uint8Array(map.data.length)
  for (let i = 0; i < map.data.length; i++) {
    out[i] = table[map.data[i]] ? 255 : 0
  }
  return out
}

export function labelName(classId: number): string {
  return ATR_LABELS[classId] ?? `class_${classId}`
}
