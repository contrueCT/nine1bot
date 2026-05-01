import { Hono } from "hono"
import z from "zod"
import {
  getBuiltinPlatformManager,
  registerBuiltinPlatformAdapters,
} from "../../../../../../packages/nine1bot/src/platform/builtin"
import { FilePlatformSecretStore } from "../../../../../../packages/nine1bot/src/platform/secrets"
import {
  PlatformActionConfirmationError,
  PlatformActionNotFoundError,
  PlatformNotFoundError,
  PlatformValidationError,
  type PlatformConfigPatch,
} from "../../../../../../packages/nine1bot/src/platform/manager"
import {
  PlatformConfigPathMissingError,
  readPlatformManagerConfig,
  writePlatformManagerConfig,
} from "../../../../../../packages/nine1bot/src/platform/config-store"

const PlatformConfigPatchSchema = z.object({
  enabled: z.boolean().optional(),
  features: z.record(z.string(), z.boolean()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
}).strict()

const PlatformActionBodySchema = z.object({
  input: z.unknown().optional(),
  confirm: z.boolean().optional(),
}).strict().default({})

function platformSecrets() {
  return new FilePlatformSecretStore(process.env.NINE1BOT_PLATFORM_SECRETS_PATH)
}

async function syncManagerFromConfig() {
  const config = await readPlatformManagerConfig()
  registerBuiltinPlatformAdapters({
    config,
    secrets: platformSecrets(),
  })
  return getBuiltinPlatformManager()
}

function errorBody(error: unknown) {
  if (error instanceof PlatformValidationError) {
    return {
      error: error.message,
      fieldErrors: error.fieldErrors,
    }
  }
  return {
    error: error instanceof Error ? error.message : String(error),
  }
}

function errorStatus(error: unknown) {
  if (
    error instanceof PlatformNotFoundError ||
    error instanceof PlatformActionNotFoundError ||
    error instanceof PlatformConfigPathMissingError
  ) {
    return 404
  }
  if (error instanceof PlatformValidationError || error instanceof PlatformActionConfirmationError) {
    return 400
  }
  return 500
}

async function parseJson(c: { req: { json: () => Promise<unknown> } }) {
  try {
    return await c.req.json()
  } catch {
    return {}
  }
}

export const Nine1BotPlatformRoutes = () =>
  new Hono()
    .get("/", async (c) => {
      try {
        const manager = getBuiltinPlatformManager()
        return c.json({
          platforms: manager.listSummaries(),
        })
      } catch (error) {
        return c.json(errorBody(error), errorStatus(error))
      }
    })
    .get("/:id", async (c) => {
      try {
        const detail = await getBuiltinPlatformManager().getDetail(c.req.param("id"))
        if (!detail) throw new PlatformNotFoundError(c.req.param("id"))
        return c.json(detail)
      } catch (error) {
        return c.json(errorBody(error), errorStatus(error))
      }
    })
    .patch("/:id", async (c) => {
      let previousConfig
      try {
        previousConfig = await readPlatformManagerConfig()
        const manager = await syncManagerFromConfig()
        const parsed = PlatformConfigPatchSchema.safeParse(await parseJson(c))
        if (!parsed.success) {
          return c.json({
            error: "Invalid platform config patch",
            fieldErrors: Object.fromEntries(
              parsed.error.issues.map((issue) => [issue.path.join(".") || "body", issue.message]),
            ),
          }, 400)
        }

        await manager.updateConfig(c.req.param("id"), parsed.data as PlatformConfigPatch)
        const nextConfig = manager.configSnapshot()
        await writePlatformManagerConfig(nextConfig)

        const detail = await manager.getDetail(c.req.param("id"))
        if (!detail) throw new PlatformNotFoundError(c.req.param("id"))
        return c.json(detail)
      } catch (error) {
        if (previousConfig) {
          try {
            registerBuiltinPlatformAdapters({
              config: previousConfig,
              secrets: platformSecrets(),
            })
          } catch {}
        }
        return c.json(errorBody(error), errorStatus(error))
      }
    })
    .post("/:id/health", async (c) => {
      try {
        const manager = getBuiltinPlatformManager()
        const runtimeStatus = await manager.refreshStatus(c.req.param("id"))
        const detail = await manager.getDetail(c.req.param("id"))
        return c.json({
          runtimeStatus,
          platform: detail,
        })
      } catch (error) {
        return c.json(errorBody(error), errorStatus(error))
      }
    })
    .post("/:id/actions/:actionId", async (c) => {
      try {
        const parsed = PlatformActionBodySchema.safeParse(await parseJson(c))
        if (!parsed.success) {
          return c.json({
            error: "Invalid platform action body",
            fieldErrors: Object.fromEntries(
              parsed.error.issues.map((issue) => [issue.path.join(".") || "body", issue.message]),
            ),
          }, 400)
        }

        const manager = getBuiltinPlatformManager()
        const result = await manager.executeAction(c.req.param("id"), c.req.param("actionId"), parsed.data)
        return c.json(result)
      } catch (error) {
        return c.json(errorBody(error), errorStatus(error))
      }
    })
