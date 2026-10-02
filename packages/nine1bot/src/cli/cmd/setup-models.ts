/** Build setup choices from the runtime catalog instead of pinning aging model IDs. */
export interface SetupCatalogModel {
  id: string
  name: string
  tool_call: boolean
  status?: string
  experimental?: boolean
}

export type SetupModelCatalog = Record<string, { models: Record<string, SetupCatalogModel> }>

export function setupModelChoices(catalog: SetupModelCatalog, providerID: string) {
  return Object.entries(catalog[providerID]?.models ?? {})
    .filter(([, model]) => model.tool_call && !model.experimental && model.status !== 'deprecated' && model.status !== 'alpha')
    .map(([id, model]) => ({ value: `${providerID}/${id}`, label: model.name || id, hint: id }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value))
}

/** The wizard remains usable when the public model catalog is temporarily offline. */
export async function loadSetupModelChoices(
  providerID: string,
  loadCatalog: () => Promise<SetupModelCatalog>,
  timeoutMs = 5000,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const catalog = await Promise.race([
      loadCatalog(),
      new Promise<undefined>((resolve) => { timeout = setTimeout(() => resolve(undefined), timeoutMs) }),
    ])
    return catalog ? setupModelChoices(catalog, providerID) : []
  } catch {
    return []
  } finally {
    clearTimeout(timeout)
  }
}
