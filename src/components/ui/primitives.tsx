/**
 * UI primitives.
 *
 * A small hand-rolled kit rather than a component library. The interface has
 * roughly a dozen distinct controls, and most of the surface area is bespoke
 * anyway — the canvas, the landmark overlay, the framing sliders. Pulling in a
 * full library to style eleven buttons costs more in bundle and indirection
 * than it saves.
 */

'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'

// ─── Button ──────────────────────────────────────────────────────────────────

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'
type ButtonSize = 'sm' | 'md' | 'lg' | 'icon'

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--color-accent)] text-[var(--color-accent-ink)] hover:brightness-110 font-medium',
  secondary:
    'bg-[var(--color-surface-raised)] text-[var(--color-ink)] hover:bg-[var(--color-border)]',
  ghost: 'bg-transparent text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)]',
  danger: 'bg-[var(--color-danger)] text-white hover:brightness-110 font-medium',
  outline:
    'bg-transparent border border-[var(--color-border-strong)] text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]',
}

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5',
  md: 'h-9 px-3.5 text-sm gap-2',
  lg: 'h-11 px-5 text-base gap-2',
  icon: 'h-9 w-9 justify-center',
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'secondary', size = 'md', ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center rounded-md transition-colors select-none',
        'disabled:opacity-45 disabled:pointer-events-none',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className
      )}
      {...props}
    />
  )
)
Button.displayName = 'Button'

// ─── Surfaces ────────────────────────────────────────────────────────────────

export function Panel({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('panel', className)} {...props}>
      {children}
    </div>
  )
}

export function PanelHeader({
  title,
  description,
  action,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-4 border-b border-[var(--color-border)] px-4 py-3',
        className
      )}
    >
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">{title}</h2>
        {description && (
          <p className="mt-0.5 text-xs text-[var(--color-ink-subtle)]">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

// ─── Badge ───────────────────────────────────────────────────────────────────

type BadgeTone = 'neutral' | 'accent' | 'positive' | 'warning' | 'danger'

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)] border-[var(--color-border)]',
  accent: 'bg-[color-mix(in_oklch,var(--color-accent)_18%,transparent)] text-[var(--color-accent)] border-[color-mix(in_oklch,var(--color-accent)_35%,transparent)]',
  positive: 'bg-[color-mix(in_oklch,var(--color-positive)_16%,transparent)] text-[var(--color-positive)] border-[color-mix(in_oklch,var(--color-positive)_32%,transparent)]',
  warning: 'bg-[color-mix(in_oklch,var(--color-warning)_16%,transparent)] text-[var(--color-warning)] border-[color-mix(in_oklch,var(--color-warning)_32%,transparent)]',
  danger: 'bg-[color-mix(in_oklch,var(--color-danger)_16%,transparent)] text-[var(--color-danger)] border-[color-mix(in_oklch,var(--color-danger)_32%,transparent)]',
}

export function Badge({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: BadgeTone
  className?: string
  children: React.ReactNode
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium leading-tight',
        BADGE_TONES[tone],
        className
      )}
    >
      {children}
    </span>
  )
}

// ─── Form controls ───────────────────────────────────────────────────────────

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      'h-9 w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-canvas)]',
      'px-2.5 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-subtle)]',
      'focus:border-[var(--color-accent)] focus:outline-none',
      'disabled:opacity-45',
      className
    )}
    {...props}
  />
))
Input.displayName = 'Input'

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-canvas)]',
      'px-2.5 py-2 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-subtle)]',
      'focus:border-[var(--color-accent)] focus:outline-none resize-y',
      className
    )}
    {...props}
  />
))
Textarea.displayName = 'Textarea'

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      'h-9 w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-canvas)]',
      'px-2 text-sm text-[var(--color-ink)] focus:border-[var(--color-accent)] focus:outline-none',
      'disabled:opacity-45',
      className
    )}
    {...props}
  >
    {children}
  </select>
))
Select.displayName = 'Select'

export function Field({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label: React.ReactNode
  hint?: React.ReactNode
  htmlFor?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <label
        htmlFor={htmlFor}
        className="block text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-subtle)]"
      >
        {label}
      </label>
      {children}
      {hint && <p className="text-[11px] leading-snug text-[var(--color-ink-subtle)]">{hint}</p>}
    </div>
  )
}

