import { describe, expect, test } from "bun:test"
import path from "path"
import { RuntimeGitLabPageAdapter } from "../../src/runtime/context/adapters/gitlab"
import { RuntimeContextEvents } from "../../src/runtime/context/events"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("GitLab page context adapter", () => {
  test("parses GitLab repository, file, tree, merge request, and issue URLs", () => {
    expect(RuntimeGitLabPageAdapter.parseGitLabUrl("https://gitlab.com/nine1/nine1bot")).toMatchObject({
      host: "gitlab.com",
      projectPath: "nine1/nine1bot",
      pageType: "gitlab-repo",
      objectKey: "gitlab.com:nine1/nine1bot:repo",
      route: "repo",
    })
    expect(RuntimeGitLabPageAdapter.parseGitLabUrl("https://gitlab.com/nine1/nine1bot/-/blob/main/src/index.ts")).toMatchObject({
      pageType: "gitlab-file",
      objectKey: "gitlab.com:nine1/nine1bot:file:main:src/index.ts",
      ref: "main",
      filePath: "src/index.ts",
      route: "blob",
    })
    expect(RuntimeGitLabPageAdapter.parseGitLabUrl("https://gitlab.com/nine1/nine1bot/-/tree/main/packages")).toMatchObject({
      pageType: "gitlab-repo",
      objectKey: "gitlab.com:nine1/nine1bot:tree:main:packages",
      ref: "main",
      treePath: "packages",
      route: "tree",
    })
    expect(RuntimeGitLabPageAdapter.parseGitLabUrl("https://gitlab.com/nine1/nine1bot/-/merge_requests/42")).toMatchObject({
      pageType: "gitlab-mr",
      objectKey: "gitlab.com:nine1/nine1bot:merge_request:42",
      iid: "42",
      route: "merge_request",
    })
    expect(RuntimeGitLabPageAdapter.parseGitLabUrl("https://gitlab.com/nine1/nine1bot/-/issues/7")).toMatchObject({
      pageType: "gitlab-issue",
      objectKey: "gitlab.com:nine1/nine1bot:issue:7",
      iid: "7",
      route: "issue",
    })
    expect(RuntimeGitLabPageAdapter.parseGitLabUrl("https://example.com/nine1/nine1bot/-/merge_requests/42")).toBeUndefined()
  })

  test("normalizes client payload and emits stable GitLab page blocks", () => {
    const payload = RuntimeContextEvents.normalizePagePayload({
      platform: "generic-browser",
      url: "https://gitlab.com/nine1/nine1bot/-/merge_requests/42",
      title: "Improve runtime",
      selection: "selected MR line",
      visibleSummary: "MR overview",
    })

    expect(payload).toMatchObject({
      platform: "gitlab",
      pageType: "gitlab-mr",
      objectKey: "gitlab.com:nine1/nine1bot:merge_request:42",
    })

    const blocks = RuntimeContextEvents.blocksFromPagePayload(payload, 1_000)
    expect(blocks.map((block) => block.id)).toEqual([
      "platform:gitlab",
      "page:gitlab-mr",
      expect.stringMatching(/^page:browser-selection:/),
    ])
    expect(blocks[1]?.content).toEqual(expect.stringContaining("Object key: gitlab.com:nine1/nine1bot:merge_request:42"))
  })

  test("deduplicates same-page events and records page transitions, content changes, and selection updates", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sessionID = `test_gitlab_${Date.now()}`
        const projectID = `project_${sessionID}`
        await RuntimeContextEvents.removeAll({ sessionID, projectID })

        const repo = {
          platform: "gitlab" as const,
          url: "https://gitlab.com/nine1/nine1bot",
          title: "nine1bot",
          visibleSummary: "Repository overview",
        }
        const mr = {
          platform: "gitlab" as const,
          url: "https://gitlab.com/nine1/nine1bot/-/merge_requests/42",
          title: "Improve runtime",
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
          expect.stringMatching(/^page:browser-selection:/),
        ])

        await RuntimeContextEvents.removeAll({ sessionID, projectID })
      },
    })
  })
})
