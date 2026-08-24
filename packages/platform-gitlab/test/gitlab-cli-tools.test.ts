import { describe, expect, test } from 'bun:test'
import type { PlatformToolCallContext } from '@nine1bot/platform-protocol'
import {
  createGitLabCliPlatformTools,
  gitLabCliToolIds,
  type GitLabCliRunner,
} from '../src/cli'

describe('GitLab CLI platform tools', () => {
  test('registers only declared GitLab-owned wrapper tools', () => {
    const tools = createGitLabCliPlatformTools()

    expect(tools.map((tool) => tool.id)).toEqual(Object.values(gitLabCliToolIds))
    expect(tools.every((tool) => tool.catalogVisibility === 'declared-only')).toBe(true)
    expect(tools.every((tool) => tool.id.startsWith('gitlab_'))).toBe(true)
    expect(tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true)
  })

  test('rejects extra fields, unsafe targets, and oversized publish bodies', () => {
    const tools = toolsById(createGitLabCliPlatformTools())

    expect(() => tools.gitlab_cli_status?.parse({ unexpected: true })).toThrow()
    expect(() => tools.gitlab_cli_mr_snapshot?.parse({
      target: {
        kind: 'merge_request',
        host: 'gitlab.example.com/path',
        projectPath: 'root/project',
        iid: '42',
      },
    })).toThrow()
    expect(() => tools.gitlab_cli_mr_snapshot?.parse({
      target: {
        kind: 'merge_request',
        host: '*.gitlab.example.com',
        projectPath: 'root/project',
        iid: '42',
      },
    })).toThrow()
    expect(() => tools.gitlab_cli_project_snapshot?.parse({
      target: {
        kind: 'project',
        host: 'gitlab.example.com',
        projectPath: '../root/project',
      },
    })).toThrow()
    expect(() => tools.gitlab_cli_project_snapshot?.parse({
      target: {
        kind: 'project',
        projectPath: 'root/project',
      },
    })).toThrow()
    expect(() => tools.gitlab_cli_publish_review_note?.parse({
      target: {
        kind: 'merge_request',
        host: 'gitlab.example.com',
        projectPath: 'root/project',
        iid: '42',
      },
      body: '你'.repeat(7_000),
    })).toThrow()
  })

  test('scopes publish permission to the target without carrying the note body', () => {
    const tool = requiredTool(createGitLabCliPlatformTools(), gitLabCliToolIds.publishReviewNote)
    const parsed = tool.parse({
      target: {
        kind: 'merge_request',
        host: 'gitlab.example.com',
        projectPath: 'root/project',
        iid: '42',
      },
      body: 'Private review body',
    })

    const permission = tool.permission?.(parsed)
    expect(permission).toEqual({
      permission: 'gitlab_cli_publish_review_note',
      patterns: ['gitlab.example.com:root/project!42'],
    })
    expect(JSON.stringify(permission)).not.toContain('Private review body')
  })

  test('uses one target-scoped read permission and enforces configured hosts', () => {
    const tools = createGitLabCliPlatformTools({ allowedHosts: ['gitlab.example.com'] })
    const project = requiredTool(tools, gitLabCliToolIds.projectSnapshot)
    const parsed = project.parse({
      target: { kind: 'project', host: 'gitlab.example.com', projectPath: 'root/project' },
    })

    expect(project.permission?.(parsed)).toEqual({
      permission: 'gitlab_cli_read',
      patterns: ['gitlab.example.com:root/project'],
    })
    expect(() => project.parse({
      target: { kind: 'project', host: 'gitlab.other.example', projectPath: 'root/project' },
    })).toThrow()
    expect(() => project.parse({
      target: { kind: 'project', projectPath: 'root/project' },
    })).toThrow()
  })

  test('resolves targets without invoking GitLab CLI', async () => {
    const tool = requiredTool(createGitLabCliPlatformTools({
      runner: async () => {
        throw new Error('runner must not be called')
      },
    }), gitLabCliToolIds.resolveTarget)

    const result = await tool.execute(tool.parse({
      url: 'https://gitlab.example.com/root/project/-/merge_requests/42',
    }), callContext())

    expect(result.status).toBe('ok')
    expect(okData(result)).toMatchObject({
      target: {
        kind: 'merge_request',
        host: 'gitlab.example.com',
        projectPath: 'root/project',
        iid: '42',
      },
    })

    const invalid = await tool.execute(tool.parse({ text: '../root/project!42' }), callContext())
    expect(invalid).toMatchObject({
      status: 'failed',
      code: 'gitlab-target-invalid',
      recoverable: false,
    })
  })

  test('passes session cwd and cancellation signal through authenticated read calls', async () => {
    const calls: Array<{ args: string[]; cwd?: string; signal?: AbortSignal }> = []
    const runner: GitLabCliRunner = async (args, options) => {
      calls.push({ args, cwd: options?.cwd, signal: options?.signal })
      const key = args.join(' ')
      if (key === '--version') return runResult(args, 'glab version 1.45.0')
      if (key === 'auth status --hostname gitlab.example.com') return runResult(args, 'gitlab.example.com\n Logged in as @nine1bot')
      if (key === 'api projects/root%2Fproject --hostname gitlab.example.com') {
        return runResult(args, JSON.stringify({
          path_with_namespace: 'root/project',
          default_branch: 'main',
        }))
      }
      return runResult(args, '', 'unexpected command', 1)
    }
    const controller = new AbortController()
    const context = callContext(controller.signal)
    const tool = requiredTool(
      createGitLabCliPlatformTools({ runner, statusCacheTtlMs: 10_000 }),
      gitLabCliToolIds.projectSnapshot,
    )

    const result = await tool.execute(tool.parse({
      target: {
        kind: 'project',
        host: 'gitlab.example.com',
        projectPath: 'root/project',
      },
    }), context)

    expect(result.status).toBe('ok')
    expect(calls.map((call) => call.args.join(' '))).toEqual([
      '--version',
      'auth status --hostname gitlab.example.com',
      'api projects/root%2Fproject --hostname gitlab.example.com',
    ])
    expect(calls.every((call) => call.cwd === context.directory)).toBe(true)
    expect(calls.every((call) => call.signal === controller.signal)).toBe(true)
  })

  test('scopes authentication status caching by directory and target host', async () => {
    const calls: string[] = []
    const runner: GitLabCliRunner = async (args) => {
      const command = args.join(' ')
      calls.push(command)
      if (command === '--version') return runResult(args, 'glab version 1.45.0')
      if (command.startsWith('auth status --hostname gitlab.')) {
        const host = command.split(' ').at(-1)
        return runResult(args, `${host}\n Logged in as @nine1bot`)
      }
      if (command.startsWith('api projects/root%2Fproject --hostname gitlab.')) {
        return runResult(args, JSON.stringify({ path_with_namespace: 'root/project' }))
      }
      return runResult(args, '', `unexpected command: ${command}`, 1)
    }
    const tool = requiredTool(
      createGitLabCliPlatformTools({ runner, statusCacheTtlMs: 60_000 }),
      gitLabCliToolIds.projectSnapshot,
    )
    const context = callContext()

    for (const host of ['gitlab.one.example', 'gitlab.two.example', 'gitlab.one.example']) {
      const result = await tool.execute(tool.parse({
        target: { kind: 'project', host, projectPath: 'root/project' },
      }), context)
      expect(result.status).toBe('ok')
    }

    expect(calls.filter((command) => command.startsWith('auth status'))).toEqual([
      'auth status --hostname gitlab.one.example',
      'auth status --hostname gitlab.two.example',
    ])
  })

  test('keeps the status tool as a current-context diagnostic cache', async () => {
    const calls: string[] = []
    const runner: GitLabCliRunner = async (args) => {
      const command = args.join(' ')
      calls.push(command)
      if (command === '--version') return runResult(args, 'glab version 1.45.0')
      if (command === 'auth status') return runResult(args, 'gitlab.example.com\n Logged in as @nine1bot')
      return runResult(args, '', `unexpected command: ${command}`, 1)
    }
    const tools = createGitLabCliPlatformTools({ runner, statusCacheTtlMs: 60_000 })
    const statusTool = requiredTool(tools, gitLabCliToolIds.status)
    const projectTool = requiredTool(tools, gitLabCliToolIds.projectSnapshot)
    const context = callContext()

    const status = await statusTool.execute(statusTool.parse({}), context)
    const availability = await projectTool.availability?.({
      sessionId: context.sessionId,
      directory: context.directory,
      agent: context.agent,
      templateIds: context.templateIds,
    })

    expect(status.status).toBe('ok')
    expect(availability).toMatchObject({ status: 'available' })
    expect(calls).toEqual(['--version', 'auth status'])
  })

  test('returns auth-required without attempting API calls when glab is logged out', async () => {
    const calls: string[] = []
    const runner: GitLabCliRunner = async (args) => {
      const key = args.join(' ')
      calls.push(key)
      if (key === '--version') return runResult(args, 'glab version 1.45.0')
      if (key === 'auth status --hostname gitlab.example.com') return runResult(args, '', 'not logged in', 1)
      return runResult(args, '', 'unexpected API call', 1)
    }
    const tool = requiredTool(createGitLabCliPlatformTools({ runner }), gitLabCliToolIds.mrSnapshot)

    const result = await tool.execute(tool.parse({
      target: { kind: 'merge_request', host: 'gitlab.example.com', projectPath: 'root/project', iid: '42' },
    }), callContext())

    expect(result).toMatchObject({
      status: 'auth-required',
      code: 'gitlab-cli-auth-required',
      recoverable: true,
    })
    expect(calls).toEqual(['--version', 'auth status --hostname gitlab.example.com'])
  })

  test('allows publishing dry-run previews without GitLab CLI availability', async () => {
    const calls: string[] = []
    const tool = requiredTool(createGitLabCliPlatformTools({
      runner: async (args) => {
        calls.push(args.join(' '))
        return runResult(args, '', 'glab is missing', 1)
      },
    }), gitLabCliToolIds.publishReviewNote)

    const parsed = tool.parse({
      target: { kind: 'merge_request', host: 'gitlab.example.com', projectPath: 'root/project', iid: '42' },
      body: 'Preview only',
      dryRun: true,
    })
    const result = await tool.execute(parsed, callContext())

    expect(result.status).toBe('ok')
    expect(tool.permission?.(parsed)).toEqual({
      permission: 'gitlab_cli_preview',
      patterns: ['gitlab.example.com:root/project!42'],
    })
    expect(await tool.availability?.({
      sessionId: 'session-cli-test',
      directory: 'C:/workspace/project',
      agent: 'platform.gitlab.assistant',
      templateIds: ['gitlab-mr'],
    })).toMatchObject({ status: 'available' })
    expect(okData(result)).toMatchObject({
      dryRun: true,
      published: false,
      bodyPreview: 'Preview only',
    })
    expect(calls).toEqual([])
  })

  test('summarizes bounded diffs unless raw diff is explicitly requested', async () => {
    const runner: GitLabCliRunner = async (args) => {
      const key = args.join(' ')
      if (key === '--version') return runResult(args, 'glab version 1.45.0')
      if (key === 'auth status --hostname gitlab.example.com') return runResult(args, 'gitlab.example.com\n Logged in as @nine1bot')
      if (key === 'api projects/root%2Fproject/merge_requests/42/changes --hostname gitlab.example.com') {
        return runResult(args, JSON.stringify({
          changes: [{
            old_path: 'src/app.ts',
            new_path: 'src/app.ts',
            diff: '@@ -1 +1 @@\n-old\n+new\n',
          }],
        }))
      }
      return runResult(args, '', 'unexpected command', 1)
    }
    const tool = requiredTool(createGitLabCliPlatformTools({ runner }), gitLabCliToolIds.mrDiff)
    const context = callContext()
    const input = {
      target: { kind: 'merge_request' as const, host: 'gitlab.example.com', projectPath: 'root/project', iid: '42' },
    }

    const summary = okData(await tool.execute(tool.parse(input), context))
    const raw = okData(await tool.execute(tool.parse({ ...input, includeDiff: true }), context))

    expect(summary).toMatchObject({
      manifest: {
        files: [{ newPath: 'src/app.ts', diffBytes: 22, hunkCount: 1 }],
      },
      diffSummary: { rawDiffIncluded: false },
    })
    expect(JSON.stringify(summary)).not.toContain('@@ -1 +1 @@')
    expect(raw).toMatchObject({
      manifest: {
        files: [{ diff: '@@ -1 +1 @@\n-old\n+new\n' }],
      },
    })
  })

  test('sanitizes CLI errors before returning stable platform failures', async () => {
    const runner: GitLabCliRunner = async (args) => {
      const key = args.join(' ')
      if (key === '--version') return runResult(args, 'glab version 1.45.0')
      if (key === 'auth status --hostname gitlab.example.com') return runResult(args, 'gitlab.example.com\n Logged in as @nine1bot')
      return runResult(args, '', 'token=glpat-secret command failed', 1)
    }
    const tool = requiredTool(createGitLabCliPlatformTools({ runner }), gitLabCliToolIds.projectSnapshot)

    const result = await tool.execute(tool.parse({
      target: { kind: 'project', host: 'gitlab.example.com', projectPath: 'root/project' },
    }), callContext())

    expect(result).toMatchObject({
      status: 'failed',
      code: 'gitlab-cli-command-failed',
      recoverable: true,
    })
    expect(JSON.stringify(result)).not.toContain('glpat-secret')
  })

  test('marks uncertain write failures as non-recoverable to prevent duplicate comments', async () => {
    const runner: GitLabCliRunner = async (args) => {
      const key = args.join(' ')
      if (key === '--version') return runResult(args, 'glab version 1.45.0')
      if (key === 'auth status --hostname gitlab.example.com') return runResult(args, 'gitlab.example.com\n Logged in as @nine1bot')
      return runResult(args, '', 'request timed out after the server accepted data', 1)
    }
    const tool = requiredTool(createGitLabCliPlatformTools({ runner }), gitLabCliToolIds.publishReviewNote)

    const result = await tool.execute(tool.parse({
      target: { kind: 'merge_request', host: 'gitlab.example.com', projectPath: 'root/project', iid: '42' },
      body: 'Publish once',
    }), callContext())

    expect(result).toMatchObject({
      status: 'failed',
      code: 'gitlab-cli-write-outcome-uncertain',
      recoverable: false,
      message: expect.stringContaining('Do not retry automatically'),
    })
  })
})

