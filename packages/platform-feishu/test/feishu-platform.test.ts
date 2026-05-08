import { describe, expect, test } from 'bun:test'
import {
  buildFeishuPageContextPayload,
  createFeishuPlatformAdapter,
  FEISHU_IM_DEFAULT_BUFFER_MS,
  FEISHU_IM_DEFAULT_BUSY_TEXT,
  FEISHU_IM_DEFAULT_MAX_BUFFER_MS,
  FEISHU_IM_DEFAULT_REPLY_TIMEOUT_MS,
  FEISHU_IM_DEFAULT_STREAMING_CARD_MAX_CHARS,
  FEISHU_IM_DEFAULT_STREAMING_CARD_UPDATE_MS,
  feishuPlatformContribution,
  feishuTemplateIdsForPage,
  normalizeFeishuIMConfig,
  parseFeishuUrl,
} from '../src'
import {
  clearFeishuIMReplyRuntimeSummaryForTesting,
  createFeishuIMBackgroundServices,
} from '../src/im'
import {
  clearFeishuIMRuntimeSnapshotForTesting,
  setFeishuIMRuntimeTestHooksForTesting,
} from '../src/im/background-runtime'
import {
  enrichFeishuPageContext,
  getFeishuAuthStatus,
  getFeishuCliVersion,
  parseVersion,
  readFeishuContextEnrichmentSettings,
  resolveFeishuCliPath,
  runFeishuCliJsonWithFile,
  type FeishuCliRunner,
} from '../src/node'
import type { PlatformAdapterContext } from '@nine1bot/platform-protocol'
import { join } from 'node:path'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  FEISHU_CURRENT_PAGE_SKILL,
  inspectFeishuSkillSources,
  resolveOfficialSkillsDirectory,
} from '../src/skills'

