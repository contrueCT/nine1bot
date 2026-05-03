import { describe, expect, it } from 'bun:test'
import { buildBrowserExtensionPageContextPayload } from '../src/content/page-context'

describe('browser extension platform page context router', () => {
  it('routes Feishu pages before GitLab and generic fallbacks', () => {
    expect(
      buildBrowserExtensionPageContextPayload({
        url: 'https://gdut-topview.feishu.cn/wiki/GKw9w6TOliwkBXkqO8UcphiDnUg',
        title: 'Wiki Doc',
        selection: ' selected text ',
        visibleSummary: 'Wiki overview',
      }),
    ).toMatchObject({
      platform: 'feishu',
      pageType: 'feishu-wiki',
      objectKey: 'feishu:wiki:GKw9w6TOliwkBXkqO8UcphiDnUg',
      selection: 'selected text',
      visibleSummary: 'Wiki overview',
    })

    expect(
      buildBrowserExtensionPageContextPayload({
        url: 'https://gitlab.com/nine1/nine1bot/-/issues/7',
        title: 'Issue',
        gitlab: {
          status: 'Open',
        },
      }),
    ).toMatchObject({
      platform: 'gitlab',
      pageType: 'gitlab-issue',
      objectKey: 'gitlab.com:nine1/nine1bot:issue:7',
      raw: {
        gitlab: {
          status: 'Open',
        },
      },
    })

    expect(
      buildBrowserExtensionPageContextPayload({
        url: 'https://example.com/docs',
        title: 'Docs',
        visibleSummary: 'Generic docs page',
      }),
    ).toMatchObject({
      platform: 'generic-browser',
      url: 'https://example.com/docs',
      title: 'Docs',
      visibleSummary: 'Generic docs page',
    })
  })
})
