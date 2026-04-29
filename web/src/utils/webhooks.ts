import type { WebhookRequestGuards } from '../api/client'

export type WebhookPresetId = 'generic' | 'uptime-kuma' | 'gitlab-webhook'

export interface WebhookPreset {
  id: WebhookPresetId
  name: string
  description: string
  sourceName: string
  requestMapping: Record<string, string>
  promptTemplate: string
  samplePayload: unknown
  guards: WebhookRequestGuards
}

export interface WebhookPreviewInput {
  sourceName: string
  projectName: string
  requestMappingText: string
  promptTemplate: string
  samplePayloadText: string
  dedupeKeyTemplate?: string
}

export interface WebhookPreviewResult {
  ok: boolean
  error?: string
  fields: Record<string, unknown>
  renderedPrompt: string
  dedupeKey: string
}

const DEFAULT_GUARDS: WebhookRequestGuards = {
  dedupe: {
    enabled: false,
    keyTemplate: '',
    ttlSeconds: 3600,
  },
  rateLimit: {
    enabled: true,
    maxRequests: 20,
    windowSeconds: 60,
  },
  cooldown: {
    enabled: true,
    seconds: 120,
  },
  replayProtection: {
    enabled: false,
    timestampHeader: 'x-nine1bot-timestamp',
    maxSkewSeconds: 300,
  },
}

export function defaultWebhookGuards(): WebhookRequestGuards {
  return cloneWebhookGuards(DEFAULT_GUARDS)
}

export function cloneWebhookGuards(guards?: Partial<WebhookRequestGuards>): WebhookRequestGuards {
  return {
    dedupe: {
      ...DEFAULT_GUARDS.dedupe,
      ...(guards?.dedupe || {}),
    },
    rateLimit: {
      ...DEFAULT_GUARDS.rateLimit,
      ...(guards?.rateLimit || {}),
    },
    cooldown: {
      ...DEFAULT_GUARDS.cooldown,
      ...(guards?.cooldown || {}),
    },
    replayProtection: {
      ...DEFAULT_GUARDS.replayProtection,
      ...(guards?.replayProtection || {}),
    },
  }
}

const GENERIC_PROMPT = `Webhook source {{source.name}} triggered an automated Nine1Bot run.

Project: {{project.name}}
Event: {{fields.event}}
Severity: {{fields.severity}}
Message: {{fields.message}}
URL: {{fields.url}}

Please inspect the event using the project context and act within the configured permissions.`

const UPTIME_KUMA_PROMPT = `Uptime Kuma reported a service status change.

Project: {{project.name}}
Monitor: {{fields.service}}
Status: {{fields.status}}
URL: {{fields.url}}
Message: {{fields.message}}

Please investigate the incident, check likely causes, and run safe remediation steps within the configured permissions.`

const GITLAB_PROMPT = `GitLab webhook received for project {{fields.projectPath}}.

Event: {{fields.event}}
Merge request: !{{fields.mergeRequestIid}} {{fields.title}}
Source branch: {{fields.sourceBranch}}
Target branch: {{fields.targetBranch}}
Commit: {{fields.commitSha}}
Author: {{fields.author}}

Please review the related code changes using the project context and report concrete risks, regressions, and missing tests.`

