/**
 * Detection post-processing: IoU, non-maximum suppression, score utilities.
 *
 * Deterministic by construction. NMS sorts by score with an index tie-break, so
 * two detections with bit-identical scores always resolve the same way — without
 * that, `Array.prototype.sort` stability across engines becomes an input to
 * which person is picked as the subject, and the same photo could frame
 * differently on two machines.
 */

import type { Box } from '@/vision/types'
import { boxArea } from '@/vision/types'

export function intersectionOverUnion(a: Box, b: Box): number {
  const left = Math.max(a.left, b.left)
  const top = Math.max(a.top, b.top)
  const right = Math.min(a.right, b.right)
  const bottom = Math.min(a.bottom, b.bottom)

  const interW = right - left
  const interH = bottom - top
  if (interW <= 0 || interH <= 0) return 0

  const inter = interW * interH
  const union = boxArea(a) + boxArea(b) - inter
  return union > 0 ? inter / union : 0
}

export interface Scored {
  box: Box
  score: number
}

/**
 * Greedy non-maximum suppression.
 *
 * Returns indices into the input array, highest score first. The comparator
 * falls back to the original index so ordering is total and stable.
 */
export function nonMaximumSuppression<T extends Scored>(
  candidates: T[],
  iouThreshold: number,
  maxOutputs = 100
): number[] {
  const order = candidates
    .map((c, i) => ({ i, score: c.score }))
    .sort((a, b) => (b.score - a.score) || (a.i - b.i))

  const keep: number[] = []
  const suppressed = new Uint8Array(candidates.length)

  for (const { i } of order) {
    if (suppressed[i]) continue
    keep.push(i)
    if (keep.length >= maxOutputs) break

    for (const { i: j } of order) {
      if (j === i || suppressed[j]) continue
      if (intersectionOverUnion(candidates[i].box, candidates[j].box) > iouThreshold) {
        suppressed[j] = 1
      }
    }
  }

  return keep
}

/** Logistic sigmoid, used where a head emits logits rather than probabilities. */
export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1)
}

/**
 * Convert centre-form (cx, cy, w, h) to corner-form. YOLO heads emit the
 * former; everything downstream of the provider uses the latter.
 */
export function centerToBox(cx: number, cy: number, w: number, h: number): Box {
  const halfW = w / 2
  const halfH = h / 2
  return { left: cx - halfW, top: cy - halfH, right: cx + halfW, bottom: cy + halfH }
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}
