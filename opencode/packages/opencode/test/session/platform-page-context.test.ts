import { describe, expect, test } from "bun:test"
import path from "path"
import { RuntimeContextEvents } from "../../src/runtime/context/events"
import { RuntimePlatformAdapterRegistry } from "../../src/runtime/platform/adapter"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("platform page context registry", () => {
  test("normalizes page payload and emits stable blocks through registered platform adapter", () => {
    RuntimePlatformAdapterRegistry.clearForTesting()
    RuntimePlatformAdapterRegistry.register({
      id: "test-platform",
      matchPage: (page) => page.platform === "test-platform",
      normalizePage: (page) => ({
        ...page,
        pageType: "test-mr",
        objectKey: "test-platform:project!42",
      }),
      blocksFromPage: (page, observedAt) => [
        {
          id: "platform:test-platform",
          layer: "platform",
          source: "page-context.test-platform",
          content: `Platform: ${page.platform}`,
          lifecycle: "turn",
          visibility: "developer-toggle",
          enabled: true,
          priority: 65,
          mergeKey: "test-platform:project!42",
          observedAt,
        },
        {
          id: "page:test-mr",
          layer: "page",
          source: "page-context.test-platform",
          content: "Object key: test-platform:project!42",
          lifecycle: "turn",
          visibility: "developer-toggle",
          enabled: true,
          priority: 62,
          mergeKey: "test-platform:project!42",
          observedAt,
        },
      ],
    })
    const payload = RuntimeContextEvents.normalizePagePayload({
      platform: "test-platform",
      url: "https://example.test/nine1/nine1bot/-/merge_requests/42",
      title: "Improve runtime",
      selection: "selected MR line",
      visibleSummary: "MR overview",
    })

    expect(payload).toMatchObject({
      platform: "test-platform",
      pageType: "test-mr",
      objectKey: "test-platform:project!42",
    })

    const blocks = RuntimeContextEvents.blocksFromPagePayload(payload, 1_000)
    expect(blocks.map((block) => block.id)).toEqual([
      "platform:test-platform",
      "page:test-mr",
    ])
    expect(blocks[1]?.content).toEqual(expect.stringContaining("Object key: test-platform:project!42"))
    RuntimePlatformAdapterRegistry.clearForTesting()
  })

  test("deduplicates same-page events and records page transitions, content changes, and selection updates", async () => {
    RuntimePlatformAdapterRegistry.clearForTesting()
    RuntimePlatformAdapterRegistry.register({
      id: "test-platform",
      matchPage: (page) => page.platform === "test-platform",
      normalizePage: (page) => ({
        ...page,
        objectKey: page.objectKey ?? page.url,
      }),
    })
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sessionID = `test_gitlab_${Date.now()}`
        const projectID = `project_${sessionID}`
        await RuntimeContextEvents.removeAll({ sessionID, projectID })

        const repo = {
          platform: "test-platform",
          url: "https://example.test/nine1/nine1bot",
          title: "nine1bot",
          pageType: "test-repo",
          objectKey: "test-platform:repo",
          visibleSummary: "Repository overview",
        }
        const mr = {
          platform: "test-platform",
          url: "https://example.test/nine1/nine1bot/-/merge_requests/42",
          title: "Improve runtime",
          pageType: "test-mr",
          objectKey: "test-platform:mr:42",
          visibleSummary: "MR overview",
        }

        const enterRepo = await RuntimeContextEvents.preparePageEvent({ sessionID, projectID, page: repo })
        expect(enterRepo?.event?.type).toBe("page-enter")
        await RuntimeContextEvents.commitPageEvent({ sessionID, projectID, prepared: enterRepo! })

        const sameRepo = await RuntimeContextEvents.preparePageEvent({ sessionID, projectID, page: repo })
        expect(sameRepo?.deduped).toBe(true)
        expect(sameRepo?.event).toBeUndefined()

        const enterMr = await RuntimeContextEvents.preparePageEvent({ sessionID, projectID, page: mr })
        expect(enterMr?.event?.type).toBe("page-enter")
        await RuntimeContextEvents.commitPageEvent({ sessionID, projectID, prepared: enterMr! })

        const updatedMr = await RuntimeContextEvents.preparePageEvent({
          sessionID,
          projectID,
          page: {
            ...mr,
            visibleSummary: "MR overview with new discussion",
          },
        })
        expect(updatedMr?.event?.type).toBe("page-update")
        await RuntimeContextEvents.commitPageEvent({ sessionID, projectID, prepared: updatedMr! })

        const selectedMr = await RuntimeContextEvents.preparePageEvent({
          sessionID,
          projectID,
          page: {
            ...mr,
            visibleSummary: "MR overview with new discussion",
            selection: "review this line",
          },
        })
        expect(selectedMr?.event?.type).toBe("selection-update")
        expect(selectedMr?.event?.blocks.map((block) => block.id)).toEqual([
          expect.stringMatching(/^page:selection:/),
        ])

        await RuntimeContextEvents.removeAll({ sessionID, projectID })
      },
    })
    RuntimePlatformAdapterRegistry.clearForTesting()
  })

  test("falls back and audits when page platform is disabled by current config", async () => {
    RuntimePlatformAdapterRegistry.clearForTesting()
    RuntimePlatformAdapterRegistry.markDisabled({
      id: "gitlab",
      templateIds: ["browser-gitlab", "gitlab-mr"],
    })

    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sessionID = `test_gitlab_disabled_${Date.now()}`
        const projectID = `project_${sessionID}`
        await RuntimeContextEvents.removeAll({ sessionID, projectID })

        const page = {
          platform: "gitlab",
          url: "https://gitlab.com/nine1/nine1bot/-/merge_requests/42",
          title: "Improve runtime",
          pageType: "gitlab-mr",
          objectKey: "gitlab.com:nine1/nine1bot:mr:42",
          visibleSummary: "MR overview",
        }
        const prepared = await RuntimeContextEvents.preparePageEvent({ sessionID, projectID, page })

        expect(prepared?.event?.source).toBe("page-context.gitlab.platform-disabled-by-current-config")
        expect(prepared?.event?.summary).toContain("platform-disabled-by-current-config")
        expect(prepared?.event?.audit).toEqual([
          expect.objectContaining({
            platform: "gitlab",
            reason: "platform-disabled-by-current-config",
          }),
        ])
        expect(prepared?.event?.blocks[0]).toMatchObject({
          id: "platform:gitlab",
          source: "page-context.gitlab.platform-disabled-by-current-config",
        })
        expect(String(prepared?.event?.blocks[0]?.content)).toContain("Platform adapter skipped")

        await RuntimeContextEvents.commitPageEvent({ sessionID, projectID, prepared: prepared! })
        const events = await RuntimeContextEvents.list({ sessionID, projectID })
        expect(events[0]?.audit?.[0]?.reason).toBe("platform-disabled-by-current-config")
        const blocks = RuntimeContextEvents.blocksFromEvents(events)
        expect(blocks[0]?.source).toBe("page-context.gitlab.platform-disabled-by-current-config")
        expect(String(blocks[0]?.content)).toContain("Platform adapter skipped")

        await RuntimeContextEvents.removeAll({ sessionID, projectID })
      },
    })

    RuntimePlatformAdapterRegistry.clearForTesting()
  })

  test("keeps old page history when a platform is disabled later", async () => {
    RuntimePlatformAdapterRegistry.clearForTesting()
    RuntimePlatformAdapterRegistry.register({
      id: "gitlab",
      matchPage: (page) => page.platform === "gitlab",
      normalizePage: (page) => page,
      blocksFromPage: (page, observedAt) => [
        {
          id: "platform:gitlab",
          layer: "platform",
          source: "page-context.gitlab",
          content: `GitLab page: ${page.title}`,
          lifecycle: "turn",
          visibility: "developer-toggle",
          enabled: true,
          priority: 65,
          mergeKey: page.objectKey,
          observedAt,
        },
      ],
    })

    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sessionID = `test_gitlab_history_${Date.now()}`
        const projectID = `project_${sessionID}`
        await RuntimeContextEvents.removeAll({ sessionID, projectID })

        const first = await RuntimeContextEvents.preparePageEvent({
          sessionID,
          projectID,
          page: {
            platform: "gitlab",
            pageType: "gitlab-repo",
            objectKey: "gitlab.com:nine1/nine1bot:repo",
            title: "nine1bot",
          },
        })
        await RuntimeContextEvents.commitPageEvent({ sessionID, projectID, prepared: first! })

        RuntimePlatformAdapterRegistry.markDisabled({
          id: "gitlab",
          templateIds: ["browser-gitlab", "gitlab-mr"],
        })
        const second = await RuntimeContextEvents.preparePageEvent({
          sessionID,
          projectID,
          page: {
            platform: "gitlab",
            pageType: "gitlab-mr",
            objectKey: "gitlab.com:nine1/nine1bot:mr:42",
            title: "Improve runtime",
          },
        })
        await RuntimeContextEvents.commitPageEvent({ sessionID, projectID, prepared: second! })

        const events = await RuntimeContextEvents.list({ sessionID, projectID })
        expect(events.map((event) => event.source)).toEqual([
          "page-context.gitlab",
          "page-context.gitlab.platform-disabled-by-current-config",
        ])

        await RuntimeContextEvents.removeAll({ sessionID, projectID })
      },
    })

    RuntimePlatformAdapterRegistry.clearForTesting()
  })
})