function toolsById(tools: ReturnType<typeof createGitLabCliPlatformTools>) {
  return Object.fromEntries(tools.map((tool) => [tool.id, tool]))
}

function requiredTool(tools: ReturnType<typeof createGitLabCliPlatformTools>, id: string) {
  const tool = tools.find((candidate) => candidate.id === id)
  if (!tool) throw new Error(`Missing tool: ${id}`)
  return tool
}

function callContext(signal = new AbortController().signal): PlatformToolCallContext {
  return {
    sessionId: 'session-cli-test',
    projectId: 'project-cli-test',
    directory: 'C:/workspace/project',
    agent: 'build',
    templateIds: ['browser-gitlab', 'gitlab-mr'],
    messageId: 'message-cli-test',
    callId: 'call-cli-test',
    signal,
    async reportProgress() {},
  }
}

function runResult(args: string[], stdout: string, stderr = '', exitCode = 0) {
  return {
    command: 'glab',
    args,
    stdout,
    stderr,
    exitCode,
  }
}

function okData(result: Awaited<ReturnType<ReturnType<typeof createGitLabCliPlatformTools>[number]['execute']>>) {
  if (result.status !== 'ok') throw new Error(`Expected ok result, got ${result.status}`)
  const parsed = JSON.parse(result.output) as { ok: boolean; data: unknown }
  expect(parsed.ok).toBe(true)
  return parsed.data
}
