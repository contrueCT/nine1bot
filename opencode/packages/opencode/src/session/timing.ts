import { Log } from "@/util/log"
import { ulid } from "ulid"

export namespace RuntimeTiming {
  const log = Log.create({ service: "runtime.timing" })

  export type Operation = "prompt" | "prompt_async" | "loop" | "command" | "shell" | "internal"
  export type Extra = Record<string, unknown>

  export type TraceOptions = {
    id?: string
    sessionID: string
    operation: Operation
    source?: string
  }

  export class Trace {
    readonly id: string
    readonly sessionID: string
    readonly operation: Operation
    readonly source?: string
    private readonly startedAt = Date.now()
    private previousAt = this.startedAt

    constructor(options: TraceOptions) {
      this.id = options.id ?? ulid()
      this.sessionID = options.sessionID
      this.operation = options.operation
      this.source = options.source
    }

    mark(stage: string, extra?: Extra) {
      const now = Date.now()
      log.info("runtime timing", {
        traceID: this.id,
        sessionID: this.sessionID,
        operation: this.operation,
        source: this.source,
        stage,
        elapsedMs: now - this.startedAt,
        deltaMs: now - this.previousAt,
        ...extra,
      })
      this.previousAt = now
    }

    async measure<T>(stage: string, fn: () => T | Promise<T>, extra?: Extra): Promise<T> {
      const started = Date.now()
      this.mark(`${stage}.started`, extra)
      try {
        const result = await fn()
        this.mark(`${stage}.completed`, {
          durationMs: Date.now() - started,
          ...extra,
        })
        return result
      } catch (error) {
        this.mark(`${stage}.failed`, {
          durationMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
          ...extra,
        })
        throw error
      }
    }
  }

  export function start(options: TraceOptions) {
    const trace = new Trace(options)
    trace.mark("request.received")
    return trace
  }

  export async function measure<T>(
    trace: Trace | undefined,
    stage: string,
    fn: () => T | Promise<T>,
    extra?: Extra,
  ): Promise<T> {
    return trace ? trace.measure(stage, fn, extra) : fn()
  }
}
