import type { AuthConfig } from '../config/schema'
import type {
  ServerAccessAuthProvider,
  ServerAccessAuthRequest,
} from '../../../../opencode/packages/opencode/src/server/access-auth'
import {
  FileAccessCredentialStore,
  hashAccessPassword,
  validateAccessPassword,
  type AccessCredential,
} from './credential-store'

type SessionKind = 'web' | 'browser-extension'

type AccessSession = {
  kind: SessionKind
  expiresAt: number
  credentialVersion: number
  createdAt: number
}

type AuthenticatedRequest =
  | { method: 'cookie'; token: string; session: AccessSession }
  | { method: 'bearer'; token: string; session: AccessSession }
  | { method: 'internal' }
  | { method: 'legacy-basic' }

type FailureState = {
  failures: number
  blockedUntil: number
  lastUsedAt: number
}

const SESSION_COOKIE = 'nine1bot_access_session'
const MAX_SESSIONS = 64
const MAX_FAILURE_KEYS = 1000
const MAX_LOGIN_BODY_BYTES = 1024
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function isLoopbackAddress(address: string | undefined): boolean {
  const normalized = address?.trim().toLowerCase()
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === '::ffff:127.0.0.1'
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Buffer.from(bytes).toString('base64url')
}

function parseCookies(header: string | undefined): Map<string, string> {
  const result = new Map<string, string>()
  if (!header) return result
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    try {
      result.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()))
    } catch {
      // Ignore malformed cookie values instead of turning an unauthenticated
      // request into a server error.
    }
  }
  return result
}

function publicWebPath(method: string, path: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false
  return path === '/' ||
    path === '/index.html' ||
    path === '/nine1bot.svg' ||
    path === '/favicon.ico' ||
    path === '/manifest.webmanifest' ||
    path.startsWith('/assets/')
}

function internalPathAllowed(path: string): boolean {
  return path === '/project' ||
    path.startsWith('/project/') ||
    path.startsWith('/session/') ||
    path.startsWith('/nine1bot/agent/')
}

export class LoginLimiter {
  private readonly failures = new Map<string, FailureState>()
  private readonly inFlight = new Map<string, number>()
  private globalFailures: FailureState | undefined
  private globalInFlight = 0

  constructor(private readonly globalFailureThreshold = 50) {}

  begin(key: string): { finish: () => void } {
    const now = Date.now()
    let state = this.failures.get(key)
    if (state && now - state.lastUsedAt > 15 * 60_000) {
      this.failures.delete(key)
      state = undefined
    }
    if (this.globalFailures && now - this.globalFailures.lastUsedAt > 15 * 60_000) {
      this.globalFailures = undefined
    }
    if (this.globalFailures?.blockedUntil && this.globalFailures.blockedUntil > now) {
      const retryAfter = Math.max(1, Math.ceil((this.globalFailures.blockedUntil - now) / 1000))
      throw Object.assign(new Error('Too many global failed login attempts'), { retryAfter })
    }
    if (state?.blockedUntil && state.blockedUntil > now) {
      const retryAfter = Math.max(1, Math.ceil((state.blockedUntil - now) / 1000))
      throw Object.assign(new Error('Too many failed login attempts'), { retryAfter })
    }
    if ((this.inFlight.get(key) ?? 0) >= 1 || this.globalInFlight >= 8) {
      throw Object.assign(new Error('Too many concurrent login attempts'), { retryAfter: 1 })
    }
    this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1)
    this.globalInFlight += 1
    let finished = false
    return {
      finish: () => {
        if (finished) return
        finished = true
        const count = Math.max(0, (this.inFlight.get(key) ?? 1) - 1)
        if (count === 0) this.inFlight.delete(key)
        else this.inFlight.set(key, count)
        this.globalInFlight = Math.max(0, this.globalInFlight - 1)
      },
    }
  }

  failed(key: string): void {
    const now = Date.now()
    const previous = this.failures.get(key)
    const failures = (previous?.failures ?? 0) + 1
    const blockSeconds = failures >= 5 ? Math.min(15 * 60, 30 * 2 ** (failures - 5)) : 0
    this.failures.set(key, {
      failures,
      blockedUntil: blockSeconds ? now + blockSeconds * 1000 : 0,
      lastUsedAt: now,
    })
    const globalCount = (this.globalFailures?.failures ?? 0) + 1
    const globalBlockSeconds = globalCount >= this.globalFailureThreshold
      ? Math.min(15 * 60, 30 * 2 ** (globalCount - this.globalFailureThreshold))
      : 0
    this.globalFailures = {
      failures: globalCount,
      blockedUntil: globalBlockSeconds ? now + globalBlockSeconds * 1000 : 0,
      lastUsedAt: now,
    }
    this.prune()
  }

  succeeded(key: string): void {
    this.failures.delete(key)
  }

  private prune(): void {
    if (this.failures.size <= MAX_FAILURE_KEYS) return
    const oldest = [...this.failures.entries()]
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)
      .slice(0, this.failures.size - MAX_FAILURE_KEYS)
    for (const [key] of oldest) this.failures.delete(key)
  }
}