/**
 * Slider with a live numeric readout.
 *
 * The readout is not decoration: framing values are specifications ("head at
 * 12%"), and an operator matching one template to another needs the number, not
 * a thumb position.
 */
export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  unit = '',
  onChange,
  disabled,
  hint,
  effectiveRange,
}: {
  label: React.ReactNode
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  onChange: (value: number) => void
  disabled?: boolean
  hint?: React.ReactNode
  /**
   * Sub-range that actually changes anything, highlighted on the track.
   *
   * Some controls are physically limited by the current photo — a crop cannot
   * slide past the edge of the image — so most of the travel can be a dead zone.
   * Marking the live band turns a control that looks broken into one that
   * visibly explains itself.
   */
  effectiveRange?: { minPct: number; maxPct: number } | null
}) {
  const span = max - min
  const outsideRange =
    effectiveRange != null &&
    span > 0 &&
    (value < effectiveRange.minPct - 0.01 || value > effectiveRange.maxPct + 0.01)

  const bandLeft =
    effectiveRange && span > 0
      ? ((Math.max(min, effectiveRange.minPct) - min) / span) * 100
      : 0
  const bandWidth =
    effectiveRange && span > 0
      ? ((Math.min(max, effectiveRange.maxPct) - Math.max(min, effectiveRange.minPct)) / span) * 100
      : 0

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-subtle)]">
          {label}
        </span>
        <span
          className={cn(
            'numeric text-xs font-medium',
            outsideRange ? 'text-[var(--color-warning)]' : 'text-[var(--color-ink)]'
          )}
        >
          {Number.isFinite(value) ? (Number.isInteger(step) ? Math.round(value) : value.toFixed(2)) : '—'}
          {unit}
        </span>
      </div>

      <div className="relative">
        {effectiveRange && bandWidth > 0 && (
          <>
            {/* Base track, drawn here because the native one is hidden. */}
            <div
              className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-[var(--color-border-strong)]"
              aria-hidden
            />
            {/* The portion of the travel that actually moves this photo. */}
            <div
              className="pointer-events-none absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-[var(--color-accent)] opacity-70"
              style={{ left: `${bandLeft}%`, width: `${bandWidth}%` }}
              aria-hidden
            />
          </>
        )}
        <input
          type="range"
          className={cn('relative w-full', effectiveRange && bandWidth > 0 && 'has-band')}
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={event => onChange(Number(event.target.value))}
        />
      </div>

      {outsideRange && (
        <p className="text-[11px] leading-snug text-[var(--color-warning)]">
          On this photo only {Math.round(effectiveRange!.minPct)}–
          {Math.round(effectiveRange!.maxPct)}
          {unit} has any effect — outside that the crop is already against the edge of the
          photograph. The setting still applies to other photos.
        </p>
      )}

      {hint && <p className="text-[11px] leading-snug text-[var(--color-ink-subtle)]">{hint}</p>}
    </div>
  )
}

export function Toggle({
  label,
  checked,
  onChange,
  hint,
  disabled,
}: {
  label: React.ReactNode
  checked: boolean
  onChange: (checked: boolean) => void
  hint?: React.ReactNode
  disabled?: boolean
}) {
  return (
    <label
      className={cn(
        'flex items-start gap-2.5',
        disabled ? 'opacity-45' : 'cursor-pointer'
      )}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'mt-0.5 h-4 w-7 shrink-0 rounded-full transition-colors',
          checked ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border-strong)]'
        )}
      >
        <span
          className={cn(
            'block h-3 w-3 rounded-full bg-white transition-transform',
            checked ? 'translate-x-3.5' : 'translate-x-0.5'
          )}
        />
      </button>
      <span className="min-w-0">
        <span className="block text-xs text-[var(--color-ink)]">{label}</span>
        {hint && (
          <span className="mt-0.5 block text-[11px] leading-snug text-[var(--color-ink-subtle)]">
            {hint}
          </span>
        )}
      </span>
    </label>
  )
}

