/** Plain-text preview for terminal clients; never use display text as a permission pattern. */
export function rememberPermissionDescription(metadata: Record<string, unknown>): string | undefined {
  if (typeof metadata.content !== "string" || !metadata.content.trim()) return
  if (metadata.scope !== "global" && metadata.scope !== "project") return
  if (typeof metadata.directory !== "string" || !metadata.directory.trim()) return
  return [
    "Save this preference for future conversation turns.",
    metadata.scope === "global" ? "Scope: global (all projects)" : "Scope: current project only",
    `Project directory: ${metadata.directory}`,
    "Preference:",
    metadata.content,
  ].join("\n")
}
