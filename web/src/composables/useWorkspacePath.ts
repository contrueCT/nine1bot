import { ref, watch, type Ref } from 'vue'
import { api } from '../api/client'

/* 当前用户的 home 目录：只用来把路径缩写成 ~/...，拿不到就原样显示 */
const homeDirectory = ref('')

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:[\\/]/.test(path)
}

export function tildify(path: string, home = homeDirectory.value): string {
  if (!path || !home) return path
  const target = normalize(path)
  const base = normalize(home)
  if (target === base) return '~'
  return target.startsWith(`${base}/`) ? `~${target.slice(base.length)}` : path
}

/** 拆成「父路径」与「目录名」，给空态标题做排版用 */
export function splitPath(path: string): { parent: string; name: string } {
  const target = normalize(path)
  const index = target.lastIndexOf('/')
  if (index < 0) return { parent: '', name: target }
  return { parent: target.slice(0, index + 1), name: target.slice(index + 1) || target }
}

export function useHomeDirectory() {
  return homeDirectory
}

/**
 * 把会话目录解析成绝对路径。草稿会话的目录是 "."，
 * 真实落点只有服务端知道，这里向 /path 问一次。
 */
export function useWorkspacePath(directory: Ref<string | undefined>) {
  const resolved = ref('')
  let generation = 0

  watch(directory, async (value) => {
    const current = ++generation
    const trimmed = (value || '').trim()
    const known = trimmed && isAbsolutePath(trimmed) ? trimmed : ''
    resolved.value = known
    if (known && homeDirectory.value) return
    try {
      const paths = await api.getPath()
      if (paths.home) homeDirectory.value = paths.home
      if (current === generation && !known) resolved.value = paths.directory || ''
    } catch {
      // 解析失败只影响展示：保持空值，界面退回到通用文案
    }
  }, { immediate: true })

  return resolved
}
