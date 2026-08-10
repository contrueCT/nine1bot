export const PLATFORM_TOOL_RUNTIME_CODES = [
  "tool-missing",
  "tool-conflict",
  "auth-required",
  "stale-generation",
  "invalid-input",
  "availability-check-failed",
  "permission-resolution-failed",
  "permission-denied",
  "execution-failed",
  "execution-timeout",
  "cancelled",
] as const

export type PlatformToolRuntimeCode = (typeof PLATFORM_TOOL_RUNTIME_CODES)[number]

export function isPlatformToolRuntimeCode(value: string): value is PlatformToolRuntimeCode {
  return (PLATFORM_TOOL_RUNTIME_CODES as readonly string[]).includes(value)
}
