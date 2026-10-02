/** Keep terminal control sequences visible instead of executing or silently dropping them. */
export function visiblePreferenceText(value: string): string {
  // Preserve ordinary line breaks and tabs. Escape C0/C1 controls (including ESC,
  // carriage return and backspace) and bidi controls that could conceal/reorder text.
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
}

export const REMEMBER_SESSION_GRANT_NOTICE = "Allow future preference saves in this scope without reviewing each one for this conversation. Saved session grants still apply when this conversation is resumed, including after a restart."

/** Plain-text preview for terminal clients; never use display text as a permission pattern. */
export function rememberPermissionDescription(metadata: Record<string, unknown>): string | undefined {
  if (typeof metadata.content !== "string" || !metadata.content.trim()) return
  if (metadata.scope !== "global" && metadata.scope !== "project") return
  if (typeof metadata.directory !== "string" || !metadata.directory.trim()) return
  return [
    "Save this preference for future conversation turns.",
    metadata.scope === "global" ? "Scope: global (all projects)" : "Scope: current project only",
    `Project directory: ${visiblePreferenceText(metadata.directory)}`,
    "Preference:",
    visiblePreferenceText(metadata.content),
  ].join("\n")
}
