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

const McpRemoteSchema = z.object({
  type: z.literal('remote'),
  url: z.string(),
  enabled: z.boolean().optional(),
  headers: z.record(z.string()).optional(),
  timeout: z.number().optional(),
})

const McpConfigSchema = z.union([
  McpLocalSchema,
  McpRemoteSchema,
  z.object({ enabled: z.boolean() }),
])

const ProviderOptionsSchema = z.object({
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
  timeout: z.union([z.number(), z.literal(false)]).optional(),
}).passthrough()

const ProviderConfigSchema = z.object({
  options: ProviderOptionsSchema.optional(),
  whitelist: z.array(z.string()).optional(),
  blacklist: z.array(z.string()).optional(),
}).passthrough()

// ===== 完整配置模式 =====

export const Nine1BotConfigSchema = z.object({
  $schema: z.string().optional(),

  // Nine1Bot 特有配置
  server: ServerConfigSchema.default({}),
  auth: AuthConfigSchema.default({}),
  tunnel: TunnelConfigSchema.default({}),
  isolation: IsolationConfigSchema.default({}),
  skills: SkillsConfigSchema.default({}),

  // OpenCode 兼容配置
  model: z.string().optional(),
  small_model: z.string().optional(),
  default_agent: z.string().optional(),
  disabled_providers: z.array(z.string()).optional(),
  enabled_providers: z.array(z.string()).optional(),

  agent: z.record(AgentConfigSchema).optional(),
  mcp: z.record(McpConfigSchema).optional(),
  provider: z.record(ProviderConfigSchema).optional(),

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
