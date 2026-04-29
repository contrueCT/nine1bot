import { PermissionNext } from "@/permission/next"
import { Project } from "@/project/project"
import { RuntimeControllerProtocol } from "@/runtime/controller/protocol"
import { Scheduler } from "@/scheduler"
import {
  runAutomatedControllerSession,
  type AutomatedControllerResponse,
  type AutomatedControllerRunner,
} from "@/server/routes/automated-controller"
import { Storage } from "@/storage/storage"
import { monotonicFactory, ulid } from "ulid"
import z from "zod"

export namespace Schedule {
  const SCANNER_ID = "schedule.due-scanner"
  const SCANNER_INTERVAL_MS = 60_000
  const RUN_MONITOR_TIMEOUT_MS = 30 * 60 * 1000
  const PROMPT_PREVIEW_LIMIT = 4000
  const DEFAULT_RUN_LIST_LIMIT = 100

  const taskLocks = new Map<string, Promise<void>>()
  const runUlid = monotonicFactory()
  let scannerStarted = false
  let automatedControllerRunnerOverride: AutomatedControllerRunner | undefined

  export const ModelChoice = z.object({
    providerID: z.string(),
    modelID: z.string(),
  })
  export type ModelChoice = z.infer<typeof ModelChoice>

  export const RuntimeProfile = z
    .object({
      modelMode: z.enum(["default", "custom"]).default("default"),
      model: ModelChoice.optional(),
      resourcesMode: z.enum(["default", "default-plus-selected"]).default("default"),
      mcpServers: z.array(z.string()).default([]),
    })
    .default(() => defaultRuntimeProfile())
  export type RuntimeProfile = z.infer<typeof RuntimeProfile>

  export const PermissionPolicy = z
    .object({
      mode: z.enum(["default", "full"]).default("default"),
    })
    .default(() => defaultPermissionPolicy())
  export type PermissionPolicy = z.infer<typeof PermissionPolicy>

  export const ScheduleRule = z.discriminatedUnion("type", [
    z.object({
      type: z.literal("once-after"),
      delayMs: z.coerce.number().int().positive(),
    }),
    z.object({
      type: z.literal("daily"),
      timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      daysOfWeek: z.array(z.coerce.number().int().min(0).max(6)).optional(),
    }),
    z.object({
      type: z.literal("interval"),
      every: z.coerce.number().int().positive(),
      unit: z.enum(["hour", "day"]),
      anchorAt: z.coerce.number().int().positive().optional(),
    }),
  ])
  export type ScheduleRule = z.infer<typeof ScheduleRule>

  export const OverlapPolicy = z.enum(["skip"])
  export type OverlapPolicy = z.infer<typeof OverlapPolicy>

  export const MisfirePolicy = z
    .object({
      mode: z.literal("skip").default("skip"),
    })
    .default(() => defaultMisfirePolicy())
  export type MisfirePolicy = z.infer<typeof MisfirePolicy>

  export const Task = z.object({
    id: z.string(),
    name: z.string(),
    enabled: z.boolean(),
    projectID: z.string(),
    schedule: ScheduleRule,
    promptTemplate: z.string(),
    timezone: z.string(),
    runtimeProfile: RuntimeProfile,
    permissionPolicy: PermissionPolicy,
    overlapPolicy: OverlapPolicy,
    misfirePolicy: MisfirePolicy,
    nextRunAt: z.number().optional(),
    lastRunAt: z.number().optional(),
    deletedAt: z.number().optional(),
    time: z.object({
      created: z.number(),
      updated: z.number(),
    }),
  })
  export type Task = z.infer<typeof Task>

  export const RunStatus = z.enum(["scheduled", "accepted", "running", "succeeded", "failed", "skipped"])
  export type RunStatus = z.infer<typeof RunStatus>

  export const RunReason = z.enum(["disabled", "overlap", "misfire", "manual", "due"])
  export type RunReason = z.infer<typeof RunReason>

  export const Run = z.object({
    id: z.string(),
    taskID: z.string(),
    projectID: z.string(),
    sessionID: z.string().optional(),
    turnSnapshotId: z.string().optional(),
    status: RunStatus,
    reason: RunReason.optional(),
    scheduledAt: z.number(),
    triggeredAt: z.number().optional(),
    promptPreview: z.string().optional(),
    responseBody: z.unknown().optional(),
    error: z.string().optional(),
    time: z.object({
      created: z.number(),
      started: z.number().optional(),
      finished: z.number().optional(),
    }),
  })
  export type Run = z.infer<typeof Run>

