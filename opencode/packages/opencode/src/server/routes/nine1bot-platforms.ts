import { Hono } from "hono"
import z from "zod"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { PermissionNext } from "@/permission/next"
import { Instance } from "@/project/instance"
import { RuntimeResourceResolver } from "@/runtime/resource/resolver"
import { RuntimeToolCatalog } from "@/runtime/tool/catalog"
import { ToolRegistry } from "@/tool/registry"
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

const ToolCatalogQuerySchema = z.object({
  agent: z.string().min(1).optional(),
  templateIds: z.string().optional(),
}).strict()

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

function parseTemplateIds(value?: string) {
  if (!value) return []
  return [...new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  )]
}

function isExposureDenied(toolID: string, ruleset: PermissionNext.Ruleset) {
  return PermissionNext.disabled([toolID], ruleset).has(toolID)
}

export const Nine1BotPlatformRoutes = () =>
  new Hono()
    .get("/", async (c) => {
      try {
        const manager = await syncManagerFromConfig()
        return c.json({
          platforms: manager.listSummaries(),
        })
      } catch (error) {
        return c.json(errorBody(error), errorStatus(error))
      }
    })
    .get("/tools", async (c) => {
      try {
        await syncManagerFromConfig()
        const parsed = ToolCatalogQuerySchema.safeParse({
          agent: c.req.query("agent") || undefined,
          templateIds: c.req.query("templateIds"),
        })
        if (!parsed.success) {
          return c.json({
            error: "Invalid platform tool catalog query",
            fieldErrors: Object.fromEntries(
              parsed.error.issues.map((issue) => [issue.path.join(".") || "query", issue.message]),
            ),
          }, 400)
        }

        const requestedAgent = parsed.data.agent
        const agentName = requestedAgent ?? (await Agent.defaultAgent())
        const agent = await Agent.mustGet(
          agentName,
          requestedAgent
            ? { includeDeclaredOnly: true, includeRecommendable: true }
            : undefined,
        )
        const templateIds = parseTemplateIds(parsed.data.templateIds)
        const [nativeToolIDs, baseResources] = await Promise.all([
          ToolRegistry.ids(),
          RuntimeResourceResolver.resolve({
            sessionID: "platform-tool-catalog",
            projectID: Instance.project.id,
            directory: Instance.directory,
            agent: agent.name,
            templateIds,
            emitFailures: false,
            emitResolved: false,
          }),
        ])
        const mcpToolIDs = Object.keys(await MCP.tools({
          servers: baseResources.mcp.availableServers,
        }))
        const summaries = await RuntimeToolCatalog.listSelectable({
          context: {
            sessionId: "platform-tool-catalog",
            projectId: Instance.project.id,
            directory: Instance.directory,
            agent: agent.name,
            templateIds,
          },
          occupiedToolIDs: new Set([...nativeToolIDs, ...mcpToolIDs]),
          isExposureDenied: (toolID) => isExposureDenied(toolID, agent.permission),
        })

        return c.json({
          tools: summaries.map((tool) => ({
            id: tool.id,
            ownerId: tool.ownerId,
            description: tool.description,
            catalogVisibility: tool.catalogVisibility,
            status: tool.status,
            generation: tool.generation,
            unavailableReason: tool.unavailableReason,
            action: tool.action,
          })),
        })
      } catch (error) {
        return c.json(errorBody(error), errorStatus(error))
      }
    })
    .get("/:id", async (c) => {
      try {
        const manager = await syncManagerFromConfig()
        await manager.refreshStatus(c.req.param("id"))
        const detail = await manager.getDetail(c.req.param("id"))
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
      let previousConfig
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
        previousConfig = manager.configSnapshot()
        const result = await manager.executeAction(c.req.param("id"), c.req.param("actionId"), parsed.data)
        if (result.updatedSettings !== undefined) {
          await writePlatformManagerConfig(manager.configSnapshot())
        }
        return c.json(result)
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
