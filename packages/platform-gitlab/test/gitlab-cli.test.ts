import { describe, expect, test } from 'bun:test'
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  createGitLabCliClient,
  createGlabRunner,
  getGitLabCliStatus,
  gitLabCliMaxOutputBytes,
  resolveGitLabTarget,
  resolveGitLabTargets,
  type GitLabCliRunner,
} from '../src/cli'

describe('GitLab CLI capability layer', () => {
  test('resolves glab once from trusted PATH without selecting the repository tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nine1bot-glab-path-'))
    const repository = join(root, 'repository')
    const repositoryBin = join(repository, 'node_modules', '.bin')
    const trustedBin = join(root, 'trusted-bin')
    const executableName = process.platform === 'win32' ? 'glab.exe' : 'glab'
    const repositoryCandidate = join(repositoryBin, executableName)
    const trustedCandidate = join(trustedBin, executableName)
    try {
      await mkdir(repositoryBin, { recursive: true })
      await mkdir(trustedBin)
      await copyFile(process.execPath, repositoryCandidate)
      await copyFile(process.execPath, trustedCandidate)
      if (process.platform !== 'win32') {
        await chmod(repositoryCandidate, 0o755)
        await chmod(trustedCandidate, 0o755)
      }
      const trustedExecutable = await realpath(trustedCandidate)
      const executions: Array<{ executable: string; cwd?: string }> = []
      const runner = createGlabRunner({
        env: { PATH: [repositoryBin, trustedBin].join(delimiter) },
        execute: async (request) => {
          executions.push({ executable: request.executable, cwd: request.cwd })
          return { stdout: 'glab version 1.45.0', stderr: '', exitCode: 0 }
        },
      })

      await runner(['--version'], { cwd: repository })
      await rm(trustedCandidate)
      await runner(['auth', 'status'], { cwd: repository })

      expect(executions).toEqual([
        { executable: trustedExecutable, cwd: repository },
        { executable: trustedExecutable, cwd: repository },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects a cached glab path when a later repository cwd contains it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nine1bot-glab-cached-cwd-'))
    const repository = join(root, 'repository')
    const repositoryBin = join(repository, 'tools')
    const otherRepository = join(root, 'other-repository')
    const executableName = process.platform === 'win32' ? 'glab.exe' : 'glab'
    const repositoryCandidate = join(repositoryBin, executableName)
    try {
      await mkdir(repositoryBin, { recursive: true })
      await mkdir(otherRepository)
      await copyFile(process.execPath, repositoryCandidate)
      if (process.platform !== 'win32') await chmod(repositoryCandidate, 0o755)
      const executions: string[] = []
      const runner = createGlabRunner({
        env: { PATH: repositoryBin },
        execute: async (request) => {
          executions.push(request.executable)
          return { stdout: 'glab version 1.45.0', stderr: '', exitCode: 0 }
        },
      })

      const first = await runner(['--version'], { cwd: otherRepository })
      const second = await runner(['--version'], { cwd: repository })

      expect(first.exitCode).toBe(0)
      expect(second).toMatchObject({
        exitCode: 1,
        stderr: 'GitLab CLI executable was not found in trusted PATH.',
      })
      expect(executions).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('passes a controlled child environment without GitLab or CI authentication overrides', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nine1bot-glab-env-'))
    const repository = join(root, 'repository')
    const trustedBin = join(root, 'trusted-bin')
    const executableName = process.platform === 'win32' ? 'glab.exe' : 'glab'
    const trustedCandidate = join(trustedBin, executableName)
    try {
      await mkdir(repository)
      await mkdir(trustedBin)
      await copyFile(process.execPath, trustedCandidate)
      if (process.platform !== 'win32') await chmod(trustedCandidate, 0o755)

      const sourceEnv: NodeJS.ProcessEnv = {
        PATH: trustedBin,
        HOME: join(root, 'home'),
        USERPROFILE: join(root, 'profile'),
        CI_PROJECT_PATH: 'root/project',
        GITLAB_TOKEN: 'glpat-primary-secret',
        gitlab_access_token: 'glpat-case-insensitive-secret',
        OAUTH_TOKEN: 'oauth-secret',
        GITLAB_HOST: 'gitlab.wrong.example',
        GITLAB_URI: 'https://gitlab.wrong.example',
        GITLAB_API_HOST: 'api.gitlab.wrong.example',
        GL_HOST: 'gitlab.wrong.example',
        GLAB_TOKEN: 'future-glab-secret',
        CI_JOB_TOKEN: 'ci-job-secret',
        CI_BUILD_TOKEN: 'ci-build-secret',
        CI_JOB_JWT: 'ci-jwt-secret',
        CI_REGISTRY_PASSWORD: 'ci-registry-secret',
        CI_REPOSITORY_URL: 'https://gitlab-ci-token:embedded-secret@gitlab.wrong.example/root/project.git',
        GLAB_ENABLE_CI_AUTOLOGIN: 'true',
        GITLAB_CI: 'true',
        CI_SERVER_FQDN: 'gitlab.wrong.example',
        CI_SERVER_HOST: 'gitlab.wrong.example',
        CI_SERVER_PROTOCOL: 'https',
        CI_SERVER_SHELL_SSH_HOST: 'ssh.gitlab.wrong.example',
        CI_SERVER_URL: 'https://gitlab.wrong.example',
        CI_API_V4_URL: 'https://gitlab.wrong.example/api/v4',
      }
      let childEnv: NodeJS.ProcessEnv | undefined
      const runner = createGlabRunner({
        env: sourceEnv,
        execute: async (request) => {
          childEnv = request.env
          return { stdout: '{}', stderr: '', exitCode: 0 }
        },
      })

      const result = await runner(['api', 'projects/root%2Fproject', '--hostname', 'gitlab.target.example'], {
        cwd: repository,
      })
      const normalizedEnv = Object.fromEntries(
        Object.entries(childEnv ?? {}).map(([key, value]) => [key.toUpperCase(), value]),
      )

      expect(normalizedEnv).toMatchObject({
        PATH: trustedBin,
        HOME: join(root, 'home'),
        USERPROFILE: join(root, 'profile'),
        CI_PROJECT_PATH: 'root/project',
      })
      for (const key of [
        'GITLAB_TOKEN',
        'GITLAB_ACCESS_TOKEN',
        'OAUTH_TOKEN',
        'GITLAB_HOST',
        'GITLAB_URI',
        'GITLAB_API_HOST',
        'GL_HOST',
        'GLAB_TOKEN',
        'CI_JOB_TOKEN',
        'CI_BUILD_TOKEN',
        'CI_JOB_JWT',
        'CI_REGISTRY_PASSWORD',
        'CI_REPOSITORY_URL',
        'GLAB_ENABLE_CI_AUTOLOGIN',
        'GITLAB_CI',
        'CI_SERVER_FQDN',
        'CI_SERVER_HOST',
        'CI_SERVER_PROTOCOL',
        'CI_SERVER_SHELL_SSH_HOST',
        'CI_SERVER_URL',
        'CI_API_V4_URL',
      ]) {
        expect(normalizedEnv).not.toHaveProperty(key)
      }
      expect(JSON.stringify(result)).not.toContain('secret')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('parses GitLab CLI status without exposing raw auth details', async () => {
    const status = await getGitLabCliStatus({
      runner: runnerFrom({
        '--version': 'glab version 1.45.0 (abcd)',
        'auth status': 'gitlab.com\n  Logged in to gitlab.com as @nine1bot\n',
      }),
    })

    expect(status).toEqual({
      available: true,
      version: '1.45.0',
      authenticated: true,
      host: 'gitlab.com',
      user: 'nine1bot',
      message: 'GitLab CLI is authenticated for gitlab.com as nine1bot.',
    })
  })

  test('checks authentication status for the explicit target host', async () => {
    const calls: string[] = []
    const status = await getGitLabCliStatus({
      host: 'gitlab.target.example',
      runner: async (args) => {
        const command = args.join(' ')
        calls.push(command)
        if (command === '--version') return runResult(args, 'glab version 1.45.0')
        if (command === 'auth status --hostname gitlab.target.example') {
          return runResult(args, 'gitlab.target.example\n  Logged in to gitlab.target.example as @nine1bot\n')
        }
        return runResult(args, '', `unexpected command: ${command}`, 1)
      },
    })

    expect(status).toMatchObject({
      available: true,
      authenticated: true,
      host: 'gitlab.target.example',
      user: 'nine1bot',
    })
    expect(calls).toEqual([
      '--version',
      'auth status --hostname gitlab.target.example',
    ])
  })

  test('reports installed but unauthenticated GitLab CLI', async () => {
    const status = await getGitLabCliStatus({
      runner: runnerFrom({
        '--version': 'glab version 1.45.0',
        'auth status': { exitCode: 1, stderr: 'not logged in' },
      }),
    })

    expect(status).toMatchObject({
      available: true,
      authenticated: false,
      version: '1.45.0',
      message: expect.stringContaining('not authenticated'),
    })
  })

  test('bounds parsed GitLab CLI identity fields', async () => {
    const status = await getGitLabCliStatus({
      runner: runnerFrom({
        '--version': `glab version ${'1'.repeat(1_000)}`,
        'auth status': `Logged in to ${'g'.repeat(1_000)} as @${'u'.repeat(1_000)}`,
      }),
    })

    expect(status).toEqual({
      available: true,
      authenticated: true,
      message: 'GitLab CLI is authenticated.',
    })
  })

  test('redacts GitLab credentials from CLI status diagnostics', async () => {
    const status = await getGitLabCliStatus({
      runner: runnerFrom({
        '--version': 'glab version 1.45.0',
        'auth status': {
          exitCode: 1,
          stderr: 'token=glpat-secret Authorization: Bearer another-secret',
        },
      }),
    })

    expect(status.message).not.toContain('glpat-secret')
    expect(status.message).not.toContain('another-secret')
  })

  test('resolves GitLab targets from URL, page context, and shorthand text', () => {
    expect(resolveGitLabTarget({
      url: 'https://gitlab.com/root/project/-/merge_requests/42',
    })).toEqual({
      kind: 'merge_request',
      host: 'gitlab.com',
      projectPath: 'root/project',
      iid: '42',
    })

    expect(resolveGitLabTarget({
      url: 'https://gitlab.com/root/project/-/commit/abc123',
    })).toEqual({
      kind: 'commit',
      host: 'gitlab.com',
      projectPath: 'root/project',
      sha: 'abc123',
    })

    expect(resolveGitLabTarget({
      url: 'https://gitlab.example.com:8443/root/project/-/merge_requests/8',
    })).toEqual({
      kind: 'merge_request',
      host: 'gitlab.example.com:8443',
      projectPath: 'root/project',
      iid: '8',
    })

    expect(resolveGitLabTarget({
      url: 'https://example.com/root/project/-/commit/abc123',
    })).toBeUndefined()

    expect(resolveGitLabTarget({
      page: {
        platform: 'gitlab',
        pageType: 'gitlab-mr',
        raw: {
          gitlab: {
            host: 'gitlab.example.com',
            projectPath: 'root/project',
            route: 'merge_request',
            iid: '7',
          },
        },
      },
    })).toEqual({
      kind: 'merge_request',
      host: 'gitlab.example.com',
      projectPath: 'root/project',
      iid: '7',
    })

    expect(resolveGitLabTargets({
      text: 'review root/project!9 and https://gitlab.com/root/project/-/merge_requests/10',
    })).toEqual([
      {
        kind: 'merge_request',
        host: 'gitlab.com',
        projectPath: 'root/project',
        iid: '10',
      },
      {
        kind: 'merge_request',
        projectPath: 'root/project',
        iid: '9',
      },
    ])
  })

  test('loads project and merge request snapshots through bounded glab api calls', async () => {
    const calls: string[] = []
    const client = createGitLabCliClient({
      runner: apiRunner(calls, {
        'api projects/root%2Fproject --hostname gitlab.example.com': {
          id: 3,
          name: 'project',
          path_with_namespace: 'root/project',
          default_branch: 'main',
          web_url: 'https://gitlab.example.com/root/project',
        },
        'api projects/root%2Fproject/merge_requests/42 --hostname gitlab.example.com': {
          id: 42,
          title: 'Improve runtime',
          state: 'opened',
          source_branch: 'feature/runtime',
          target_branch: 'main',
          web_url: 'https://gitlab.example.com/root/project/-/merge_requests/42',
          author: { username: 'alice' },
        },
      }),
    })

    await expect(client.projectSnapshot({
      kind: 'project',
      host: 'gitlab.example.com',
      projectPath: 'root/project',
    })).resolves.toMatchObject({
      id: 3,
      pathWithNamespace: 'root/project',
      defaultBranch: 'main',
    })

    await expect(client.mrSnapshot({
      kind: 'merge_request',
      host: 'gitlab.example.com',
      projectPath: 'root/project',
      iid: '42',
    })).resolves.toMatchObject({
      title: 'Improve runtime',
      author: 'alice',
      sourceBranch: 'feature/runtime',
      targetBranch: 'main',
    })

    expect(calls).toEqual([
      'api projects/root%2Fproject --hostname gitlab.example.com',
      'api projects/root%2Fproject/merge_requests/42 --hostname gitlab.example.com',
    ])
  })

  test('builds bounded diff context from GitLab CLI API output', async () => {
    const client = createGitLabCliClient({
      runner: apiRunner([], {
        'api projects/root%2Fproject/merge_requests/42/changes': {
          changes: [
            {
              old_path: 'src/app.ts',
              new_path: 'src/app.ts',
              diff: '@@ -1 +1 @@\n-old\n+new\n',
            },
            {
              old_path: 'big.bin',
              new_path: 'big.bin',
              too_large: true,
            },
          ],
        },
      }),
    })

    const diff = await client.mrDiff({
      target: {
        kind: 'merge_request',
        projectPath: 'root/project',
        iid: '42',
      },
      maxFiles: 10,
      maxBytes: 1000,
    })

    expect(diff.manifest.files.map((file) => file.newPath)).toEqual(['src/app.ts'])
    expect(diff.manifest.skipped).toEqual([{ path: 'big.bin', reason: 'too-large' }])
    expect(diff.coverage).toBe('Included 1 changed file(s); skipped 1.')
  })

  test('reports GitLab overflow as omitted coverage even when returned files fit the local budget', async () => {
    const client = createGitLabCliClient({
      runner: apiRunner([], {
        'api projects/root%2Fproject/merge_requests/42/changes': {
          overflow: true,
          changes: [{
            old_path: 'src/app.ts',
            new_path: 'src/app.ts',
            diff: '@@ -1 +1 @@\n-old\n+new\n',
          }],
        },
      }),
    })

    const diff = await client.mrDiff({
      target: { kind: 'merge_request', projectPath: 'root/project', iid: '42' },
    })

    expect(diff.truncated).toBe(true)
    expect(diff.manifest.skipped).toContainEqual({
      path: '[additional changed files omitted by GitLab]',
      reason: 'too-large',
    })
    expect(diff.coverage).toBe('Included 1 changed file(s); skipped 1.')
  })

  test('bounds commit diff retrieval to maxFiles plus one and reports additional coverage', async () => {
    const calls: string[] = []
    const client = createGitLabCliClient({
      runner: apiRunner(calls, {
        'api projects/root%2Fproject/repository/commits/abc123/diff?page=1&per_page=3 --hostname gitlab.example.com': [
          {
            old_path: 'src/one.ts',
            new_path: 'src/one.ts',
            diff: '@@ -1 +1 @@\n-old one\n+new one\n',
          },
          {
            old_path: 'src/two.ts',
            new_path: 'src/two.ts',
            diff: '@@ -1 +1 @@\n-old two\n+new two\n',
          },
          {
            old_path: 'src/three.ts',
            new_path: 'src/three.ts',
            diff: '@@ -1 +1 @@\n-old three\n+new three\n',
          },
        ],
      }),
    })

    const diff = await client.commitDiff({
      target: {
        kind: 'commit',
        host: 'gitlab.example.com',
        projectPath: 'root/project',
        sha: 'abc123',
      },
      maxFiles: 2,
      maxBytes: 1_000,
    })

    expect(calls).toEqual([
      'api projects/root%2Fproject/repository/commits/abc123/diff?page=1&per_page=3 --hostname gitlab.example.com',
    ])
    expect(diff.manifest.files.map((file) => file.newPath)).toEqual(['src/one.ts', 'src/two.ts'])
    expect(diff.manifest.stats).toMatchObject({
      fileCount: 3,
      includedFileCount: 2,
      skippedFileCount: 1,
      truncated: true,
    })
    expect(diff.truncated).toBe(true)
    expect(diff.coverage).toBe(
      'Included 2 changed file(s); skipped at least 1. Additional commit diff files were omitted after the local 2-file limit.',
    )
  })

  test('reports GitLab commit diff limits as truncated coverage', async () => {
    const client = createGitLabCliClient({
      runner: apiRunner([], {
        'api projects/root%2Fproject/repository/commits/abc123/diff?page=1&per_page=5 --hostname gitlab.example.com': [
          {
            old_path: 'src/collapsed.ts',
            new_path: 'src/collapsed.ts',
            diff: '',
            collapsed: true,
          },
        ],
      }),
    })

    const diff = await client.commitDiff({
      target: {
        kind: 'commit',
        host: 'gitlab.example.com',
        projectPath: 'root/project',
        sha: 'abc123',
      },
      maxFiles: 4,
    })

    expect(diff.manifest.skipped).toEqual([{ path: 'src/collapsed.ts', reason: 'too-large' }])
    expect(diff.manifest.stats.truncated).toBe(true)
    expect(diff.truncated).toBe(true)
    expect(diff.coverage).toBe(
      'Included 0 changed file(s); skipped 1. GitLab diff limits omitted content for one or more commit files.',
    )
  })

  test('builds repository health context with important file previews and budget', async () => {
    const client = createGitLabCliClient({
      runner: apiRunner([], {
        'api projects/root%2Fproject': {
          id: 3,
          name: 'project',
          path_with_namespace: 'root/project',
          default_branch: 'main',
        },
        'api projects/root%2Fproject/repository/tree?per_page=100&ref=main': [
          { path: 'README.md', type: 'blob' },
          { path: 'package.json', type: 'blob' },
          { path: 'src', type: 'tree' },
        ],
        'api projects/root%2Fproject/repository/files/README.md?ref=main': {
          encoding: 'base64',
          content: Buffer.from('# Project\n').toString('base64'),
        },
        'api projects/root%2Fproject/repository/files/package.json?ref=main': {
          encoding: 'base64',
          content: Buffer.from('{"type":"module"}').toString('base64'),
        },
      }),
    })

    const context = await client.repositoryHealthContext({
      target: {
        kind: 'project',
        projectPath: 'root/project',
      },
      maxFiles: 3,
      maxBytes: 100,
    })

    expect(context.rootTree).toEqual([
      { path: 'README.md', type: 'file' },
      { path: 'package.json', type: 'file' },
      { path: 'src', type: 'tree' },
    ])
    expect(context.rootTreeTruncated).toBe(false)
    expect(context.readme).toBe('# Project\n')
    expect(context.importantFiles.map((file) => file.path)).toEqual(['README.md', 'package.json'])
    expect(context.skipped).toEqual([])
    expect(context.coverage).toEqual('Read 2/2 important file preview(s) from root/project at main. Skipped 0. Byte budget used 27/100.')
  })

  test('counts repository preview budgets in UTF-8 bytes without splitting code points', async () => {
    const client = createGitLabCliClient({
      runner: apiRunner([], {
        'api projects/root%2Fproject': {
          path_with_namespace: 'root/project',
          default_branch: 'main',
        },
        'api projects/root%2Fproject/repository/tree?per_page=100&ref=main': [
          { path: 'README.md', type: 'blob' },
        ],
        'api projects/root%2Fproject/repository/files/README.md?ref=main': {
          encoding: 'base64',
          content: Buffer.from('你你').toString('base64'),
        },
      }),
    })

    const context = await client.repositoryHealthContext({
      target: { kind: 'project', projectPath: 'root/project' },
      maxBytes: 4,
    })

    expect(context.readme).toBe('你')
    expect(context.coverage).toContain('Byte budget used 3/4.')
    expect(context.skipped).toContainEqual({
      path: 'README.md',
      reason: 'content-preview-truncated-by-byte-budget',
    })
  })

  test('reports repository health skipped reasons for limits, truncation, and read failures', async () => {
    const client = createGitLabCliClient({
      runner: apiRunner([], {
        'api projects/root%2Fproject': {
          id: 3,
          name: 'project',
          path_with_namespace: 'root/project',
          default_branch: 'main',
        },
        'api projects/root%2Fproject/repository/tree?per_page=100&ref=main': [
          { path: 'README.md', type: 'blob' },
          { path: 'package.json', type: 'blob' },
        ],
        'api projects/root%2Fproject/repository/files/README.md?ref=main': {
          encoding: 'base64',
          content: Buffer.from('1234567890').toString('base64'),
        },
      }),
    })

    const context = await client.repositoryHealthContext({
      target: {
        kind: 'project',
        projectPath: 'root/project',
      },
      paths: ['README.md', 'missing.md', 'package.json'],
      maxFiles: 2,
      maxBytes: 4,
    })

    expect(context.importantFiles).toEqual([{
      path: 'README.md',
      reason: 'project overview',
      contentPreview: '1234',
    }])
    expect(context.skipped).toEqual([
      { path: 'package.json', reason: 'max-files-limit' },
      { path: 'README.md', reason: 'content-preview-truncated-by-byte-budget' },
      { path: 'missing.md', reason: 'byte-budget-exhausted' },
    ])
    expect(context.coverage).toEqual('Read 1/3 important file preview(s) from root/project at main. Skipped 3. Byte budget used 4/4.')
  })

  test('publishes review notes through fixed GitLab CLI API calls', async () => {
    const calls: string[] = []
    const requestBodies: Array<string | undefined> = []
    const client = createGitLabCliClient({
      runner: apiRunner(calls, {
        'api projects/root%2Fproject/merge_requests/42/notes --method POST --input - --hostname gitlab.example.com': {
          id: 9,
          web_url: 'https://gitlab.example.com/root/project/-/merge_requests/42#note_9',
        },
        'api projects/root%2Fproject/repository/commits/abc123/comments --method POST --input - --hostname gitlab.example.com': {
          id: 11,
        },
      }, requestBodies),
    })

    await expect(client.publishReviewNote({
      target: {
        kind: 'merge_request',
        host: 'gitlab.example.com',
        projectPath: 'root/project',
        iid: '42',
      },
      body: 'Looks good',
    })).resolves.toMatchObject({
      dryRun: false,
      published: true,
      noteId: 9,
      webUrl: 'https://gitlab.example.com/root/project/-/merge_requests/42#note_9',
      bodyPreview: 'Looks good',
    })

    await expect(client.publishReviewNote({
      target: {
        kind: 'commit',
        host: 'gitlab.example.com',
        projectPath: 'root/project',
        sha: 'abc123',
      },
      body: 'Commit note',
    })).resolves.toMatchObject({
      dryRun: false,
      published: true,
      noteId: 11,
      bodyPreview: 'Commit note',
    })

    expect(calls).toEqual([
      'api projects/root%2Fproject/merge_requests/42/notes --method POST --input - --hostname gitlab.example.com',
      'api projects/root%2Fproject/repository/commits/abc123/comments --method POST --input - --hostname gitlab.example.com',
    ])
    expect(requestBodies).toEqual([
      JSON.stringify({ body: 'Looks good' }),
      JSON.stringify({ note: 'Commit note' }),
    ])
  })

  test('keeps publish note dry runs away from GitLab CLI', async () => {
    const calls: string[] = []
    const client = createGitLabCliClient({ runner: apiRunner(calls, {}) })

    await expect(client.publishReviewNote({
      target: {
        kind: 'merge_request',
        projectPath: 'root/project',
        iid: '42',
      },
      body: 'Draft review note',
      dryRun: true,
    })).resolves.toMatchObject({
      dryRun: true,
      published: false,
      bodyPreview: 'Draft review note',
    })

    expect(calls).toEqual([])
  })

  test('publishes MR inline discussions through fixed GitLab CLI API calls', async () => {
    const calls: string[] = []
    const requestBodies: Array<string | undefined> = []
    const client = createGitLabCliClient({
      runner: apiRunner(calls, {
        'api projects/root%2Fproject/merge_requests/42/discussions --method POST --input - --hostname gitlab.example.com': {
          id: 'd'.repeat(1_000),
        },
      }, requestBodies),
    })

    await expect(client.publishReviewDiscussion({
      target: {
        kind: 'merge_request',
        host: 'gitlab.example.com',
        projectPath: 'root/project',
        iid: '42',
      },
      body: 'Inline note',
      position: {
        position_type: 'text',
        base_sha: 'base',
        start_sha: 'start',
        head_sha: 'head',
        old_path: 'src/app.ts',
        new_path: 'src/app.ts',
        new_line: 12,
      },
    })).resolves.toMatchObject({
      dryRun: false,
      published: true,
      discussionId: undefined,
      bodyPreview: 'Inline note',
    })

    expect(calls).toEqual([
      'api projects/root%2Fproject/merge_requests/42/discussions --method POST --input - --hostname gitlab.example.com',
    ])
    expect(requestBodies).toEqual([
      JSON.stringify({
        body: 'Inline note',
        position: {
          position_type: 'text',
          base_sha: 'base',
          start_sha: 'start',
          head_sha: 'head',
          old_path: 'src/app.ts',
          new_path: 'src/app.ts',
          new_line: 12,
        },
      }),
    ])
  })

  test('propagates cancellation signals to every GitLab CLI call', async () => {
    const controller = new AbortController()
    let receivedSignal: AbortSignal | undefined
    const client = createGitLabCliClient({
      signal: controller.signal,
      runner: async (args, options) => {
        receivedSignal = options?.signal
        return {
          command: 'glab',
          args,
          stdout: JSON.stringify({ path_with_namespace: 'root/project' }),
          stderr: '',
          exitCode: 0,
        }
      },
    })

    await client.projectSnapshot({ kind: 'project', projectPath: 'root/project' })
    expect(receivedSignal).toBe(controller.signal)
  })

  test('rejects oversized CLI output before JSON parsing', async () => {
    const client = createGitLabCliClient({
      runner: async (args) => ({
        command: 'glab',
        args,
        stdout: 'x'.repeat(gitLabCliMaxOutputBytes + 1),
        stderr: '',
        exitCode: 0,
      }),
    })

    await expect(client.projectSnapshot({
      kind: 'project',
      projectPath: 'root/project',
    })).rejects.toMatchObject({
      code: 'output_too_large',
    })
  })

  test('classifies target-host authentication failures without exposing credentials', async () => {
    const client = createGitLabCliClient({
      runner: async (args) => ({
        command: 'glab',
        args,
        stdout: '',
        stderr: '401 Unauthorized: run glab auth login; token=glpat-secret',
        exitCode: 1,
      }),
    })

    const error = await client.projectSnapshot({
      kind: 'project',
      host: 'gitlab.other.example',
      projectPath: 'root/project',
    }).catch((failure) => failure)
    expect(error).toMatchObject({
      code: 'glab_not_authenticated',
    })
    expect(String(error?.message)).not.toContain('glpat-secret')
  })

  test('does not turn cancellation during repository preview reads into skipped files', async () => {
    const controller = new AbortController()
    const client = createGitLabCliClient({
      signal: controller.signal,
      runner: async (args) => {
        const key = args.join(' ')
        if (key === 'api projects/root%2Fproject') {
          return runResult(args, JSON.stringify({
            path_with_namespace: 'root/project',
            default_branch: 'main',
          }))
        }
        if (key === 'api projects/root%2Fproject/repository/tree?per_page=100&ref=main') {
          return runResult(args, JSON.stringify([{ path: 'README.md', type: 'blob' }]))
        }
        controller.abort()
        return {
          ...runResult(args, '', 'cancelled', 1),
          cancelled: true,
        }
      },
    })

    await expect(client.repositoryHealthContext({
      target: { kind: 'project', projectPath: 'root/project' },
    })).rejects.toMatchObject({
      code: 'command_cancelled',
    })
  })

  test('bounds snapshot text and large diff manifests before wrapper serialization', async () => {
    const longPath = `${'nested/'.repeat(80)}app.ts`
    const changes = Array.from({ length: 200 }, (_value, index) => ({
      old_path: `${index}-${longPath}`,
      new_path: `${index}-${longPath}`,
      diff: '@@ -1 +1 @@\n-old\n+new\n',
    }))
    const client = createGitLabCliClient({
      runner: apiRunner([], {
        'api projects/root%2Fproject': {
          path_with_namespace: 'root/project',
          description: '你'.repeat(2_000),
        },
        'api projects/root%2Fproject/merge_requests/42/changes': { changes },
      }),
    })

    const project = await client.projectSnapshot({ kind: 'project', projectPath: 'root/project' })
    const diff = await client.mrDiff({
      target: { kind: 'merge_request', projectPath: 'root/project', iid: '42' },
      maxFiles: 1,
      maxBytes: 100,
    })

    expect(Buffer.byteLength(project.description || '', 'utf8')).toBeLessThanOrEqual(2_000)
    expect(diff.manifest.stats.fileCount).toBe(200)
    expect(diff.manifest.stats.skippedFileCount).toBe(200)
    expect(diff.manifest.files).toEqual([])
    expect(diff.manifest.skipped).toContainEqual({
      path: '[200 additional changed file(s) omitted]',
      reason: 'budget-exceeded',
    })
    expect(diff.manifest.files.length + diff.manifest.skipped.length).toBeLessThanOrEqual(49)
    expect(diff.manifest.files.every((file) => Buffer.byteLength(file.newPath, 'utf8') <= 256)).toBe(true)
    expect(diff.manifest.skipped.every((file) => Buffer.byteLength(file.path, 'utf8') <= 256)).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(diff), 'utf8')).toBeLessThan(64 * 1_024)
  })

  test('bounds repository tree paths independently from file preview budgets', async () => {
    const longPath = `${'nested/'.repeat(80)}file.ts`
    const client = createGitLabCliClient({
      runner: apiRunner([], {
        'api projects/root%2Fproject': {
          path_with_namespace: 'root/project',
          default_branch: 'main',
        },
        'api projects/root%2Fproject/repository/tree?per_page=100&ref=main': Array.from(
          { length: 100 },
          (_value, index) => ({ path: `${index}-${longPath}`, type: 'blob' }),
        ),
      }),
    })

    const context = await client.repositoryHealthContext({
      target: { kind: 'project', projectPath: 'root/project' },
      maxBytes: 100,
    })

    expect(context.rootTree).toEqual([])
    expect(context.rootTreeTruncated).toBe(true)
    expect(context.coverage).toContain('Root tree was truncated to 60 entries.')
    expect(context.rootTree.every((item) => Buffer.byteLength(item.path, 'utf8') <= 256)).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(context), 'utf8')).toBeLessThan(64 * 1_024)
  })
})

function runnerFrom(outputs: Record<string, string | { stdout?: string; stderr?: string; exitCode?: number }>): GitLabCliRunner {
  return async (args) => {
    const key = args.join(' ')
    const output = outputs[key]
    if (output === undefined) {
      return { command: 'glab', args, stdout: '', stderr: `unexpected command: ${key}`, exitCode: 1 }
    }
    if (typeof output === 'string') {
      return { command: 'glab', args, stdout: output, stderr: '', exitCode: 0 }
    }
    return {
      command: 'glab',
      args,
      stdout: output.stdout ?? '',
      stderr: output.stderr ?? '',
      exitCode: output.exitCode ?? 0,
    }
  }
}

function apiRunner(
  calls: string[],
  responses: Record<string, unknown>,
  requestBodies: Array<string | undefined> = [],
): GitLabCliRunner {
  return async (args, options) => {
    const key = args.join(' ')
    calls.push(key)
    requestBodies.push(options?.stdin)
    if (!(key in responses)) {
      return { command: 'glab', args, stdout: '', stderr: `unexpected command: ${key}`, exitCode: 1 }
    }
    return {
      command: 'glab',
      args,
      stdout: JSON.stringify(responses[key]),
      stderr: '',
      exitCode: 0,
    }
  }
}

function runResult(args: string[], stdout: string, stderr = '', exitCode = 0) {
  return { command: 'glab', args, stdout, stderr, exitCode }
}
