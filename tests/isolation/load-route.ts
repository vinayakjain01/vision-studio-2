import path from 'path'
import { pathToFileURL } from 'url'

/** Dynamically imports a route module by its project-relative file path (as `route-inventory.ts` reports it). */
export async function loadRouteModule(filePath: string): Promise<Record<string, unknown>> {
  const abs = path.resolve(__dirname, '../..', filePath)
  return import(pathToFileURL(abs).href)
}
