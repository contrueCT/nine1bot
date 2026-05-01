import { z } from 'zod'

// ===== Nine1Bot 特有配置 =====

export const ServerConfigSchema = z.object({
  port: z.number().default(4096),
  hostname: z.string().default('127.0.0.1'),
  openBrowser: z.boolean().default(true),
})

export const AuthConfigSchema = z.object({
  enabled: z.boolean().default(false),
  password: z.string().optional(),
})

export const NgrokConfigSchema = z.object({
  authToken: z.string(),
  domain: z.string().optional(),
  region: z.enum(['us', 'eu', 'ap', 'au', 'sa', 'jp', 'in']).optional(),
})

export const NatappConfigSchema = z.object({
  authToken: z.string(),
  clientId: z.string().optional(),
})

export const TunnelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(['ngrok', 'natapp']).default('ngrok'),
  ngrok: NgrokConfigSchema.optional(),
  natapp: NatappConfigSchema.optional(),
})

// 配置隔离选项
export const IsolationConfigSchema = z.object({
  // 禁用 opencode 全局配置（~/.config/opencode/）
  disableGlobalConfig: z.boolean().default(false),
  // 禁用项目级配置（./.opencode/）
  disableProjectConfig: z.boolean().default(false),
  // 是否继承 opencode 的配置（默认继承）
  // 设为 false 则完全使用 nine1bot 自己的配置
  inheritOpencode: z.boolean().default(true),
})

// Skills 配置选项
export const SkillsConfigSchema = z.object({
  // 是否继承 opencode 的 skills（默认继承）
  inheritOpencode: z.boolean().default(true),
  // 是否继承 claude code 的 skills（默认继承）
  inheritClaudeCode: z.boolean().default(true),
})

// 浏览器控制配置
// 浏览器控制已内置到主服务的 /browser/ 路径下，不再需要独立端口
export const BrowserConfigSchema = z.object({
  // 是否启用浏览器控制
  enabled: z.boolean().default(false),
  // Chrome CDP 端口
  cdpPort: z.number().default(9222),
  // 是否自动启动 Chrome
  autoLaunch: z.boolean().default(true),
  // 是否使用无头模式
  headless: z.boolean().default(false),
})

export const RuntimeFeatureFlagSchema = z.object({
  enabled: z.boolean().default(true),
})

export const RuntimeConfigSchema = z.object({
  agentRunSpec: RuntimeFeatureFlagSchema.default({}),
  profileSnapshot: RuntimeFeatureFlagSchema.default({}),
  contextPipeline: RuntimeFeatureFlagSchema.default({}),
  resourceResolver: RuntimeFeatureFlagSchema.default({}),
})

export const PlatformConfigEntrySchema = z.object({
  enabled: z.boolean().optional(),
  features: z.record(z.boolean()).default({}),
  settings: z.record(z.unknown()).default({}),
})

export const PlatformsConfigSchema = z.record(PlatformConfigEntrySchema).default({})

export const FeishuConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    mode: z.enum(['websocket']).default('websocket'),
    appId: z.string().optional(),
    appSecret: z.string().optional(),
    verificationToken: z.string().optional(),
    encryptKey: z.string().optional(),
    defaultDirectory: z.string().optional(),
  })
  .superRefine((config, ctx) => {
    if (!config.enabled) {
      return
    }

    if (!config.appId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['appId'],
        message: 'appId is required when feishu.enabled is true',
      })
    }

    if (!config.appSecret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['appSecret'],
        message: 'appSecret is required when feishu.enabled is true',
      })
    }
  })

// ===== OpenCode 兼容配置（简化版）=====

const PermissionActionSchema = z.enum(['ask', 'allow', 'deny'])

const PermissionRuleSchema = z.union([
  PermissionActionSchema,
  z.object({
    default: PermissionActionSchema.optional(),
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  }),
])

const AgentConfigSchema = z.object({
  model: z.string().optional(),
  prompt: z.string().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  disable: z.boolean().optional(),
  description: z.string().optional(),
  mode: z.enum(['subagent', 'primary', 'all']).optional(),
  hidden: z.boolean().optional(),
  steps: z.number().optional(),
}).passthrough()

const McpLocalSchema = z.object({
  type: z.literal('local'),
  command: z.array(z.string()),
  environment: z.record(z.string()).optional(),
  enabled: z.boolean().optional(),
  timeout: z.number().optional(),
})

const McpOAuthSchema = z.object({
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  scope: z.string().optional(),
})

const McpRemoteSchema = z.object({
  type: z.literal('remote'),
  url: z.string(),
  enabled: z.boolean().optional(),
  headers: z.record(z.string()).optional(),
  oauth: z.union([McpOAuthSchema, z.literal(false)]).optional(),
  timeout: z.number().optional(),
})

const McpServerConfigSchema = z.union([
  McpLocalSchema,
  McpRemoteSchema,
  z.object({ enabled: z.boolean() }),
])

// MCP 配置（支持继承控制）
const McpConfigSchema = z.object({
  inheritOpencode: z.boolean().default(true),
  inheritClaudeCode: z.boolean().default(true),
}).catchall(McpServerConfigSchema)

const ProviderOptionsSchema = z.object({
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
  timeout: z.union([z.number(), z.literal(false)]).optional(),
}).passthrough()

