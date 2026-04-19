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

const CustomProviderModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
})

const CustomProviderSchema = z.object({
  name: z.string().min(1),
  protocol: z.enum(["openai", "anthropic"]),
  baseURL: z.string().url(),
  models: z.array(CustomProviderModelSchema).min(1),
  options: z
    .object({
      timeout: z.union([z.number(), z.literal(false)]).optional(),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .catchall(z.any())
    .optional(),
})

const CustomProviderIDSchema = z.string().regex(/^[a-z0-9][a-z0-9-_]{1,63}$/)

async function readNine1botConfig(configPath: string): Promise<Record<string, any>> {
  const text = await readFile(configPath, "utf-8")
  return (parseJsonc(text) || {}) as Record<string, any>
}

async function writeNine1botConfig(configPath: string, nextConfig: Record<string, any>) {
  await writeFile(configPath, JSON.stringify(nextConfig, null, 2))
}

async function patchOpencodeRuntimeConfig(patch: Record<string, any>) {
  const opConfigPath = process.env.OPENCODE_CONFIG || ""
  if (!opConfigPath) return
  const opText = await readFile(opConfigPath, "utf-8").catch(() => "{}")
  const opConfig = JSON.parse(opText)
  Object.assign(opConfig, patch)
  await writeFile(opConfigPath, JSON.stringify(opConfig, null, 2))
}

function protocolToNpm(protocol: "openai" | "anthropic") {
  return protocol === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible"
}

function mapCustomProvidersToOpencode(customProviders: Record<string, any>) {
  const mapped: Record<string, any> = {}
  for (const [providerId, provider] of Object.entries(customProviders || {})) {
    mapped[providerId] = {
      name: provider.name,
      npm: protocolToNpm(provider.protocol),
      api: provider.baseURL,
      options: {
        baseURL: provider.baseURL,
        ...(provider.options || {}),
      },
      models: Object.fromEntries(
        (provider.models || []).map((model: any) => [
          model.id,
          {
            id: model.id,
            name: model.name || model.id,
            provider: {
              npm: protocolToNpm(provider.protocol),
            },
          },
        ]),
      ),
    }
  }
  return mapped
}

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
    .post(
      "/runtime/reload",
      describeRoute({
        summary: "Reload runtime config state",
        description: "Refresh in-memory config and provider caches from the current runtime config file without disposing sessions.",
        operationId: "config.runtime.reload",
        responses: {
          200: {
            description: "Successfully reloaded runtime config state",
            content: {
              "application/json": {
                schema: resolver(z.object({ success: z.literal(true) })),
              },
            },
          },
        },
      }),
      async (c) => {
        Config.reloadRuntime()
        Provider.refresh()
        return c.json({ success: true as const })
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
        return c.json({ model: undefined, small_model: undefined, customProviders: {}, configPath: "" })
      }
      try {
        const config = await readNine1botConfig(configPath)
        return c.json({
          model: config.model,
          small_model: config.small_model,
          customProviders: config.customProviders || {},
          configPath,
        })
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
        const existing = await readNine1botConfig(configPath)
        const mergedConfig = { ...existing, ...body }
        await writeNine1botConfig(configPath, mergedConfig)
        // 2. 更新 OPENCODE_CONFIG 临时文件（运行时配置源，Instance 重建后读取）
        const runtimePatch = { ...body }
        if (runtimePatch.customProviders) {
          const previousCustomProviders = existing.customProviders || {}
          const nextCustomProviders = mergedConfig.customProviders || {}
          const mapped = mapCustomProvidersToOpencode(nextCustomProviders)
          delete runtimePatch.customProviders
          const currentProvider = (await Config.get()).provider || {}
          const preserved = Object.fromEntries(
            Object.entries(currentProvider).filter(([providerId]) => !(providerId in previousCustomProviders)),
          )
          runtimePatch.provider = { ...preserved, ...mapped }
        }
        await patchOpencodeRuntimeConfig(runtimePatch)
        // 3. 触发 Instance 重建，强制重新加载配置
        await Config.update(runtimePatch)
        Provider.refresh()
        return c.json({ success: true })
      } catch (e: any) {
        return c.json({ error: e.message }, 500)
      }
    })
    .get("/nine1bot/custom-providers", async (c) => {
      const configPath = process.env.NINE1BOT_CONFIG_PATH || ""
      if (!configPath) {
        return c.json({})
      }
      try {
        const config = await readNine1botConfig(configPath)
        return c.json(config.customProviders || {})
      } catch (e: any) {
        return c.json({ error: e.message }, 500)
      }
    })
    .put(
      "/nine1bot/custom-providers/:id",
      validator(
        "param",
        z.object({
          id: CustomProviderIDSchema,
        }),
      ),
      validator("json", CustomProviderSchema),
      async (c) => {
        const configPath = process.env.NINE1BOT_CONFIG_PATH || ""
        if (!configPath) {
          return c.json({ error: "No config path" }, 404)
        }
        try {
          const id = c.req.valid("param").id
          const body = c.req.valid("json")
          const existing = await readNine1botConfig(configPath)
          const currentProviders = existing.customProviders || {}
          const customProviders = { ...currentProviders, [id]: body }
          await writeNine1botConfig(configPath, { ...existing, customProviders })

          const mapped = mapCustomProvidersToOpencode(customProviders)
          const current = await Config.get()
          await patchOpencodeRuntimeConfig({
            provider: {
              ...(current.provider || {}),
              ...mapped,
            },
          })
          await Config.update({
            provider: {
              ...(current.provider || {}),
              ...mapped,
            },
          })
          Provider.refresh()
          return c.json({ success: true })
        } catch (e: any) {
          return c.json({ error: e.message }, 500)
        }
      },
    )
    .delete(
      "/nine1bot/custom-providers/:id",
      validator(
        "param",
        z.object({
          id: CustomProviderIDSchema,
        }),
      ),
      async (c) => {
        const configPath = process.env.NINE1BOT_CONFIG_PATH || ""
        if (!configPath) {
          return c.json({ error: "No config path" }, 404)
        }
        try {
          const id = c.req.valid("param").id
          const existing = await readNine1botConfig(configPath)
          const customProviders = { ...(existing.customProviders || {}) }
          delete customProviders[id]
          await writeNine1botConfig(configPath, { ...existing, customProviders })

          const mapped = mapCustomProvidersToOpencode(customProviders)
          const current = await Config.get()
          const preserved = Object.fromEntries(
            Object.entries(current.provider || {}).filter(([providerId]) => !(providerId in (existing.customProviders || {}))),
          )
          const nextProvider = {
            ...preserved,
            ...mapped,
          }
          await patchOpencodeRuntimeConfig({ provider: nextProvider })
          await Config.update({ provider: nextProvider })
          Provider.refresh()
          return c.json({ success: true })
        } catch (e: any) {
          return c.json({ error: e.message }, 500)
        }
      },
    ),
)
