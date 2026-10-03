import { BrowserSettingsPatch, readBrowserSettings, patchBrowserSettings, browserReadiness } from "../nine1bot-browser-settings"
import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Config } from "../../config/config"
import { Provider } from "../../provider/provider"
import { JsonFile } from "../../util/json-file"
import { updateNine1botConfig } from "../../config/nine1bot"
import { mapValues } from "remeda"
import { errors } from "../error"
import { Log } from "../../util/log"
import { lazy } from "../../util/lazy"
import { RuntimeToolRegistry, RuntimeToolSelectionError } from "../../runtime/tool/registry"
import {
  BrowserExtensionConfigPatch,
  patchBrowserExtensionConfig,
  readBrowserExtensionConfig,
} from "../nine1bot-browser-extension-config"

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

async function readNine1botConfig(configPath: string) {
  return (await JsonFile.read(configPath)).data
}

const Nine1botPatch = Config.Info.extend({
  customProviders: z.record(CustomProviderIDSchema, CustomProviderSchema).optional(),
}).strict()

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
        await Config.update(config, { reload: "refresh" })
        Provider.refresh()
        return c.json(await Config.get())
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
    .patch("/nine1bot", validator("json", Nine1botPatch), async (c) => {
      const configPath = process.env.NINE1BOT_CONFIG_PATH || ""
      if (!configPath) {
        return c.json({ error: "No config path" }, 404)
      }
      try {
        const body = c.req.valid("json")
        await updateNine1botConfig((draft) => Object.assign(draft, body))
        return c.json({ success: true })
      } catch (e: any) {
        return c.json({ error: e.message }, 500)
      }
    })
    .get("/nine1bot/browser", async (c) => {
      try { return c.json(await readBrowserSettings()) }
      catch (e: any) { return c.json({ error: e.message }, 500) }
    })
    .patch("/nine1bot/browser", validator("json", BrowserSettingsPatch), async (c) => {
      if (!process.env.NINE1BOT_CONFIG_PATH) return c.json({ error: "No config path" }, 404)
      try { return c.json(await patchBrowserSettings(c.req.valid("json"))) }
      catch (e: any) { return c.json({ error: e.message }, 500) }
    })
    .get("/nine1bot/readiness", async (c) => {
      try { return c.json(await browserReadiness()) }
      catch (e: any) { return c.json({ error: e.message }, 500) }
    })
    .get("/nine1bot/browser-extension", async (c) => {
      try {
        return c.json(await readBrowserExtensionConfig())
      } catch (e: any) {
        return c.json({ error: e.message }, 500)
      }
    })
    .patch("/nine1bot/browser-extension", validator("json", BrowserExtensionConfigPatch), async (c) => {
      try {
        const patch = c.req.valid("json")
        const registeredTools =
          patch.registeredTools === null || patch.registeredTools === undefined
            ? patch.registeredTools
            : [...new Set(patch.registeredTools.map((toolID) => toolID.trim()).filter(Boolean))]
        if (registeredTools) RuntimeToolRegistry.assertUserSelectable(registeredTools)
        const config = await patchBrowserExtensionConfig({
          ...patch,
          ...(registeredTools !== undefined ? { registeredTools } : {}),
        })
        Config.refresh()
        Provider.refresh()
        return c.json(config)
      } catch (e: any) {
        if (e instanceof RuntimeToolSelectionError) {
          return c.json(
            {
              error: "Some registered tools cannot be saved as browser defaults.",
              invalid: e.invalid,
            },
            400,
          )
        }
        return c.json({ error: e.message }, e.message === "No config path" ? 404 : 500)
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
          await updateNine1botConfig((draft) => {
            draft.customProviders = { ...draft.customProviders, [id]: body }
          })
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
          await updateNine1botConfig((draft) => {
            delete draft.customProviders?.[id]
          })
          return c.json({ success: true })
        } catch (e: any) {
          return c.json({ error: e.message }, 500)
        }
      },
    ),
)
