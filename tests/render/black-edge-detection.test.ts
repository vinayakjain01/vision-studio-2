import { describe, it, expect } from 'vitest'
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas'
import { detectAnomalousBlackEdges } from '@/render/compositor'

/**
 * Phase 2/3 (docs/ISSUES.md issue 3, invariant I3): detectAnomalousBlackEdges
 * is the post-render backstop — catches the "black bars" symptom regardless
 * of what causes it, not just the specific sanitizeBackgroundColor fix.
 * Pure canvas-pixel logic, no photo fixture needed: these tests paint known
 * patterns with @napi-rs/canvas directly, the same engine the real
 * renderer uses.
 */
describe('detectAnomalousBlackEdges', () => {
  function canvasOf(width: number, height: number, paint: (ctx: SKRSContext2D) => void) {
    const canvas = createCanvas(width, height)
    paint(canvas.getContext('2d'))
    return canvas
  }

  it('does not flag a normal, evenly-colored render', () => {
    const canvas = canvasOf(400, 500, ctx => {
      ctx.fillStyle = '#e5e5e5'
      ctx.fillRect(0, 0, 400, 500)
      ctx.fillStyle = '#336699'
      ctx.fillRect(100, 100, 200, 300)
    })
    expect(detectAnomalousBlackEdges(canvas, 400, 500)).toBe(false)
  })

  it('flags a render whose entire canvas defaulted to black (the exact bug this traces back to)', () => {
    const canvas = canvasOf(400, 500, ctx => {
      // Canvas2D's own default fillStyle, unset — exactly what an invalid
      // background.color assignment leaves behind.
      ctx.fillRect(0, 0, 400, 500)
      // A normal-colored subject in the middle, same as a real render would have.
      ctx.fillStyle = '#cc8844'
      ctx.fillRect(150, 150, 100, 200)
    })
    expect(detectAnomalousBlackEdges(canvas, 400, 500)).toBe(true)
  })

  it('does NOT flag a genuinely all-black product photo (a black garment on a black backdrop) — the centre is near-black too', () => {
    const canvas = canvasOf(400, 500, ctx => {
      ctx.fillStyle = '#000000'
      ctx.fillRect(0, 0, 400, 500)
    })
    expect(detectAnomalousBlackEdges(canvas, 400, 500)).toBe(false)
  })

  it('does not flag black bars on only one edge if they are not near-black enough (a dark but not near-black letterbox)', () => {
    const canvas = canvasOf(400, 500, ctx => {
      ctx.fillStyle = '#333333' // dark grey, well above the near-black channel ceiling
      ctx.fillRect(0, 0, 400, 500)
      ctx.fillStyle = '#cc8844'
      ctx.fillRect(100, 100, 200, 300)
    })
    expect(detectAnomalousBlackEdges(canvas, 400, 500)).toBe(false)
  })

  it('flags when only the top and bottom are near-black (letterboxing), even with normal content filling the rest', () => {
    const canvas = canvasOf(400, 500, ctx => {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, 400, 500)
      ctx.fillStyle = '#000000'
      ctx.fillRect(0, 0, 400, 10) // top bar
      ctx.fillRect(0, 490, 400, 10) // bottom bar
      ctx.fillStyle = '#cc8844'
      ctx.fillRect(100, 100, 200, 300)
    })
    expect(detectAnomalousBlackEdges(canvas, 400, 500)).toBe(true)
  })
})
