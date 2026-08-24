import { PermissionNext } from "@/permission/next"

export function toolSelectionAllows(
  tool: { id: string; requireExplicitEnable?: boolean },
  requested: Record<string, boolean> | undefined,
  permissions?: PermissionNext.Ruleset,
) {
  if (permissions && PermissionNext.disabled([tool.id], permissions).has(tool.id)) return false
  if (requested?.[tool.id] === false) return false
  if (requested?.[tool.id] === true) return true
  if (tool.requireExplicitEnable) return false
  return requested?.["*"] !== false
}
