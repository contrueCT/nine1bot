import { computed, ref } from 'vue'
import {
  setAccessToken,
  setAccessUnauthorizedHandler,
} from '../api/access-auth'
import {
  getTrustedExtensionParentContext,
  isTrustedExtensionParentEvent,
} from '../utils/extension-parent'

type AccessStatus = {
  enabled: boolean
  authenticated: boolean
  surface?: 'web' | 'browser-extension' | null
  expiresAt?: string | null
  secureTransport?: boolean
}

const loading = ref(true)
const enabled = ref(false)
const authenticated = ref(false)
// A transport failure is not evidence that the user's authenticated session ended.
const status = ref<'unknown' | 'authenticated' | 'unauthenticated'>('unknown')
const error = ref('')
const retryAfterSeconds = ref(0)
const secureTransport = ref(window.location.protocol === 'https:')
const surface = ref<'web' | 'browser-extension'>('web')

const required = computed(() => enabled.value && !authenticated.value)
const loopbackHost = new Set(['localhost', '127.0.0.1', '::1'])
const insecureTransport = computed(() =>
  enabled.value && !secureTransport.value && !loopbackHost.has(window.location.hostname),
)

function resetUnauthorizedState(): void {
  setAccessToken(undefined)
  status.value = 'unauthenticated'
  authenticated.value = false
  error.value = '登录状态已失效，请重新输入访问密码。'
  if (surface.value === 'browser-extension') {
    const context = getTrustedExtensionParentContext()
    context?.parent.postMessage({ type: 'nine1bot.clearAccessToken' }, context.origin)
  }
}

async function requestExtensionAccessToken(): Promise<string> {
  const context = getTrustedExtensionParentContext()
  if (!context) return ''

  const requestId = crypto.randomUUID()
  return new Promise<string>((resolve) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener('message', onMessage)
      resolve('')
    }, 1500)
    const onMessage = (event: MessageEvent) => {
      if (!isTrustedExtensionParentEvent(event)) return
      const message = event.data as {
        type?: unknown
        requestId?: unknown
        accessToken?: unknown
      } | undefined
      if (message?.type !== 'nine1bot.accessToken' || message.requestId !== requestId) return
      window.clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      resolve(typeof message.accessToken === 'string' ? message.accessToken : '')
    }
    window.addEventListener('message', onMessage)
    context.parent.postMessage({ type: 'nine1bot.requestAccessToken', requestId }, context.origin)
  })
}

async function readStatus(): Promise<AccessStatus> {
  const response = await fetch('/access-auth/status', {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`无法读取访问认证状态（HTTP ${response.status}）`)
  const result = await response.json()
  if (typeof result?.enabled !== 'boolean' || typeof result?.authenticated !== 'boolean') throw new Error('访问认证状态响应无效')
  return result as AccessStatus
}

export function useAccessAuth() {
  async function initialize(clientSurface: 'web' | 'browser-extension'): Promise<boolean> {
    surface.value = clientSurface
    loading.value = true
    status.value = 'unknown'
    error.value = ''
    retryAfterSeconds.value = 0
    setAccessUnauthorizedHandler(resetUnauthorizedState)

    try {
      if (clientSurface === 'browser-extension') {
        setAccessToken(await requestExtensionAccessToken())
      }
      const result = await readStatus()
      enabled.value = result.enabled
      authenticated.value = result.authenticated
      status.value = result.authenticated ? 'authenticated' : 'unauthenticated'
      secureTransport.value = result.secureTransport ?? window.location.protocol === 'https:'
      return result.authenticated
    } catch (cause) {
      enabled.value = true
      authenticated.value = false
      error.value = cause instanceof Error ? cause.message : '无法连接到 Nine1Bot 认证服务。'
      return false
    } finally {
      loading.value = false
    }
  }

  async function login(password: string): Promise<boolean> {
    error.value = ''
    retryAfterSeconds.value = 0
    let response: Response
    try {
      response = await fetch('/access-auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, surface: surface.value }),
      })
    } catch {
      error.value = '无法连接到 Nine1Bot，请检查服务和网络后重试。'
      return false
    }
    const body = await response.json().catch(() => ({})) as {
      authenticated?: boolean
      accessToken?: string
      error?: { message?: string }
    }
    if (!response.ok) {
      if (response.status === 401) {
        status.value = 'unauthenticated'
        authenticated.value = false
      }
      const retryAfter = Number(response.headers.get('Retry-After') || 0)
      retryAfterSeconds.value = Number.isFinite(retryAfter) ? retryAfter : 0
      error.value = response.status === 429
        ? `尝试次数过多，请在 ${Math.max(1, retryAfterSeconds.value)} 秒后重试。`
        : response.status === 401
          ? '访问密码不正确。'
          : body.error?.message || '登录失败，请稍后重试。'
      return false
    }
    if (body.accessToken) setAccessToken(body.accessToken)
    authenticated.value = body.authenticated === true
    status.value = typeof body.authenticated === 'boolean' ? (body.authenticated ? 'authenticated' : 'unauthenticated') : 'unknown'
    return authenticated.value
  }

  async function logout(): Promise<void> {
    const request = fetch('/access-auth/logout', { method: 'POST' }).catch(() => undefined)
    setAccessToken(undefined)
    status.value = 'unauthenticated'
    authenticated.value = false
    await request
    if (surface.value === 'browser-extension') {
      const context = getTrustedExtensionParentContext()
      context?.parent.postMessage({ type: 'nine1bot.clearAccessToken' }, context.origin)
    }
  }

  return {
    loading,
    enabled,
    authenticated,
    status,
    required,
    insecureTransport,
    error,
    retryAfterSeconds,
    initialize,
    login,
    logout,
  }
}