  export const RunResponse = z.object({
    accepted: z.boolean(),
    run: Run,
    sessionId: z.string().optional(),
    turnSnapshotId: z.string().optional(),
    error: z.string().optional(),
  })
  export type RunResponse = z.infer<typeof RunResponse>

  export const TaskCreate = z.object({
    name: z.string().trim().min(1),
    enabled: z.boolean().optional(),
    projectID: z.string(),
    schedule: ScheduleRule,
    promptTemplate: z.string().optional(),
    timezone: z.string().optional(),
    runtimeProfile: RuntimeProfile.optional(),
    permissionPolicy: PermissionPolicy.optional(),
    overlapPolicy: OverlapPolicy.optional(),
    misfirePolicy: MisfirePolicy.optional(),
  })
  export type TaskCreate = z.infer<typeof TaskCreate>

  export const TaskUpdate = z.object({
    name: z.string().trim().min(1).optional(),
    enabled: z.boolean().optional(),
    projectID: z.string().optional(),
    schedule: ScheduleRule.optional(),
    promptTemplate: z.string().optional(),
    timezone: z.string().optional(),
    runtimeProfile: RuntimeProfile.optional(),
    permissionPolicy: PermissionPolicy.optional(),
    overlapPolicy: OverlapPolicy.optional(),
    misfirePolicy: MisfirePolicy.optional(),
  })
  export type TaskUpdate = z.infer<typeof TaskUpdate>

  const FULL_PERMISSION_RULES: PermissionNext.Ruleset = [
    {
      permission: "*",
      pattern: "*",
      action: "allow",
    },
  ]

  const SCHEDULED_CLIENT_CAPABILITIES = {
    interactions: false,
    permissionRequests: false,
    questionRequests: false,
    artifacts: false,
    filePreview: false,
    resourceFailures: true,
    continueInWeb: true,
  } satisfies RuntimeControllerProtocol.ClientCapabilities

  const SCHEDULED_ENTRY_BASE = {
    source: "schedule",
    platform: "nine1bot-scheduler",
    mode: "scheduled-run",
    templateIds: ["default-user-template", "scheduled-entry"],
  } satisfies RuntimeControllerProtocol.Entry

  export function init() {
    if (scannerStarted) return
    scannerStarted = true
    void skipMissedRuns().finally(() => {
      Scheduler.register({
        id: SCANNER_ID,
        interval: SCANNER_INTERVAL_MS,
        scope: "global",
        run: async () => {
          await runDueTasks()
        },
      })
    })
  }

  export function stopScanner() {
    Scheduler.unregister(SCANNER_ID, "global")
    scannerStarted = false
  }

  export const _testing = {
    setAutomatedControllerRunner(runner?: AutomatedControllerRunner) {
      automatedControllerRunnerOverride = runner
    },
    resetAutomatedControllerRunner() {
      automatedControllerRunnerOverride = undefined
    },
  }

  export function defaultPromptTemplate() {
    return [
      "Scheduled task {{task.name}} triggered an automated Nine1Bot run.",
      "",
      "Project: {{project.name}}",
      "Scheduled at: {{schedule.scheduledAt}}",
      "Triggered at: {{schedule.triggeredAt}}",
      "",
      "Please execute the configured recurring task using the project context and stay within the configured permissions.",
    ].join("\n")
  }

  export function defaultRuntimeProfile(): RuntimeProfile {
    return {
      modelMode: "default",
      resourcesMode: "default",
      mcpServers: [],
    }
  }

  export function defaultPermissionPolicy(): PermissionPolicy {
    return {
      mode: "default",
    }
  }

  export function defaultMisfirePolicy(): MisfirePolicy {
    return {
      mode: "skip",
    }
  }

