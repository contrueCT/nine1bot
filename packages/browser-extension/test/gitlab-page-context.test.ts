import { describe, expect, it } from 'bun:test'
import { buildPageContextPayload, parseGitLabUrl } from '../src/page-context/gitlab'

describe('browser extension GitLab page parser', () => {
  it('detects GitLab repo, file, tree, merge request, and issue pages', () => {
    expect(parseGitLabUrl('https://gitlab.com/nine1/nine1bot')).toMatchObject({
      pageType: 'gitlab-repo',
      objectKey: 'gitlab.com:nine1/nine1bot:repo',
      route: 'repo',
    })
    expect(parseGitLabUrl('https://gitlab.com/nine1/nine1bot/-/blob/main/src/index.ts')).toMatchObject({
      pageType: 'gitlab-file',
      objectKey: 'gitlab.com:nine1/nine1bot:file:main:src/index.ts',
      ref: 'main',
      filePath: 'src/index.ts',
      route: 'blob',
    })
    expect(parseGitLabUrl('https://gitlab.com/nine1/nine1bot/-/tree/main/packages')).toMatchObject({
      pageType: 'gitlab-repo',
      objectKey: 'gitlab.com:nine1/nine1bot:tree:main:packages',
      ref: 'main',
      treePath: 'packages',
      route: 'tree',
    })
    expect(parseGitLabUrl('https://gitlab.com/nine1/nine1bot/-/merge_requests/42')).toMatchObject({
      pageType: 'gitlab-mr',
      objectKey: 'gitlab.com:nine1/nine1bot:merge_request:42',
      iid: '42',
      route: 'merge_request',
    })
    expect(parseGitLabUrl('https://gitlab.com/nine1/nine1bot/-/issues/7')).toMatchObject({
      pageType: 'gitlab-issue',
      objectKey: 'gitlab.com:nine1/nine1bot:issue:7',
      iid: '7',
      route: 'issue',
    })
    expect(parseGitLabUrl('https://example.com/nine1/nine1bot/-/issues/7')).toBeUndefined()
  })

  it('builds request-time page context payloads without Chrome APIs', () => {
    expect(
      buildPageContextPayload({
        url: 'https://gitlab.com/nine1/nine1bot/-/merge_requests/42',
        title: 'Improve runtime',
        selection: ' selected text ',
        visibleSummary: 'MR overview',
      }),
    ).toMatchObject({
      platform: 'gitlab',
      pageType: 'gitlab-mr',
      objectKey: 'gitlab.com:nine1/nine1bot:merge_request:42',
      selection: 'selected text',
      visibleSummary: 'MR overview',
      raw: {
        gitlab: {
          host: 'gitlab.com',
          projectPath: 'nine1/nine1bot',
          route: 'merge_request',
          iid: '42',
        },
      },
    })

    expect(
      buildPageContextPayload({
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
