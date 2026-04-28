import z from "zod"
import { BusEvent } from "@/bus/bus-event"

export namespace RuntimeMetricsEvents {
  export const ControllerApiCompleted = BusEvent.define(
    "runtime.metrics.controller_api.completed",
    z.object({
      route: z.string(),
      method: z.string(),
      status: z.number(),
      durationMs: z.number(),
      completedAt: z.number(),
      entrySource: z.string().optional(),
      platform: z.string().optional(),
      mode: z.string().optional(),
      traceId: z.string().optional(),
      protocolVersion: z.string().optional(),
      accepted: z.boolean().optional(),
      busy: z.boolean().optional(),
      errorType: z.string().optional(),
    }),
  )

  export function normalizeErrorType(error: unknown) {
    if (error instanceof Error) return error.name || "Error"
    return "UnknownError"
  }
}