export type AccessAuthRuntime = {
  state: 'disabled' | 'active'
  service: AccessAuthService
}

export type CreateAccessAuthRuntimeOptions = {
  store?: FileAccessCredentialStore
  env?: Record<string, string | undefined>
}

export async function createAccessAuthRuntime(
  config: AuthConfig,
  options: CreateAccessAuthRuntimeOptions = {},
): Promise<AccessAuthRuntime> {
  const store = options.store ?? new FileAccessCredentialStore()
  const env = options.env ?? process.env
  if (!config.enabled) {
    return {
      state: 'disabled',
      service: new AccessAuthService({ config, passwordHash: undefined, credentialVersion: 0 }),
    }
  }

  const environmentPassword = env.NINE1BOT_WEB_PASSWORD
  let credential: AccessCredential | undefined
  let passwordHash: string
  let credentialVersion: number
  let credentialStore: FileAccessCredentialStore | undefined
  let credentialStoreOptional = false

  if (environmentPassword !== undefined) {
    validateAccessPassword(environmentPassword)
    passwordHash = await hashAccessPassword(environmentPassword)
    credentialVersion = 1
  } else {
    credential = await store.load()
    if (credential) {
      passwordHash = credential.passwordHash
      credentialVersion = credential.credentialVersion
      credentialStore = store
    } else if (config.password !== undefined) {
      validateAccessPassword(config.password)
      passwordHash = await hashAccessPassword(config.password)
      credentialVersion = 1
      credentialStore = store
      credentialStoreOptional = true
      console.warn(
        'Web access password is still stored in config. Run `nine1bot config migrate-auth` to store only an Argon2id hash.',
      )
    } else {
      throw new Error(
        'Web access authentication is enabled but no password is configured. Run `nine1bot config set-password`.',
      )
    }
  }

  try {
    await Bun.password.verify('nine1bot credential validation probe', passwordHash)
  } catch {
    throw new Error('Web access credential hash is invalid. Run `nine1bot config set-password`.')
  }

  return {
    state: 'active',
    service: new AccessAuthService({
      config,
      passwordHash,
      credentialVersion,
      credentialStore,
      credentialStoreOptional,
    }),
  }
}

export class AccessAuthService implements ServerAccessAuthProvider {
  private readonly sessions = new Map<string, AccessSession>()
  private readonly limiter = new LoginLimiter()
  private readonly internalToken = randomToken()
  private legacyWarningLogged = false
  private credentialRefresh: Promise<void> | undefined

  constructor(private readonly options: {
    config: AuthConfig
    passwordHash: string | undefined
    credentialVersion: number
    credentialStore?: FileAccessCredentialStore
    credentialStoreOptional?: boolean
  }) {}

  get enabled(): boolean {
    return this.options.config.enabled
  }

  createInternalAuthorization(): string {
    return `Bearer ${this.internalToken}`
  }

