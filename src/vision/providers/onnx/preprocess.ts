/**
 * Tensor preparation: resize, letterbox, channel order, normalisation.
 *
 * All of it is hand-rolled rather than delegated to sharp, for one reason:
 * every operation here has to be exactly invertible. A detection comes back in
 * model-input coordinates and must land on the right pixel of the source image,
 * or a "head at 12% from the top" template silently frames the wrong thing. The
 * `Letterbox` record returned alongside each tensor is that inverse, and it is
 * the only sanctioned way back to source space.
 *
 * Pure functions over typed arrays — no I/O, no model knowledge.
 */

import type { DecodedImage, Point, Box } from '@/vision/types'

/**
 * The forward transform applied to reach model input, and everything needed to
 * undo it.
 *
 * Forward:  model_px = source_px * scale + pad
 * Inverse:  source_px = (model_px - pad) / scale
 */
export interface Letterbox {
  /** Uniform scale factor applied to the source image. */
  scale: number
  /** Left padding in model-input pixels. */
  padX: number
  /** Top padding in model-input pixels. */
  padY: number
  /** Model input dimensions. */
  inputWidth: number
  inputHeight: number
  /** Source dimensions the inverse maps back into. */
  sourceWidth: number
  sourceHeight: number
}

export function unletterboxPoint(p: Point, lb: Letterbox): Point {
  return {
    x: (p.x - lb.padX) / lb.scale,
    y: (p.y - lb.padY) / lb.scale,
  }
}

export function unletterboxBox(b: Box, lb: Letterbox): Box {
  return {
    left: (b.left - lb.padX) / lb.scale,
    top: (b.top - lb.padY) / lb.scale,
    right: (b.right - lb.padX) / lb.scale,
    bottom: (b.bottom - lb.padY) / lb.scale,
  }
}

/** Clamp a box to the image rectangle. Detections routinely overhang the edge. */
export function clampBox(b: Box, width: number, height: number): Box {
  return {
    left: Math.max(0, Math.min(width, b.left)),
    top: Math.max(0, Math.min(height, b.top)),
    right: Math.max(0, Math.min(width, b.right)),
    bottom: Math.max(0, Math.min(height, b.bottom)),
  }
}

// ─── Resampling ──────────────────────────────────────────────────────────────

/**
 * Resize interleaved 8-bit pixels.
 *
 * Downscales by more than 1.5× use box averaging; anything else uses bilinear.
 * That split matters for detection quality: bilinear downsampling a 4000px
 * studio photo to 640px aliases hard edges into noise, and a noisy hem edge
 * moves the `garment_hem` anchor. Box averaging is what OpenCV's INTER_AREA
 * does and is the standard preprocessing for exactly this reason.
 *
 * Fully deterministic — integer arithmetic on fixed weights, no float
 * accumulation order that varies by platform.
 */
export function resizePixels(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  channels: number,
  dstW: number,
  dstH: number
): Uint8Array {
  if (srcW === dstW && srcH === dstH) return src

  const scaleX = srcW / dstW
  const scaleY = srcH / dstH
  const useArea = scaleX > 1.5 || scaleY > 1.5

  return useArea
    ? resizeArea(src, srcW, srcH, channels, dstW, dstH)
    : resizeBilinear(src, srcW, srcH, channels, dstW, dstH)
}

function resizeArea(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  channels: number,
  dstW: number,
  dstH: number
): Uint8Array {
  const dst = new Uint8Array(dstW * dstH * channels)
  const scaleX = srcW / dstW
  const scaleY = srcH / dstH

  for (let dy = 0; dy < dstH; dy++) {
    const y0 = Math.floor(dy * scaleY)
    const y1 = Math.max(y0 + 1, Math.min(srcH, Math.ceil((dy + 1) * scaleY)))

    for (let dx = 0; dx < dstW; dx++) {
      const x0 = Math.floor(dx * scaleX)
      const x1 = Math.max(x0 + 1, Math.min(srcW, Math.ceil((dx + 1) * scaleX)))
      const count = (y1 - y0) * (x1 - x0)
      const dstIdx = (dy * dstW + dx) * channels

      for (let c = 0; c < channels; c++) {
        let sum = 0
        for (let sy = y0; sy < y1; sy++) {
          const rowBase = sy * srcW * channels + c
          for (let sx = x0; sx < x1; sx++) {
            sum += src[rowBase + sx * channels]
          }
        }
        dst[dstIdx + c] = (sum / count + 0.5) | 0
      }
    }
  }
  return dst
}

function resizeBilinear(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  channels: number,
  dstW: number,
  dstH: number
): Uint8Array {
  const dst = new Uint8Array(dstW * dstH * channels)
  // Half-pixel centre alignment — matches OpenCV/PIL and keeps the resize
  // symmetric, so a centred subject stays centred.
  const scaleX = srcW / dstW
  const scaleY = srcH / dstH

  for (let dy = 0; dy < dstH; dy++) {
    const fy = Math.max(0, (dy + 0.5) * scaleY - 0.5)
    const y0 = Math.min(srcH - 1, Math.floor(fy))
    const y1 = Math.min(srcH - 1, y0 + 1)
    const wy = fy - y0

    for (let dx = 0; dx < dstW; dx++) {
      const fx = Math.max(0, (dx + 0.5) * scaleX - 0.5)
      const x0 = Math.min(srcW - 1, Math.floor(fx))
      const x1 = Math.min(srcW - 1, x0 + 1)
      const wx = fx - x0

      const i00 = (y0 * srcW + x0) * channels
      const i01 = (y0 * srcW + x1) * channels
      const i10 = (y1 * srcW + x0) * channels
      const i11 = (y1 * srcW + x1) * channels
      const dstIdx = (dy * dstW + dx) * channels

      for (let c = 0; c < channels; c++) {
        const top = src[i00 + c] * (1 - wx) + src[i01 + c] * wx
        const bottom = src[i10 + c] * (1 - wx) + src[i11 + c] * wx
        dst[dstIdx + c] = (top * (1 - wy) + bottom * wy + 0.5) | 0
      }
    }
  }
  return dst
}

