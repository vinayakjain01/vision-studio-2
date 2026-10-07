'use client'

import useSWR from 'swr'
import { fetcher } from '@/lib/api'
import { jitterMs } from '@/lib/polling'
import { Panel, PanelHeader, Stat, Progress } from '@/components/ui/primitives'
import { formatBytes } from '@/lib/utils'

interface GlobalPanelStats {
  workersBusy: number
  workersIdle: number
  workersTotal: number
  queueDepthTotal: number
  eventLoopP99Ms: number | null
  aiExtendGlobalCallsThisMonth: number
  aiExtendGlobalCap: number
  freeDiskBytes: number | null
  controlDbSizeBytes: number
}

export function GlobalPanel() {
  const { data, isLoading } = useSWR<GlobalPanelStats>('/api/admin/global', fetcher, {
    refreshInterval: () => jitterMs(5000),
  })

  if (isLoading || !data) {
    return <Panel><p className="px-4 py-6 text-sm text-[var(--color-ink-subtle)]">Loading…</p></Panel>
  }

  const aiExtendRatio = data.aiExtendGlobalCap > 0 ? data.aiExtendGlobalCallsThisMonth / data.aiExtendGlobalCap : 0

  return (
    <div className="space-y-4">
      <Panel>
        <PanelHeader title="Worker pool" description="Across every tenant — the shared pool this install runs." />
        <div className="grid grid-cols-2 gap-3 px-4 py-4 sm:grid-cols-4">
          <Stat label="Busy workers" value={data.workersBusy} tone={data.workersBusy > 0 ? 'positive' : 'default'} />
          <Stat label="Idle workers" value={data.workersIdle} />
          <Stat label="Total workers" value={data.workersTotal} />
          <Stat label="Queue depth (all tenants)" value={data.queueDepthTotal} />
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Event loop" description="p99 delay from the last logging window — see src/lib/event-loop-monitor.ts." />
        <div className="px-4 py-4">
          <Stat
            label="p99 delay"
            value={data.eventLoopP99Ms != null ? `${data.eventLoopP99Ms}ms` : '—'}
            tone={data.eventLoopP99Ms != null && data.eventLoopP99Ms > 200 ? 'danger' : 'default'}
          />
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="AI Extend (global)" description="Every tenant's generative-fill calls this month, against the shared platform cap." />
        <div className="space-y-2 px-4 py-4">
          <Progress value={aiExtendRatio} />
          <p className="numeric text-xs text-[var(--color-ink-muted)]">
            {data.aiExtendGlobalCallsThisMonth} / {data.aiExtendGlobalCap} calls this month
          </p>
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Storage" />
        <div className="grid grid-cols-2 gap-3 px-4 py-4">
          <Stat label="Free disk (data volume)" value={data.freeDiskBytes != null ? formatBytes(data.freeDiskBytes) : 'unknown'} />
          <Stat label="control.db size" value={formatBytes(data.controlDbSizeBytes)} />
        </div>
      </Panel>
    </div>
  )
}