  async handle(c: any, next: () => Promise<void>, request: ServerAccessAuthRequest): Promise<Response | void> {
    const path = c.req.path.replace(/\/$/, '') || '/'
    const method = c.req.method.toUpperCase()

    if (path.startsWith('/access-auth')) {
      const preflight = this.handleAccessCorsPreflight(c, request)
      if (preflight) return preflight
    }

    if (path === '/healthz' && method === 'GET') {
      return c.json({ ok: true, authEnabled: this.enabled }, 200, {
        'Cache-Control': 'no-store',
      })
    }
    let credentialReady = true
    if (this.enabled && !publicWebPath(method, path)) {
      try {
        await this.refreshCredentialFromStore()
      } catch {
        credentialReady = false
      }
    }
    if (path === '/access-auth/status' && method === 'GET') {
      // An unreadable credential store cannot determine whether an existing
      // cookie is valid. Report availability failure, never a false logout.
      return credentialReady ? this.status(c, request) : this.authUnavailable(c, request)
    }
    if (path === '/access-auth/login' && method === 'POST') {
      if (!credentialReady) return this.authUnavailable(c, request)
      return this.login(c, request)
    }
    if (path === '/access-auth/logout' && method === 'POST') {
      return this.logout(c, request)
    }

    if (!this.enabled) return next()
    if (publicWebPath(method, path)) return next()
    if (!credentialReady) return this.authUnavailable(c, request)
    if (method === 'GET' && path === '/mcp/oauth/callback') return next()
    if (request.localBrowserRelay) return next()

    const authenticated = await this.authenticate(c, request)
    if (!authenticated) return this.unauthorized(c)
    if (authenticated.method === 'internal') {
      if (!isLoopbackAddress(request.remoteAddress) || !internalPathAllowed(path)) {
        return this.unauthorized(c)
      }
    }
    if (authenticated.method === 'cookie' && !SAFE_METHODS.has(method)) {
      const origin = c.req.header('Origin')
      if (!origin || origin !== this.effectiveOrigin(c)) {
        return c.json({ error: { code: 'invalid_request_origin', message: 'Request origin is not allowed' } }, 403)
      }
    }
    return next()
  }

  private async status(c: any, request: ServerAccessAuthRequest): Promise<Response> {
    const authenticated = this.enabled ? await this.authenticate(c, request) : undefined
    const session = authenticated && 'session' in authenticated ? authenticated.session : undefined
    return this.jsonWithCors(c, request, {
      enabled: this.enabled,
      authenticated: !this.enabled || Boolean(authenticated),
      surface: session?.kind ?? null,
      expiresAt: session ? new Date(session.expiresAt).toISOString() : null,
      secureTransport: this.secureRequest(c),
    })
  }

  private async login(c: any, request: ServerAccessAuthRequest): Promise<Response> {
    if (!this.enabled) {
      return this.jsonWithCors(c, request, { enabled: false, authenticated: true })
    }
    const contentLength = Number(c.req.header('content-length') ?? 0)
    if (Number.isFinite(contentLength) && contentLength > MAX_LOGIN_BODY_BYTES) {
      return this.jsonWithCors(c, request, {
        error: { code: 'invalid_login_request', message: 'Login request is too large' },
      }, 413)
    }

    const parsed = await this.readLoginBody(c)
    if (parsed.tooLarge) {
      return this.jsonWithCors(c, request, {
        error: { code: 'invalid_login_request', message: 'Login request is too large' },
      }, 413)
    }
    const body = parsed.body as {
      password?: unknown
      surface?: unknown
    } | undefined
    const surface: SessionKind = body?.surface === 'browser-extension' ? 'browser-extension' : 'web'
    const origin = c.req.header('Origin')
    if (surface === 'browser-extension') {
      if (!isLoopbackAddress(request.remoteAddress) || (origin && !origin.startsWith('chrome-extension://'))) {
        return this.jsonWithCors(c, request, {
          error: { code: 'invalid_login_origin', message: 'Extension login origin is not allowed' },
        }, 403)
      }
    } else if (origin && origin !== this.effectiveOrigin(c)) {
      return c.json({ error: { code: 'invalid_login_origin', message: 'Login origin is not allowed' } }, 403)
    }
    if (!body || typeof body.password !== 'string' || !this.options.passwordHash) {
      return this.unauthorized(c, request)
    }

    const key = request.remoteAddress || 'unknown'
    let guard: { finish: () => void }
    try {
      guard = this.limiter.begin(key)
    } catch (error) {
      const retryAfter = error && typeof error === 'object' && 'retryAfter' in error
        ? String(error.retryAfter)
        : '1'
      return this.jsonWithCors(c, request, {
        error: { code: 'access_auth_rate_limited', message: 'Too many login attempts' },
      }, 429, { 'Retry-After': retryAfter })
    }

    try {
      const valid = await Bun.password.verify(body.password, this.options.passwordHash)
      if (!valid) {
        this.limiter.failed(key)
        return this.unauthorized(c, request)
      }
      this.limiter.succeeded(key)
      const token = this.createSession(surface)
      const session = this.sessions.get(token)!
      if (surface === 'browser-extension') {
        return this.jsonWithCors(c, request, {
          enabled: true,
          authenticated: true,
          accessToken: token,
          expiresAt: new Date(session.expiresAt).toISOString(),
        })
      }
      const response = this.jsonWithCors(c, request, {
        enabled: true,
        authenticated: true,
        expiresAt: new Date(session.expiresAt).toISOString(),
      })
      response.headers.append('Set-Cookie', this.sessionCookie(token, c))
      return response
    } finally {
      guard.finish()
    }
  }

