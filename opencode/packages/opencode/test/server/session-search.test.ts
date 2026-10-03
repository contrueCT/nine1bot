import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Storage } from "../../src/storage/storage"
import { Server } from "../../src/server/server"
import { Identifier } from "../../src/id/id"
import { tmpdir } from "../fixture/fixture"

async function textMessage(sessionID: string, text: string) {
  const messageID = Identifier.ascending("message")
  const partID = Identifier.ascending("part")
  await Session.updateMessage({
    id: messageID,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: "test", modelID: "test" },
  })
  await Session.updatePart({ id: partID, messageID, sessionID, type: "text", text })
  return { messageID, partID }
}

describe("GET /session/search", () => {
  test("returns message excerpts, scopes project from directory header and filters before limit", async () => {
    await using project = await tmpdir({ git: true, config: { model: "test/model" } })
    await using other = await tmpdir({ git: true, config: { model: "test/model" } })
    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({ title: "Ordinary title" })
        const hit = await textMessage(session.id, "Conversation 中文needle body")
        const extension = await Session.create({ title: "needle extension" })
        await Session.update(extension.id, (draft) => {
          draft.client = { source: "browser-extension" }
        })
        const automation = await Session.create({ title: "needle automation" })
        await Session.update(automation.id, (draft) => {
          draft.client = { source: "schedule" }
        })
        await Session.create({ title: "needle child", parentID: session.id })
        await Instance.provide({
          directory: other.path,
          fn: async () => {
            await Session.create({ title: "needle other project" })
          },
        })
        const request = (query: string) =>
          app.request(`/session/search?${query}`, {
            headers: { "x-opencode-directory": encodeURIComponent(project.path) },
          })
        const response = await request("q=needle")
        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body.hasMore).toBe(false)
        expect(body.results).toHaveLength(2)
        expect(body.results.find((row: any) => row.session.id === session.id)).toMatchObject({
          messageID: hit.messageID,
          snippet: "Conversation 中文needle body",
        })
        const filtered = await (await request("q=needle&clientSource=browser-extension&limit=1")).json()
        expect(filtered.results.map((row: any) => row.session.id)).toEqual([extension.id])
        expect(filtered.hasMore).toBe(false)
        expect((await (await request("q=missing")).json()).results).toEqual([])
        for (const query of [
          "q=",
          "q=%20%20",
          "q=needle&limit=0",
          "q=needle&limit=101",
          "q=needle&limit=1.5",
          "q=needle&clientSource=unknown",
        ]) {
          expect((await request(query)).status).toBe(400)
        }
        await Session.updatePart({
          id: hit.partID,
          messageID: hit.messageID,
          sessionID: session.id,
          type: "text",
          text: "replacement",
        })
        expect((await (await request("q=%E4%B8%AD%E6%96%87")).json()).results).toEqual([])
        await Session.remove(session.id)
        expect((await (await request("q=replacement")).json()).results).toEqual([])
      },
    })
  })

  test("backfill, rebuild, atomic writes and reverted content follow canonical storage", async () => {
    await using project = await tmpdir({ git: true, config: { model: "test/model" } })
    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const session = await Session.create({ title: "Historical title" })
        const hit = await textMessage(session.id, "historical source")
        const query = (q: string) => Storage.searchSessions({ projectID: Instance.project.id, q })
        await Storage.rebuildSessionSearch()
        expect((await query("historical source")).results[0].messageID).toBe(hit.messageID)
        await Session.update(session.id, (draft) => {
          draft.revert = { messageID: hit.messageID }
        })
        expect((await query("historical source")).results).toEqual([])
        await Session.update(session.id, (draft) => {
          delete draft.revert
        })
        expect((await query("historical source")).results).toHaveLength(1)
        await Storage.writeAtomic(["part", hit.messageID, hit.partID], {
          id: hit.partID,
          messageID: hit.messageID,
          sessionID: session.id,
          type: "text",
          text: "atomic text",
        })
        expect((await query("historical source")).results).toEqual([])
        expect((await query("atomic text")).results).toHaveLength(1)
        await Session.removeMessage({ sessionID: session.id, messageID: hit.messageID })
        expect((await query("atomic text")).results).toEqual([])
        await Session.remove(session.id)
      },
    })
  })
})
