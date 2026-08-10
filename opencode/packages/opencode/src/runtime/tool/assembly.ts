import { jsonSchema, tool, type Tool as AITool, type ToolCallOptions } from "ai"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { RuntimeResourceResolver } from "@/runtime/resource/resolver"
import type { RuntimeToolCatalog } from "./catalog"
import { PlatformToolExecutor } from "./executor"

export namespace PlatformToolAssembly {
  export type Input = {
    references: RuntimeToolCatalog.ResolvedReference[]
    occupiedToolIDs: ReadonlySet<string>
    model: Provider.Model
    isExposureDenied(toolID: string): boolean | Promise<boolean>
    executionInput(
      reference: RuntimeToolCatalog.ResolvedReference,
      rawInput: unknown,
      options: ToolCallOptions,
    ): PlatformToolExecutor.Input
  }

  export type Result = {
    tools: Record<string, AITool>
    acceptedReferences: RuntimeToolCatalog.ResolvedReference[]
    conflicts: RuntimeResourceResolver.ResourceFailure[]
    hardDeniedToolIDs: string[]
  }

  export async function create(input: Input): Promise<Result> {
    const exposure = await Promise.all(
      input.references.map(async (reference) => ({
        reference,
        denied: await exposureDenied(input.isExposureDenied, reference.id),
      })),
    )
    const hardDeniedToolIDs = exposure
      .filter((item) => item.denied)
      .map((item) => item.reference.id)
      .sort((left, right) => left.localeCompare(right))
    const visible = exposure.filter((item) => !item.denied).map((item) => item.reference)
    const conflicts = visible
      .filter((reference) => input.occupiedToolIDs.has(reference.id))
      .map(toolConflictFailure)
      .sort((left, right) => left.resourceID.localeCompare(right.resourceID))
    const acceptedReferences = visible
      .filter((reference) => !input.occupiedToolIDs.has(reference.id))
      .sort((left, right) => left.id.localeCompare(right.id))
    const tools: Record<string, AITool> = {}

    for (const reference of acceptedReferences) {
      const schema = ProviderTransform.schema(input.model, reference.definition.inputSchema as any)
      tools[reference.id] = tool({
        id: reference.id as any,
        description: reference.definition.description,
        inputSchema: jsonSchema(schema as any),
        execute(rawInput, options) {
          return PlatformToolExecutor.execute(input.executionInput(reference, rawInput, options))
        },
      })
    }

    return {
      tools,
      acceptedReferences,
      conflicts,
      hardDeniedToolIDs,
    }
  }

  function toolConflictFailure(
    reference: RuntimeToolCatalog.ResolvedReference,
  ): RuntimeResourceResolver.ResourceFailure {
    return {
      resourceType: "tool",
      resourceID: reference.id,
      ownerID: reference.ownerID,
      generation: reference.generation,
      code: "tool-conflict",
      status: "unavailable",
      stage: "resolve",
      reason: "tool-conflict",
      message: `Registered tool "${reference.id}" conflicts with an existing runtime tool.`,
      recoverable: false,
    }
  }

  async function exposureDenied(check: Input["isExposureDenied"], toolID: string) {
    try {
      return (await check(toolID)) === true
    } catch {
      return true
    }
  }
}
