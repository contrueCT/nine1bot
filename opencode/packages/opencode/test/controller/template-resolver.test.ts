import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { ControllerTemplateResolver } from "../../src/runtime/controller/template-resolver"
import { RuntimePlatformAdapterRegistry } from "../../src/runtime/platform/adapter"
import { RuntimeResourceResolver } from "../../src/runtime/resource/resolver"
import { SessionProfileCompiler } from "../../src/runtime/session/profile-compiler"
import { tmpdir } from "../fixture/fixture"

describe("controller template resolver", () => {
  afterEach(() => {
    RuntimePlatformAdapterRegistry.clearForTesting()
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
})
