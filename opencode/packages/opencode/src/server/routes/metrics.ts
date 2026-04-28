import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Instance } from "@/project/instance"
import { RuntimeMetricsQueries } from "@/runtime/metrics/queries"
import { RuntimeMetricsStore } from "@/runtime/metrics/store"
import { lazy } from "@/util/lazy"

const WindowQuery = z.object({
  window: z.enum(["1h", "24h", "7d"]).optional(),
})

const DetailQuery = WindowQuery.extend({
  kind: z.enum(["turn", "tool", "resource", "controller_api"]).optional(),
  providerID: z.string().optional(),
  modelID: z.string().optional(),
  tool: z.string().optional(),
  resourceType: z.enum(["mcp", "skill"]).optional(),
  resourceID: z.string().optional(),
  sessionID: z.string().optional(),
  turnSnapshotId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

function windowMs(value?: z.infer<typeof WindowQuery>["window"]) {
  if (value === "1h") return 60 * 60 * 1000
  if (value === "7d") return 7 * 24 * 60 * 60 * 1000
  return 24 * 60 * 60 * 1000
}

function bucketMs(value?: z.infer<typeof WindowQuery>["window"]) {
  if (value === "1h") return 5 * 60 * 1000
  if (value === "7d") return 6 * 60 * 60 * 1000
  return 60 * 60 * 1000
}

function summarize(window: z.infer<typeof WindowQuery>["window"]) {
  const result = RuntimeMetricsQueries.summarize(
    RuntimeMetricsStore()
      .list({
        directory: Instance.directory,
        windowMs: windowMs(window),
      })
      .map((item) => item.event),
    {
      bucketMs: bucketMs(window),
    },
  )
  return result
}

export const MetricsRoutes = lazy(() =>
  new Hono()
    .get(
      "/dashboard",
      describeRoute({
        summary: "Get metrics dashboard payload",
        description: "Return aggregated dashboard data for the current project directory in a single response.",
        operationId: "metrics.dashboard",
        responses: {
          200: {
            description: "Metrics dashboard payload",
            content: {
              "application/json": {
                schema: resolver(z.any()),
              },
            },
          },
        },
      }),
      validator("query", WindowQuery),
      async (c) => {
        const query = c.req.valid("query")
        return c.json(summarize(query.window))
      },
    )
    .get(
      "/events",
      describeRoute({
        summary: "Get metrics detail events",
        description: "Return filtered runtime metrics events for drill-down views.",
        operationId: "metrics.events",
        responses: {
          200: {
            description: "Metrics detail events",
            content: {
              "application/json": {
                schema: resolver(z.any()),
              },
            },
          },
        },
      }),
      validator("query", DetailQuery),
      async (c) => {
        const query = c.req.valid("query")
        const events = RuntimeMetricsStore()
          .list({
            directory: Instance.directory,
            windowMs: windowMs(query.window),
          })
          .map((item) => item.event)

        return c.json(
          RuntimeMetricsQueries.detail(events, {
            kind: query.kind,
            providerID: query.providerID,
            modelID: query.modelID,
            tool: query.tool,
            resourceType: query.resourceType,
            resourceID: query.resourceID,
            sessionID: query.sessionID,
            turnSnapshotId: query.turnSnapshotId,
            limit: query.limit,
          }),
        )
      },
    )
    .get(
      "/timeline",
      describeRoute({
        summary: "Get metrics timeline",
        description: "Return aggregated metrics timeline for the current project directory.",
        operationId: "metrics.timeline",
        responses: {
          200: {
            description: "Metrics timeline",
            content: {
              "application/json": {
                schema: resolver(z.any()),
              },
            },
          },
        },
      }),
      validator("query", WindowQuery),
      async (c) => {
        const query = c.req.valid("query")
        return c.json(summarize(query.window).timeline)
      },
    )
    .get(
      "/overview",
      describeRoute({
        summary: "Get metrics overview",
        description: "Return aggregated overview metrics for the current project directory.",
        operationId: "metrics.overview",
        responses: {
          200: {
            description: "Overview metrics",
            content: {
              "application/json": {
                schema: resolver(z.any()),
              },
            },
          },
        },
      }),
      validator("query", WindowQuery),
      async (c) => {
        const query = c.req.valid("query")
        return c.json(summarize(query.window).overview)
      },
    )
    .get(
      "/models",
      describeRoute({
        summary: "Get model metrics",
        description: "Return aggregated model metrics for the current project directory.",
        operationId: "metrics.models",
        responses: {
          200: {
            description: "Model metrics",
            content: {
              "application/json": {
                schema: resolver(z.any()),
              },
            },
          },
        },
      }),
      validator("query", WindowQuery),
      async (c) => {
        const query = c.req.valid("query")
        return c.json(summarize(query.window).models)
      },
    )
    .get(
      "/tools",
      describeRoute({
        summary: "Get tool metrics",
        description: "Return aggregated tool metrics for the current project directory.",
        operationId: "metrics.tools",
        responses: {
          200: {
            description: "Tool metrics",
            content: {
              "application/json": {
                schema: resolver(z.any()),
              },
            },
          },
        },
      }),
      validator("query", WindowQuery),
      async (c) => {
        const query = c.req.valid("query")
        return c.json(summarize(query.window).tools)
      },
    )
    .get(
      "/resources",
      describeRoute({
        summary: "Get resource metrics",
        description: "Return aggregated resource metrics for the current project directory.",
        operationId: "metrics.resources",
        responses: {
          200: {
            description: "Resource metrics",
            content: {
              "application/json": {
                schema: resolver(z.any()),
              },
            },
          },
        },
      }),
      validator("query", WindowQuery),
      async (c) => {
        const query = c.req.valid("query")
        return c.json(summarize(query.window).resources)
      },
    ),
)
