import { notFound } from 'next/navigation'
import { batches } from '@/db/repositories'
import { BatchDetailClient } from '@/components/generate/batch-detail-client'

export const dynamic = 'force-dynamic'

export default async function BatchPage({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params
  if (!batches.get(batchId)) notFound()
  return <BatchDetailClient batchId={batchId} />
}