describe('Feishu platform adapter package', () => {
  test('parses Phase 1 Feishu URL routes', () => {
    expect(parseFeishuUrl('https://gdut-topview.feishu.cn/docx/GeVqd0rdho2WbPxLCyWcXI8nnpg')).toMatchObject({
      host: 'gdut-topview.feishu.cn',
      tenant: 'gdut-topview',
      brand: 'feishu',
      pageType: 'feishu-docx',
      objectKey: 'feishu:docx:GeVqd0rdho2WbPxLCyWcXI8nnpg',
      route: 'docx',
      objType: 'docx',
    })
    expect(parseFeishuUrl('https://gdut-topview.feishu.cn/wiki/GKw9w6TOliwkBXkqO8UcphiDnUg')).toMatchObject({
      pageType: 'feishu-wiki',
      objectKey: 'feishu:wiki:GKw9w6TOliwkBXkqO8UcphiDnUg',
      route: 'wiki',
      objType: 'wiki',
    })
    expect(parseFeishuUrl('https://www.feishu.cn/sheets/shtcnI8QzfNsZk8B1RKJhtOEyHh')).toMatchObject({
      host: 'www.feishu.cn',
      pageType: 'feishu-sheet',
      objectKey: 'feishu:sheet:shtcnI8QzfNsZk8B1RKJhtOEyHh',
      route: 'sheets',
      objType: 'sheet',
    })
    expect(parseFeishuUrl('https://gdut-topview.feishu.cn/base/GOerbRw0LaPdCpsnfT1cMg39ntb?table=tblikn3kcM2UbD4L&view=vewXxBNTOK')).toMatchObject({
      pageType: 'feishu-bitable',
      objectKey: 'feishu:bitable:GOerbRw0LaPdCpsnfT1cMg39ntb',
      route: 'base',
      objType: 'bitable',
      tableId: 'tblikn3kcM2UbD4L',
      viewId: 'vewXxBNTOK',
      query: {
        table: 'tblikn3kcM2UbD4L',
        view: 'vewXxBNTOK',
      },
    })
    expect(parseFeishuUrl('https://gdut-topview.feishu.cn/drive/folder/WpF7fSL5PlZYUkdfxBqcQ6KJnSC')).toMatchObject({
      pageType: 'feishu-folder',
      objectKey: 'feishu:folder:WpF7fSL5PlZYUkdfxBqcQ6KJnSC',
      route: 'drive/folder',
      objType: 'folder',
    })
    expect(parseFeishuUrl('https://gdut-topview.feishu.cn/slides/PKkosoB9RlwVFcdKj42cBRk2n3e')).toMatchObject({
      pageType: 'feishu-slides',
      objectKey: 'feishu:slides:PKkosoB9RlwVFcdKj42cBRk2n3e',
      route: 'slides',
      objType: 'slides',
    })
    expect(parseFeishuUrl('https://gdut-topview.feishu.cn/space/home')).toMatchObject({
      pageType: 'feishu-unknown',
      objectKey: 'feishu:unknown:gdut-topview.feishu.cn:space/home',
      route: 'unknown',
      objType: 'unknown',
    })
    expect(parseFeishuUrl('https://example.com/wiki/GKw9w6TOliwkBXkqO8UcphiDnUg')).toBeUndefined()
  })

  test('builds browser page payloads with stable Feishu identity', () => {
    const payload = buildFeishuPageContextPayload({
      url: 'https://gdut-topview.feishu.cn/base/GOerbRw0LaPdCpsnfT1cMg39ntb?table=tblikn3kcM2UbD4L&view=vewXxBNTOK',
      title: 'Project Base',
      selection: ' selected text ',
      visibleSummary: 'Base overview',
    })

    expect(payload).toMatchObject({
      platform: 'feishu',
      pageType: 'feishu-bitable',
      objectKey: 'feishu:bitable:GOerbRw0LaPdCpsnfT1cMg39ntb',
      selection: 'selected text',
      visibleSummary: 'Base overview',
      raw: {
        feishu: {
          host: 'gdut-topview.feishu.cn',
          tenant: 'gdut-topview',
          route: 'base',
          token: 'GOerbRw0LaPdCpsnfT1cMg39ntb',
          objType: 'bitable',
          tableId: 'tblikn3kcM2UbD4L',
          viewId: 'vewXxBNTOK',
        },
      },
    })

    expect(buildFeishuPageContextPayload({
      url: 'https://example.com/page',
      title: 'Example',
    })).toMatchObject({
      platform: 'generic-browser',
      url: 'https://example.com/page',
    })
  })

  test('contributes template ids, context blocks, and builtin resources', () => {
    const page = {
      platform: 'feishu',
      url: 'https://gdut-topview.feishu.cn/wiki/GKw9w6TOliwkBXkqO8UcphiDnUg',
      title: 'Wiki Doc',
    }
    const adapter = createFeishuPlatformAdapter()
    const templateIds = feishuTemplateIdsForPage(page)

    expect(templateIds).toEqual(['browser-feishu', 'feishu-wiki'])
    expect(adapter.inferTemplateIds({ entry: { platform: 'feishu' }, page })).toEqual(templateIds)
    const templateBlocks = adapter.templateContextBlocks({ templateIds, page })
    expect(templateBlocks.map((block) => block.source)).toEqual([
      'template.browser-feishu',
      'template.feishu-wiki',
    ])
    expect(templateBlocks[0]?.content).toEqual(expect.stringContaining('official lark-cli'))
    expect(templateBlocks[0]?.content).toEqual(expect.stringContaining('dry-run first'))
    expect(templateBlocks[0]?.content).toEqual(expect.stringContaining('existing Nine1Bot permissions'))
    expect(templateBlocks[1]?.content).toEqual(expect.stringContaining('official lark-cli'))

    const resources = adapter.resourceContributions({ templateIds })
    expect(resources?.builtinTools.enabledGroups).toEqual(['feishu-context'])
    expect(resources?.skills.skills).toEqual([FEISHU_CURRENT_PAGE_SKILL])
  })

  test('documents write guidance without adding a CLI wrapper boundary', async () => {
    const skillText = await Bun.file(join(import.meta.dir, '..', 'skills', FEISHU_CURRENT_PAGE_SKILL, 'SKILL.md')).text()

    expect(skillText).toEqual(expect.stringContaining('## Write Operations'))
    expect(skillText).toEqual(expect.stringContaining('Target object'))
    expect(skillText).toEqual(expect.stringContaining('Impact scope'))
    expect(skillText).toEqual(expect.stringContaining('--dry-run'))
    expect(skillText).toEqual(expect.stringContaining('Do not invent dry-run behavior'))
    expect(skillText).toEqual(expect.stringContaining('Do not build a Nine1Bot-specific wrapper'))
    expect(skillText).toEqual(expect.stringContaining('never use a wiki node token directly as a docx/file token for writes'))
    expect(skillText).toEqual(expect.stringContaining('do not require a separate Nine1Bot high-risk API confirmation layer'))
    expect(skillText).toEqual(expect.stringContaining('Do not ask the user to copy access tokens'))
  })

  test('discovers companion and official skill directories', async () => {
    await withTempDir(async (officialDirectory) => {
      await writeSkill(officialDirectory, 'lark-doc')
      await writeSkill(officialDirectory, 'lark-drive')
      await writeSkill(officialDirectory, 'custom-skill')

      const status = inspectFeishuSkillSources({ officialSkillsDirectory: officialDirectory })

      expect(status.companion).toMatchObject({
        exists: true,
        readable: true,
        skillCount: 1,
        skills: [FEISHU_CURRENT_PAGE_SKILL],
      })
      expect(status.official).toMatchObject({
        exists: true,
        readable: true,
        skillCount: 2,
        skills: ['lark-doc', 'lark-drive'],
      })
      expect(resolveOfficialSkillsDirectory({ officialSkillsDirectory: officialDirectory })).toBe(status.official.directory)
    })
  })

  test('builds stable runtime page context blocks and truncates selection', () => {
    const adapter = createFeishuPlatformAdapter()
    const page = buildFeishuPageContextPayload({
      url: 'https://gdut-topview.feishu.cn/docx/GeVqd0rdho2WbPxLCyWcXI8nnpg',
      title: 'Docx',
      selection: ` ${'a'.repeat(5000)} `,
      visibleSummary: 'Doc overview',
    })

    expect(page.selection?.length).toBe(4003)
    expect(page.selection?.endsWith('...')).toBe(true)
    const normalized = adapter.normalizePage(page)
    expect(normalized).toMatchObject({
      platform: 'feishu',
      pageType: 'feishu-docx',
      objectKey: 'feishu:docx:GeVqd0rdho2WbPxLCyWcXI8nnpg',
    })

    const blocks = adapter.blocksFromPage(page, 1_000) ?? []
    expect(blocks.map((block) => block.id)).toEqual([
      'platform:feishu',
      'page:feishu-docx',
      expect.stringMatching(/^page:browser-selection:/),
    ])
    expect(blocks[1]?.content).toEqual(expect.stringContaining('Object key: feishu:docx:GeVqd0rdho2WbPxLCyWcXI8nnpg'))
  })

  test('reports missing CLI without reading CLI private token storage', async () => {
    const ctx: PlatformAdapterContext = {
      platformId: 'feishu',
      enabled: true,
      settings: {},
      features: {},
      env: { PATH: '' },
      secrets: {
        async get() { return undefined },
        async set() {},
        async delete() {},
        async has() { return false },
      },
      audit: {
        write() {},
      },
    }

    const status = await feishuPlatformContribution.getStatus?.(ctx)
    expect(status).toMatchObject({ status: 'missing' })
    expect(status?.cards).toContainEqual(expect.objectContaining({ id: 'cli', value: 'missing' }))
    expect(status?.cards).toContainEqual(expect.objectContaining({ id: 'auth', value: 'unknown' }))
    expect(status?.cards).toContainEqual(expect.objectContaining({ id: 'context', value: 'auto' }))
    expect(status?.cards).toContainEqual(expect.objectContaining({ id: 'companion', value: FEISHU_CURRENT_PAGE_SKILL }))
    expect(status?.cards).toContainEqual(expect.objectContaining({ id: 'skills' }))
  })

  test('declares first-run defaults and placeholders in platform descriptor', () => {
    const fields = new Map(
      feishuPlatformContribution.descriptor.config?.sections
        .flatMap((section) => section.fields)
        .map((field) => [field.key, field]) ?? [],
    )
    const imDefaults = normalizeFeishuIMConfig({})
    const enrichmentDefaults = readFeishuContextEnrichmentSettings({})

    expect(fields.get('cliPath')).toMatchObject({
      placeholder: expect.stringContaining('PATH'),
    })
    expect(fields.get('officialSkillsDirectory')).toMatchObject({
      placeholder: expect.stringContaining('~/.agents/skills'),
    })
    expect(fields.get('contextEnrichment')).toMatchObject({
      defaultValue: enrichmentDefaults.contextEnrichment,
    })
    expect(fields.get('metadataTimeoutMs')).toMatchObject({
      defaultValue: enrichmentDefaults.metadataTimeoutMs,
    })

    expect(fields.get('imEnabled')).toMatchObject({ defaultValue: false })
    expect(fields.get('imDefaultAppId')).toMatchObject({
      placeholder: expect.stringContaining('enabling IM'),
    })
    expect(fields.get('imDefaultAppId')?.defaultValue).toBeUndefined()
    expect(fields.get('imDefaultAppSecret')).toMatchObject({
      secret: true,
      placeholder: expect.stringContaining('enabling IM'),
    })
    expect(fields.get('imDefaultAppSecret')?.defaultValue).toBeUndefined()
    expect(fields.get('imDefaultDirectory')).toMatchObject({
      placeholder: expect.stringContaining('current project directory'),
    })
    expect(fields.get('imDefaultDirectory')?.defaultValue).toBeUndefined()

    expect(fields.get('imConnectionMode')).toMatchObject({ defaultValue: imDefaults.connectionMode })
    expect(fields.get('imDmPolicy')).toMatchObject({ defaultValue: imDefaults.policy.dmPolicy })
    expect(fields.get('imGroupPolicy')).toMatchObject({ defaultValue: imDefaults.policy.groupPolicy })
    expect(fields.get('imAllowFrom')).toMatchObject({ defaultValue: imDefaults.policy.allowFrom })
    expect(fields.get('imReplyMode')).toMatchObject({ defaultValue: imDefaults.policy.replyMode })
    expect(fields.get('imReplyPresentation')).toMatchObject({ defaultValue: imDefaults.policy.replyPresentation })
    expect(fields.get('imReplyTimeoutMs')).toMatchObject({ defaultValue: FEISHU_IM_DEFAULT_REPLY_TIMEOUT_MS })
    expect(fields.get('imStreamingCardUpdateMs')).toMatchObject({ defaultValue: FEISHU_IM_DEFAULT_STREAMING_CARD_UPDATE_MS })
    expect(fields.get('imStreamingCardMaxChars')).toMatchObject({ defaultValue: FEISHU_IM_DEFAULT_STREAMING_CARD_MAX_CHARS })
    expect(fields.get('imMessageBufferMs')).toMatchObject({ defaultValue: FEISHU_IM_DEFAULT_BUFFER_MS })
    expect(fields.get('imMaxBufferMs')).toMatchObject({ defaultValue: FEISHU_IM_DEFAULT_MAX_BUFFER_MS })
    expect(fields.get('imBusyRejectText')).toMatchObject({ defaultValue: FEISHU_IM_DEFAULT_BUSY_TEXT })
    expect(fields.get('imAccounts')).toMatchObject({ defaultValue: [] })
  })

  test('registers Feishu IM reply settings in platform descriptor', () => {
    const imSection = feishuPlatformContribution.descriptor.config?.sections.find((section) => section.id === 'im')
    expect(imSection?.fields.map((field) => field.key)).toContain('imReplyPresentation')
    expect(imSection?.fields.map((field) => field.key)).toContain('imReplyTimeoutMs')
    expect(imSection?.fields.map((field) => field.key)).toContain('imStreamingCardUpdateMs')
    expect(imSection?.fields.map((field) => field.key)).toContain('imStreamingCardMaxChars')
    expect(imSection?.fields.find((field) => field.key === 'imReplyPresentation')).toMatchObject({
      type: 'select',
      options: ['auto', 'text', 'card', 'streaming-card'],
    })
  })

  test('merges compact IM runtime cards into platform status details', async () => {
    clearFeishuIMReplyRuntimeSummaryForTesting()
    clearFeishuIMRuntimeSnapshotForTesting()
    setFeishuIMRuntimeTestHooksForTesting({
      createGateway: createAutoConnectedGatewayFactory(),
    })

    const ctx: PlatformAdapterContext = {
      platformId: 'feishu',
      enabled: true,
      settings: {
        imEnabled: true,
        imDefaultAppId: 'cli_xxx',
        imDefaultAppSecret: {
          provider: 'nine1bot-local',
          key: 'platform:feishu:default:imDefaultAppSecret',
        },
      },
      features: {},
      env: { PATH: '' },
      secrets: {
        async get() { return 'secret' },
        async set() {},
        async delete() {},
        async has() { return true },
      },
      audit: {
        write() {},
      },
    }

    const services = createFeishuIMBackgroundServices(ctx)
    expect(services).toHaveLength(1)
    const handle = await services[0]!.start({
      ...ctx,
      localUrl: 'http://127.0.0.1:4096',
    })

    try {
      const status = await feishuPlatformContribution.getStatus?.(ctx)
      const ids = status?.cards?.map((card) => card.id) ?? []

      expect(ids).toEqual(expect.arrayContaining([
        'cli',
        'auth',
        'context',
        'companion',
        'skills',
        'im-runtime',
        'im-gateway-state',
        'im-restart-attempts',
        'im-accounts',
      ]))
      expect(ids).not.toContain('im-last-reply-error')
      expect(ids).not.toContain('im-last-card-update-error')
      expect(ids).not.toContain('im-last-streaming-fallback')
      expect(ids).not.toContain('im-streaming-fallbacks')
      expect(ids).not.toContain('im-buffer')
      expect(ids).not.toContain('im-reply')
    } finally {
      await handle.stop()
      clearFeishuIMReplyRuntimeSummaryForTesting()
      clearFeishuIMRuntimeSnapshotForTesting()
    }
  })

  test('handles official skills directory actions without mutating CLI auth state', async () => {
    await withTempDir(async (officialDirectory) => {
      await writeSkill(officialDirectory, 'lark-doc')
      const ctx: PlatformAdapterContext = {
        platformId: 'feishu',
        enabled: true,
        settings: {},
        features: {},
        env: { PATH: '' },
        secrets: {
          async get() { return undefined },
          async set() {},
          async delete() {},
          async has() { return false },
        },
        audit: {
          write() {},
        },
      }

      const configure = await feishuPlatformContribution.handleAction?.('skills.configureDirectory', {
        directory: officialDirectory,
      }, ctx)
      expect(configure).toMatchObject({
        status: 'ok',
        updatedSettings: {
          officialSkillsDirectory: officialDirectory,
        },
        updatedStatus: {
          status: 'missing',
        },
        data: {
          official: {
            skillCount: 1,
            skills: ['lark-doc'],
          },
        },
      })

      const refresh = await feishuPlatformContribution.handleAction?.('skills.refreshOfficialDirectory', undefined, {
        ...ctx,
        settings: { officialSkillsDirectory: officialDirectory },
      })
      expect(refresh).toMatchObject({
        status: 'ok',
        data: {
          official: {
            skillCount: 1,
            skills: ['lark-doc'],
          },
        },
      })
      expect(refresh?.updatedSettings).toBeUndefined()

      const clear = await feishuPlatformContribution.handleAction?.('skills.configureDirectory', {
        directory: '',
      }, {
        ...ctx,
        settings: { officialSkillsDirectory: officialDirectory },
      })
      expect(clear).toMatchObject({
        status: 'ok',
        updatedSettings: {
          officialSkillsDirectory: null,
        },
      })

      await withTempDir(async (missingParent) => {
        const missing = await feishuPlatformContribution.handleAction?.('skills.configureDirectory', {
          directory: join(missingParent, 'missing'),
        }, ctx)
        expect(missing).toMatchObject({
          status: 'failed',
          data: {
            official: {
              exists: false,
            },
          },
        })
      })
    })
  })

  test('uses verified lark-cli commands and parses auth states', async () => {
    const runner: FeishuCliRunner = async (_command, args) => {
      if (args[0] === '--version') {
        return { exitCode: 0, stdout: 'lark-cli version 1.0.23\n', stderr: '' }
      }
      if (args.join(' ') === 'auth status') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            identity: 'user:ou_123',
            tokenStatus: 'needs_refresh',
            userName: 'Demo User',
          }),
          stderr: '',
        }
      }
      return { exitCode: 1, stdout: '', stderr: 'unexpected command' }
    }

    await expect(getFeishuCliVersion({ cliPath: 'lark-cli', runner })).resolves.toMatchObject({
      version: '1.0.23',
    })
    await expect(getFeishuAuthStatus({ cliPath: 'lark-cli', runner })).resolves.toMatchObject({
      state: 'authenticated',
      tokenStatus: 'needs_refresh',
    })
  })

  test('resolves explicit bare lark-cli command names through PATH on Windows', async () => {
    await withTempDir(async (directory) => {
      const command = join(directory, 'lark-cli.cmd')
      await writeFile(command, '@echo off\n', 'utf8')

      expect(resolveFeishuCliPath('lark-cli', {
        OS: 'Windows_NT',
        PATH: directory,
      })).toBe(command)
    })
  })

  test('parses lark-cli versions without regex backtracking', () => {
    expect(parseVersion('lark-cli version 1.0.23\n')).toBe('1.0.23')
    expect(parseVersion('lark-cli 1.0.23-beta.1+build.5\n')).toBe('1.0.23-beta.1+build.5')
    expect(parseVersion(`lark-cli version ${'9'.repeat(10_000)}\n`)).toBe(`lark-cli version ${'9'.repeat(10_000)}`)
  })

  test('passes only whitelisted environment variables to lark-cli', async () => {
    const originalSecret = process.env.NINE1BOT_SECRET
    const originalApiKey = process.env.OPENAI_API_KEY
    process.env.NINE1BOT_SECRET = 'process-secret'
    process.env.OPENAI_API_KEY = 'process-api-key'

    try {
      let seenEnv: Record<string, string | undefined> | undefined
      const runner: FeishuCliRunner = async (_command, _args, options) => {
        seenEnv = options.env
        return { exitCode: 0, stdout: 'lark-cli version 1.0.23\n', stderr: '' }
      }

      await getFeishuCliVersion({
        cliPath: 'lark-cli',
        env: {
          PATH: 'C:\\bin',
          TEMP: 'C:\\tmp',
          HTTP_PROXY: 'http://proxy.local',
          NINE1BOT_SECRET: 'override-secret',
          LARK_ACCESS_TOKEN: 'uat-token',
        },
        runner,
      })

      expect(seenEnv).toMatchObject({
        PATH: 'C:\\bin',
        TEMP: 'C:\\tmp',
        HTTP_PROXY: 'http://proxy.local',
      })
      expect(seenEnv).not.toHaveProperty('NINE1BOT_SECRET')
      expect(seenEnv).not.toHaveProperty('OPENAI_API_KEY')
      expect(seenEnv).not.toHaveProperty('LARK_ACCESS_TOKEN')
    } finally {
      restoreEnv('NINE1BOT_SECRET', originalSecret)
      restoreEnv('OPENAI_API_KEY', originalApiKey)
    }
  })

  test('passes JSON params through relative @file arguments', async () => {
    const seen: Array<{ args: string[]; payload: unknown }> = []
    const runner: FeishuCliRunner = async (_command, args, options) => {
      const fileArg = args.find((arg) => arg.startsWith('@'))
      const payload = fileArg && options.cwd
        ? await Bun.file(join(options.cwd, fileArg.slice(1))).json()
        : undefined
      seen.push({ args, payload })
      return { exitCode: 0, stdout: JSON.stringify({ code: 0, data: { node: { title: 'Wiki' } } }), stderr: '' }
    }

    await runFeishuCliJsonWithFile({
      cliPath: 'lark-cli',
      args: ['wiki', 'spaces', 'get_node'],
      fileFlag: '--params',
      fileName: 'params.json',
      payload: { token: 'wikcn_token' },
      timeoutMs: 2_000,
      runner,
    })

    expect(seen[0]?.args).toEqual([
      'wiki',
      'spaces',
      'get_node',
      '--params',
      '@params.json',
      '--as',
      'user',
      '--format',
      'json',
    ])
    expect(seen[0]?.payload).toEqual({ token: 'wikcn_token' })
  })

  test('enriches wiki pages with get_node metadata', async () => {
    const calls: string[][] = []
    const runner: FeishuCliRunner = async (_command, args) => {
      calls.push(args)
      if (args.join(' ') === 'auth status') {
        return authOk()
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          code: 0,
          data: {
            node: {
              title: 'Wiki Doc',
              space_id: 'spc_123',
              obj_type: 'docx',
              obj_token: 'docx_token',
              owner: { name: 'Owner' },
              obj_create_time: 1710000000,
              obj_edit_time: 1710000100,
            },
          },
        }),
        stderr: '',
      }
    }

    const page = buildFeishuPageContextPayload({
      url: 'https://gdut-topview.feishu.cn/wiki/GKw9w6TOliwkBXkqO8UcphiDnUg',
      title: 'Visible Wiki Title',
    })
    const result = await enrichFeishuPageContext({
      page,
      settings: { cliPath: 'lark-cli' },
      observedAt: 1000,
      runner,
    })

    expect(calls[1]).toContain('--params')
    expect(result.summary).toMatchObject({ status: 'loaded' })
    expect(result.metadata).toMatchObject({
      api: 'wiki.spaces.get_node',
      title: 'Wiki Doc',
      objType: 'docx',
      objToken: 'docx_token',
      objectKey: 'feishu:docx:docx_token',
      spaceId: 'spc_123',
    })
    expect(result.page.raw?.feishu).toMatchObject({
      enrichment: {
        status: 'loaded',
        resolvedObjType: 'docx',
        resolvedObjToken: 'docx_token',
      },
    })
    expect(result.blocks[0]?.id).toBe('page:feishu-metadata')
    expect(result.blocks[0]?.content).toEqual(expect.stringContaining('Metadata API: wiki.spaces.get_node'))
  })

  test('maps direct Feishu pages to drive metas batch_query doc types', async () => {
    const cases = [
      ['https://gdut-topview.feishu.cn/docx/GeVqd0rdho2WbPxLCyWcXI8nnpg', 'docx'],
      ['https://www.feishu.cn/sheets/shtcnI8QzfNsZk8B1RKJhtOEyHh', 'sheet'],
      ['https://gdut-topview.feishu.cn/base/GOerbRw0LaPdCpsnfT1cMg39ntb?table=tbl&view=vew', 'bitable'],
      ['https://gdut-topview.feishu.cn/slides/PKkosoB9RlwVFcdKj42cBRk2n3e', 'slides'],
      ['https://gdut-topview.feishu.cn/drive/folder/WpF7fSL5PlZYUkdfxBqcQ6KJnSC', 'folder'],
    ] as const

    for (const [url, docType] of cases) {
      let payload: any
      const runner: FeishuCliRunner = async (_command, args, options) => {
        if (args.join(' ') === 'auth status') return authOk()
        const fileArg = args.find((arg) => arg.startsWith('@'))
        payload = fileArg && options.cwd
          ? await Bun.file(join(options.cwd, fileArg.slice(1))).json()
          : undefined
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            code: 0,
            data: {
              metas: [{
                title: `${docType} title`,
                doc_type: docType,
                doc_token: 'token_123',
                url: 'https://example.feishu.cn/meta',
                owner_id: 'ou_owner',
                latest_modify_time: 1710000100,
              }],
            },
          }),
          stderr: '',
        }
      }
      const result = await enrichFeishuPageContext({
        page: buildFeishuPageContextPayload({ url, title: 'Visible' }),
        settings: { cliPath: 'lark-cli' },
        runner,
      })

      expect(payload.request_docs[0].doc_type).toBe(docType)
      expect(result.summary).toMatchObject({ status: 'loaded' })
      expect(result.metadata).toMatchObject({
        api: 'drive.metas.batch_query',
        objType: docType,
        title: `${docType} title`,
      })
    }
  })

  test('degrades Feishu enrichment without secrets for missing CLI, login, permission, timeout, and visible-only', async () => {
    const page = buildFeishuPageContextPayload({
      url: 'https://gdut-topview.feishu.cn/docx/GeVqd0rdho2WbPxLCyWcXI8nnpg',
      title: 'Docx',
    })

    await expect(enrichFeishuPageContext({
      page,
      settings: {},
      env: { PATH: '' },
    })).resolves.toMatchObject({
      summary: { status: 'missing_cli' },
      blocks: [{ id: 'page:feishu-metadata' }],
    })

    await expect(enrichFeishuPageContext({
      page,
      settings: { cliPath: 'lark-cli' },
      runner: async () => ({ exitCode: 0, stdout: JSON.stringify({ tokenStatus: 'expired' }), stderr: '' }),
    })).resolves.toMatchObject({
      summary: { status: 'need_login' },
    })

    await expect(enrichFeishuPageContext({
      page,
      settings: { cliPath: 'lark-cli' },
      runner: async (_command, args) => {
        if (args.join(' ') === 'auth status') return authOk()
        return { exitCode: 1, stdout: '', stderr: JSON.stringify({ error: { code: 99991663, message: 'Permission denied' } }) }
      },
    })).resolves.toMatchObject({
      summary: { status: 'permission_denied' },
    })

    await expect(enrichFeishuPageContext({
      page,
      settings: { cliPath: 'lark-cli' },
      runner: async (_command, args) => {
        if (args.join(' ') === 'auth status') return authOk()
        return { exitCode: null, stdout: '', stderr: '', timedOut: true }
      },
    })).resolves.toMatchObject({
      summary: { status: 'timeout' },
    })

    const visibleOnlyRunner: FeishuCliRunner = async () => {
      throw new Error('CLI should not run')
    }
    await expect(enrichFeishuPageContext({
      page,
      settings: { cliPath: 'lark-cli', contextEnrichment: 'visible-only' },
      runner: visibleOnlyRunner,
    })).resolves.toMatchObject({
      summary: { status: 'visible_only' },
      blocks: [],
    })

    await expect(enrichFeishuPageContext({
      page,
      settings: { cliPath: 'lark-cli', contextEnrichment: 'disabled' },
      runner: visibleOnlyRunner,
    })).resolves.toMatchObject({
      summary: { status: 'not_applicable' },
      blocks: [],
      page,
    })
  })
})

function authOk() {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      identity: 'user:ou_123',
      tokenStatus: 'valid',
    }),
    stderr: '',
  }
}

async function withTempDir<T>(fn: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'nine1bot-feishu-skills-'))
  try {
    return await fn(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function writeSkill(root: string, name: string) {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${name}`,
    '---',
    '',
    `# ${name}`,
    '',
  ].join('\n'), 'utf8')
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key]
    return
  }
  process.env[key] = value
}

function createAutoConnectedGatewayFactory() {
  return (options: {
    account: { id: string }
    onConnectionStateChange?: (event: {
      accountId: string
      state: 'connected' | 'reconnecting' | 'connection-error' | 'stopped'
      at: string
      message?: string
    }) => void | Promise<void>
  }) => ({
    async start() {
      await options.onConnectionStateChange?.({
        accountId: options.account.id,
        state: 'connected',
        at: new Date().toISOString(),
      })
    },
    async stop() {
      await options.onConnectionStateChange?.({
        accountId: options.account.id,
        state: 'stopped',
        at: new Date().toISOString(),
      })
    },
    async injectMessage() {},
    async injectCardAction() {
      return undefined
    },
    isStarted() {
      return true
    },
  })
}
