import { notFound } from 'next/navigation'
import { templates } from '@/db/repositories'
import { withTenant } from '@/tenancy/page-context'
import { TemplateBuilder } from '@/components/builder/builder-workspace'

export const dynamic = 'force-dynamic'

export default async function TemplateBuilderPage({
  params,
}: {
  params: Promise<{ templateId: string }>
}) {
  return withTenant(async () => {
    const { templateId } = await params
    const template = templates.get(templateId)
    if (!template) notFound()

    return <TemplateBuilder template={template} />
  })
}
