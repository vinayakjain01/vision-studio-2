/**
 * Landmark overlay.
 *
 * Draws everything the Vision Engine found on top of an image: person boxes,
 * the pose skeleton, the face box and its five points, the mask bounding boxes,
 * the derived anchors, and a solved crop box.
 *
 * SVG in SOURCE-IMAGE coordinates via `viewBox`, so nothing here does any
 * scaling arithmetic — the browser maps source pixels to display pixels, and
 * an anchor at source (826, 300) lands on the same pixel of the photo whatever
 * size the element is rendered at. Doing that conversion in JS is how overlays
 * drift by a few pixels at some zoom levels, which is exactly the error a
 * debug view exists to rule out.
 *
 * Stroke widths are expressed with `vector-effect: non-scaling-stroke` so lines
 * stay 1–2 device pixels regardless of how far the viewBox is scaled.
 */

'use client'

import * as React from 'react'
import {
  SKELETON_EDGES,
  type Anchors,
  type AnchorName,
  type Box,
  type FaceDetection,
  type PersonDetection,
  type Size,
} from '@/vision/types'
import type { CropBox } from '@/framing/types'

export interface OverlayToggles {
  personBox: boolean
  skeleton: boolean
  keypoints: boolean
  faceBox: boolean
  faceLandmarks: boolean
  maskBounds: boolean
  garmentBox: boolean
  anchors: boolean
  anchorLabels: boolean
  cropBox: boolean
}

export const DEFAULT_TOGGLES: OverlayToggles = {
  personBox: false,
  skeleton: true,
  keypoints: true,
  faceBox: true,
  faceLandmarks: false,
  maskBounds: false,
  garmentBox: false,
  anchors: true,
  anchorLabels: true,
  cropBox: true,
}

/** Which colour band an anchor belongs to. Head/torso/limb/garment. */
const ANCHOR_COLOR: Record<AnchorName, string> = {
  head_top: 'var(--color-lm-head)',
  eye_line: 'var(--color-lm-head)',
  chin: 'var(--color-lm-head)',
  neck: 'var(--color-lm-head)',
  shoulder_left: 'var(--color-lm-torso)',
  shoulder_right: 'var(--color-lm-torso)',
  shoulder_center: 'var(--color-lm-torso)',
  chest: 'var(--color-lm-torso)',
  waist: 'var(--color-lm-torso)',
  hip_center: 'var(--color-lm-torso)',
  knee_center: 'var(--color-lm-limb)',
  ankle_center: 'var(--color-lm-limb)',
  feet: 'var(--color-lm-limb)',
  garment_top: 'var(--color-lm-garment)',
  garment_hem: 'var(--color-lm-garment)',
  subject_center: 'var(--color-lm-torso)',
  subject_top: 'var(--color-lm-torso)',
  subject_bottom: 'var(--color-lm-torso)',
}

export interface LandmarkOverlayProps {
  image: Size
  persons?: PersonDetection[]
  primaryPersonIndex?: number | null
  faces?: FaceDetection[]
  primaryFaceIndex?: number | null
  anchors?: Anchors
  personMaskBox?: Box | null
  garmentBox?: Box | null
  crop?: CropBox | null
  toggles?: Partial<OverlayToggles>
  /** Anchors below this confidence are dimmed rather than hidden. */
  confidenceFloor?: number
  className?: string
  /** Highlighted anchor — used when hovering a row in the debug list. */
  highlightAnchor?: AnchorName | null
}

