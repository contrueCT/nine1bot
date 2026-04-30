import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { RuntimeControllerProtocol } from "../../src/runtime/controller/protocol"
import { Schedule } from "../../src/schedule/schedule"
import type { AutomatedControllerRunner } from "../../src/server/routes/automated-controller"
import { Server } from "../../src/server/server"
import { Storage } from "../../src/storage/storage"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const acceptedRunner: AutomatedControllerRunner = async (input) => {
  const response = {
    accepted: true,
    sessionID: "ses_route_scheduled",
    turnSnapshotId: "turn_route_scheduled",
    status: 202,
    response: {
      version: RuntimeControllerProtocol.VERSION,
      accepted: true,
      sessionId: "ses_route_scheduled",
      turnSnapshotId: "turn_route_scheduled",
    },
  }
  await input.onControllerResponse?.(response)
  await input.onFinished?.({ status: "succeeded" })
  return response
}

async function cleanup(taskIDs: string[], projectID?: string) {
  Schedule._testing.resetAutomatedControllerRunner()
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

describe("schedules routes", () => {
  test("creates, reads, updates, lists, and deletes scheduled tasks", async () => {
    await using tmp = await tmpdir({ git: true })
    const taskIDs: string[] = []
    let projectID: string | undefined

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          projectID = Instance.project.id
          const app = Server.App()
          const headers = {
            "Content-Type": "application/json",
            "x-opencode-directory": tmp.path,
          }

          const created = await app.request("/schedules/tasks", {
            method: "POST",
            headers,
            body: JSON.stringify({
              name: "Route schedule",
              projectID,
              timezone: "UTC",
              schedule: { type: "daily", timeOfDay: "09:30" },
              promptTemplate: "Run {{task.name}}",
            }),
          })
          expect(created.status).toBe(200)
          const task = await created.json() as Schedule.Task
          taskIDs.push(task.id)
          expect(task.name).toBe("Route schedule")
          expect(typeof task.nextRunAt).toBe("number")

          const fetched = await app.request(`/schedules/tasks/${task.id}`, { headers })
          expect(fetched.status).toBe(200)
          const fetchedTask = await fetched.json() as Schedule.Task
          expect(fetchedTask.id).toBe(task.id)

          const list = await app.request("/schedules/tasks", { headers })
          expect(list.status).toBe(200)
          const tasks = await list.json() as Schedule.Task[]
          expect(tasks.some((item) => item.id === task.id)).toBe(true)

          const updated = await app.request(`/schedules/tasks/${task.id}`, {
            method: "PATCH",
            headers,
            body: JSON.stringify({
              name: "Route schedule updated",
              enabled: false,
            }),
          })
          expect(updated.status).toBe(200)
          const updatedTask = await updated.json() as Schedule.Task
          expect(updatedTask.name).toBe("Route schedule updated")
          expect(updatedTask.enabled).toBe(false)
          expect(updatedTask.nextRunAt).toBeUndefined()

          const deleted = await app.request(`/schedules/tasks/${task.id}`, {
            method: "DELETE",
            headers,
          })
          expect(deleted.status).toBe(200)
          const deletedTask = await deleted.json() as Schedule.Task
          expect(typeof deletedTask.deletedAt).toBe("number")

          const hiddenList = await app.request("/schedules/tasks", { headers })
          const visibleTasks = await hiddenList.json() as Schedule.Task[]
          expect(visibleTasks.some((item) => item.id === task.id)).toBe(false)

          const updateDeleted = await app.request(`/schedules/tasks/${task.id}`, {
            method: "PATCH",
            headers,
            body: JSON.stringify({
              name: "Should not update",
            }),
          })
          expect(updateDeleted.status).toBe(404)

          const deleteDeleted = await app.request(`/schedules/tasks/${task.id}`, {
            method: "DELETE",
            headers,
          })
          expect(deleteDeleted.status).toBe(404)
        },
      })
    } finally {
      await cleanup(taskIDs, projectID)
    }
  })

  test("runs a scheduled task manually and lists run records with pagination", async () => {
    await using tmp = await tmpdir({ git: true })
    const taskIDs: string[] = []
    let projectID: string | undefined

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          projectID = Instance.project.id
          Schedule._testing.setAutomatedControllerRunner(acceptedRunner)
          const app = Server.App()
          const headers = {
            "Content-Type": "application/json",
            "x-opencode-directory": tmp.path,
          }

          const created = await app.request("/schedules/tasks", {
            method: "POST",
            headers,
            body: JSON.stringify({
              name: "Manual route schedule",
              projectID,
              timezone: "UTC",
              schedule: { type: "once-after", delayMs: 60_000 },
              promptTemplate: "Manual run {{task.name}}",
            }),
          })
          expect(created.status).toBe(200)
          const task = await created.json() as Schedule.Task
          taskIDs.push(task.id)

          const runResponse = await app.request(`/schedules/tasks/${task.id}/run`, {
            method: "POST",
            headers,
          })
          expect(runResponse.status).toBe(200)
          const runBody = await runResponse.json() as Schedule.RunResponse
          expect(runBody.accepted).toBe(true)
          expect(runBody.sessionId).toBe("ses_route_scheduled")
          expect(runBody.turnSnapshotId).toBe("turn_route_scheduled")
          expect(runBody.run.status).toBe("succeeded")
          expect(runBody.run.promptPreview).toContain("Manual route schedule")

          const runsResponse = await app.request(`/schedules/runs?taskID=${encodeURIComponent(task.id)}&limit=1&offset=0`, {
            headers,
          })
          expect(runsResponse.status).toBe(200)
          const runs = await runsResponse.json() as Schedule.Run[]
          expect(runs).toHaveLength(1)
          expect(runs[0].id).toBe(runBody.run.id)
        },
      })
    } finally {
      await cleanup(taskIDs, projectID)
    }
  })
})
