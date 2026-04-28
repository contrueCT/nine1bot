import { RuntimeMetricsAggregator } from "./aggregator"
import type {
  MetricsOverview,
  MetricsTimelineBucket,
  ModelMetricsRow,
  ResourceMetricsRow,
  RuntimeMetricEvent,
  ToolMetricsRow,
} from "./types"

export namespace RuntimeMetricsQueries {
  export type DetailFilter = {
    kind?: RuntimeMetricEvent["kind"]
    providerID?: string
    modelID?: string
    tool?: string
    resourceType?: "mcp" | "skill"
    resourceID?: string
    sessionID?: string
    turnSnapshotId?: string
    limit?: number
  }

  export type Result = {
    overview: MetricsOverview
    models: ModelMetricsRow[]
    tools: ToolMetricsRow[]
    resources: ResourceMetricsRow[]
    timeline: MetricsTimelineBucket[]
  }

  export function summarize(events: RuntimeMetricEvent[], options?: { bucketMs?: number }): Result {
    return {
      overview: RuntimeMetricsAggregator.overview(events),
      models: RuntimeMetricsAggregator.models(events),
      tools: RuntimeMetricsAggregator.tools(events),
      resources: RuntimeMetricsAggregator.resources(events),
      timeline: RuntimeMetricsAggregator.timeline(events, {
        bucketMs: options?.bucketMs,
      }),
    }
  }

  export function detail(events: RuntimeMetricEvent[], filter?: DetailFilter) {
    return events
      .filter((event) => {
        if (filter?.kind && event.kind !== filter.kind) return false
        if (filter?.sessionID) {
          if (!("sessionID" in event) || event.sessionID !== filter.sessionID) return false
        }
        if (filter?.turnSnapshotId) {
          if (!("turnSnapshotId" in event) || event.turnSnapshotId !== filter.turnSnapshotId) return false
        }
        if (filter?.providerID && (!("providerID" in event) || event.providerID !== filter.providerID)) return false
        if (filter?.modelID && (!("modelID" in event) || event.modelID !== filter.modelID)) return false
        if (filter?.tool && (!("tool" in event) || event.tool !== filter.tool)) return false
        if (filter?.resourceType && (!("resourceType" in event) || event.resourceType !== filter.resourceType)) return false
        if (filter?.resourceID && (!("resourceID" in event) || event.resourceID !== filter.resourceID)) return false
        return true
      })
      .sort((a, b) => b.recordedAt - a.recordedAt)
      .slice(0, filter?.limit ?? 50)
  }
}
