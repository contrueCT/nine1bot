import type { PlatformStatusCard } from '../api/client'

export type GitLabCliGuide = {
  title: string
  text: string
  tone: NonNullable<PlatformStatusCard['tone']>
}

export function gitLabCliGuide(card: PlatformStatusCard | undefined): GitLabCliGuide {
  const value = card?.value || 'unknown'
  if (value.startsWith('authenticated')) {
    const host = value.slice('authenticated'.length).replace(/^:\s*/, '').trim()
    return {
      title: 'GitLab CLI 已就绪',
      tone: 'success',
      text: host
        ? `当前已登录 ${host}。打开 GitLab 仓库、MR 或 commit 页面后，可以在对话栏直接说明要检查或 review 的目标。`
        : '当前 CLI 已登录。打开 GitLab 仓库、MR 或 commit 页面后，可以在对话栏直接说明要检查或 review 的目标。',
    }
  }
  if (value === 'not authenticated') {
    return {
      title: 'GitLab CLI 需要登录',
      tone: 'warning',
      text: '已检测到 glab，请在运行 Nine1Bot 的机器上执行 glab auth login，然后刷新平台状态。',
    }
  }
  if (value === 'missing') {
    return {
      title: 'GitLab CLI 未安装',
      tone: 'neutral',
      text: '请先在运行 Nine1Bot 的机器上安装 glab，完成登录后再刷新平台状态。',
    }
  }
  return {
    title: 'GitLab CLI 状态未知',
    tone: 'neutral',
    text: '刷新平台状态后，可查看运行 Nine1Bot 的机器是否已安装并登录 glab。',
  }
}
