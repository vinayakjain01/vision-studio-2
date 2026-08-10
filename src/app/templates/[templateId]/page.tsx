import { notFound } from 'next/navigation'
import { templates } from '@/db/repositories'
import { TemplateBuilder } from '@/components/builder/builder-workspace'

export const dynamic = 'force-dynamic'

export default async function TemplateBuilderPage({
  params,
}: {
  params: Promise<{ templateId: string }>
}) {
  const { templateId } = await params
  const template = templates.get(templateId)
  if (!template) notFound()

  return <TemplateBuilder template={template} />
}