  export function defaultTimezone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  }

  export async function createTask(input: TaskCreate, now = Date.now()) {
    await Project.get(input.projectID)
    const timezone = validateTimezone(input.timezone || defaultTimezone())
    const schedule = normalizeSchedule(input.schedule, now)
    const task: Task = {
      id: `task_${ulid().toLowerCase()}`,
      name: input.name,
      enabled: input.enabled ?? true,
      projectID: input.projectID,
      schedule,
      promptTemplate: input.promptTemplate ?? defaultPromptTemplate(),
      timezone,
      runtimeProfile: RuntimeProfile.parse(input.runtimeProfile),
      permissionPolicy: PermissionPolicy.parse(input.permissionPolicy),
      overlapPolicy: input.overlapPolicy ?? "skip",
      misfirePolicy: MisfirePolicy.parse(input.misfirePolicy),
      nextRunAt: input.enabled === false ? undefined : initialNextRunAt(schedule, now, timezone),
      time: {
        created: now,
        updated: now,
      },
    }
    await Storage.write(["scheduled_task", task.id], task)
    return Task.parse(task)
  }

  export async function updateTask(taskID: string, input: TaskUpdate, now = Date.now()) {
    if (input.projectID) {
      await Project.get(input.projectID)
    }
    const updated = await Storage.update<Task>(["scheduled_task", taskID], (draft) => {
      Object.assign(draft, Task.parse(draft))
      if (draft.deletedAt) throw taskNotFound(taskID)
      const scheduleChanged = input.schedule !== undefined
      const timezoneChanged = input.timezone !== undefined
      if (input.name !== undefined) draft.name = input.name
      if (input.enabled !== undefined) draft.enabled = input.enabled
      if (input.projectID !== undefined) draft.projectID = input.projectID
      if (input.schedule !== undefined) draft.schedule = normalizeSchedule(input.schedule, now)
      if (input.promptTemplate !== undefined) draft.promptTemplate = input.promptTemplate
      if (input.timezone !== undefined) draft.timezone = validateTimezone(input.timezone)
      if (input.runtimeProfile !== undefined) {
        draft.runtimeProfile = RuntimeProfile.parse({
          ...draft.runtimeProfile,
          ...input.runtimeProfile,
        })
      }
      if (input.permissionPolicy !== undefined) {
        draft.permissionPolicy = PermissionPolicy.parse({
          ...draft.permissionPolicy,
          ...input.permissionPolicy,
        })
      }
      if (input.overlapPolicy !== undefined) draft.overlapPolicy = input.overlapPolicy
      if (input.misfirePolicy !== undefined) draft.misfirePolicy = MisfirePolicy.parse(input.misfirePolicy)
      if (!draft.enabled) {
        draft.nextRunAt = undefined
      } else if (scheduleChanged || timezoneChanged || input.enabled === true || !draft.nextRunAt) {
        draft.nextRunAt = initialNextRunAt(draft.schedule, now, draft.timezone)
      }
      draft.time.updated = now
    })
    return Task.parse(updated)
  }

  export async function deleteTask(taskID: string) {
    const deleted = await Storage.update<Task>(["scheduled_task", taskID], (draft) => {
      Object.assign(draft, Task.parse(draft))
      if (draft.deletedAt) throw taskNotFound(taskID)
      draft.enabled = false
      draft.nextRunAt = undefined
      draft.deletedAt = Date.now()
      draft.time.updated = Date.now()
    })
    return Task.parse(deleted)
  }

  export async function getTask(taskID: string) {
    const task = Task.parse(await Storage.read<Task>(["scheduled_task", taskID]))
    if (task.deletedAt) throw taskNotFound(taskID)
    return task
  }

  export async function listTasks() {
    const tasks: Task[] = []
    for (const key of await Storage.list(["scheduled_task"])) {
      const task = await Storage.read<Task>(key).catch(() => undefined)
      if (!task || task.deletedAt) continue
      tasks.push(Task.parse(task))
    }
    tasks.sort((a, b) => b.time.updated - a.time.updated)
    return tasks
  }

  export async function createRun(input: {
    taskID: string
    projectID: string
    status?: RunStatus
    reason?: RunReason
    scheduledAt: number
    triggeredAt?: number
    promptPreview?: string
    responseBody?: unknown
    error?: string
  }) {
    const run: Run = {
      id: `run_${runUlid().toLowerCase()}`,
      taskID: input.taskID,
      projectID: input.projectID,
      status: input.status ?? "scheduled",
      reason: input.reason,
      scheduledAt: input.scheduledAt,
      triggeredAt: input.triggeredAt,
      promptPreview: input.promptPreview,
      responseBody: summarize(input.responseBody),
      error: input.error,
      time: {
        created: Date.now(),
      },
    }
    await Storage.write(["scheduled_run", run.id], run)
    await writeRunIndexes(run)
    return run
  }

  export async function updateRun(runID: string, input: Partial<Omit<Run, "id" | "time">> & {
    time?: Partial<Run["time"]>
  }) {
    const updated = await Storage.update<Run>(["scheduled_run", runID], (draft) => {
      const { time, ...rest } = input
      Object.assign(draft, {
        ...rest,
        ...(rest.responseBody !== undefined ? { responseBody: summarize(rest.responseBody) } : {}),
      })
      if (time) {
        draft.time = {
          ...draft.time,
          ...time,
        }
      }
    })
    const parsed = Run.parse(updated)
    await writeRunIndexes(parsed)
    return parsed
  }

  export async function listRuns(input: { taskID?: string; limit?: number; offset?: number } = {}) {
    const paging = normalizeRunPaging(input)
    if (input.taskID) {
      const keys = (await Storage.list(["scheduled_run_by_task", input.taskID])).reverse()
      if (keys.length > 0) {
        return listRunsFromKeys(keys, {
          ...paging,
          taskID: input.taskID,
          indexed: true,
        })
      }
    }
    return listRunsFromKeys((await Storage.list(["scheduled_run"])).reverse(), {
      ...paging,
      taskID: input.taskID,
    })
  }

  export async function runTaskNow(taskID: string, input: { now?: number; runner?: AutomatedControllerRunner } = {}) {
    const now = input.now ?? Date.now()
    return withTaskLock(taskID, async () => {
      const task = await getTask(taskID)
      if (task.deletedAt) throw new Storage.NotFoundError({ message: `Scheduled task not found: ${taskID}` })
      if (!task.enabled) {
        return createRun({
          taskID: task.id,
          projectID: task.projectID,
          status: "skipped",
          reason: "disabled",
          scheduledAt: now,
          triggeredAt: now,
          error: "Scheduled task is disabled.",
        })
      }
      return triggerTaskRun(task, {
        reason: "manual",
        scheduledAt: now,
        triggeredAt: now,
        runner: input.runner ?? automatedControllerRunnerOverride,
      })
    })
  }

  export async function runTaskNowResponse(taskID: string, input: { now?: number; runner?: AutomatedControllerRunner } = {}) {
    return runResponse(await runTaskNow(taskID, input))
  }

  export async function runDueTasks(input: { now?: number; runner?: AutomatedControllerRunner } = {}) {
    const now = input.now ?? Date.now()
    const tasks = await listTasks()
    const runs: Run[] = []
    for (const task of tasks) {
      if (!task.enabled || !task.nextRunAt || task.nextRunAt > now) continue
      const run = await withTaskLock(task.id, async () => {
        const current = await getTask(task.id).catch(() => undefined)
        if (!current || current.deletedAt || !current.enabled || !current.nextRunAt || current.nextRunAt > now) {
          return undefined
        }
        if (await hasActiveRun(current.id)) {
          const skipped = await createRun({
            taskID: current.id,
            projectID: current.projectID,
            status: "skipped",
            reason: "overlap",
            scheduledAt: current.nextRunAt,
            triggeredAt: now,
            error: "Previous scheduled run is still active.",
          })
          await advanceTaskAfterDue(current, current.nextRunAt, now)
          return skipped
        }
        const run = await triggerTaskRun(current, {
          reason: "due",
          scheduledAt: current.nextRunAt,
          triggeredAt: now,
          runner: input.runner ?? automatedControllerRunnerOverride,
        })
        await advanceTaskAfterDue(current, current.nextRunAt, now)
        return run
      })
      if (run) runs.push(run)
    }
    return runs
  }

  export async function skipMissedRuns(now = Date.now()) {
    const tasks = await listTasks()
    const runs: Run[] = []
    for (const task of tasks) {
      if (!task.enabled || !task.nextRunAt || task.nextRunAt > now) continue
      const run = await withTaskLock(task.id, async () => {
        const current = await getTask(task.id).catch(() => undefined)
        if (!current || current.deletedAt || !current.enabled || !current.nextRunAt || current.nextRunAt > now) {
          return undefined
        }
        const skipped = await createRun({
          taskID: current.id,
          projectID: current.projectID,
          status: "skipped",
          reason: "misfire",
          scheduledAt: current.nextRunAt,
          triggeredAt: now,
          error: "Missed scheduled run skipped on startup.",
        })
        await advanceTaskAfterDue(current, current.nextRunAt, now)
        return skipped
      })
      if (run) runs.push(run)
    }
    return runs
  }

  export function initialNextRunAt(rule: ScheduleRule, now = Date.now(), timezone = defaultTimezone()) {
    if (rule.type === "once-after") return now + rule.delayMs
    return nextRunAfter(rule, now, timezone)
  }

  export function nextRunAfter(rule: ScheduleRule, after: number, timezone = defaultTimezone()): number | undefined {
    if (rule.type === "once-after") return undefined
    if (rule.type === "interval") return nextIntervalRunAt(rule, after)
    return nextDailyRunAt(rule, after, validateTimezone(timezone))
  }

  export function renderPrompt(task: Task, project: Project.Info, input: {
    scheduledAt: number
    triggeredAt: number
  }) {
    return renderTemplate(task.promptTemplate, renderContext(task, project, input))
  }

  function normalizeSchedule(rule: ScheduleRule, now: number): ScheduleRule {
    if (rule.type !== "interval" || rule.anchorAt) return rule
    return {
      ...rule,
      anchorAt: now,
    }
  }

  function sessionChoiceForTask(task: Task): RuntimeControllerProtocol.SessionChoice {
    const choice: NonNullable<RuntimeControllerProtocol.SessionChoice> = {}
    if (task.runtimeProfile.modelMode === "custom" && task.runtimeProfile.model) {
      choice.model = task.runtimeProfile.model
    }
    const mcpServers = task.runtimeProfile.resourcesMode === "default-plus-selected"
      ? task.runtimeProfile.mcpServers.filter((server) => server.trim().length > 0)
      : []
    if (mcpServers.length > 0) {
      choice.resources = {
        mcp: {
          servers: mcpServers,
        },
      }
    }
    return Object.keys(choice).length > 0 ? choice : undefined
  }

  function permissionForTask(task: Task) {
    return task.permissionPolicy.mode === "full" ? FULL_PERMISSION_RULES : undefined
  }

  async function triggerTaskRun(task: Task, input: {
    reason: RunReason
    scheduledAt: number
    triggeredAt: number
    runner?: AutomatedControllerRunner
  }) {
    const project = await Project.get(task.projectID)
    const directory = project.rootDirectory || project.worktree
    const renderedPrompt = renderPrompt(task, project, {
      scheduledAt: input.scheduledAt,
      triggeredAt: input.triggeredAt,
    })
    const run = await createRun({
      taskID: task.id,
      projectID: task.projectID,
      status: "accepted",
      reason: input.reason,
      scheduledAt: input.scheduledAt,
      triggeredAt: input.triggeredAt,
      promptPreview: promptPreview(renderedPrompt),
    })
    const entry = {
      ...SCHEDULED_ENTRY_BASE,
      traceId: run.id,
    } satisfies RuntimeControllerProtocol.Entry
    const runner = input.runner ?? automatedControllerRunnerOverride ?? runAutomatedControllerSession

    try {
      await runner({
        directory,
        title: `Scheduled: ${task.name}`,
        permission: permissionForTask(task),
        sessionChoice: sessionChoiceForTask(task),
        entry,
        clientCapabilities: SCHEDULED_CLIENT_CAPABILITIES,
        parts: [{ type: "text", text: renderedPrompt }],
        timeoutMs: RUN_MONITOR_TIMEOUT_MS,
        timeoutMessage: "Scheduled run monitor timed out.",
        interactionPolicy: {
          permission: task.permissionPolicy.mode === "full" ? "allow-session" : "deny",
          question: "deny",
          permissionAllowMessage: "Scheduled run uses the full permission policy, so permission requests are allowed for this session.",
          permissionDenyMessage: "Scheduled runs use the default non-interactive permission policy, so permission requests are denied.",
          questionDenyMessage: "Question request denied automatically in scheduled run.",
        },
        async onControllerResponse(response) {
          await updateRun(run.id, {
            sessionID: response.sessionID,
            turnSnapshotId: response.turnSnapshotId,
            status: response.accepted ? "running" : "failed",
            responseBody: responseForRun(run.id, response),
            time: { started: Date.now() },
            ...(response.accepted ? {} : { error: "controller_message_not_accepted" }),
          })
        },
        async onFinished(result) {
          await updateRun(run.id, {
            status: result.status,
            ...(result.error ? { error: result.error } : {}),
            time: { finished: Date.now() },
          }).catch(() => undefined)
        },
        async onInteraction(interaction) {
          if (!interaction.error) return
          await updateRun(run.id, {
            error: interaction.error,
          }).catch(() => undefined)
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await updateRun(run.id, {
        status: "failed",
        error: message,
        responseBody: {
          accepted: false,
          runId: run.id,
          error: message,
        },
        time: { finished: Date.now() },
      }).catch(() => undefined)
    }

    return Run.parse(await Storage.read<Run>(["scheduled_run", run.id]))
  }

  async function advanceTaskAfterDue(task: Task, scheduledAt: number, now: number) {
    await Storage.update<Task>(["scheduled_task", task.id], (draft) => {
      Object.assign(draft, Task.parse(draft))
      draft.lastRunAt = now
      draft.nextRunAt = nextRunAfter(draft.schedule, Math.max(now, scheduledAt), draft.timezone)
      draft.time.updated = now
    })
  }

  async function hasActiveRun(taskID: string) {
    const keys = (await Storage.list(["scheduled_run_active", taskID])).reverse()
    for (const key of keys) {
      const run = await readRunFromKey(key, { indexed: true })
      if (!run || run.taskID !== taskID || !isActiveRunStatus(run.status)) {
        await Storage.remove(key).catch(() => undefined)
        continue
      }
      return true
    }

    for (const run of await listRuns({ taskID, limit: 100 })) {
      if (isActiveRunStatus(run.status)) {
        await writeRunIndexes(run).catch(() => undefined)
        return true
      }
    }
    return false
  }

  async function withTaskLock<T>(taskID: string, fn: () => Promise<T>) {
    const previous = taskLocks.get(taskID) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.catch(() => undefined).then(() => current)
    taskLocks.set(taskID, tail)
    await previous.catch(() => undefined)
    try {
      return await fn()
    } finally {
      release()
      if (taskLocks.get(taskID) === tail) {
        taskLocks.delete(taskID)
      }
    }
  }

  function responseForRun(runID: string, response: AutomatedControllerResponse) {
    return {
      accepted: response.accepted,
      runId: runID,
      sessionId: response.sessionID,
      turnSnapshotId: response.turnSnapshotId,
      ...(response.accepted ? {} : { error: "controller_message_not_accepted" }),
    }
  }

  function runResponse(run: Run): RunResponse {
    return RunResponse.parse({
      accepted: run.status !== "failed" && run.status !== "skipped",
      run,
      sessionId: run.sessionID,
      turnSnapshotId: run.turnSnapshotId,
      error: run.error,
    })
  }

  function promptPreview(prompt: string) {
    return prompt.length > PROMPT_PREVIEW_LIMIT ? `${prompt.slice(0, PROMPT_PREVIEW_LIMIT)}...` : prompt
  }

  function normalizeRunPaging(input: { limit?: number; offset?: number }) {
    return {
      limit: Math.max(0, input.limit ?? DEFAULT_RUN_LIST_LIMIT),
      offset: Math.max(0, input.offset ?? 0),
    }
  }

  async function listRunsFromKeys(keys: string[][], input: {
    taskID?: string
    limit: number
    offset: number
    indexed?: boolean
  }) {
    if (input.limit === 0) return []
    const runs: Run[] = []
    let matched = 0
    for (const key of keys) {
      const run = await readRunFromKey(key, { indexed: input.indexed })
      if (!run) continue
      if (input.taskID && run.taskID !== input.taskID) continue
      if (matched++ < input.offset) continue
      runs.push(run)
      if (runs.length >= input.limit) break
    }
    return runs
  }

  async function readRunFromKey(key: string[], input: { indexed?: boolean } = {}) {
    const runID = key[key.length - 1]
    if (!runID) return undefined
    const run = await Storage.read<Run>(["scheduled_run", runID]).catch(async () => {
      if (input.indexed) await Storage.remove(key).catch(() => undefined)
      return undefined
    })
    return run ? Run.parse(run) : undefined
  }

  async function writeRunIndexes(run: Run) {
    await Storage.write(["scheduled_run_by_task", run.taskID, run.id], { id: run.id })
    if (isActiveRunStatus(run.status)) {
      await Storage.write(["scheduled_run_active", run.taskID, run.id], { id: run.id })
    } else {
      await Storage.remove(["scheduled_run_active", run.taskID, run.id]).catch(() => undefined)
    }
  }

  function isActiveRunStatus(status: RunStatus) {
    return status === "scheduled" || status === "accepted" || status === "running"
  }

  function taskNotFound(taskID: string) {
    return new Storage.NotFoundError({ message: `Scheduled task not found: ${taskID}` })
  }

  function nextIntervalRunAt(rule: Extract<ScheduleRule, { type: "interval" }>, after: number) {
    const anchor = rule.anchorAt ?? after
    const intervalMs = rule.every * (rule.unit === "hour" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000)
    if (anchor > after) return anchor
    const elapsed = after - anchor
    return anchor + (Math.floor(elapsed / intervalMs) + 1) * intervalMs
  }

  function nextDailyRunAt(rule: Extract<ScheduleRule, { type: "daily" }>, after: number, timezone: string) {
    const [hour, minute] = rule.timeOfDay.split(":").map((part) => Number(part))
    if (hour > 23 || minute > 59) throw new Error(`Invalid timeOfDay: ${rule.timeOfDay}`)
    const now = zonedParts(after, timezone)
    for (let offset = 0; offset <= 8; offset++) {
      const localDate = new Date(Date.UTC(now.year, now.month - 1, now.day + offset, hour, minute, 0, 0))
      const localYear = localDate.getUTCFullYear()
      const localMonth = localDate.getUTCMonth() + 1
      const localDay = localDate.getUTCDate()
      const localWeekday = new Date(Date.UTC(localYear, localMonth - 1, localDay)).getUTCDay()
      if (rule.daysOfWeek?.length && !rule.daysOfWeek.includes(localWeekday)) continue
      const candidate = zonedDateTimeToUtc({
        year: localYear,
        month: localMonth,
        day: localDay,
        hour,
        minute,
        second: 0,
      }, timezone)
      if (candidate > after) return candidate
    }
    return undefined
  }

  function validateTimezone(timezone: string) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone }).format(new Date())
      return timezone
    } catch {
      throw new Error(`Invalid timezone: ${timezone}`)
    }
  }

  function zonedParts(timestamp: number, timezone: string) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(timestamp))
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
    return {
      year: Number(values.year),
      month: Number(values.month),
      day: Number(values.day),
      hour: Number(values.hour),
      minute: Number(values.minute),
      second: Number(values.second),
    }
  }

  function zonedDateTimeToUtc(input: {
    year: number
    month: number
    day: number
    hour: number
    minute: number
    second: number
  }, timezone: string) {
    const utc = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, input.second, 0)
    const first = utc - timezoneOffset(utc, timezone)
    const second = utc - timezoneOffset(first, timezone)
    return second
  }

  function timezoneOffset(timestamp: number, timezone: string) {
    const parts = zonedParts(timestamp, timezone)
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0)
    const milliseconds = timestamp - Math.floor(timestamp / 1000) * 1000
    return asUtc + milliseconds - timestamp
  }

  function renderContext(task: Task, project: Project.Info, input: {
    scheduledAt: number
    triggeredAt: number
  }) {
    return {
      task: {
        id: task.id,
        name: task.name,
      },
      project: {
        id: project.id,
        name: project.name || project.rootDirectory || project.worktree || project.id,
        rootDirectory: project.rootDirectory,
        worktree: project.worktree,
      },
      schedule: {
        timezone: task.timezone,
        scheduledAt: new Date(input.scheduledAt).toISOString(),
        triggeredAt: new Date(input.triggeredAt).toISOString(),
        previousRunAt: task.lastRunAt ? new Date(task.lastRunAt).toISOString() : undefined,
      },
    }
  }

  function renderTemplate(template: string, context: Record<string, any>) {
    return template.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_match, expression) => {
      return stringifyTemplateValue(readPath(context, expression))
    })
  }

  function readPath(value: unknown, path: string): unknown {
    let current = value
    for (const segment of path.split(".")) {
      if (!segment) return undefined
      if (typeof current !== "object" || current === null) return undefined
      current = (current as Record<string, unknown>)[segment]
    }
    return current
  }

  function stringifyTemplateValue(value: unknown) {
    if (value === undefined || value === null) return ""
    if (typeof value === "string") return value
    if (typeof value === "number" || typeof value === "boolean") return String(value)
    return JSON.stringify(value, null, 2)
  }

  function summarize(value: unknown, depth = 0): unknown {
    if (depth > 4) return "[truncated]"
    if (typeof value === "string") {
      return value.length > 1000 ? `${value.slice(0, 1000)}...` : value
    }
    if (typeof value !== "object" || value === null) return value
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => summarize(item, depth + 1))
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value).slice(0, 50)) {
      result[key] = summarize(item, depth + 1)
    }
    return result
  }
}
