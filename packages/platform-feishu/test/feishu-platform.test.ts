import { describe, expect, test } from 'bun:test'
import {
  buildFeishuPageContextPayload,
  createFeishuPlatformAdapter,
  feishuPlatformContribution,
  feishuTemplateIdsForPage,
  parseFeishuUrl,
} from '../src'
import type { PlatformAdapterContext } from '@nine1bot/platform-protocol'

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
    expect(adapter.templateContextBlocks({ templateIds, page }).map((block) => block.source)).toEqual([
      'template.browser-feishu',
      'template.feishu-wiki',
    ])
    expect(adapter.resourceContributions({ templateIds })?.builtinTools.enabledGroups).toContain('feishu-context')
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

    await expect(feishuPlatformContribution.getStatus?.(ctx)).resolves.toMatchObject({
      status: 'missing',
      cards: [
        { id: 'cli', value: 'missing' },
        { id: 'auth', value: 'unknown' },
      ],
    })
  })
})
