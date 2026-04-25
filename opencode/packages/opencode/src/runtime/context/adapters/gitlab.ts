import { RuntimeContextPipeline } from "@/runtime/context/pipeline"
import type { ContextBlock } from "@/runtime/protocol/agent-run-spec"

export namespace RuntimeGitLabPageAdapter {
  export type PagePayload = {
    platform: "gitlab" | "generic-browser" | "feishu"
    url?: string
    pageType?: string
    title?: string
    objectKey?: string
    selection?: string
    visibleSummary?: string
    raw?: Record<string, unknown>
  }

  export type GitLabUrlInfo = {
    host: string
    projectPath: string
    pageType: "gitlab-repo" | "gitlab-file" | "gitlab-mr" | "gitlab-issue"
    objectKey: string
    ref?: string
    filePath?: string
    treePath?: string
    iid?: string
    route: "repo" | "blob" | "tree" | "merge_request" | "issue"
  }

  export function adapt(page: PagePayload): PagePayload {
    const parsed = parseGitLabUrl(page.url)
    if (!parsed) return page

    return {
      ...page,
      platform: "gitlab",
      pageType: parsed.pageType,
      objectKey: parsed.objectKey,
      raw: {
        ...(page.raw ?? {}),
        gitlab: {
          ...(recordValue(page.raw?.["gitlab"]) ?? {}),
          host: parsed.host,
          projectPath: parsed.projectPath,
          route: parsed.route,
          ref: parsed.ref,
          filePath: parsed.filePath,
          treePath: parsed.treePath,
          iid: parsed.iid,
        },
      },
    }
  }

  export function parseGitLabUrl(input?: string): GitLabUrlInfo | undefined {
    if (!input) return undefined

    let url: URL
    try {
      url = new URL(input)
    } catch {
      return undefined
    }

    if (!isLikelyGitLabHost(url.hostname)) return undefined

    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent)
    if (parts.length === 0) return undefined

    const dashIndex = parts.indexOf("-")
    const projectParts = dashIndex === -1 ? parts : parts.slice(0, dashIndex)
    const projectPath = projectParts.join("/")
    if (!projectPath) return undefined

    if (dashIndex === -1) {
      return {
        host: url.hostname,
        projectPath,
        pageType: "gitlab-repo",
        objectKey: objectKey(url.hostname, projectPath, "repo"),
        route: "repo",
      }
    }

    const route = parts[dashIndex + 1]
    const rest = parts.slice(dashIndex + 2)

    if (route === "merge_requests" && rest[0]) {
      return {
        host: url.hostname,
        projectPath,
        pageType: "gitlab-mr",
        objectKey: objectKey(url.hostname, projectPath, "merge_request", rest[0]),
        route: "merge_request",
        iid: rest[0],
      }
    }

    if (route === "issues" && rest[0]) {
      return {
        host: url.hostname,
        projectPath,
        pageType: "gitlab-issue",
        objectKey: objectKey(url.hostname, projectPath, "issue", rest[0]),
        route: "issue",
        iid: rest[0],
      }
    }

    if (route === "blob" && rest[0]) {
      const ref = rest[0]
      const filePath = rest.slice(1).join("/")
      return {
        host: url.hostname,
        projectPath,
        pageType: "gitlab-file",
        objectKey: objectKey(url.hostname, projectPath, "file", ref, filePath),
        route: "blob",
        ref,
        filePath,
      }
    }

    if (route === "tree") {
      const ref = rest[0]
      const treePath = rest.slice(1).join("/")
      return {
        host: url.hostname,
        projectPath,
        pageType: "gitlab-repo",
        objectKey: objectKey(url.hostname, projectPath, "tree", ref, treePath),
        route: "tree",
        ref,
        treePath,
      }
    }

