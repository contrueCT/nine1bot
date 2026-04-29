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
    .patch(
      "/tasks/:taskID",
      validator("param", z.object({ taskID: z.string() })),
      validator("json", Schedule.TaskUpdate),
      async (c) => c.json(await Schedule.updateTask(c.req.valid("param").taskID, c.req.valid("json"))),
    )
    .delete(
      "/tasks/:taskID",
      validator("param", z.object({ taskID: z.string() })),
      async (c) => c.json(await Schedule.deleteTask(c.req.valid("param").taskID)),
    )
    .post(
      "/tasks/:taskID/run",
      validator("param", z.object({ taskID: z.string() })),
      async (c) => c.json(await Schedule.runTaskNow(c.req.valid("param").taskID)),
    )
    .get(
      "/runs",
      validator(
        "query",
        z.object({
          taskID: z.string().optional(),
          limit: z.coerce.number().min(1).max(500).optional(),
        }),
      ),
      async (c) => c.json(await Schedule.listRuns(c.req.valid("query"))),
    ),
)
