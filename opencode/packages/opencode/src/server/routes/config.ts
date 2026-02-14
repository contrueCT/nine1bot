import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { readFile, writeFile } from "fs/promises"
import { parse as parseJsonc } from "jsonc-parser"
import { Config } from "../../config/config"
import { Provider } from "../../provider/provider"
import { mapValues } from "remeda"
import { errors } from "../error"
import { Log } from "../../util/log"
import { lazy } from "../../util/lazy"

const log = Log.create({ service: "server" })

export const ConfigRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get configuration",
        description: "Retrieve the current OpenCode configuration settings and preferences.",
        operationId: "config.get",
        responses: {
          200: {
            description: "Get config info",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await Config.get())
      },
    )
    .patch(
      "/",
      describeRoute({
        summary: "Update configuration",
        description: "Update OpenCode configuration settings and preferences.",
        operationId: "config.update",
        responses: {
          200: {
            description: "Successfully updated config",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Config.Info),
      async (c) => {
        const config = c.req.valid("json")
        await Config.update(config)
        return c.json(config)
      },
    )
    .get(
      "/providers",
      describeRoute({
        summary: "List config providers",
        description: "Get a list of all configured AI providers and their default models.",
        operationId: "config.providers",
        responses: {
          200: {
            description: "List of providers",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    providers: Provider.Info.array(),
                    default: z.record(z.string(), z.string()),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        using _ = log.time("providers")
        const providers = await Provider.list().then((x) => mapValues(x, (item) => item))
        return c.json({
          providers: Object.values(providers),
          default: mapValues(providers, (item) => Provider.sort(Object.values(item.models))[0].id),
        })
      },
    )
    .get("/nine1bot", async (c) => {
      const configPath = process.env.NINE1BOT_CONFIG_PATH || ""
      if (!configPath) {
        return c.json({ model: undefined, small_model: undefined, configPath: "" })
      }
      try {
        const text = await readFile(configPath, "utf-8")
        const config = parseJsonc(text) || {}
        return c.json({ model: config.model, small_model: config.small_model, configPath })
      } catch (e: any) {
        return c.json({ error: e.message }, 500)
      }
    })
    .patch("/nine1bot", async (c) => {
      const configPath = process.env.NINE1BOT_CONFIG_PATH || ""
      if (!configPath) {
        return c.json({ error: "No config path" }, 404)
      }
      try {
        const body = await c.req.json()
        // 1. 写入 nine1bot.config.jsonc（持久化，重启后生效）
        const text = await readFile(configPath, "utf-8")
        const existing = parseJsonc(text) || {}
        await writeFile(configPath, JSON.stringify({ ...existing, ...body }, null, 2))
        // 2. 更新 OPENCODE_CONFIG 临时文件（运行时配置源，Instance 重建后读取）
        const opConfigPath = process.env.OPENCODE_CONFIG || ""
        if (opConfigPath) {
          const opText = await readFile(opConfigPath, "utf-8").catch(() => "{}")
          const opConfig = JSON.parse(opText)
          Object.assign(opConfig, body)
          await writeFile(opConfigPath, JSON.stringify(opConfig, null, 2))
        }
        // 3. 触发 Instance 重建，强制重新加载配置
        await Config.update(body)
        return c.json({ success: true })
      } catch (e: any) {
        return c.json({ error: e.message }, 500)
      }
    }),
)
