/**
 * 用户偏好 API 路由
 * 仅在 Nine1Bot 环境下生效
 *
 * 直接读取偏好文件，不依赖动态导入
 */

import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { errors } from "../error"
import { Preferences } from "../../preferences"
import { projectPreferenceContext } from "../../preferences/context"
import { Instance } from "../../project/instance"

const PreferenceSchema = Preferences.Info
const AddPreferenceSchema = Preferences.Add
const UpdatePreferenceSchema = Preferences.Update
const conflictResponse = {
  409: {
    description: "Ambiguous preference ID; no records changed",
    content: { "application/json": { schema: resolver(z.object({ error: z.string() })) } },
  },
}

function context(): Preferences.Context {
  return projectPreferenceContext(Instance.project, Instance.directory)
}

export function PreferencesRoutes() {
  // 检查是否在 Nine1Bot 环境中
  if (!Preferences.enabled()) {
    // 返回空路由
    return new Hono()
  }

  return new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List preferences",
        description: "Get all user preferences",
        operationId: "preferences.list",
        responses: {
          200: {
            description: "List of preferences",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    preferences: Preferences.Listed.array(),
                    global: Preferences.Listed.array(),
                    project: Preferences.Listed.array(),
                    unresolved: Preferences.Listed.array(),
                    projectID: z.string(),
                    directory: z.string(),
                  })
                ),
              },
            },
          },
          ...errors(500),
        },
      }),
      async (c) => {
        try {
          return c.json(await Preferences.list(context()))
        } catch (error: any) {
          if (error instanceof Preferences.AmbiguousError) return c.json({ error: error.message }, 409)
          return c.json({ error: error.message }, 500)
        }
      }
    )
    .post(
      "/",
      describeRoute({
        summary: "Add preference",
        description: "Add a new user preference",
        operationId: "preferences.add",
        responses: {
          200: {
            description: "Created preference",
            content: {
              "application/json": {
                schema: resolver(PreferenceSchema),
              },
            },
          },
          ...errors(400, 500),
        },
      }),
      validator("json", AddPreferenceSchema),
      async (c) => {
        try {
          const input = c.req.valid("json")
          return c.json(await Preferences.add(input, context()))
        } catch (error: any) {
          if (error instanceof Preferences.AmbiguousError) return c.json({ error: error.message }, 409)
          return c.json({ error: error.message }, 500)
        }
      }
    )
    .patch(
      "/:id",
      describeRoute({
        summary: "Update preference",
        description: "Update an existing preference",
        operationId: "preferences.update",
        responses: {
          200: {
            description: "Updated preference",
            content: {
              "application/json": {
                schema: resolver(PreferenceSchema),
              },
            },
          },
          ...errors(400, 404, 500),
          ...conflictResponse,
        },
      }),
      validator("param", z.object({ id: z.string() })),
      validator("json", UpdatePreferenceSchema),
      async (c) => {
        try {
          const { id } = c.req.valid("param")
          const input = c.req.valid("json")
          const preference = await Preferences.update(id, input, context())
          if (!preference) return c.json({ error: "Preference not found" }, 404)
          return c.json(preference)
        } catch (error: any) {
          if (error instanceof Preferences.AmbiguousError) return c.json({ error: error.message }, 409)
          return c.json({ error: error.message }, 500)
        }
      }
    )
    .delete(
      "/:id",
      describeRoute({
        summary: "Delete preference",
        description: "Delete a preference",
        operationId: "preferences.delete",
        responses: {
          200: {
            description: "Deletion result",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(404, 500),
          ...conflictResponse,
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        try {
          const { id } = c.req.valid("param")
          if (!await Preferences.remove(id, context())) return c.json({ error: "Preference not found" }, 404)
          return c.json(true)
        } catch (error: any) {
          if (error instanceof Preferences.AmbiguousError) return c.json({ error: error.message }, 409)
          return c.json({ error: error.message }, 500)
        }
      }
    )
    .get(
      "/prompt",
      describeRoute({
        summary: "Get preferences prompt",
        description: "Get the formatted preferences as a prompt string for injection",
        operationId: "preferences.prompt",
        responses: {
          200: {
            description: "Preferences prompt",
            content: {
              "application/json": {
                schema: resolver(z.object({ prompt: z.string() })),
              },
            },
          },
          ...errors(500),
        },
      }),
      async (c) => {
        try {
          return c.json({ prompt: await Preferences.prompt(context()) })
        } catch (error: any) {
          if (error instanceof Preferences.AmbiguousError) return c.json({ error: error.message }, 409)
          return c.json({ error: error.message }, 500)
        }
      }
    )
}
