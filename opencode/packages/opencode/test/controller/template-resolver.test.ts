import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { ControllerTemplateResolver } from "../../src/runtime/controller/template-resolver"
import { RuntimePlatformAdapterRegistry } from "../../src/runtime/platform/adapter"
import { RuntimeResourceResolver } from "../../src/runtime/resource/resolver"
import { SessionProfileCompiler } from "../../src/runtime/session/profile-compiler"
import {
  RuntimeToolRegistrationError,
  RuntimeToolRegistry,
  RuntimeToolSelectionError,
} from "../../src/runtime/tool/registry"
import { tmpdir } from "../fixture/fixture"

describe("controller template resolver", () => {
  afterEach(() => {
    RuntimePlatformAdapterRegistry.clearForTesting()
    RuntimeToolRegistry.clearForTesting()
  })

  test("creates distinct scene templates for web, Feishu, and registered browser platform sessions", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        mcp: {
          enabled_server: {
            type: "local",
            command: ["node", "server.js"],
            enabled: true,
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        RuntimePlatformAdapterRegistry.register({
          id: "test-platform",
          matchPage: (page) => page.platform === "test-platform",
          normalizePage: (page) => ({
            ...page,
            pageType: "test-mr",
            objectKey: "test-platform:project!42",
          }),
          inferTemplateIds: (input) => input.page?.platform === "test-platform" ? ["browser-test-platform", "test-mr"] : [],
          templateContextBlocks: (input) => input.templateIds
            .filter((templateId) => templateId === "browser-test-platform" || templateId === "test-mr")
            .map((templateId) => ({
              id: `template:${templateId}`,
              layer: "platform",
              source: `template.${templateId}`,
              content: `Template ${templateId}`,
              lifecycle: "session",
              visibility: "developer-toggle",
              enabled: true,
              priority: 40,
            })),
          resourceContributions: (input) => input.templateIds.includes("browser-test-platform")
            ? {
                builtinTools: {
                  enabledGroups: ["test-platform-context"],
                },
                mcp: {
                  servers: [],
                  lifecycle: "session",
                  mergeMode: "additive-only",
                },
                skills: {
                  skills: [],
                  lifecycle: "session",
                  mergeMode: "additive-only",
                },
              }
            : undefined,
        })
        const web = await ControllerTemplateResolver.resolve({
          entry: {
            source: "web",
            mode: "web-chat",
            templateIds: ["default-user-template", "web-chat"],
          },
        })
        const feishu = await ControllerTemplateResolver.resolve({
          entry: {
            source: "feishu",
            platform: "feishu",
            mode: "feishu-private-chat",
            templateIds: ["default-user-template", "feishu-chat"],
          },
        })
        const platform = await ControllerTemplateResolver.resolve({
          entry: {
            source: "browser-extension",
            platform: "test-platform",
            mode: "browser-sidepanel",
            templateIds: ["default-user-template", "browser-generic", "browser-test-platform"],
          },
          page: {
            platform: "test-platform",
            url: "https://example.test/nine1/nine1bot/-/merge_requests/42",
            title: "Improve runtime",
          },
        })

        expect(web.templateIds).toContain("web-chat")
        expect(feishu.templateIds).toContain("feishu-chat")
        expect(platform.templateIds).toEqual([
          "default-user-template",
          "browser-generic",
          "browser-test-platform",
          "test-mr",
        ])
        expect(web.contextPreview.map((block) => block.source)).toContain("template.web-chat")
        expect(feishu.contextPreview.map((block) => block.source)).toContain("template.feishu-chat")
        expect(platform.contextPreview.map((block) => block.source)).toContain("template.browser-test-platform")
        expect(web.resourcesPreview.builtinGroups).toContain("web-chat")
        expect(feishu.resourcesPreview.builtinGroups).toContain("chat-text")
        expect(platform.resourcesPreview.builtinGroups).toContain("test-platform-context")
        expect(web.resourcesPreview.mcp).toContain("enabled_server")
      },
    })
  })

  test("session choice resources are additive and still pass through the live gate", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        mcp: {
          disabled_server: {
            type: "local",
            command: ["node", "server.js"],
            enabled: false,
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await ControllerTemplateResolver.resolve({
          entry: {
            source: "web",
            mode: "web-chat",
          },
          sessionChoice: {
            resources: {
              builtinTools: {
                enabledTools: ["display_file"],
              },
              mcp: {
                servers: ["disabled_server", "missing_server"],
              },
              skills: {
                skills: ["missing-skill-for-template-test"],
              },
            },
          },
        })
        const profile = await SessionProfileCompiler.compile({
          source: "new-session",
          profileTemplate: resolved.profileTemplate,
        })
        const resourceResolution = await RuntimeResourceResolver.resolve({
          sessionID: "template_test",
          profile,
          emitFailures: false,
          emitResolved: false,
        })

        expect(profile.resources.builtinTools.enabledTools).toContain("display_file")
        expect(profile.resources.mcp.servers).toContain("disabled_server")
        expect(profile.resources.mcp.servers).toContain("missing_server")
        expect(profile.resources.skills.skills).toContain("missing-skill-for-template-test")
        expect(resourceResolution.mcp.availableServers).not.toContain("disabled_server")
        expect(resourceResolution.mcp.availableServers).not.toContain("missing_server")
        expect(resourceResolution.mcp.availability.disabled_server.reason).toBe("disabled-by-current-config")
        expect(resourceResolution.skills.availability["missing-skill-for-template-test"].reason).toBe(
          "disabled-by-current-config",
        )
      },
    })
  })

  test("filters disabled platform templates and resource contributions with audit", async () => {
    await using tmp = await tmpdir({
      git: true,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        RuntimePlatformAdapterRegistry.markDisabled({
          id: "gitlab",
          templateIds: ["browser-gitlab", "gitlab-mr"],
        })

        const resolved = await ControllerTemplateResolver.resolve({
          entry: {
            source: "browser-extension",
            platform: "gitlab",
            mode: "browser-sidepanel",
            templateIds: ["default-user-template", "browser-generic", "browser-gitlab", "gitlab-mr"],
          },
          page: {
            platform: "gitlab",
            url: "https://gitlab.com/nine1/nine1bot/-/merge_requests/42",
            title: "Improve runtime",
          },
        })

        expect(resolved.templateIds).toEqual(["default-user-template", "browser-generic"])
        expect(resolved.contextPreview.map((block) => block.source)).not.toContain("template.browser-gitlab")
        expect(resolved.resourcesPreview.builtinGroups).not.toContain("gitlab-context")
        expect(resolved.audit.skippedPlatforms).toEqual([
          expect.objectContaining({
            platform: "gitlab",
            reason: "platform-disabled-by-current-config",
            matchedTemplateIds: ["browser-gitlab", "gitlab-mr"],
          }),
        ])
      },
    })
  })

  test("merges owner-checked platform declarations and user-selectable choices", async () => {
    const fixtureSecret = "demo-runtime-secret-value"
    registerDemoTools(fixtureSecret)

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        RuntimePlatformAdapterRegistry.register({
          id: "demo",
          resourceContributions: ({ templateIds, agentName }) =>
            templateIds.includes("demo-page") && agentName === "build"
              ? {
                  ...RuntimeResourceResolver.emptyResources(),
                  registeredTools: {
                    tools: ["demo_declared", "demo_declared"],
                    lifecycle: "session",
                    mergeMode: "additive-only",
                    availability: {
                      demo_declared: {
                        declared: true,
                        status: "degraded",
                        reason: "token=demo-runtime-secret-value",
                        action: {
                          type: "open-settings",
                          label: "Open settings with Authorization: Bearer demo-runtime-secret-value",
                        },
                      },
                      demo_not_declared: {
                        declared: true,
                        status: "available",
                      },
                    },
                  },
                }
              : undefined,
        })

        const resolved = await ControllerTemplateResolver.resolve({
          entry: { source: "web", templateIds: ["demo-page"] },
          sessionChoice: {
            resources: { registeredTools: { tools: ["demo_selectable", "demo_selectable"] } },
          },
        })
        const profile = await SessionProfileCompiler.compile({
          source: "new-session",
          profileTemplate: resolved.profileTemplate,
        })

        expect(resolved.profileTemplate.resources.registeredTools?.tools).toEqual([
          "demo_declared",
          "demo_selectable",
        ])
        expect(resolved.resourcesPreview.registeredTools).toEqual([
          "demo_declared",
          "demo_selectable",
        ])
        expect(resolved.audit.resources.registeredTools).toEqual([
          "demo_declared",
          "demo_selectable",
        ])
        expect(profile.resources.registeredTools).toEqual({
          tools: ["demo_declared", "demo_selectable"],
          lifecycle: "session",
          mergeMode: "additive-only",
          availability: {
            demo_declared: {
              declared: true,
              status: "degraded",
              reason: "token=[REDACTED]",
              action: {
                type: "open-settings",
                label: "Open settings with Authorization: [REDACTED]",
              },
            },
          },
        })

        const serialized = JSON.stringify(profile)
        expect(serialized).not.toContain("inputSchema")
        expect(serialized).not.toContain("generation")
        expect(serialized).not.toContain("execute")
        expect(serialized).not.toContain(fixtureSecret)
        expect(serialized).not.toContain("demo_not_declared")
      },
    })
  })

  test("rejects platform declarations owned by another adapter", async () => {
    registerDemoTools("owner-secret")
    RuntimeToolRegistry.registerOwner({
      owner: { id: "other", kind: "platform", enabled: true },
      tools: [definition("other_tool", "declared-only", "other-secret")],
    })

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        RuntimePlatformAdapterRegistry.register({
          id: "demo",
          resourceContributions: () => ({
            ...RuntimeResourceResolver.emptyResources(),
            registeredTools: {
              tools: ["other_tool"],
              lifecycle: "session",
              mergeMode: "additive-only",
            },
          }),
        })

        try {
          await ControllerTemplateResolver.resolve({
            entry: { source: "web", templateIds: ["demo-page"] },
          })
          throw new Error("expected cross-owner declaration to fail")
        } catch (error) {
          expect(error).toBeInstanceOf(RuntimeToolRegistrationError)
          expect((error as RuntimeToolRegistrationError).code).toBe("tool-ownership")
        }
      },
    })
  })

  test("rejects direct selection of a declared-only registered tool", async () => {
    registerDemoTools("selection-secret")

    await using tmp = await tmpdir({
      git: true,
      config: {
        runtime: {
          resourceResolver: {
            enabled: false,
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        try {
          await ControllerTemplateResolver.resolve({
            sessionChoice: {
              resources: { registeredTools: { tools: ["demo_declared"] } },
            },
          })
          throw new Error("expected declared-only selection to fail")
        } catch (error) {
          expect(error).toBeInstanceOf(RuntimeToolSelectionError)
          expect((error as RuntimeToolSelectionError).invalid).toEqual([
            { id: "demo_declared", reason: "declared-only" },
          ])
          expect(String(error)).not.toContain("selection-secret")
        }
      },
    })
  })
})

function registerDemoTools(secret: string) {
  RuntimeToolRegistry.registerOwner({
    owner: { id: "demo", kind: "platform", enabled: true },
    tools: [
      definition("demo_declared", "declared-only", secret),
      definition("demo_selectable", "user-selectable", secret),
    ],
  })
}

function definition(
  id: string,
  catalogVisibility: RuntimeToolRegistry.Definition["catalogVisibility"],
  secret: string,
): RuntimeToolRegistry.Definition {
  return {
    id,
    description: `Fixture tool ${id}.`,
    catalogVisibility,
    inputSchema: {
      type: "object",
      additionalProperties: false,
    },
    parse: (input) => input,
    execute: async () => ({
      status: "ok",
      title: id,
      output: secret,
    }),
  }
}