// ─── Feedback ────────────────────────────────────────────────────────────────

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      {icon && <div className="text-[var(--color-ink-subtle)]">{icon}</div>}
      <div>
        <p className="text-sm font-medium text-[var(--color-ink)]">{title}</p>
        {description && (
          <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-[var(--color-ink-subtle)]">
            {description}
          </p>
        )}
      </div>
      {action}
    </div>
  )
}

export function Progress({ value, className }: { value: number; className?: string }) {
  const pct = Math.max(0, Math.min(100, value * 100))
  return (
    <div
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-border)]', className)}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-300"
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  tone?: 'default' | 'positive' | 'warning' | 'danger'
}) {
  const toneClass =
    tone === 'positive'
      ? 'text-[var(--color-positive)]'
      : tone === 'warning'
        ? 'text-[var(--color-warning)]'
        : tone === 'danger'
          ? 'text-[var(--color-danger)]'
          : 'text-[var(--color-ink)]'

  return (
    <div className="panel px-4 py-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-subtle)]">
        {label}
      </p>
      <p className={cn('numeric mt-1 text-2xl font-semibold leading-none', toneClass)}>{value}</p>
      {hint && <p className="mt-1.5 text-[11px] text-[var(--color-ink-subtle)]">{hint}</p>}
    </div>
  )
}

export function Alert({
  tone = 'neutral',
  title,
  children,
}: {
  tone?: 'neutral' | 'warning' | 'danger' | 'positive'
  title?: React.ReactNode
  children: React.ReactNode
}) {
  const tones = {
    neutral: 'border-[var(--color-border-strong)] bg-[var(--color-surface-raised)]',
    warning:
      'border-[color-mix(in_oklch,var(--color-warning)_35%,transparent)] bg-[color-mix(in_oklch,var(--color-warning)_10%,transparent)]',
    danger:
      'border-[color-mix(in_oklch,var(--color-danger)_35%,transparent)] bg-[color-mix(in_oklch,var(--color-danger)_10%,transparent)]',
    positive:
      'border-[color-mix(in_oklch,var(--color-positive)_35%,transparent)] bg-[color-mix(in_oklch,var(--color-positive)_10%,transparent)]',
  }

  return (
    <div className={cn('rounded-md border px-3 py-2.5 text-xs leading-relaxed', tones[tone])}>
      {title && <p className="mb-1 font-semibold text-[var(--color-ink)]">{title}</p>}
      <div className="text-[var(--color-ink-muted)]">{children}</div>
    </div>
  )
}

// ─── Tabs ────────────────────────────────────────────────────────────────────

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  className,
}: {
  tabs: { value: T; label: React.ReactNode; count?: number }[]
  value: T
  onChange: (value: T) => void
  className?: string
}) {
  return (
    <div
      role="tablist"
      className={cn(
        'inline-flex items-center gap-0.5 rounded-lg bg-[var(--color-surface)] p-0.5',
        className
      )}
    >
      {tabs.map(tab => (
        <button
          key={tab.value}
          role="tab"
          aria-selected={value === tab.value}
          onClick={() => onChange(tab.value)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
            value === tab.value
              ? 'bg-[var(--color-surface-raised)] text-[var(--color-ink)]'
              : 'text-[var(--color-ink-subtle)] hover:text-[var(--color-ink-muted)]'
          )}
        >
          {tab.label}
          {tab.count != null && (
            <span className="numeric rounded bg-[var(--color-border)] px-1 text-[10px]">
              {tab.count}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}

/** Bar of definition-style key/value rows. Used throughout the debug panel. */
export function DataList({
  rows,
  className,
}: {
  rows: { label: React.ReactNode; value: React.ReactNode }[]
  className?: string
}) {
  return (
    <dl className={cn('divide-y divide-[var(--color-border)]', className)}>
      {rows.map((row, index) => (
        <div key={index} className="flex items-baseline justify-between gap-3 py-1.5">
          <dt className="text-xs text-[var(--color-ink-subtle)]">{row.label}</dt>
          <dd className="numeric text-right text-xs font-medium text-[var(--color-ink)]">
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent',
        className
      )}
      aria-hidden
    />
  )
}