    return {
      host: url.hostname,
      projectPath,
      pageType: "gitlab-repo",
      objectKey: objectKey(url.hostname, projectPath, "repo"),
      route: "repo",
    }
  }

  export function blocksFromPage(page: PagePayload, observedAt: number): ContextBlock[] | undefined {
    if (page.platform !== "gitlab") return undefined
    const adapted = adapt(page)
    const gitlab = recordValue(adapted.raw?.["gitlab"])
    const pageType = adapted.pageType ?? "gitlab-repo"
    const pageKey = [adapted.platform, pageType, adapted.objectKey ?? adapted.url ?? adapted.title ?? "unknown"].join(":")
    const blocks: ContextBlock[] = [
      RuntimeContextPipeline.textBlock({
        id: "platform:gitlab",
        layer: "platform",
        source: "page-context.gitlab",
        content: renderPlatform(adapted, gitlab),
        lifecycle: "turn",
        visibility: "developer-toggle",
        priority: 65,
        mergeKey: pageKey,
        observedAt,
      }),
      RuntimeContextPipeline.textBlock({
        id: `page:${pageType}`,
        layer: "page",
        source: "page-context.gitlab",
        content: renderPage(adapted, gitlab),
        lifecycle: "turn",
        visibility: "developer-toggle",
        priority: 60,
        mergeKey: pageKey,
        observedAt,
      }),
    ]

    if (adapted.selection?.trim()) {
      blocks.push(
        RuntimeContextPipeline.textBlock({
          id: `page:browser-selection:${RuntimeContextPipeline.textDigest(adapted.selection).slice(0, 12)}`,
          layer: "page",
          source: "page-context.gitlab.selection",
          content: `Current page selection:\n${adapted.selection.trim()}`,
          lifecycle: "turn",
          visibility: "developer-toggle",
          priority: 55,
          mergeKey: `${pageKey}:selection`,
          observedAt,
        }),
      )
    }

    return blocks
  }

  function renderPlatform(page: PagePayload, gitlab?: Record<string, unknown>) {
    return [
      "Platform: GitLab",
      page.url ? `URL: ${page.url}` : undefined,
      stringValue(gitlab?.["host"]) ? `Host: ${gitlab?.["host"]}` : undefined,
      stringValue(gitlab?.["projectPath"]) ? `Project path: ${gitlab?.["projectPath"]}` : undefined,
    ]
      .filter(Boolean)
      .join("\n")
  }

  function renderPage(page: PagePayload, gitlab?: Record<string, unknown>) {
    return [
      page.pageType ? `Page type: ${page.pageType}` : undefined,
      page.title ? `Title: ${page.title}` : undefined,
      page.objectKey ? `Object key: ${page.objectKey}` : undefined,
      stringValue(gitlab?.["route"]) ? `GitLab route: ${gitlab?.["route"]}` : undefined,
      stringValue(gitlab?.["iid"]) ? `IID: ${gitlab?.["iid"]}` : undefined,
      stringValue(gitlab?.["ref"]) ? `Ref: ${gitlab?.["ref"]}` : undefined,
      stringValue(gitlab?.["filePath"]) ? `File path: ${gitlab?.["filePath"]}` : undefined,
      stringValue(gitlab?.["treePath"]) ? `Tree path: ${gitlab?.["treePath"]}` : undefined,
      page.visibleSummary ? `Visible summary:\n${page.visibleSummary}` : undefined,
    ]
      .filter(Boolean)
      .join("\n")
  }

  function isLikelyGitLabHost(hostname: string) {
    const normalized = hostname.toLowerCase()
    return normalized === "gitlab.com" || normalized.includes("gitlab")
  }

  function objectKey(host: string, projectPath: string, ...parts: Array<string | undefined>) {
    return [host, projectPath, ...parts.filter((part) => part && part.trim())].join(":")
  }

  function recordValue(input: unknown): Record<string, unknown> | undefined {
    return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined
  }

  function stringValue(input: unknown) {
    return typeof input === "string" && input.trim() ? input : undefined
  }
}