  private async logout(c: any, request: ServerAccessAuthRequest): Promise<Response> {
    const authenticated = await this.authenticate(c, request)
    if (authenticated?.method === 'cookie') {
      const origin = c.req.header('Origin')
      if (!origin || origin !== this.effectiveOrigin(c)) {
        return c.json({ error: { code: 'invalid_request_origin', message: 'Request origin is not allowed' } }, 403)
      }
    }
    if (authenticated && 'token' in authenticated) this.sessions.delete(authenticated.token)
    const response = this.emptyWithCors(c, request)
    response.headers.append(
      'Set-Cookie',
      `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${this.secureRequest(c) ? '; Secure' : ''}`,
    )
    return response
  }

  private createSession(kind: SessionKind): string {
    this.pruneSessions()
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0]
      if (!oldest) break
      this.sessions.delete(oldest[0])
    }
    const token = randomToken()
    const now = Date.now()
    this.sessions.set(token, {
      kind,
      createdAt: now,
      expiresAt: now + this.options.config.sessionTtlMinutes * 60_000,
      credentialVersion: this.options.credentialVersion,
    })
    return token
  }

  private pruneSessions(): void {
    const now = Date.now()
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now || session.credentialVersion !== this.options.credentialVersion) {
        this.sessions.delete(token)
      }
    }
  }

  private async authenticate(c: any, request?: ServerAccessAuthRequest): Promise<AuthenticatedRequest | undefined> {
    this.pruneSessions()
    const authorization = c.req.header('Authorization')
    const bearerMatch = authorization?.match(/^Bearer\s+(.+)$/i)
    if (bearerMatch) {
      const token = bearerMatch[1].trim()
      if (token === this.internalToken) return { method: 'internal' }
      const session = this.sessions.get(token)
      if (session) return { method: 'bearer', token, session }
    }
    if (/^Basic\s+/i.test(authorization || '') && this.options.config.legacyBasic === 'compat') {
      const key = request?.remoteAddress || 'unknown'
      let guard: { finish: () => void } | undefined
      try {
        guard = this.limiter.begin(key)
        const valid = await this.verifyLegacyBasic(authorization)
        if (valid) {
          this.limiter.succeeded(key)
          return { method: 'legacy-basic' }
        }
        this.limiter.failed(key)
      } catch {
        return undefined
      } finally {
        guard?.finish()
      }
    }
    const token = parseCookies(c.req.header('Cookie')).get(SESSION_COOKIE)
    if (token) {
      const session = this.sessions.get(token)
      if (session) return { method: 'cookie', token, session }
    }
    return undefined
  }

  private async verifyLegacyBasic(header: string): Promise<boolean> {
    if (!this.options.passwordHash) return false
    try {
      const encoded = header.replace(/^Basic\s+/i, '')
      const decoded = Buffer.from(encoded, 'base64').toString('utf8')
      const separator = decoded.indexOf(':')
      if (separator < 0 || decoded.slice(0, separator) !== 'nine1bot') return false
      const valid = await Bun.password.verify(decoded.slice(separator + 1), this.options.passwordHash)
      if (valid && !this.legacyWarningLogged) {
        this.legacyWarningLogged = true
        console.warn('Legacy Basic Web access is deprecated; use the Nine1Bot login session API.')
      }
      return valid
    } catch {
      return false
    }
  }

  private sessionCookie(token: string, c: any): string {
    const secure = this.secureRequest(c) ? '; Secure' : ''
    return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${this.options.config.sessionTtlMinutes * 60}${secure}`
  }

  private effectiveOrigin(c: any): string {
    const direct = new URL(c.req.url)
    const publicUrl = process.env.NINE1BOT_PUBLIC_URL
    if (publicUrl) {
      try {
        const publicOrigin = new URL(publicUrl)
        if (c.req.header('Host') === publicOrigin.host) return publicOrigin.origin
      } catch {}
    }
    return direct.origin
  }

  private secureRequest(c: any): boolean {
    return this.effectiveOrigin(c).startsWith('https://')
  }

  private handleAccessCorsPreflight(c: any, request: ServerAccessAuthRequest): Response | undefined {
    if (c.req.method !== 'OPTIONS') return undefined
    const origin = c.req.header('Origin')
    if (!origin?.startsWith('chrome-extension://') || !isLoopbackAddress(request.remoteAddress)) return undefined
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '600',
        'Cache-Control': 'no-store',
        Vary: 'Origin',
      },
    })
  }

  private jsonWithCors(
    c: any,
    request: ServerAccessAuthRequest,
    body: unknown,
    status = 200,
    headers: Record<string, string> = {},
  ): Response {
    const responseHeaders = new Headers({ 'Cache-Control': 'no-store', ...headers })
    const origin = c.req.header('Origin')
    if (origin?.startsWith('chrome-extension://') && isLoopbackAddress(request.remoteAddress)) {
      responseHeaders.set('Access-Control-Allow-Origin', origin)
      responseHeaders.set('Vary', 'Origin')
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        ...Object.fromEntries(responseHeaders),
        'Content-Type': 'application/json; charset=UTF-8',
      },
    })
  }

  private emptyWithCors(c: any, request: ServerAccessAuthRequest): Response {
    const headers = new Headers({ 'Cache-Control': 'no-store' })
    const origin = c.req.header('Origin')
    if (origin?.startsWith('chrome-extension://') && isLoopbackAddress(request.remoteAddress)) {
      headers.set('Access-Control-Allow-Origin', origin)
      headers.set('Vary', 'Origin')
    }
    return new Response(null, { status: 204, headers })
  }

  private authUnavailable(c: any, request: ServerAccessAuthRequest): Response {
    return this.jsonWithCors(c, request, {
      error: {
        code: 'access_auth_unavailable',
        message: 'Web access authentication is temporarily unavailable',
      },
    }, 503)
  }

  private async readLoginBody(c: any): Promise<{ tooLarge: boolean; body?: unknown }> {
    const raw = c.req.raw as Request | undefined
    if (!raw?.body) {
      const body = await c.req.json().catch(() => undefined)
      return { tooLarge: false, body }
    }

    const reader = raw.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > MAX_LOGIN_BODY_BYTES) {
          await reader.cancel().catch(() => undefined)
          return { tooLarge: true }
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    try {
      return { tooLarge: false, body: JSON.parse(new TextDecoder().decode(bytes)) }
    } catch {
      return { tooLarge: false }
    }
  }

  private async refreshCredentialFromStore(): Promise<void> {
    const store = this.options.credentialStore
    if (!store) return
    if (this.credentialRefresh) return this.credentialRefresh

    this.credentialRefresh = (async () => {
      const credential = await store.load()
      if (!credential) {
        if (this.options.credentialStoreOptional) return
        this.options.passwordHash = undefined
        this.sessions.clear()
        throw new Error('Web access credential is missing')
      }
      if (
        credential.credentialVersion === this.options.credentialVersion &&
        credential.passwordHash === this.options.passwordHash
      ) return
      try {
        await Bun.password.verify('nine1bot credential validation probe', credential.passwordHash)
      } catch {
        this.options.passwordHash = undefined
        this.sessions.clear()
        throw new Error('Web access credential hash is invalid')
      }
      this.options.passwordHash = credential.passwordHash
      this.options.credentialVersion = credential.credentialVersion
      this.options.credentialStoreOptional = false
      this.sessions.clear()
    })()
    try {
      await this.credentialRefresh
    } finally {
      this.credentialRefresh = undefined
    }
  }

  private unauthorized(c: any, request?: ServerAccessAuthRequest): Response {
    const body = { error: { code: 'access_auth_required', message: 'Web access authentication is required' } }
    return request
      ? this.jsonWithCors(c, request, body, 401)
      : c.json(body, 401, { 'Cache-Control': 'no-store' })
  }
}