export const WEBHOOK_PRESETS: WebhookPreset[] = [
  {
    id: 'generic',
    name: 'Generic JSON',
    description: 'Start from a neutral JSON webhook template.',
    sourceName: 'Generic webhook',
    requestMapping: {
      event: 'body.event',
      severity: 'body.severity',
      message: 'body.message',
      url: 'body.url',
    },
    promptTemplate: GENERIC_PROMPT,
    samplePayload: {
      event: 'deploy_failed',
      severity: 'warning',
      message: 'Production deploy failed during health check.',
      url: 'https://example.com/deploys/123',
    },
    guards: defaultWebhookGuards(),
  },
  {
    id: 'uptime-kuma',
    name: 'Uptime Kuma',
    description: 'Map monitor status changes into an incident prompt.',
    sourceName: 'Uptime Kuma Production',
    requestMapping: {
      monitorID: 'body.monitor.id',
      service: 'body.monitor.name',
      status: 'body.heartbeat.status',
      message: 'body.msg',
      url: 'body.monitor.url',
    },
    promptTemplate: UPTIME_KUMA_PROMPT,
    samplePayload: {
      msg: '[API] [DOWN] connect ETIMEDOUT',
      monitor: {
        id: 12,
        name: 'API',
        url: 'https://api.example.com/health',
      },
      heartbeat: {
        status: 0,
        msg: 'connect ETIMEDOUT',
      },
    },
    guards: cloneWebhookGuards({
      dedupe: {
        enabled: true,
        keyTemplate: '{{fields.monitorID}}:{{fields.status}}',
        ttlSeconds: 3600,
      },
    }),
  },
  {
    id: 'gitlab-webhook',
    name: 'GitLab Webhook',
    description: 'Turn GitLab merge request events into code review runs.',
    sourceName: 'GitLab MR Review',
    requestMapping: {
      event: 'body.object_kind',
      projectPath: 'body.project.path_with_namespace',
      mergeRequestIid: 'body.object_attributes.iid',
      title: 'body.object_attributes.title',
      sourceBranch: 'body.object_attributes.source_branch',
      targetBranch: 'body.object_attributes.target_branch',
      commitSha: 'body.object_attributes.last_commit.id',
      author: 'body.user.name',
    },
    promptTemplate: GITLAB_PROMPT,
    samplePayload: {
      object_kind: 'merge_request',
      user: {
        name: 'Ada Lovelace',
      },
      project: {
        path_with_namespace: 'team/service',
      },
      object_attributes: {
        iid: 42,
        title: 'Improve webhook handling',
        source_branch: 'feature/webhook',
        target_branch: 'main',
        last_commit: {
          id: 'abc123def456',
        },
      },
    },
    guards: cloneWebhookGuards({
      dedupe: {
        enabled: true,
        keyTemplate: '{{fields.event}}:{{fields.projectPath}}:{{fields.mergeRequestIid}}:{{fields.commitSha}}',
        ttlSeconds: 3600,
      },
    }),
  },
]

export function webhookPresetById(id: string) {
  return WEBHOOK_PRESETS.find((preset) => preset.id === id) || WEBHOOK_PRESETS[0]
}

export function findWebhookPresetForConfig(requestMapping: Record<string, string>, promptTemplate: string) {
  return WEBHOOK_PRESETS.find((preset) => (
    JSON.stringify(preset.requestMapping) === JSON.stringify(requestMapping) &&
    preset.promptTemplate.trim() === promptTemplate.trim()
  ))
}

export function parseWebhookMapping(text: string) {
  const parsed = JSON.parse(text || '{}')
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Request mapping must be a JSON object')
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new Error(`Mapping "${key}" must be a string path`)
    }
  }
  return parsed as Record<string, string>
}

export function previewWebhookConfig(input: WebhookPreviewInput): WebhookPreviewResult {
  try {
    const requestMapping = parseWebhookMapping(input.requestMappingText)
    const body = JSON.parse(input.samplePayloadText || '{}')
    const context = {
      source: {
        name: input.sourceName || 'Webhook source',
      },
      project: {
        name: input.projectName || 'Project',
      },
      fields: {} as Record<string, unknown>,
      body,
      headers: {},
      query: {},
    }
    context.fields = mapWebhookFields(requestMapping, context)
    return {
      ok: true,
      fields: context.fields,
      renderedPrompt: renderWebhookTemplate(input.promptTemplate, context),
      dedupeKey: input.dedupeKeyTemplate?.trim()
        ? renderWebhookTemplate(input.dedupeKeyTemplate, context).trim()
        : '',
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      fields: {},
      renderedPrompt: '',
      dedupeKey: '',
    }
  }
}

function mapWebhookFields(mapping: Record<string, string>, context: Record<string, unknown>) {
  const fields: Record<string, unknown> = {}
  for (const [field, path] of Object.entries(mapping)) {
    fields[field] = readPath(context, path)
  }
  return fields
}

function renderWebhookTemplate(template: string, context: Record<string, unknown>) {
  return template.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_match, expression: string) => {
    const value = expression === 'fields'
      ? context.fields
      : readPath(context, expression)
    return stringifyTemplateValue(value)
  })
}

function readPath(root: unknown, path: string) {
  const segments = path.split('.').filter(Boolean)
  let current = root
  for (const segment of segments) {
    if (current === undefined || current === null) return undefined
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)]
      continue
    }
    if (typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function stringifyTemplateValue(value: unknown) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value, null, 2)
}