export function LandmarkOverlay({
  image,
  persons = [],
  primaryPersonIndex = null,
  faces = [],
  primaryFaceIndex = null,
  anchors = {},
  personMaskBox = null,
  garmentBox = null,
  crop = null,
  toggles,
  confidenceFloor = 0.15,
  className,
  highlightAnchor = null,
}: LandmarkOverlayProps) {
  const t = { ...DEFAULT_TOGGLES, ...toggles }

  // Marker sizes scale with the image so they stay legible on a 6000px source
  // and do not swamp a 600px one.
  const unit = Math.max(image.width, image.height) / 200
  const dot = unit * 1.1
  const stroke = Math.max(1, unit * 0.35)

  return (
    <svg
      className={className}
      viewBox={`0 0 ${image.width} ${image.height}`}
      preserveAspectRatio="none"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      aria-hidden
    >
      {/* Crop box — drawn first so landmarks sit on top of the dimming. */}
      {t.cropBox && crop && (
        <CropIndicator crop={crop} image={image} stroke={stroke} />
      )}

      {t.personBox &&
        persons.map((person, index) => (
          <rect
            key={`person-${index}`}
            x={person.box.left}
            y={person.box.top}
            width={person.box.right - person.box.left}
            height={person.box.bottom - person.box.top}
            fill="none"
            stroke={index === primaryPersonIndex ? 'var(--color-lm-torso)' : 'var(--color-ink-subtle)'}
            strokeWidth={stroke}
            strokeDasharray={index === primaryPersonIndex ? undefined : `${unit} ${unit}`}
            vectorEffect="non-scaling-stroke"
            opacity={index === primaryPersonIndex ? 0.9 : 0.5}
          />
        ))}

      {personMaskBox && t.maskBounds && (
        <rect
          x={personMaskBox.left}
          y={personMaskBox.top}
          width={personMaskBox.right - personMaskBox.left}
          height={personMaskBox.bottom - personMaskBox.top}
          fill="none"
          stroke="var(--color-lm-torso)"
          strokeWidth={stroke}
          strokeDasharray={`${unit * 2} ${unit}`}
          vectorEffect="non-scaling-stroke"
          opacity={0.65}
        />
      )}

      {garmentBox && t.garmentBox && (
        <rect
          x={garmentBox.left}
          y={garmentBox.top}
          width={garmentBox.right - garmentBox.left}
          height={garmentBox.bottom - garmentBox.top}
          fill="none"
          stroke="var(--color-lm-garment)"
          strokeWidth={stroke}
          strokeDasharray={`${unit * 2} ${unit}`}
          vectorEffect="non-scaling-stroke"
          opacity={0.75}
        />
      )}

      {/* Skeleton */}
      {t.skeleton &&
        persons.map((person, personIndex) => (
          <g key={`skeleton-${personIndex}`} opacity={personIndex === primaryPersonIndex ? 1 : 0.4}>
            {SKELETON_EDGES.map(([from, to], edgeIndex) => {
              const a = person.keypoints[from]
              const b = person.keypoints[to]
              if (!a?.visible || !b?.visible) return null
              return (
                <line
                  key={edgeIndex}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke="var(--color-lm-torso)"
                  strokeWidth={stroke * 1.4}
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                  opacity={0.85}
                />
              )
            })}
          </g>
        ))}

      {/* Keypoints */}
      {t.keypoints &&
        persons.map((person, personIndex) => (
          <g key={`kp-${personIndex}`} opacity={personIndex === primaryPersonIndex ? 1 : 0.4}>
            {Object.entries(person.keypoints).map(([name, kp]) =>
              kp.visible ? (
                <circle
                  key={name}
                  cx={kp.x}
                  cy={kp.y}
                  r={dot * 0.55}
                  fill="var(--color-lm-torso)"
                  stroke="var(--color-canvas)"
                  strokeWidth={stroke * 0.6}
                  vectorEffect="non-scaling-stroke"
                />
              ) : null
            )}
          </g>
        ))}

      {/* Faces */}
      {t.faceBox &&
        faces.map((face, index) => (
          <rect
            key={`face-${index}`}
            x={face.box.left}
            y={face.box.top}
            width={face.box.right - face.box.left}
            height={face.box.bottom - face.box.top}
            fill="none"
            stroke="var(--color-lm-head)"
            strokeWidth={stroke}
            vectorEffect="non-scaling-stroke"
            opacity={index === primaryFaceIndex ? 0.95 : 0.45}
          />
        ))}

      {t.faceLandmarks &&
        faces.map((face, index) =>
          face.landmarks ? (
            <g key={`flm-${index}`} opacity={index === primaryFaceIndex ? 1 : 0.45}>
              {Object.values(face.landmarks).map((point, pointIndex) => (
                <circle
                  key={pointIndex}
                  cx={point.x}
                  cy={point.y}
                  r={dot * 0.4}
                  fill="var(--color-lm-head)"
                  stroke="var(--color-canvas)"
                  strokeWidth={stroke * 0.5}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </g>
          ) : null
        )}

      {/* Anchors — the layer that actually drives framing, so drawn last. */}
      {t.anchors &&
        (Object.entries(anchors) as [AnchorName, Anchors[AnchorName]][]).map(([name, anchor]) => {
          if (!anchor) return null
          const highlighted = highlightAnchor === name
          const faded = anchor.confidence < confidenceFloor

          return (
            <g key={name} opacity={faded && !highlighted ? 0.3 : 1}>
              {/* Horizontal guide: anchors are almost always used as a vertical
                  target, so the line is what an operator visually aligns to. */}
              <line
                x1={0}
                y1={anchor.y}
                x2={image.width}
                y2={anchor.y}
                stroke={ANCHOR_COLOR[name]}
                strokeWidth={highlighted ? stroke * 1.2 : stroke * 0.6}
                strokeDasharray={`${unit * 1.5} ${unit * 1.5}`}
                vectorEffect="non-scaling-stroke"
                opacity={highlighted ? 0.9 : 0.35}
              />
              <circle
                cx={anchor.x}
                cy={anchor.y}
                r={highlighted ? dot * 1.3 : dot * 0.85}
                fill={ANCHOR_COLOR[name]}
                stroke="var(--color-canvas)"
                strokeWidth={stroke * 0.8}
                vectorEffect="non-scaling-stroke"
              />
              {t.anchorLabels && (
                <text
                  x={anchor.x + dot * 1.6}
                  y={anchor.y - dot * 0.6}
                  fill={ANCHOR_COLOR[name]}
                  fontSize={unit * 5}
                  fontFamily="var(--font-mono)"
                  style={{ paintOrder: 'stroke' }}
                  stroke="var(--color-canvas)"
                  strokeWidth={unit * 1.2}
                  strokeLinejoin="round"
                >
                  {name}
                </text>
              )}
            </g>
          )
        })}
    </svg>
  )
}

/**
 * The crop rectangle, with everything outside it dimmed.
 *
 * Drawn as four rects rather than a mask because the crop can extend past the
 * image edge (overflow policy `allow`), and a mask-based cutout would clip to
 * the viewBox and hide the fact that the crop overhangs — which is precisely
 * what the operator needs to see.
 */
function CropIndicator({
  crop,
  image,
  stroke,
}: {
  crop: CropBox
  image: Size
  stroke: number
}) {
  const left = Math.max(0, crop.x)
  const top = Math.max(0, crop.y)
  const right = Math.min(image.width, crop.x + crop.width)
  const bottom = Math.min(image.height, crop.y + crop.height)

  const dim = 'oklch(0.10 0 0)'
  const dimOpacity = 0.55

  return (
    <g>
      <rect x={0} y={0} width={image.width} height={Math.max(0, top)} fill={dim} opacity={dimOpacity} />
      <rect
        x={0}
        y={bottom}
        width={image.width}
        height={Math.max(0, image.height - bottom)}
        fill={dim}
        opacity={dimOpacity}
      />
      <rect x={0} y={top} width={Math.max(0, left)} height={Math.max(0, bottom - top)} fill={dim} opacity={dimOpacity} />
      <rect
        x={right}
        y={top}
        width={Math.max(0, image.width - right)}
        height={Math.max(0, bottom - top)}
        fill={dim}
        opacity={dimOpacity}
      />

      <rect
        x={crop.x}
        y={crop.y}
        width={crop.width}
        height={crop.height}
        fill="none"
        stroke="var(--color-lm-crop)"
        strokeWidth={stroke * 1.6}
        vectorEffect="non-scaling-stroke"
      />
    </g>
  )
}

/** Legend matching the overlay colours. */
export function LandmarkLegend() {
  const entries = [
    { color: 'var(--color-lm-head)', label: 'Head & face' },
    { color: 'var(--color-lm-torso)', label: 'Pose & torso' },
    { color: 'var(--color-lm-limb)', label: 'Limbs & feet' },
    { color: 'var(--color-lm-garment)', label: 'Garment' },
    { color: 'var(--color-lm-crop)', label: 'Crop box' },
  ]

  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {entries.map(entry => (
        <span key={entry.label} className="flex items-center gap-1.5 text-[11px] text-[var(--color-ink-subtle)]">
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: entry.color }}
          />
          {entry.label}
        </span>
      ))}
    </div>
  )
}
