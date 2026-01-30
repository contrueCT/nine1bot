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
import path from "path"
import os from "os"

// 偏好数据类型定义
const PreferenceSchema = z.object({
  id: z.string(),
  content: z.string(),
  source: z.enum(["user", "ai"]),
  createdAt: z.number(),
  scope: z.enum(["global", "project"]),
})

const AddPreferenceSchema = z.object({
  content: z.string(),
  source: z.enum(["user", "ai"]).optional(),
  scope: z.enum(["global", "project"]).optional(),
})

const UpdatePreferenceSchema = z.object({
  content: z.string().optional(),
})

// 偏好类型
interface Preference {
  id: string
  content: string
  source: "user" | "ai"
  createdAt: number
  scope: "global" | "project"
}

interface PreferencesFile {
  version: number
  preferences: Preference[]
}

// 生成唯一 ID
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8)
}

// 获取偏好文件路径
function getPreferencesFilePath(): string {
  // 优先使用环境变量
  if (process.env.NINE1BOT_PREFERENCES_PATH) {
    return process.env.NINE1BOT_PREFERENCES_PATH
  }
  // 默认路径
  const configDir = path.join(os.homedir(), '.nine1bot')
  return path.join(configDir, 'preferences.json')
}

// 读取偏好文件
async function readPreferencesFile(): Promise<PreferencesFile> {
  const filePath = getPreferencesFilePath()
  try {
    const file = Bun.file(filePath)
    if (!await file.exists()) {
      return { version: 1, preferences: [] }
    }
    const content = await file.text()
    return JSON.parse(content) as PreferencesFile
  } catch {
    return { version: 1, preferences: [] }
  }
}

// 写入偏好文件
async function writePreferencesFile(data: PreferencesFile): Promise<void> {
  const filePath = getPreferencesFilePath()
  const dir = path.dirname(filePath)

  // 确保目录存在
  try {
    await Bun.write(path.join(dir, '.keep'), '')
  } catch {
    // 目录可能已存在
  }

  await Bun.write(filePath, JSON.stringify(data, null, 2))
}

export function PreferencesRoutes() {
  // 检查是否在 Nine1Bot 环境中
  if (!process.env.NINE1BOT_PREFERENCES_PATH && !process.env.NINE1BOT_PREFERENCES_MODULE) {
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
                    preferences: PreferenceSchema.array(),
                    global: PreferenceSchema.array(),
                    project: PreferenceSchema.array(),
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
          const data = await readPreferencesFile()
          const preferences = data.preferences || []
          return c.json({
            preferences,
            global: preferences.filter(p => p.scope === 'global'),
            project: preferences.filter(p => p.scope === 'project'),
          })
        } catch (error: any) {
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
          const data = await readPreferencesFile()

          const preference: Preference = {
            id: generateId(),
            content: input.content,
            source: input.source || "user",
            createdAt: Date.now(),
            scope: input.scope || "global",
          }

          data.preferences.push(preference)
          await writePreferencesFile(data)

          return c.json(preference)
        } catch (error: any) {
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
        },
      }),
      validator("param", z.object({ id: z.string() })),
      validator("json", UpdatePreferenceSchema),
      async (c) => {
        try {
          const { id } = c.req.valid("param")
          const input = c.req.valid("json")
          const data = await readPreferencesFile()

          const index = data.preferences.findIndex(p => p.id === id)
          if (index === -1) {
            return c.json({ error: "Preference not found" }, 404)
          }

          if (input.content) {
            data.preferences[index].content = input.content
          }

          await writePreferencesFile(data)
          return c.json(data.preferences[index])
        } catch (error: any) {
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
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        try {
          const { id } = c.req.valid("param")
          const data = await readPreferencesFile()

          const index = data.preferences.findIndex(p => p.id === id)
          if (index === -1) {
            return c.json({ error: "Preference not found" }, 404)
          }

          data.preferences.splice(index, 1)
          await writePreferencesFile(data)

          return c.json(true)
        } catch (error: any) {
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
          const data = await readPreferencesFile()
          const preferences = data.preferences || []

          if (preferences.length === 0) {
            return c.json({ prompt: "" })
          }

          const items = preferences.map((p, i) => `${i + 1}. ${p.content}`).join('\n')
          const prompt = `<user-preferences>
以下是用户设置的偏好，请在回复中遵循这些偏好：

${items}

这些偏好由用户明确设置，优先级高于默认行为。
</user-preferences>`

          return c.json({ prompt })
        } catch (error: any) {
          return c.json({ error: error.message }, 500)
        }
      }
    )
}
