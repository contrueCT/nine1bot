import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { RuntimeControllerProtocol } from "../../src/runtime/controller/protocol"
import { Schedule } from "../../src/schedule/schedule"
import type { AutomatedControllerRunner } from "../../src/server/routes/automated-controller"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../fixture/fixture"

const acceptedRunner: AutomatedControllerRunner = async (input) => {
  const response = {
    accepted: true,
    sessionID: "ses_test_scheduled",
    turnSnapshotId: "turn_test_scheduled",
    status: 202,
    response: {
      version: RuntimeControllerProtocol.VERSION,
      accepted: true,
      sessionId: "ses_test_scheduled",
      turnSnapshotId: "turn_test_scheduled",
    },
  }
  await input.onControllerResponse?.(response)
  await input.onFinished?.({ status: "succeeded" })
  return response
}

async function cleanup(taskIDs: string[], projectID?: string) {
  for (const taskID of taskIDs) {
    for (const run of await Schedule.listRuns({ taskID, limit: 500 }).catch(() => [])) {
      await Storage.remove(["scheduled_run", run.id]).catch(() => undefined)
      await Storage.remove(["scheduled_run_by_task", taskID, run.id]).catch(() => undefined)
      await Storage.remove(["scheduled_run_active", taskID, run.id]).catch(() => undefined)
    }
    await Storage.remove(["scheduled_task", taskID]).catch(() => undefined)
  }
  if (projectID) {
    await Storage.remove(["project", projectID]).catch(() => undefined)
    await Storage.remove(["project_meta", projectID]).catch(() => undefined)
  }
  await Instance.disposeAll().catch(() => undefined)
}

describe("scheduled task time calculation", () => {
  test("computes once-after, daily, and interval next run times", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z")

    expect(Schedule.initialNextRunAt({ type: "once-after", delayMs: 2 * 60 * 60 * 1000 }, now, "UTC")).toBe(
      Date.parse("2026-01-01T02:00:00.000Z"),
    )
    expect(Schedule.initialNextRunAt({ type: "daily", timeOfDay: "00:05" }, now, "UTC")).toBe(
      Date.parse("2026-01-01T00:05:00.000Z"),
    )
    expect(Schedule.nextRunAfter({ type: "interval", every: 6, unit: "hour", anchorAt: now }, now, "UTC")).toBe(
      Date.parse("2026-01-01T06:00:00.000Z"),
    )
  })

  test("supports explicit timezone for daily schedules", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z")

    expect(Schedule.initialNextRunAt({ type: "daily", timeOfDay: "09:30" }, now, "Asia/Shanghai")).toBe(
      Date.parse("2026-01-01T01:30:00.000Z"),
    )
  })

  test("does not accept cron schedules in v1", () => {
    const parsed = Schedule.TaskCreate.safeParse({
      name: "Cron task",
      projectID: "project_test",
      schedule: {
        type: "cron",
        expression: "0 9 * * *",
      },
    })

    expect(parsed.success).toBe(false)
  })
})

describe("scheduled task storage and run behavior", () => {
  test("manual run records controller response and success", async () => {
    await using tmp = await tmpdir({ git: true })
    const taskIDs: string[] = []
    let projectID: string | undefined

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          projectID = Instance.project.id
          const task = await Schedule.createTask({
            name: "Manual test",
            projectID,
            schedule: { type: "once-after", delayMs: 60_000 },
            timezone: "UTC",
            promptTemplate: "Run {{task.name}} for {{project.name}}",
          }, 1000)
          taskIDs.push(task.id)

          const run = await Schedule.runTaskNow(task.id, {
            now: 2000,
            runner: acceptedRunner,
          })

          expect(run.status).toBe("succeeded")
          expect(run.reason).toBe("manual")
          expect(run.sessionID).toBe("ses_test_scheduled")
          expect(run.turnSnapshotId).toBe("turn_test_scheduled")
        },
      })
    } finally {
      await cleanup(taskIDs, projectID)
    }
  })

  test("skips due task when previous run is active and advances one-shot schedule", async () => {
    await using tmp = await tmpdir({ git: true })
    const taskIDs: string[] = []
    let projectID: string | undefined

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          projectID = Instance.project.id
          const task = await Schedule.createTask({
            name: "Overlap test",
            projectID,
            schedule: { type: "once-after", delayMs: 1000 },
            timezone: "UTC",
          }, 1000)
          taskIDs.push(task.id)
          await Schedule.createRun({
            taskID: task.id,
            projectID,
            status: "running",
            reason: "due",
            scheduledAt: 2000,
          })

          const runs = await Schedule.runDueTasks({
            now: 3000,
            runner: acceptedRunner,
          })
          const updated = await Schedule.getTask(task.id)

          expect(runs).toHaveLength(1)
          expect(runs[0].status).toBe("skipped")
          expect(runs[0].reason).toBe("overlap")
          expect(updated.nextRunAt).toBeUndefined()
        },
      })
    } finally {
      await cleanup(taskIDs, projectID)
    }
  })

  test("skips missed startup runs and advances the schedule", async () => {
    await using tmp = await tmpdir({ git: true })
    const taskIDs: string[] = []
    let projectID: string | undefined

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          projectID = Instance.project.id
          const task = await Schedule.createTask({
            name: "Misfire test",
            projectID,
            schedule: { type: "once-after", delayMs: 1000 },
            timezone: "UTC",
          }, 1000)
          taskIDs.push(task.id)

          const runs = await Schedule.skipMissedRuns(3000)
          const updated = await Schedule.getTask(task.id)

          expect(runs).toHaveLength(1)
          expect(runs[0].status).toBe("skipped")
          expect(runs[0].reason).toBe("misfire")
          expect(updated.nextRunAt).toBeUndefined()
        },
      })
    } finally {
      await cleanup(taskIDs, projectID)
    }
  })

  test("lists scheduled runs through the per-task index with pagination", async () => {
    await using tmp = await tmpdir({ git: true })
    const taskIDs: string[] = []
    let projectID: string | undefined

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          projectID = Instance.project.id
          const task = await Schedule.createTask({
            name: "Run index test",
            projectID,
            schedule: { type: "once-after", delayMs: 1000 },
            timezone: "UTC",
          }, 1000)
          taskIDs.push(task.id)

          const first = await Schedule.createRun({
            taskID: task.id,
            projectID,
            status: "succeeded",
            reason: "manual",
            scheduledAt: 1000,
          })
          const second = await Schedule.createRun({
            taskID: task.id,
            projectID,
            status: "succeeded",
            reason: "manual",
            scheduledAt: 2000,
          })

          const newest = await Schedule.listRuns({ taskID: task.id, limit: 1 })
          const next = await Schedule.listRuns({ taskID: task.id, limit: 1, offset: 1 })

          expect(newest).toHaveLength(1)
          expect(newest[0].id).toBe(second.id)
          expect(next).toHaveLength(1)
          expect(next[0].id).toBe(first.id)
        },
      })
    } finally {
      await cleanup(taskIDs, projectID)
    }
  })
})