// ─── Letterboxing into a tensor ──────────────────────────────────────────────

export interface LetterboxOptions {
  /** Target square/rect input size. */
  inputWidth: number
  inputHeight: number
  /** Fill value for the padded region, 0–255 per channel. */
  padValue: number
  /** Place the resized image centred, or flush at the top-left. */
  align: 'center' | 'topleft'
  /** Channel order the model expects. */
  channelOrder: 'rgb' | 'bgr'
  /** `(value - mean) / std`, applied per channel after the order swap. */
  mean: number
  std: number
}

/**
 * Produce an NCHW float32 tensor plus its inverse transform.
 *
 * `align` exists because the two detectors disagree: YOLO centres the image in
 * the padded square, SCRFD (following InsightFace's reference implementation)
 * places it flush top-left. Getting this wrong shifts every face box by half
 * the padding, which is invisible on a square photo and badly wrong on a 2:3
 * portrait.
 */
export function letterboxToTensor(
  image: DecodedImage,
  options: LetterboxOptions
): { data: Float32Array; letterbox: Letterbox } {
  const { inputWidth, inputHeight, padValue, align, channelOrder, mean, std } = options

  const scale = Math.min(inputWidth / image.width, inputHeight / image.height)
  const resizedW = Math.max(1, Math.round(image.width * scale))
  const resizedH = Math.max(1, Math.round(image.height * scale))

  const padX = align === 'center' ? Math.floor((inputWidth - resizedW) / 2) : 0
  const padY = align === 'center' ? Math.floor((inputHeight - resizedH) / 2) : 0

  const resized = resizePixels(
    image.data,
    image.width,
    image.height,
    image.channels,
    resizedW,
    resizedH
  )

  const plane = inputWidth * inputHeight
  const data = new Float32Array(plane * 3)

  // Pre-fill with the normalised pad value so the padded border is a constant
  // the model sees consistently rather than uninitialised zeroes.
  const normalisedPad = (padValue - mean) / std
  if (normalisedPad !== 0) data.fill(normalisedPad)

  // Channel indices after the requested order swap. Source is always RGB(A).
  const c0 = channelOrder === 'rgb' ? 0 : 2
  const c1 = 1
  const c2 = channelOrder === 'rgb' ? 2 : 0

  for (let y = 0; y < resizedH; y++) {
    const dstRow = (y + padY) * inputWidth + padX
    const srcRow = y * resizedW * image.channels
    for (let x = 0; x < resizedW; x++) {
      const s = srcRow + x * image.channels
      const d = dstRow + x
      data[d] = (resized[s + c0] - mean) / std
      data[plane + d] = (resized[s + c1] - mean) / std
      data[2 * plane + d] = (resized[s + c2] - mean) / std
    }
  }

  return {
    data,
    letterbox: {
      // `scale` here maps ANALYSIS-image pixels to model pixels. Callers
      // compose it with image.scaleX/scaleY to reach source space.
      scale,
      padX,
      padY,
      inputWidth,
      inputHeight,
      sourceWidth: image.width,
      sourceHeight: image.height,
    },
  }
}

/** A single value applied to all channels, or one value per output channel. */
export type Normalisation = number | [number, number, number]

function channelValue(value: Normalisation, channel: number): number {
  return typeof value === 'number' ? value : value[channel]
}

/**
 * Resize straight to a target (no padding) and normalise — for dense-prediction
 * models like MODNet and SegFormer, where letterbox padding would put a hard
 * artificial edge into the output map.
 *
 * `mean`/`std` accept per-channel triples because the two dense models
 * disagree: MODNet wants a flat (x − 127.5) / 127.5, SegFormer wants ImageNet
 * per-channel statistics. Applying one model's normalisation to the other
 * produces output that looks structurally plausible and is systematically
 * wrong, which is far harder to notice than a crash.
 */
export function resizeToTensor(
  image: DecodedImage,
  targetW: number,
  targetH: number,
  options: { channelOrder: 'rgb' | 'bgr'; mean: Normalisation; std: Normalisation }
): { data: Float32Array; scaleX: number; scaleY: number } {
  const resized = resizePixels(
    image.data,
    image.width,
    image.height,
    image.channels,
    targetW,
    targetH
  )

  const plane = targetW * targetH
  const data = new Float32Array(plane * 3)
  const order = options.channelOrder === 'rgb' ? [0, 1, 2] : [2, 1, 0]

  for (let c = 0; c < 3; c++) {
    const srcChannel = order[c]
    const mean = channelValue(options.mean, c)
    const std = channelValue(options.std, c)
    const offset = c * plane
    for (let i = 0; i < plane; i++) {
      data[offset + i] = (resized[i * image.channels + srcChannel] - mean) / std
    }
  }

  return { data, scaleX: targetW / image.width, scaleY: targetH / image.height }
}

/** Round up to the nearest multiple — MODNet requires inputs divisible by 32. */
export function roundUpTo(value: number, multiple: number): number {
  return Math.max(multiple, Math.ceil(value / multiple) * multiple)
}
