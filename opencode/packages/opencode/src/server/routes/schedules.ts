import { Schedule } from "@/schedule/schedule"
import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { lazy } from "../../util/lazy"
import { errors } from "../error"

export const ScheduleRoutes = lazy(() =>
  new Hono()
    .get(
      "/tasks",
      describeRoute({
        summary: "List scheduled tasks",
        operationId: "schedules.tasks.list",
        responses: {
          200: {
            description: "Scheduled tasks",
            content: {
              "application/json": {
                schema: resolver(Schedule.Task.array()),
              },
            },
          },
        },
      }),
      async (c) => c.json(await Schedule.listTasks()),
    )
    .post(
      "/tasks",
      describeRoute({
        summary: "Create scheduled task",
        operationId: "schedules.tasks.create",
        responses: {
          200: {
            description: "Created scheduled task",
            content: {
              "application/json": {
                schema: resolver(Schedule.Task),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("json", Schedule.TaskCreate),
      async (c) => c.json(await Schedule.createTask(c.req.valid("json"))),
    )
    .get(
      "/tasks/:taskID",
      describeRoute({
        summary: "Get scheduled task",
        operationId: "schedules.tasks.get",
        responses: {
          200: {
            description: "Scheduled task",
            content: {
              "application/json": {
                schema: resolver(Schedule.Task),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ taskID: z.string() })),
      async (c) => c.json(await Schedule.getTask(c.req.valid("param").taskID)),
    )
    .patch(
      "/tasks/:taskID",
      describeRoute({
        summary: "Update scheduled task",
        operationId: "schedules.tasks.update",
        responses: {
          200: {
            description: "Updated scheduled task",
            content: {
              "application/json": {
                schema: resolver(Schedule.Task),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ taskID: z.string() })),
      validator("json", Schedule.TaskUpdate),
      async (c) => c.json(await Schedule.updateTask(c.req.valid("param").taskID, c.req.valid("json"))),
    )
    .delete(
      "/tasks/:taskID",
      describeRoute({
        summary: "Delete scheduled task",
        operationId: "schedules.tasks.delete",
        responses: {
          200: {
            description: "Deleted scheduled task",
            content: {
              "application/json": {
                schema: resolver(Schedule.Task),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ taskID: z.string() })),
      async (c) => c.json(await Schedule.deleteTask(c.req.valid("param").taskID)),
    )
    .post(
      "/tasks/:taskID/run",
      describeRoute({
        summary: "Run scheduled task now",
        operationId: "schedules.tasks.run",
        responses: {
          200: {
            description: "Accepted or skipped scheduled task run",
            content: {
              "application/json": {
                schema: resolver(Schedule.RunResponse),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ taskID: z.string() })),
      async (c) => c.json(await Schedule.runTaskNowResponse(c.req.valid("param").taskID)),
    )
    .get(
      "/runs",
      describeRoute({
        summary: "List scheduled task runs",
        operationId: "schedules.runs.list",
        responses: {
          200: {
            description: "Scheduled runs",
            content: {
              "application/json": {
                schema: resolver(Schedule.Run.array()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "query",
        z.object({
          taskID: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        }),
      ),
      async (c) => c.json(await Schedule.listRuns(c.req.valid("query"))),
    ),
)
