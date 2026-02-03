import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { AgentTerminal } from "@/pty/agent-terminal"
import { Storage } from "../../storage/storage"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

export const AgentTerminalRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List Agent Terminals",
        description: "Get a list of all active agent terminal sessions.",
        operationId: "agentTerminal.list",
        responses: {
          200: {
            description: "List of sessions",
            content: {
              "application/json": {
                schema: resolver(AgentTerminal.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const sessionID = c.req.query("sessionID")
        return c.json(AgentTerminal.list(sessionID))
      },
    )
    .get(
      "/:id",
      describeRoute({
        summary: "Get Agent Terminal",
        description: "Retrieve detailed information about a specific agent terminal session.",
        operationId: "agentTerminal.get",
        responses: {
          200: {
            description: "Session info",
            content: {
              "application/json": {
                schema: resolver(AgentTerminal.Info),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        const info = AgentTerminal.get(c.req.valid("param").id)
        if (!info) {
          throw new Storage.NotFoundError({ message: "Agent terminal not found" })
        }
        return c.json(info)
      },
    )
    .post(
      "/:id/resize",
      describeRoute({
        summary: "Resize Agent Terminal",
        description: "Resize an agent terminal to the specified dimensions.",
        operationId: "agentTerminal.resize",
        responses: {
          200: {
            description: "Terminal resized successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      validator(
        "json",
        z.object({
          rows: z.number().int().min(1).max(500),
          cols: z.number().int().min(1).max(500),
        })
      ),
      async (c) => {
        const { id } = c.req.valid("param")
        const { rows, cols } = c.req.valid("json")
        const success = AgentTerminal.resize(id, rows, cols)
        if (!success) {
          throw new Storage.NotFoundError({ message: "Agent terminal not found or not running" })
        }
        return c.json(true)
      },
    )
    .get(
      "/:id/screen",
      describeRoute({
        summary: "Get Agent Terminal Screen",
        description: "Get the current screen content of an agent terminal.",
        operationId: "agentTerminal.screen",
        responses: {
          200: {
            description: "Screen content",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    screen: z.string(),
                    screenAnsi: z.string(),
                    cursor: z.object({ row: z.number(), col: z.number() }),
                  })
                ),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        const { id } = c.req.valid("param")
        const screen = AgentTerminal.getScreen(id)
        const screenAnsi = AgentTerminal.getScreenAnsi(id)
        const cursor = AgentTerminal.getCursor(id)

        if (screen === undefined || screenAnsi === undefined || cursor === undefined) {
          throw new Storage.NotFoundError({ message: "Agent terminal not found" })
        }

        return c.json({ screen, screenAnsi, cursor })
      },
    )
    .get(
      "/:id/buffer",
      describeRoute({
        summary: "Get Agent Terminal Raw Buffer",
        description: "Get the raw output buffer of an agent terminal for history replay.",
        operationId: "agentTerminal.buffer",
        responses: {
          200: {
            description: "Raw buffer content",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    buffer: z.string(),
                  })
                ),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        const { id } = c.req.valid("param")
        const buffer = AgentTerminal.getRawBuffer(id)

        if (buffer === undefined) {
          throw new Storage.NotFoundError({ message: "Agent terminal not found" })
        }

        return c.json({ buffer })
      },
    )
    .post(
      "/:id/write",
      describeRoute({
        summary: "Write to Agent Terminal",
        description: "Send input data to an agent terminal (user interaction).",
        operationId: "agentTerminal.write",
        responses: {
          200: {
            description: "Data written successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      validator(
        "json",
        z.object({
          data: z.string(),
        })
      ),
      async (c) => {
        const { id } = c.req.valid("param")
        const { data } = c.req.valid("json")
        const success = AgentTerminal.write(id, data)
        if (!success) {
          throw new Storage.NotFoundError({ message: "Agent terminal not found or not running" })
        }
        return c.json(true)
      },
    )
    .delete(
      "/:id",
      describeRoute({
        summary: "Close Agent Terminal",
        description: "Close and terminate an agent terminal session.",
        operationId: "agentTerminal.close",
        responses: {
          200: {
            description: "Terminal closed successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        const success = await AgentTerminal.close(c.req.valid("param").id)
        if (!success) {
          throw new Storage.NotFoundError({ message: "Agent terminal not found" })
        }
        return c.json(true)
      },
    ),
)
