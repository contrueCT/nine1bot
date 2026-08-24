import { describe, expect, test } from 'bun:test'
import { gitLabCliGuide } from '../src/lib/gitlab-cli-guide'

describe('GitLab CLI setup guide', () => {
  test('guides an authenticated CLI user into the page workflow', () => {
    expect(gitLabCliGuide({
      id: 'cli',
      label: 'GitLab CLI',
      value: 'authenticated: gitlab.example.com',
      tone: 'success',
    })).toEqual({
      title: 'GitLab CLI 已就绪',
      tone: 'success',
      text: '当前已登录 gitlab.example.com。打开 GitLab 仓库、MR 或 commit 页面后，可以在对话栏直接说明要检查或 review 的目标。',
    })
  })

  test('explains installation, login, and unknown states', () => {
    expect(gitLabCliGuide({ id: 'cli', label: 'GitLab CLI', value: 'missing' })).toMatchObject({
      title: 'GitLab CLI 未安装',
      tone: 'neutral',
      text: expect.stringContaining('安装 glab'),
    })
    expect(gitLabCliGuide({ id: 'cli', label: 'GitLab CLI', value: 'not authenticated', tone: 'warning' })).toMatchObject({
      title: 'GitLab CLI 需要登录',
      tone: 'warning',
      text: expect.stringContaining('glab auth login'),
    })
    expect(gitLabCliGuide(undefined)).toMatchObject({
      title: 'GitLab CLI 状态未知',
      tone: 'neutral',
    })
  })
})