const ProviderItemConfigSchema = z.object({
  options: ProviderOptionsSchema.optional(),
  whitelist: z.array(z.string()).optional(),
  blacklist: z.array(z.string()).optional(),
}).passthrough()

const CustomProviderModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
})

const CustomProviderOptionsSchema = z.object({
  timeout: z.union([z.number(), z.literal(false)]).optional(),
  headers: z.record(z.string()).optional(),
}).passthrough()

const CustomProviderSchema = z.object({
  name: z.string().min(1),
  protocol: z.enum(['openai', 'anthropic']),
  baseURL: z.string().url(),
  models: z.array(CustomProviderModelSchema).min(1),
  options: CustomProviderOptionsSchema.optional(),
})

// Provider 配置（支持继承控制）
const ProviderConfigSchema = z.object({
  inheritOpencode: z.boolean().default(true),
}).catchall(ProviderItemConfigSchema)

const CUSTOM_PROVIDER_ID_REGEX = /^[a-z0-9][a-z0-9-_]{1,63}$/

const CustomProvidersConfigSchema = z.record(CustomProviderSchema).superRefine((providers, ctx) => {
  for (const providerId of Object.keys(providers)) {
    if (!CUSTOM_PROVIDER_ID_REGEX.test(providerId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [providerId],
        message: 'Provider ID must match ^[a-z0-9][a-z0-9-_]{1,63}$',
      })
    }
  }
})

// ===== 完整配置模式 =====

export const Nine1BotConfigSchema = z.object({
  $schema: z.string().optional(),

  // Nine1Bot 特有配置
  server: ServerConfigSchema.default({}),
  auth: AuthConfigSchema.default({}),
  tunnel: TunnelConfigSchema.default({}),
  isolation: IsolationConfigSchema.default({}),
  skills: SkillsConfigSchema.default({}),
  browser: BrowserConfigSchema.default({}),
  runtime: RuntimeConfigSchema.default({}),
  platforms: PlatformsConfigSchema.default({}),
  feishu: FeishuConfigSchema.default({}),


  // OpenCode 兼容配置
  model: z.string().optional(),
  small_model: z.string().optional(),
  default_agent: z.string().optional(),
  disabled_providers: z.array(z.string()).optional(),
  enabled_providers: z.array(z.string()).optional(),

  agent: z.record(AgentConfigSchema).optional(),
  mcp: McpConfigSchema.optional(),
  provider: ProviderConfigSchema.optional(),
  customProviders: CustomProvidersConfigSchema.default({}),

  permission: z.object({
    read: PermissionRuleSchema.optional(),
    edit: PermissionRuleSchema.optional(),
    glob: PermissionRuleSchema.optional(),
    grep: PermissionRuleSchema.optional(),
    list: PermissionRuleSchema.optional(),
    bash: PermissionRuleSchema.optional(),
    task: PermissionRuleSchema.optional(),
    external_directory: PermissionRuleSchema.optional(),
    todowrite: PermissionActionSchema.optional(),
    todoread: PermissionActionSchema.optional(),
    question: PermissionActionSchema.optional(),
    webfetch: PermissionActionSchema.optional(),
    websearch: PermissionActionSchema.optional(),
  }).passthrough().optional(),

  plugin: z.array(z.string()).optional(),
  instructions: z.array(z.string()).optional(),

  // 其他 OpenCode 配置
  theme: z.string().optional(),
  username: z.string().optional(),
  share: z.enum(['manual', 'auto', 'disabled']).optional(),
  autoupdate: z.union([z.boolean(), z.literal('notify')]).optional(),
  snapshot: z.boolean().optional(),

  compaction: z.object({
    auto: z.boolean().optional(),
    prune: z.boolean().optional(),
  }).optional(),

  sandbox: z.object({
    enabled: z.boolean().optional(),
    directory: z.string().optional(),
    allowedPaths: z.array(z.string()).optional(),
    denyPaths: z.array(z.string()).optional(),
  }).optional(),

  autonomous: z.object({
    enabled: z.boolean().optional(),
    maxRetries: z.number().optional(),
    askAfterRetries: z.boolean().optional(),
    allowDoomLoop: z.boolean().optional(),
  }).optional(),

  experimental: z.record(z.any()).optional(),
}).passthrough()

export type Nine1BotConfig = z.infer<typeof Nine1BotConfigSchema>
export type ServerConfig = z.infer<typeof ServerConfigSchema>
export type AuthConfig = z.infer<typeof AuthConfigSchema>
export type TunnelConfig = z.infer<typeof TunnelConfigSchema>
export type NgrokConfig = z.infer<typeof NgrokConfigSchema>
export type NatappConfig = z.infer<typeof NatappConfigSchema>
export type IsolationConfig = z.infer<typeof IsolationConfigSchema>
export type SkillsConfig = z.infer<typeof SkillsConfigSchema>
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>
export type PlatformConfigEntry = z.infer<typeof PlatformConfigEntrySchema>
export type PlatformsConfig = z.infer<typeof PlatformsConfigSchema>
export type FeishuConfig = z.infer<typeof FeishuConfigSchema>
export type CustomProvider = z.infer<typeof CustomProviderSchema>
export type CustomProviderModel = z.infer<typeof CustomProviderModelSchema>
